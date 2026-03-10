/**
 * Minimal Telegram message handler.
 *
 * Handles incoming PlatformMessage from Telegram:
 *   1. Resolves workspace from TelegramBindingRepository
 *   2. Connects to CDP
 *   3. Injects the prompt into Antigravity
 *   4. Monitors the response via GrpcResponseMonitor
 *   5. Relays the response text back via PlatformChannel.send()
 */

import type { PlatformMessage, PlatformChannel, PlatformSentMessage } from '../platform/types';
import type { TelegramBindingRepository } from '../database/telegramBindingRepository';
import type { WorkspaceService } from '../services/workspaceService';
import { CdpBridge, ensureWorkspaceRuntime, registerApprovalWorkspaceChannel } from '../services/cdpBridgeManager';
import type { UserMessageInfo } from '../services/userMessageDetector';
import { CdpService } from '../services/cdpService';
import { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import { createPipelineSession } from '../utils/pipelineDebugLog';
import {
    initialDeliveryState,
    deliveryReducer,
    createDeliverySnapshot,
    type MessageDeliveryState,
    type DeliveryAction,
} from '../platform/telegram/messageDeliveryState';
import {
    planDelivery,
    executeDelivery,
    splitTelegramText,
} from '../platform/telegram/telegramDeliveryPipeline';
import { parseTelegramProjectCommand, handleTelegramProjectCommand } from './telegramProjectCommand';
import { parseTelegramCommand, handleTelegramCommand } from './telegramCommands';

import { ModeService } from '../services/modeService';
import type { ModelService } from '../services/modelService';
import { applyDefaultModel } from '../services/defaultModelApplicator';
import { logger } from '../utils/logger';
import { downloadTelegramPhotos } from '../utils/telegramImageHandler';
import { cleanupInboundImageAttachments } from '../utils/imageHandler';
import type { InboundImageAttachment } from '../utils/imageHandler';
import type { ChatSessionService } from '../services/chatSessionService';
import type { ScheduleService } from '../services/scheduleService';
import type { ScheduleRecord } from '../database/scheduleRepository';
import type { ClawCommandInterceptor } from '../services/clawCommandInterceptor';
import type { TelegramSessionStateStore } from './telegramJoinCommand';
import type { TelegramMessageTracker } from '../services/telegramMessageTracker';
import type { WorkspaceRuntime } from '../services/workspaceRuntime';
import { AntigravityTrajectoryRenderer } from '../services/antigravityTrajectoryRenderer';
import { markdownToTelegramHtmlViaUnified, rawHtmlToTelegramHtml } from '../platform/telegram/trajectoryRenderer';

const TELEGRAM_STREAM_RENDER_COALESCE_MS = 8;

/**
 * Sentinel text the AI must include when its inspect analysis is complete.
 * ClawGravity parses the response for this marker to exit inspect mode for the cycle.
 */
const INSPECT_DONE_SENTINEL = '[[INSPECT_COMPLETE]]';

/** Prefix used to identify inspect-mode prompts (prevents recursive triggering). */
const INSPECT_PROMPT_PREFIX = '[Inspect Mode';

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(reason?: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

export interface TelegramMessageHandlerDeps {
    readonly bridge: CdpBridge;
    readonly telegramBindingRepo: TelegramBindingRepository;
    readonly workspaceService?: WorkspaceService;
    readonly modeService?: ModeService;
    readonly modelService?: ModelService;
    readonly templateRepo?: import('../database/templateRepository').TemplateRepository;
    readonly fetchQuota?: () => Promise<any[]>;
    /** Shared map of active response monitors keyed by project name.
     *  Used by /stop to halt monitoring and prevent stale re-sends. */
    readonly activeMonitors?: Map<string, GrpcResponseMonitor>;
    /** Bot token for downloading Telegram file attachments. */
    readonly botToken?: string;
    /** Bot API object for getFile calls. */
    readonly botApi?: import('../platform/telegram/wrappers').TelegramBotLike['api'];
    readonly chatSessionService?: ChatSessionService;
    readonly sessionStateStore?: TelegramSessionStateStore;
    /** Schedule service for managing cron-based tasks */
    readonly scheduleService?: ScheduleService;
    /** Callback invoked when a schedule fires to execute a prompt */
    readonly scheduleJobCallback?: (schedule: ScheduleRecord) => void;
    /** Interceptor that scans AI responses for @claw commands */
    readonly clawInterceptor?: ClawCommandInterceptor;
    /** Message tracker for /clear to delete bot messages from chat. */
    readonly messageTracker?: TelegramMessageTracker;
}

/**
 * Create a handler for Telegram messages.
 * Returns an async function that processes a single PlatformMessage.
 */
export function createTelegramMessageHandler(deps: TelegramMessageHandlerDeps) {
    // Per-workspace prompt queue to serialize messages
    const workspaceQueues = new Map<string, Promise<void>>();

    function enqueueForWorkspace(
        workspacePath: string,
        task: () => Promise<void>,
    ): Promise<void> {
        const current = (workspaceQueues.get(workspacePath) ?? Promise.resolve()).catch(() => { });
        const next = current.then(async () => {
            try {
                await task();
            } catch (err: any) {
                logger.error('[TelegramQueue] task error:', err?.message || err);
            }
        });
        workspaceQueues.set(workspacePath, next);
        return next;
    }

    return async (message: PlatformMessage): Promise<void> => {
        const handlerEntryTime = Date.now();
        const chatId = message.channel.id;
        const hasImageAttachments = message.attachments.length > 0
            && message.attachments.some((att) => (att.contentType || '').startsWith('image/'));
        const promptText = message.content.trim();

        // Allow through if there's text OR image attachments
        if (!promptText && !hasImageAttachments) return;

        logger.debug(`[TelegramHandler] handler entered (chat=${chatId}, msgTime=${message.createdAt.toISOString()}, handlerDelay=${handlerEntryTime - message.createdAt.getTime()}ms)`);

        // Intercept built-in commands (/help, /status, /stop, /ping, /start)
        const cmd = parseTelegramCommand(promptText);
        let forwardedPrompt: string | undefined;
        if (cmd) {
            const cmdResult = await handleTelegramCommand(
                {
                    bridge: deps.bridge,
                    modeService: deps.modeService,
                    modelService: deps.modelService,
                    telegramBindingRepo: deps.telegramBindingRepo,
                    templateRepo: deps.templateRepo,
                    workspaceService: deps.workspaceService,
                    fetchQuota: deps.fetchQuota,
                    activeMonitors: deps.activeMonitors as any,
                    chatSessionService: deps.chatSessionService,
                    sessionStateStore: deps.sessionStateStore,
                    scheduleService: deps.scheduleService,
                    scheduleJobCallback: deps.scheduleJobCallback,
                    botApi: deps.botApi,
                    messageTracker: deps.messageTracker,
                },
                message,
                cmd,
            );
            if (cmdResult?.forwardAsMessage) {
                // Command wants to inject a prompt through the regular pipeline
                // (e.g. /inspect toggles inspect mode for the session)
                forwardedPrompt = cmdResult.forwardAsMessage;
            } else {
                return;
            }
        }

        // Intercept /project command before CDP path
        if (deps.workspaceService) {
            const parsed = parseTelegramProjectCommand(promptText);
            if (parsed) {
                await handleTelegramProjectCommand(
                    { workspaceService: deps.workspaceService, telegramBindingRepo: deps.telegramBindingRepo },
                    message,
                    parsed,
                );
                return;
            }
        }

        if (promptText) {
            deps.sessionStateStore?.pushRecentMessage(chatId, promptText);
        }

        // Resolve workspace binding for this Telegram chat
        const binding = deps.telegramBindingRepo.findByChatId(chatId);
        if (!binding) {
            await message.reply({
                text: 'No project is linked to this chat. Use /project to bind a workspace.',
            }).catch(logger.error);
            return;
        }

        // Resolve relative workspace name to absolute path (mirrors Discord handler behavior).
        // Without this, CDP receives a bare name like "DemoLG" and Antigravity
        // falls back to its default scratch directory.
        const workspacePath = deps.workspaceService
            ? deps.workspaceService.getWorkspacePath(binding.workspacePath)
            : binding.workspacePath;

        // Acknowledge receipt before queueing
        await message.react('\u{1F440}').catch(() => { });

        await enqueueForWorkspace(workspacePath, async () => {
            // Track all bot-sent message IDs so /clear can delete them
            const tracker = deps.messageTracker;
            const trackedChannel = tracker
                ? wrapChannelWithTracking(message.channel, tracker)
                : message.channel;
            // Also track the user's own message
            const userMsgIdNum = Number(message.id);
            if (tracker && !isNaN(userMsgIdNum)) {
                tracker.track(chatId, userMsgIdNum);
            }

            const cdpStartTime = Date.now();
            logger.debug(`[TelegramHandler] getOrConnect start (elapsed=${cdpStartTime - handlerEntryTime}ms)`);
            let runtime: WorkspaceRuntime;
            let cdp: CdpService;
            let projectName: string;
            let preparedRuntime: WorkspaceRuntime | null = null;
            let preparedProjectName = '';
            try {
                const prepared = await ensureWorkspaceRuntime(deps.bridge, workspacePath, {
                    enableActionDetectors: true,
                    userMessageSinkKey: `telegram:${chatId}`,
                    onUserMessage: (info: UserMessageInfo) => {
                        if (!preparedRuntime || !preparedProjectName) return;
                        handlePassiveUserMessage(
                            message.channel,
                            preparedRuntime,
                            info,
                            deps.activeMonitors,
                            undefined,
                            deps.sessionStateStore,
                        )
                            .catch((err: any) => logger.error('[TelegramPassive] Error handling PC message:', err));
                    },
                });
                runtime = prepared.runtime;
                cdp = prepared.cdp;
                projectName = prepared.projectName;
                preparedRuntime = runtime;
                preparedProjectName = projectName;
            } catch (e: any) {
                await message.reply({
                    text: `Failed to connect to workspace: ${e.message}`,
                }).catch(logger.error);
                return;
            }
            logger.debug(`[TelegramHandler] getOrConnect done (took=${Date.now() - cdpStartTime}ms)`);

            deps.bridge.lastActiveWorkspace = projectName;
            deps.bridge.lastActiveChannel = message.channel;
            registerApprovalWorkspaceChannel(deps.bridge, projectName, message.channel);

            const selectedSession = deps.sessionStateStore?.getSelectedSession(chatId);
            const currentCascadeId = deps.sessionStateStore?.getCurrentCascadeId(chatId) || selectedSession?.id || undefined;
            if (currentCascadeId) {
                await runtime.setActiveCascade(currentCascadeId);
            }

            // Always push ModeService's mode to Antigravity on CDP connect.
            // ModeService is the source of truth (what the user sees in /mode UI).
            // Without this, Antigravity could be in a different mode (e.g. Planning)
            // while the user believes they're in Fast mode.
            if (deps.modeService) {
                const currentMode = deps.modeService.getCurrentMode();
                const syncRes = await runtime.syncUiMode(currentMode);
                if (syncRes.ok) {
                    deps.modeService.markSynced();
                    logger.debug(`[TelegramHandler] Mode pushed to Antigravity: ${currentMode}`);
                } else {
                    logger.warn(`[TelegramHandler] Mode push failed: ${syncRes.error}`);
                }
            }

            // Apply default model preference on CDP connect
            if (deps.modelService) {
                const modelResult = await applyDefaultModel(cdp, deps.modelService);
                if (modelResult.stale && modelResult.staleMessage) {
                    await message.reply({ text: modelResult.staleMessage }).catch(logger.error);
                }
            }

            // Download image attachments if present
            let inboundImages: InboundImageAttachment[] = [];
            if (hasImageAttachments && deps.botToken && deps.botApi) {
                try {
                    inboundImages = await downloadTelegramPhotos(
                        message.attachments,
                        deps.botToken,
                        deps.botApi,
                    );
                } catch (err: any) {
                    logger.warn('[TelegramHandler] Image download failed:', err?.message || err);
                }

                if (hasImageAttachments && inboundImages.length === 0) {
                    await message.reply({
                        text: 'Failed to retrieve attached images. Please wait and try again.',
                    }).catch(logger.error);
                    return;
                }
            }

            // Determine the prompt text — use forwarded prompt (from command) if available,
            // otherwise fall back to regular prompt or default for image-only messages
            const effectivePrompt = forwardedPrompt || promptText || 'Please review the attached images and respond accordingly.';

            // Inject prompt (with or without images) into Antigravity
            logger.prompt(effectivePrompt);
            let injectResult;
            let initialMonitoringTarget;
            try {
                const sendResult = await runtime.sendPromptWithMonitoringTarget({
                    text: effectivePrompt,
                    overrideCascadeId: currentCascadeId,
                    imageFilePaths: inboundImages.map((img) => img.localPath),
                });
                injectResult = sendResult.injectResult;
                initialMonitoringTarget = sendResult.monitoringTarget;
            } finally {
                // Cleanup temp files regardless of outcome
                if (inboundImages.length > 0) {
                    await cleanupInboundImageAttachments(inboundImages).catch(() => { });
                }
            }

            if (!injectResult.ok) {
                await message.reply({
                    text: `Failed to send message: ${injectResult.error}`,
                }).catch(logger.error);
                return;
            }
            if (injectResult.cascadeId) {
                deps.sessionStateStore?.setCurrentCascadeId(chatId, injectResult.cascadeId);
            }

            // Monitor the response
            const channel = trackedChannel;
            const startTime = Date.now();
            const mirror = await createTelegramMirrorSession(channel, 'Processing...');
            const trajectoryRenderer = new AntigravityTrajectoryRenderer(cdp);

            const TIMEOUT_MS = 600_000;
            const monitorDeferred = createDeferred<void>();

            let settled = false;
            const settle = () => {
                if (settled) return;
                settled = true;
                clearTimeout(safetyTimer);
                deps.activeMonitors?.delete(projectName);
                monitorDeferred.resolve();
            };

            const monitoringTarget = initialMonitoringTarget
                ?? await runtime.getMonitoringTarget(injectResult.cascadeId || currentCascadeId || null);
            if (!monitoringTarget) {
                await channel.send({ text: '❌ gRPC client unavailable — cannot monitor response.' }).catch(logger.error);
                settle();
                return;
            }
            const { grpcClient, cascadeId } = monitoringTarget;
            let monitor: GrpcResponseMonitor | null = null;
            const pipeline = createPipelineSession('tg-active');
            const monitorConfig = buildMonitorCallbacks({
                pipeline,
                mirror,
                channel,
                getPhase: () => monitor?.getPhase?.() || 'timeout',
                renderOnlyOnComplete: true,
                resolveFinalText: (finalText: string) => finalText,
                handleEmptyComplete: async () => {
                    await channel.send({ text: '(Empty response from Antigravity)' }).catch(logger.error);
                    await mirror.clear();
                },
                afterComplete: async (_finalText: string, deliveredText: string | null) => {
                    // Detect inspect-complete sentinel: LLM confirmed no issues → auto-disable inspect mode.
                    if (deliveredText?.includes(INSPECT_DONE_SENTINEL)) {
                        deps.sessionStateStore?.setInspect(chatId, false);
                        await channel.send({ text: '🔍 Inspect 分析完成，未发现问题，已自动关闭 Inspect 模式。' }).catch(logger.error);
                        logger.info(`[TelegramHandler:inspect] Inspect cycle complete, auto-disabled (chat=${chatId})`);
                    }

                    // Inspect mode: send TG conversation + response back for self-analysis.
                    // Skip if the current prompt is itself an inspect prompt (prevents recursion).
                    if (deps.sessionStateStore?.getInspect(chatId) && deliveredText?.trim()
                        && !effectivePrompt.startsWith(INSPECT_PROMPT_PREFIX)) {
                        const inspectPrompt = buildInspectPrompt(effectivePrompt, deliveredText);
                        const inspectCascadeId = injectResult.cascadeId
                            || deps.sessionStateStore?.getCurrentCascadeId(chatId)
                            || cascadeId;
                        // Fire-and-forget: inject the inspect prompt.
                        // The recursion guard above ensures this only fires once per user message.
                        runtime.sendPromptWithMonitoringTarget({
                            text: inspectPrompt,
                            overrideCascadeId: inspectCascadeId,
                        }).then(() => {
                            logger.info(`[TelegramHandler:inspect] Inspect prompt injected (chat=${chatId})`);
                        }).catch((err: any) => {
                            logger.warn(`[TelegramHandler:inspect] Failed to inject inspect prompt: ${err?.message || err}`);
                        });
                    }

                    if (!deps.clawInterceptor || !deliveredText || !deliveredText.trim()) {
                        return;
                    }

                    await executeClawChain({
                        channel,
                        runtime,
                        clawInterceptor: deps.clawInterceptor,
                        initialText: deliveredText,
                        initialCascadeId: injectResult.cascadeId
                            || deps.sessionStateStore?.getCurrentCascadeId(chatId)
                            || cascadeId,
                        logPrefix: '[TelegramHandler]',
                        delayBeforeInjectMs: 2000,
                        onCascadeIdUpdate: (id) => deps.sessionStateStore?.setCurrentCascadeId(chatId, id),
                    });
                },
                handleTimeoutNotice: async (_lastText: string, phase: string) => {
                    const isError = phase === 'error';
                    const isQuota = phase === 'quotaReached';

                    if (isQuota) {
                        await channel.send({ text: '⚠️ Model quota reached. Please try again later or switch models with /model.' }).catch(logger.error);
                    } else if (isError) {
                        await channel.send({ text: '❌ An error occurred while generating the response.' }).catch(logger.error);
                    } else {
                        const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
                        await channel.send({ text: `Response timed out after ${elapsedSeconds}s.` }).catch(logger.error);
                    }
                },
                cleanup: settle,
            });

            if (!cascadeId) {
                await channel.send({ text: '❌ No cascade ID — cannot monitor response.' }).catch(logger.error);
                settle();
                return;
            }
            monitor = new GrpcResponseMonitor({
                grpcClient,
                cascadeId,
                maxDurationMs: TIMEOUT_MS,
                expectedUserMessage: effectivePrompt,
                trajectoryRenderer,
                ...monitorConfig
            });

            const safetyTimer = setTimeout(() => {
                logger.warn(`[TelegramHandler:${projectName}] Safety timeout — releasing queue after idle period`);
                monitor.stop().catch(() => { });
                settle();
            }, TIMEOUT_MS);

            // Register the monitor so /stop can access and stop it
            deps.activeMonitors?.set(projectName, monitor);

            monitor.start().catch((err: any) => {
                logger.error(`[TelegramHandler:${projectName}] monitor.start() failed:`, err?.message || err);
                mirror.dispose();
                settle();
            });

            await monitorDeferred.promise;
        });
    };
}

// ---------------------------------------------------------------------------
// Inspect-mode self-analysis prompt builder
// ---------------------------------------------------------------------------

/**
 * Build a self-analysis prompt for inspect mode.
 *
 * Includes the TG user prompt and Antigravity's response, asking Antigravity
 * to compare, identify discrepancies, and self-fix.
 */
function buildInspectPrompt(userPrompt: string, antigravityResponse: string): string {
    const parts: string[] = [];
    parts.push(
        '[Inspect Mode — Self-Analysis]',
        '',
        'The following is the Telegram conversation that was just exchanged.',
        'Compare the TG-forwarded content with your own token stream.',
        'Identify any discrepancies, missing information, formatting issues, or bugs.',
        '',
        '## User Prompt (from Telegram)',
        '```',
        userPrompt,
        '```',
        '',
        '## Your Response (delivered to Telegram)',
        '```',
        antigravityResponse.slice(0, 8000), // cap to avoid enormous prompts
        '```',
        '',
        'Please:',
        '1. Analyze the difference between what was requested and what was delivered',
        '2. Check if there are any code errors, truncation, or formatting problems',
        '3. If you find issues in YOUR OWN codebase that caused the discrepancy, fix them',
        '4. After fixing, compile and restart the process to apply changes',
        '5. Briefly summarize your findings',
        '',
        `IMPORTANT: Include the exact text ${INSPECT_DONE_SENTINEL} at the very end of your response`,
        'ONLY when you are confident that:',
        '  - There are NO remaining issues, OR',
        '  - All issues have been identified and fixed.',
        `When ClawGravity detects ${INSPECT_DONE_SENTINEL}, it will automatically disable Inspect mode for this chat.`,
        `If you are NOT confident everything is resolved, do NOT include ${INSPECT_DONE_SENTINEL} — Inspect mode will remain active for the next message.`,
        `If you fixed something and triggered a restart, still include ${INSPECT_DONE_SENTINEL} AFTER your summary (only if the fix is complete).`,
    );
    return parts.join('\n');
}

/**
 * Split long text into Telegram-safe chunks (max 4096 chars).
 * Converts Markdown to Telegram HTML before splitting for consistency.
 */
async function sendTextChunked(
    channel: PlatformChannel,
    text: string,
): Promise<void> {
    const telegramHtml = markdownToTelegramHtmlViaUnified(text) || text;
    const chunks = splitTelegramText(telegramHtml);
    for (const chunk of chunks) {
        await channel.send({ text: chunk }).catch(logger.error);
    }
}

// ---------------------------------------------------------------------------
// Shared @claw command chain executor (Issue #5)
// ---------------------------------------------------------------------------

interface ClawChainOptions {
    readonly channel: PlatformChannel;
    readonly runtime: WorkspaceRuntime;
    readonly clawInterceptor: ClawCommandInterceptor;
    readonly initialText: string;
    readonly initialCascadeId: string | null;
    readonly logPrefix: string;
    readonly maxDepth?: number;
    readonly delayBeforeInjectMs?: number;
    readonly onCascadeIdUpdate?: (cascadeId: string) => void;
    readonly onFollowUpMonitor?: (monitor: GrpcResponseMonitor) => void;
    readonly onFollowUpComplete?: () => void;
}

async function executeClawChain(opts: ClawChainOptions): Promise<void> {
    const {
        channel, runtime, clawInterceptor, logPrefix,
        maxDepth = 3, delayBeforeInjectMs = 0,
    } = opts;

    let currentText = opts.initialText;
    let activeCascadeId = opts.initialCascadeId;
    let clawDepth = 0;

    while (clawDepth < maxDepth) {
        const clawResults = await clawInterceptor.execute(currentText);
        if (clawResults.length === 0) break;

        clawDepth++;
        logger.info(`${logPrefix} Found @claw command(s) — executing (depth=${clawDepth})...`);

        for (const r of clawResults) {
            const icon = r.success ? '✅' : '❌';
            await channel.send({ text: `${icon} @claw:${r.command.action} — ${r.message}` }).catch(() => { });
        }

        const resultLines = clawResults.map(r =>
            `@claw:${r.command.action} — ${r.success ? 'OK' : 'FAIL'}\n${r.message}`
        );
        const feedback = `[ClawGravity Command Results]\n\n${resultLines.join('\n\n')}`;
        if (delayBeforeInjectMs > 0) {
            await new Promise(r => setTimeout(r, delayBeforeInjectMs));
        }

        const followUpResult = await runtime.sendPromptWithMonitoringTarget({
            text: feedback,
            overrideCascadeId: activeCascadeId || undefined,
        });
        const ir = followUpResult.injectResult;
        if (!ir.ok) {
            logger.warn(`${logPrefix} Failed to inject @claw results: ${ir.error}`);
            break;
        }
        if (ir.cascadeId) {
            opts.onCascadeIdUpdate?.(ir.cascadeId);
        }

        logger.debug(`${logPrefix} @claw results injected — awaiting follow-up (depth=${clawDepth})...`);

        const followUpTarget = followUpResult.monitoringTarget
            ?? await runtime.getMonitoringTarget(ir.cascadeId || activeCascadeId || null);
        if (!followUpTarget) {
            logger.warn(`${logPrefix} @claw follow-up: gRPC unavailable`);
            break;
        }
        activeCascadeId = followUpTarget.cascadeId;

        const deferred = createDeferred<string>();
        const followUpMonitor = new GrpcResponseMonitor({
            grpcClient: followUpTarget.grpcClient,
            cascadeId: followUpTarget.cascadeId,
            maxDurationMs: 300_000,
            expectedUserMessage: feedback,
            onComplete: (text: string) => deferred.resolve(text?.trim() || ''),
            onTimeout: (lastText: string) => {
                logger.warn(`${logPrefix} @claw follow-up timed out (depth=${clawDepth})`);
                deferred.resolve(lastText || '');
            },
        });

        opts.onFollowUpMonitor?.(followUpMonitor);
        followUpMonitor.start().catch((err: any) => {
            logger.error(`${logPrefix} follow-up monitor.start() failed:`, err?.message || err);
            deferred.resolve('');
        });

        const nextText = await deferred.promise;
        opts.onFollowUpComplete?.();

        if (!nextText || nextText.trim().length === 0) break;

        await sendTextChunked(channel, nextText);
        currentText = nextText;

        if (clawDepth >= maxDepth) {
            logger.warn(`${logPrefix} Reached max @claw depth (${maxDepth}). Stopping.`);
            await sendTextChunked(channel, `⚠️ Reached max @claw execution depth (${maxDepth}). Stopping auto-execution.`);
            break;
        }
    }
}



export function createCoalescedStatusRenderer(
    channel: PlatformChannel,
    getMessages: () => PlatformSentMessage[],
    setMessages: (messages: PlatformSentMessage[]) => void,
) {
    let lastAppliedText = '';
    let pendingText: string | null = null;
    let renderTimer: NodeJS.Timeout | null = null;
    let renderPromise: Promise<void> | null = null;
    let disposed = false;

    const scheduleFlush = () => {
        if (disposed || renderTimer) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            void flushPending();
        }, TELEGRAM_STREAM_RENDER_COALESCE_MS);
    };

    const flushPending = async (): Promise<void> => {
        if (disposed || renderPromise) {
            return renderPromise ?? Promise.resolve();
        }

        renderPromise = (async () => {
            while (!disposed && pendingText && pendingText !== lastAppliedText) {
                const nextText = pendingText;
                pendingText = null;
                const syncResult = await syncStreamingStatusMessages(channel, getMessages(), nextText);
                setMessages(syncResult.messages);
                if (syncResult.applied) {
                    lastAppliedText = nextText;
                }
            }
        })()
            .catch(() => { })
            .finally(() => {
                renderPromise = null;
                if (!disposed && pendingText && pendingText !== lastAppliedText) {
                    scheduleFlush();
                }
            });

        return renderPromise;
    };

    return {
        request(text: string, immediate = false): void {
            if (disposed || !text) return;
            if (text === lastAppliedText || text === pendingText) return;

            pendingText = text;
            if (immediate) {
                if (renderTimer) {
                    clearTimeout(renderTimer);
                    renderTimer = null;
                }
                void flushPending();
                return;
            }

            scheduleFlush();
        },
        async flush(): Promise<void> {
            if (renderTimer) {
                clearTimeout(renderTimer);
                renderTimer = null;
            }
            while (!disposed) {
                const hasPendingText = !!pendingText && pendingText !== lastAppliedText;
                if (!renderPromise && !hasPendingText) {
                    return;
                }
                await flushPending();
                if (renderTimer) {
                    clearTimeout(renderTimer);
                    renderTimer = null;
                }
            }
        },
        dispose(): void {
            disposed = true;
            pendingText = null;
            if (renderTimer) {
                clearTimeout(renderTimer);
                renderTimer = null;
            }
        },
    };
}

