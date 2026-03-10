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
import { splitOutputAndLogs } from '../utils/discordFormatter';
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
                // (e.g. /debug builds a prompt and hands it off for full monitoring)
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

            // Determine the prompt text — use forwarded prompt (from /debug) if available,
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
            const mirrorForwarder = createTelegramMirrorForwarder(mirror);
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
            const monitorConfig = createTelegramMirrorMonitorCallbacks({
                mirror,
                mirrorForwarder,
                getPhase: () => monitor?.getPhase?.() || 'timeout',
                resolveFinalText: async (finalText: string) => {
                    const separated = splitOutputAndLogs(finalText || '');
                    const finalOutputText = separated.output || finalText || '';
                    if (finalOutputText && finalOutputText.trim().length > 0) {
                        logger.divider(`Output (${finalOutputText.length} chars)`);
                        console.info(finalOutputText);
                    }
                    logger.divider();
                    return finalOutputText && finalOutputText.trim().length > 0
                        ? finalOutputText
                        : finalText;
                },
                handleEmptyComplete: async () => {
                    await channel.send({ text: '(Empty response from Antigravity)' }).catch(logger.error);
                    await mirror.clear();
                },
                afterComplete: async (_finalText: string, deliveredText: string | null) => {
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
                clearMirrorAfterTimeout: false,
                renderOnlyOnComplete: true,
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


async function deliverFinalTelegramText(
    channel: PlatformChannel,
    existingMessages: PlatformSentMessage[],
    text: string,
): Promise<PlatformSentMessage[]> {
    // Convert raw Markdown to Telegram-safe HTML via the unified pipeline
    const telegramHtml = markdownToTelegramHtmlViaUnified(text) || text;
    const chunks = splitTelegramText(telegramHtml);
    if (chunks.length === 0) {
        return existingMessages;
    }

    const nextMessages = existingMessages.slice();
    for (let i = 0; i < chunks.length; i++) {
        const existing = nextMessages[i];
        if (existing) {
            try {
                nextMessages[i] = await existing.edit({ text: chunks[i] });
                continue;
            } catch (err: any) {
                logger.warn(`[TelegramDeliver] final edit failed for msg #${i}: ${err?.message || err}`);
                const shouldPreserveExisting = isTelegramLengthError(err);
                const replacement = await channel.send({ text: chunks[i] }).catch((sendErr: any) => {
                    logger.error(`[TelegramDeliver] final send failed for chunk #${i}: ${sendErr?.message || sendErr}`);
                    return null;
                });
                if (replacement) {
                    if (!shouldPreserveExisting) {
                        await existing.delete().catch(() => { });
                    }
                    nextMessages[i] = replacement;
                    continue;
                }
            }
            continue;
        }

        const sent = await channel.send({ text: chunks[i] }).catch((err: any) => {
            logger.error(`[TelegramDeliver] final send failed for chunk #${i}: ${err?.message || err}`);
            return null;
        });
        if (sent) {
            nextMessages[i] = sent;
        }
    }

    for (let i = chunks.length; i < nextMessages.length; i++) {
        await nextMessages[i].delete().catch(() => { });
    }

    return nextMessages.slice(0, chunks.length);
}

/**
 * Split text into chunks that fit Telegram's 4096-char limit.
 * Prefers splitting at newline boundaries to avoid breaking HTML tags.
 */
function splitTelegramText(text: string): string[] {
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) return text.length > 0 ? [text] : [];

    type OpenTag = { name: string; openTag: string };
    const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
    const chunks: string[] = [];
    const openTags: OpenTag[] = [];
    let current = '';
    let cursor = 0;

    const buildClosingTags = () => openTags.slice().reverse().map((tag) => `</${tag.name}>`).join('');
    const buildOpeningTags = () => openTags.map((tag) => tag.openTag).join('');
    const flushChunk = () => {
        if (!current) return;
        chunks.push(current + buildClosingTags());
        current = buildOpeningTags();
    };
    const splitTextSegment = (segment: string, maxLen: number): [string, string] => {
        if (segment.length <= maxLen) {
            return [segment, ''];
        }

        const candidate = segment.slice(0, maxLen);
        const lastNewline = candidate.lastIndexOf('\n');
        const splitAt = lastNewline > maxLen / 2 ? lastNewline + 1 : maxLen;
        return [segment.slice(0, splitAt), segment.slice(splitAt)];
    };
    const appendText = (segment: string) => {
        let remaining = segment;
        while (remaining.length > 0) {
            const closingTags = buildClosingTags();
            const available = MAX_LENGTH - current.length - closingTags.length;
            if (available <= 0) {
                flushChunk();
                continue;
            }

            const [piece, rest] = splitTextSegment(remaining, available);
            current += piece;
            remaining = rest;
            if (remaining.length > 0) {
                flushChunk();
            }
        }
    };

    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(text)) !== null) {
        if (match.index > cursor) {
            appendText(text.slice(cursor, match.index));
        }

        const fullTag = match[0];
        const rawName = match[1] || '';
        const tagName = rawName.toLowerCase();
        const isClosing = fullTag.startsWith('</');
        const isSelfClosing = fullTag.endsWith('/>') || tagName === 'tg-emoji';

        if ((current.length + fullTag.length + buildClosingTags().length) > MAX_LENGTH) {
            flushChunk();
        }
        current += fullTag;

        if (isClosing) {
            const idx = openTags.map((tag) => tag.name).lastIndexOf(tagName);
            if (idx >= 0) {
                openTags.splice(idx, 1);
            }
        } else if (!isSelfClosing) {
            openTags.push({ name: tagName, openTag: fullTag });
        }

        cursor = match.index + fullTag.length;
    }

    if (cursor < text.length) {
        appendText(text.slice(cursor));
    }

    if (current) {
        chunks.push(current + buildClosingTags());
    }

    return chunks.filter((chunk) => chunk.length > 0);
}

function isTelegramLengthError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || '');
    return /(message is too long|too long|text_too_long|message_too_long|caption is too long|entities too long)/i.test(message);
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
                const shouldPreserveExisting = isTelegramLengthError(err);
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

interface TelegramMirrorSession {
    updateText(text: string, immediate?: boolean): void;
    updateHtml(html: string, immediate?: boolean): void;
    hasRenderableContent(): boolean;
    flush(): Promise<void>;
    finalize(text: string): Promise<void>;
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
    let latestText = '';
    let latestHtml = '';
    let preferredFormat: 'text' | 'html' = 'text';

    const renderCurrent = (): string => {
        if (preferredFormat === 'html' && latestHtml.trim()) {
            return rawHtmlToTelegramHtml(latestHtml).trim();
        }
        return markdownToTelegramHtmlViaUnified(latestText).trim();
    };

    if (initialPlaceholderText) {
        const initialMessage = await channel.send({ text: initialPlaceholderText }).catch(() => null);
        if (initialMessage) {
            messages = [initialMessage];
        }
    }

    return {
        updateText(text: string, immediate = false): void {
            const isFirstVisibleUpdate = !latestText.trim();
            latestText = text || '';
            preferredFormat = 'text';
            const renderedText = renderCurrent();
            if (!renderedText) return;
            renderer.request(renderedText, immediate || isFirstVisibleUpdate);
        },
        updateHtml(html: string, immediate = false): void {
            const isFirstVisibleUpdate = !latestText.trim() && !latestHtml.trim();
            latestHtml = html || '';
            preferredFormat = 'html';
            const renderedText = renderCurrent();
            if (!renderedText) return;
            renderer.request(renderedText, immediate || isFirstVisibleUpdate);
        },
        async flush(): Promise<void> {
            await renderer.flush();
        },
        hasRenderableContent(): boolean {
            return renderCurrent().trim().length > 0;
        },
        async finalize(text: string): Promise<void> {
            latestText = text || '';

            if (preferredFormat === 'html' && latestHtml.trim()) {
                // HTML-preferred: render the latest HTML into the status message
                const renderedText = renderCurrent();
                if (renderedText) {
                    renderer.request(renderedText, true);
                    await renderer.flush();
                }
                return;
            }

            if (latestText.trim()) {
                // Text-preferred: deliverFinalTelegramText handles the final edit/send
                // Dispose the coalesced renderer first to avoid racing edits
                renderer.dispose();
                messages = await deliverFinalTelegramText(channel, messages, latestText);
                return;
            }

            if (messages.length > 0) {
                await deleteStreamingStatusMessages(messages);
                messages = [];
            }
        },
        async clear(): Promise<void> {
            latestText = '';
            latestHtml = '';
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

function applyTimelineUpdateToMirror(
    mirror: TelegramMirrorSession,
    timeline: {
        content: string;
        format: 'text' | 'html';
    },
): void {
    if (!timeline.content?.trim()) return;
    if (timeline.format === 'html') {
        mirror.updateHtml(timeline.content);
        return;
    }
    mirror.updateText(timeline.content);
}

function createTelegramMirrorForwarder(
    mirror: TelegramMirrorSession,
    shouldForward: () => boolean = () => true,
    options?: {
        renderedOnly?: boolean;
    },
): {
    onTextUpdate: (text: string) => void;
    onRenderedTimeline: (timeline: { content: string; format: 'text' | 'html' }) => void;
    flushLastText: (text: string) => Promise<void>;
    finalizeText: (text: string) => Promise<void>;
    finalizeRendered: () => Promise<void>;
    hasRenderableContent: () => boolean;
} {
    const renderedOnly = options?.renderedOnly === true;

    return {
        onTextUpdate: (text: string) => {
            if (renderedOnly) return;
            if (!shouldForward()) return;
            mirror.updateText(text);
        },
        onRenderedTimeline: (timeline: { content: string; format: 'text' | 'html' }) => {
            if (!shouldForward()) return;
            applyTimelineUpdateToMirror(mirror, timeline);
        },
        async flushLastText(text: string): Promise<void> {
            if (renderedOnly) return;
            if (!shouldForward()) return;
            const visibleText = markdownToTelegramHtmlViaUnified(text || '').trim();
            if (!visibleText) return;
            mirror.updateText(text, true);
            await mirror.flush();
        },
        async finalizeText(text: string): Promise<void> {
            if (!shouldForward()) return;
            if (text && text.trim().length > 0) {
                await mirror.finalize(text);
                return;
            }
            await mirror.clear();
        },
        async finalizeRendered(): Promise<void> {
            if (!shouldForward()) return;
            await mirror.finalize('');
        },
        hasRenderableContent: () => shouldForward() && mirror.hasRenderableContent(),
    };
}

interface TelegramMirrorMonitorCallbacksOptions {
    readonly mirror: TelegramMirrorSession;
    readonly mirrorForwarder: ReturnType<typeof createTelegramMirrorForwarder>;
    readonly getPhase: () => string;
    readonly resolveFinalText: (finalText: string) => Promise<string | null> | string | null;
    readonly handleEmptyComplete?: () => Promise<void>;
    readonly afterComplete?: (finalText: string, deliveredText: string | null) => Promise<void>;
    readonly handleTimeoutNotice: (lastText: string, phase: string) => Promise<void>;
    readonly cleanup: () => void;
    readonly clearMirrorAfterTimeout?: boolean;
    readonly renderOnlyOnComplete?: boolean;
}

function createTelegramMirrorMonitorCallbacks(options: TelegramMirrorMonitorCallbacksOptions) {
    const {
        mirror,
        mirrorForwarder,
        getPhase,
        resolveFinalText,
        handleEmptyComplete,
        afterComplete,
        handleTimeoutNotice,
        cleanup,
        clearMirrorAfterTimeout = false,
        renderOnlyOnComplete = false,
    } = options;

    return {
        onTextUpdate: mirrorForwarder.onTextUpdate,
        onRenderedTimeline: mirrorForwarder.onRenderedTimeline,
        onComplete: async (finalText: string) => {
            try {
                const deliveredText = await resolveFinalText(finalText);
                if (renderOnlyOnComplete) {
                    if (mirrorForwarder.hasRenderableContent()) {
                        await mirrorForwarder.finalizeRendered();
                    } else if (deliveredText && deliveredText.trim().length > 0) {
                        // Fallback: renderer produced no content, but we have raw text
                        logger.debug('[TelegramMirror] Rendered timeline empty — falling back to text delivery');
                        await mirrorForwarder.finalizeText(deliveredText);
                    } else if (handleEmptyComplete) {
                        await handleEmptyComplete();
                    }
                } else if (deliveredText && deliveredText.trim().length > 0) {
                    await mirrorForwarder.finalizeText(deliveredText);
                } else if (handleEmptyComplete) {
                    await handleEmptyComplete();
                }
                await afterComplete?.(finalText, deliveredText);
            } finally {
                mirror.dispose();
                cleanup();
            }
        },
        onTimeout: async (lastText: string) => {
            try {
                await mirrorForwarder.flushLastText(lastText);
                await handleTimeoutNotice(lastText, getPhase());
                if (clearMirrorAfterTimeout) {
                    await mirror.clear();
                }
            } finally {
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
    const mirrorForwarder = createTelegramMirrorForwarder(mirror, isCurrentChatSession, { renderedOnly: true });
    const trajectoryRenderer = new AntigravityTrajectoryRenderer(
        runtime.getConnectedCdp() || runtime.getCdpUnsafe(),
    );

    const initialMonitoringTarget = await runtime.getMonitoringTarget(info.cascadeId || null);
    let monitor: GrpcResponseMonitor | null = null;
    const cleanupPassiveState = () => clearPassiveMonitorState(projectName, activeMonitors);
    const monitorConfig = createTelegramMirrorMonitorCallbacks({
        mirror,
        mirrorForwarder,
        getPhase: () => monitor?.getPhase?.() || 'timeout',
        resolveFinalText: async (finalText: string) => {
            if (!isCurrentChatSession()) {
                return null;
            }
            return finalText;
        },
        handleEmptyComplete: async () => {
            if (isCurrentChatSession()) {
                await mirror.clear();
            }
        },
        afterComplete: async (_finalText: string, deliveredText: string | null) => {
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
        renderOnlyOnComplete: true,
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