async function syncStreamingStatusMessages(
    channel: PlatformChannel,
    existingMessages: PlatformSentMessage[],
    text: string,
): Promise<{ messages: PlatformSentMessage[]; applied: boolean }> {
    const chunks = splitTelegramText(text);
    if (chunks.length === 0) {
        return {
            messages: existingMessages,
            applied: true,
        };
    }

    const nextMessages = existingMessages.slice();
    let applied = true;
    for (let i = 0; i < chunks.length; i++) {
        const existing = nextMessages[i];
        if (existing) {
            try {
                nextMessages[i] = await existing.edit({ text: chunks[i] });
                continue;
            } catch (err: any) {
                logger.warn(`[TelegramStatus] edit failed for msg #${i}: ${err?.message || err}`);
                const shouldPreserveExisting = /(message is too long|too long|text_too_long|message_too_long|caption is too long|entities too long)/i.test(
                    err instanceof Error ? err.message : String(err || ''),
                );
                const replacement = await channel.send({ text: chunks[i] }).catch((sendErr: any) => {
                    logger.error(`[TelegramStatus] replacement send failed for chunk #${i}: ${sendErr?.message || sendErr}`);
                    return null;
                });
                if (replacement) {
                    if (!shouldPreserveExisting) {
                        await existing.delete().catch(() => { });
                    }
                    nextMessages[i] = replacement;
                    continue;
                }
                applied = false;
            }
            continue;
        }

        const sent = await channel.send({ text: chunks[i] }).catch((err: any) => {
            logger.error(`[TelegramStatus] send failed for chunk #${i}: ${err?.message || err}`);
            return null;
        });
        if (sent) {
            nextMessages[i] = sent;
        } else {
            applied = false;
        }
    }

    for (let i = chunks.length; i < nextMessages.length; i++) {
        await nextMessages[i].delete().catch(() => { });
    }

    return {
        messages: nextMessages.slice(0, chunks.length),
        applied,
    };
}

async function deleteStreamingStatusMessages(messages: PlatformSentMessage[]): Promise<void> {
    await Promise.all(messages.map((message) => message.delete().catch(() => { })));
}

// ---------------------------------------------------------------------------
// TelegramMirrorSession — CRDT-backed streaming updater
// ---------------------------------------------------------------------------

/**
 * Mirror session using CRDT state (LWW-Registers).
 *
 * Writers:
 *   - dispatch(TEXT_UPDATE) — from onProgress (raw streaming text)
 *   - dispatch(HTML_UPDATE) — from onRenderedTimeline (rendered HTML)
 *   - dispatch(COMPLETE)    — from onComplete (final text)
 *
 * The streaming coalesced renderer reads derived state from the CRDT
 * and pushes updates to Telegram. It's the only stateful I/O concern.
 *
 * On completion, `snapshot()` freezes the CRDT state and the pure
 * delivery pipeline takes over — no shared mutable state.
 */
interface TelegramMirrorSession {
    dispatch(action: DeliveryAction): void;
    snapshot(): import('../platform/telegram/messageDeliveryState').DeliverySnapshot;
    getMessages(): PlatformSentMessage[];
    flush(): Promise<void>;
    clear(): Promise<void>;
    dispose(): void;
}

async function createTelegramMirrorSession(
    channel: PlatformChannel,
    initialPlaceholderText?: string,
): Promise<TelegramMirrorSession> {
    let messages: PlatformSentMessage[] = [];
    const renderer = createCoalescedStatusRenderer(
        channel,
        () => messages,
        (nextMessages) => {
            messages = nextMessages;
        },
    );
    let state: MessageDeliveryState = initialDeliveryState();

    // Prefer Markdown → Telegram HTML (pure, no CDP dependency).
    // Falls back to CDP-rendered HTML if text state hasn't arrived yet.
    const renderCurrent = (): string => {
        if (state.text.clock > 0 && state.text.value.trim()) {
            return markdownToTelegramHtmlViaUnified(state.text.value).trim();
        }
        if (state.html.clock > 0 && state.html.value.trim()) {
            return rawHtmlToTelegramHtml(state.html.value).trim();
        }
        return '';
    };

    if (initialPlaceholderText) {
        const initialMessage = await channel.send({ text: initialPlaceholderText }).catch(() => null);
        if (initialMessage) {
            messages = [initialMessage];
        }
    }

    return {
        dispatch(action: DeliveryAction): void {
            state = deliveryReducer(state, action);
            // Push streaming update (skip for COMPLETE — delivery pipeline handles that)
            if (action.type !== 'COMPLETE') {
                const isFirstVisible = state.text.clock <= 1 && state.html.clock <= 1;
                const renderedText = renderCurrent();
                if (renderedText) {
                    renderer.request(renderedText, isFirstVisible);
                }
            }
        },
        snapshot() {
            return createDeliverySnapshot(state);
        },
        getMessages() {
            return messages.slice();
        },
        async flush(): Promise<void> {
            await renderer.flush();
        },
        async clear(): Promise<void> {
            state = initialDeliveryState();
            if (messages.length > 0) {
                await deleteStreamingStatusMessages(messages);
                messages = [];
            }
        },
        dispose(): void {
            renderer.dispose();
        },
    };
}

// ---------------------------------------------------------------------------
// Monitor callback builder — connects GrpcResponseMonitor to CRDT + pipeline
// ---------------------------------------------------------------------------

interface MonitorCallbackOptions {
    readonly pipeline: ReturnType<typeof createPipelineSession>;
    readonly mirror: TelegramMirrorSession;
    readonly channel: PlatformChannel;
    readonly getPhase: () => string;
    readonly renderOnlyOnComplete: boolean;
    readonly resolveFinalText: (finalText: string) => string | null;
    readonly shouldForward?: () => boolean;
    readonly handleEmptyComplete?: () => Promise<void>;
    readonly afterComplete?: (finalText: string, deliveredText: string | null) => Promise<void>;
    readonly handleTimeoutNotice: (lastText: string, phase: string) => Promise<void>;
    readonly cleanup: () => void;
}

/**
 * Build GrpcResponseMonitor callbacks using the CRDT + pure pipeline pattern.
 *
 * Data flow:
 *   onProgress(text) → dispatch(TEXT_UPDATE) → coalesced render
 *   onRenderedTimeline(html) → dispatch(HTML_UPDATE) → coalesced render
 *   onComplete(finalText) →
 *     1. dispatch(COMPLETE)
 *     2. snapshot() — freezes state
 *     3. planDelivery(snapshot) — pure function
 *     4. executeDelivery(plan) — Telegram API
 *
 * No shared mutable state during steps 2-4. Race-free by construction.
 */
function buildMonitorCallbacks(options: MonitorCallbackOptions) {
    const {
        pipeline,
        mirror,
        channel,
        getPhase,
        renderOnlyOnComplete,
        resolveFinalText,
        shouldForward = () => true,
        handleEmptyComplete,
        afterComplete,
        handleTimeoutNotice,
        cleanup,
    } = options;

    return {
        onProgress: (text: string) => {
            if (!shouldForward()) return;
            // HTML register having clock > 0 means rendered content arrived;
            // prefer that over raw text (same logic as old hasReceivedRenderedContent flag,
            // but derived from CRDT state instead of separate mutable boolean).
            mirror.dispatch({ type: 'TEXT_UPDATE', text });
        },

        onRenderedTimeline: (timeline: { content: string; format: 'text' | 'html' }) => {
            if (!shouldForward()) return;
            if (!timeline.content?.trim()) return;
            if (timeline.format === 'html') {
                mirror.dispatch({ type: 'HTML_UPDATE', html: timeline.content });
            } else {
                mirror.dispatch({ type: 'TEXT_UPDATE', text: timeline.content });
            }
        },

        onComplete: async (finalText: string) => {
            try {
                // 1. Dispatch completion (monotonic flag)
                mirror.dispatch({ type: 'COMPLETE', finalText });

                // 2. Resolve final text (caller-specific logic, e.g. session validation)
                const resolvedText = resolveFinalText(finalText);
                if (resolvedText === null) {
                    // Caller decided not to deliver (e.g. stale session)
                    return;
                }

                // 3. Freeze state — atomic snapshot, no more state changes matter
                const snapshot = mirror.snapshot();
                const existingMessages = mirror.getMessages();
                mirror.dispose(); // stop streaming renderer

                // 4. Pure pipeline: snapshot → plan (deterministic, no side effects)
                const plan = planDelivery(pipeline, snapshot, { renderOnlyOnComplete });

                pipeline.observe('deliveryPlan', {
                    mode: plan.mode,
                    reason: plan.reason,
                    chunkCount: plan.chunks.length,
                    telegramHtmlLength: plan.telegramHtml.length,
                });

                // 5. Execute delivery (Telegram API calls)
                if (plan.mode === 'empty') {
                    if (handleEmptyComplete) {
                        await handleEmptyComplete();
                    }
                } else {
                    await executeDelivery(pipeline, plan, channel, existingMessages);
                }

                // 6. Post-delivery hooks
                await afterComplete?.(finalText, plan.deliveredText);
            } finally {
                pipeline.flush();
                mirror.dispose(); // idempotent
                cleanup();
            }
        },

        onTimeout: async (lastText: string) => {
            try {
                pipeline.observe('timeout', {
                    lastTextLength: lastText.length,
                    phase: getPhase(),
                });
                // Flush current streaming state before the timeout notice
                await mirror.flush();
                await handleTimeoutNotice(lastText, getPhase());
            } finally {
                pipeline.flush();
                mirror.dispose();
                cleanup();
            }
        },
    };
}


// ---------------------------------------------------------------------------
// Passive PC → Telegram notification
// ---------------------------------------------------------------------------

/** Per-workspace passive response monitors to avoid duplicates. */
const passiveResponseMonitors = new Map<string, GrpcResponseMonitor>();

/** TTL cleanup: remove stale passive monitors that weren't properly cleaned up. */
const PASSIVE_MONITOR_TTL_MS = 15 * 60 * 1000; // 15 minutes
const passiveMonitorCreatedAt = new Map<string, number>();
let passiveMonitorCleanupTimer: NodeJS.Timeout | null = null;
const PASSIVE_USER_EVENT_TTL_MS = 15_000;
const recentPassiveUserEvents = new Map<string, number>();

function maybeStopPassiveMonitorCleanup(): void {
    if (passiveResponseMonitors.size === 0 && passiveMonitorCleanupTimer) {
        clearInterval(passiveMonitorCleanupTimer);
        passiveMonitorCleanupTimer = null;
    }
}

function ensurePassiveMonitorCleanup(): void {
    if (passiveMonitorCleanupTimer) return;
    passiveMonitorCleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, createdAt] of passiveMonitorCreatedAt) {
            if (now - createdAt > PASSIVE_MONITOR_TTL_MS) {
                const monitor = passiveResponseMonitors.get(key);
                if (monitor) {
                    logger.debug(`[TelegramPassive] Cleaning up stale monitor for ${key} (age=${Math.round((now - createdAt) / 1000)}s)`);
                    monitor.stop().catch(() => { });
                    passiveResponseMonitors.delete(key);
                }
                passiveMonitorCreatedAt.delete(key);
            }
        }
        maybeStopPassiveMonitorCleanup();
    }, 60_000);
}

function clearPassiveMonitorState(
    projectName: string,
    activeMonitors?: Map<string, GrpcResponseMonitor>,
): void {
    passiveResponseMonitors.delete(projectName);
    passiveMonitorCreatedAt.delete(projectName);
    activeMonitors?.delete(`passive:${projectName}`);
    maybeStopPassiveMonitorCleanup();
}

function normalizePassiveEventText(text: string): string {
    return (text || '')
        .replace(/\r/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .slice(0, 200);
}

function buildPassiveUserEventKey(channelId: string, projectName: string, info: UserMessageInfo): string {
    return [
        channelId,
        projectName,
        info.cascadeId || 'no-cascade',
        normalizePassiveEventText(info.text),
    ].join('|');
}

function shouldSkipDuplicatePassiveUserEvent(channelId: string, projectName: string, info: UserMessageInfo): boolean {
    const now = Date.now();
    const key = buildPassiveUserEventKey(channelId, projectName, info);

    for (const [existingKey, timestamp] of recentPassiveUserEvents) {
        if (now - timestamp > PASSIVE_USER_EVENT_TTL_MS) {
            recentPassiveUserEvents.delete(existingKey);
        }
    }

    const lastSeenAt = recentPassiveUserEvents.get(key) ?? 0;
    if (lastSeenAt && now - lastSeenAt <= PASSIVE_USER_EVENT_TTL_MS) {
        return true;
    }

    recentPassiveUserEvents.set(key, now);
    return false;
}

/**
 * Handle a user message detected from the Antigravity PC UI.
 * Forwards the message text to the linked Telegram chat and starts a passive
 * backend response monitor to relay the AI response.
 */
export async function handlePassiveUserMessage(
    channel: PlatformChannel,
    runtime: WorkspaceRuntime,
    info: UserMessageInfo,
    activeMonitors?: Map<string, GrpcResponseMonitor>,
    clawInterceptor?: ClawCommandInterceptor,
    sessionStateStore?: TelegramSessionStateStore,
): Promise<void> {
    if (sessionStateStore) {
        const expectedCascadeId = sessionStateStore.getCurrentCascadeId(channel.id)
            || await runtime.getActiveCascadeId().catch(() => null);
        if (expectedCascadeId && info.cascadeId && info.cascadeId !== expectedCascadeId) {
            logger.debug(
                `[TelegramPassive] Ignoring cross-session user message for chat ${channel.id}: ` +
                `expected=${expectedCascadeId.slice(0, 12)}..., got=${info.cascadeId.slice(0, 12)}...`,
            );
            return;
        }
    }

    const projectName = runtime.getProjectName();
    if (shouldSkipDuplicatePassiveUserEvent(channel.id, projectName, info)) {
        logger.debug(
            `[TelegramPassive] Skipping duplicate mirrored user message for ${projectName} ` +
            `(chat=${channel.id}, cascade=${info.cascadeId || 'unknown'})`,
        );
        return;
    }

    // Forward the user message
    const preview = info.text.length > 200 ? info.text.slice(0, 200) + '…' : info.text;
    await channel.send({ text: `🖥️ ${preview}` }).catch(logger.error);

    // Start passive backend response monitor to capture the AI response
    startPassiveResponseMonitor(
        channel,
        runtime,
        projectName,
        info,
        activeMonitors,
        clawInterceptor,
        sessionStateStore,
    );
}

/**
 * Start a passive backend response monitor that sends the AI response to Telegram
 * when generation completes. If a monitor is already running for this
 * workspace, it is stopped and replaced.
 */
async function startPassiveResponseMonitor(
    channel: PlatformChannel,
    runtime: WorkspaceRuntime,
    projectName: string,
    info: UserMessageInfo,
    activeMonitors?: Map<string, GrpcResponseMonitor>,
    clawInterceptor?: ClawCommandInterceptor,
    sessionStateStore?: TelegramSessionStateStore,
): Promise<void> {
    const isCurrentChatSession = (): boolean => {
        if (!sessionStateStore || !info.cascadeId) return true;
        const currentCascadeId = sessionStateStore.getCurrentCascadeId(channel.id);
        return !!currentCascadeId && currentCascadeId === info.cascadeId;
    };

    // Stop previous passive monitor if still running
    const prev = passiveResponseMonitors.get(projectName);
    if (prev?.isActive()) {
        prev.stop().catch(() => { });
    }

    const startTime = Date.now();
    const mirror = await createTelegramMirrorSession(channel);
    const trajectoryRenderer = new AntigravityTrajectoryRenderer(
        runtime.getConnectedCdp() || runtime.getCdpUnsafe(),
    );

    const initialMonitoringTarget = await runtime.getMonitoringTarget(info.cascadeId || null);
    let monitor: GrpcResponseMonitor | null = null;
    const cleanupPassiveState = () => clearPassiveMonitorState(projectName, activeMonitors);
    const passivePipeline = createPipelineSession('tg-passive');
    const monitorConfig = buildMonitorCallbacks({
        pipeline: passivePipeline,
        mirror,
        channel,
        getPhase: () => monitor?.getPhase?.() || 'timeout',
        renderOnlyOnComplete: true,
        resolveFinalText: (finalText: string) => {
            if (!isCurrentChatSession()) {
                return null;
            }
            return finalText;
        },
        shouldForward: isCurrentChatSession,
        handleEmptyComplete: async () => {
            if (isCurrentChatSession()) {
                await mirror.clear();
            }
        },
        afterComplete: async (_finalText: string, deliveredText: string | null) => {
            // Detect inspect-complete sentinel in passive path: LLM confirmed no issues → auto-disable.
            if (deliveredText?.includes(INSPECT_DONE_SENTINEL) && isCurrentChatSession()) {
                sessionStateStore?.setInspect(channel.id, false);
                await channel.send({ text: '🔍 Inspect 分析完成，未发现问题，已自动关闭 Inspect 模式。' }).catch(logger.error);
                logger.info(`[TelegramPassive:inspect] Inspect cycle complete, auto-disabled (chat=${channel.id})`);
            }

            if (!clawInterceptor || !deliveredText || !deliveredText.trim() || !isCurrentChatSession()) {
                return;
            }

            await executeClawChain({
                channel,
                runtime,
                clawInterceptor,
                initialText: deliveredText,
                initialCascadeId: initialMonitoringTarget?.cascadeId || info.cascadeId || null,
                logPrefix: '[TelegramPassive]',
                onFollowUpMonitor: (monitor) => {
                    passiveResponseMonitors.set(projectName, monitor);
                    passiveMonitorCreatedAt.set(projectName, Date.now());
                    activeMonitors?.set(`passive:${projectName}`, monitor);
                },
                onFollowUpComplete: () => clearPassiveMonitorState(projectName, activeMonitors),
            });
        },
        handleTimeoutNotice: async (_lastText: string, phase: string) => {
            if (!isCurrentChatSession()) {
                return;
            }

            if (phase === 'quotaReached') {
                await channel.send({ text: '⚠️ Model quota reached. Please try again later or switch models with /model.' }).catch(() => { });
            } else if (phase === 'error') {
                await channel.send({ text: '❌ An error occurred while generating the response.' }).catch(() => { });
            } else {
                const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
                await channel.send({ text: `⏱️ Response timed out after ${elapsedSeconds}s.` }).catch(() => { });
            }
        },
        cleanup: cleanupPassiveState,
    });

    if (!initialMonitoringTarget) {
        logger.warn('[TelegramPassive] gRPC client or cascadeId unavailable — cannot start passive monitor');
        mirror.dispose();
        return;
    }
    monitor = new GrpcResponseMonitor({
        grpcClient: initialMonitoringTarget.grpcClient,
        cascadeId: initialMonitoringTarget.cascadeId,
        maxDurationMs: 600_000,
        expectedUserMessage: info.text,
        trajectoryRenderer,
        ...monitorConfig
    });

    passiveResponseMonitors.set(projectName, monitor);
    passiveMonitorCreatedAt.set(projectName, Date.now());
    ensurePassiveMonitorCleanup();
    activeMonitors?.set(`passive:${projectName}`, monitor);
    monitor.startPassive().catch((err: any) => {
        logger.error('[TelegramPassive] Failed to start response monitor:', err?.message || err);
        clearPassiveMonitorState(projectName, activeMonitors);
        mirror.dispose();
    });
}

// ---------------------------------------------------------------------------
// Channel tracking wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a PlatformChannel so that every message sent through it is
 * automatically recorded in the TelegramMessageTracker.
 * This enables /clear to delete all bot-sent messages from the chat.
 */
function wrapChannelWithTracking(
    channel: PlatformChannel,
    tracker: TelegramMessageTracker,
): PlatformChannel {
    return {
        ...channel,
        async send(payload) {
            const sent = await channel.send(payload);
            const msgIdNum = Number(sent.id);
            if (!isNaN(msgIdNum)) {
                tracker.track(channel.id, msgIdNum);
            }
            return sent;
        },
    };
}
