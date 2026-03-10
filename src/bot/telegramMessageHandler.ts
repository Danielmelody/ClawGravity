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

import { ModeService, MODE_UI_NAMES } from '../services/modeService';
import type { ModelService } from '../services/modelService';
import { applyDefaultModel } from '../services/defaultModelApplicator';
import { buildModeModelLines } from '../utils/streamMessageFormatter';
import { logger } from '../utils/logger';
import { downloadTelegramPhotos } from '../utils/telegramImageHandler';
import { cleanupInboundImageAttachments } from '../utils/imageHandler';
import type { InboundImageAttachment } from '../utils/imageHandler';
import type { ExtractionMode } from '../utils/config';
import type { ChatSessionService } from '../services/chatSessionService';
import type { ScheduleService } from '../services/scheduleService';
import type { ScheduleRecord } from '../database/scheduleRepository';
import type { ClawCommandInterceptor } from '../services/clawCommandInterceptor';
import type { TelegramSessionStateStore } from './telegramJoinCommand';
import type { TelegramMessageTracker } from '../services/telegramMessageTracker';
import type { WorkspaceRuntime } from '../services/workspaceRuntime';
import { markdownToTelegramHtmlViaUnified, rawHtmlToTelegramHtml } from '../platform/telegram/trajectoryRenderer';
import { AntigravityTrajectoryRenderer } from '../services/antigravityTrajectoryRenderer';
import { escapeHtml } from '../platform/telegram/telegramFormatter';

const TELEGRAM_STREAM_RENDER_COALESCE_MS = 8;

export interface TelegramMessageHandlerDeps {
    readonly bridge: CdpBridge;
    readonly telegramBindingRepo: TelegramBindingRepository;
    readonly workspaceService?: WorkspaceService;
    readonly modeService?: ModeService;
    readonly modelService?: ModelService;
    readonly extractionMode?: ExtractionMode;
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
                        handlePassiveUserMessage(message.channel, preparedRuntime, info, deps.activeMonitors, deps.extractionMode)
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
            let initialMonitoringTarget = null;
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
            let renderedTimelineHtml = '';
            let statusMessages: PlatformSentMessage[] = [];
            const statusRenderer = createCoalescedStatusRenderer(
                channel,
                () => statusMessages,
                (nextMessages) => {
                    statusMessages = nextMessages;
                },
            );

            const localMode = deps.modeService?.getCurrentMode() || 'fast';
            const currentModeName = MODE_UI_NAMES[localMode] || localMode;
            const currentModelByCdp = await runtime.getCurrentModel().catch(() => null);
            const currentModel = currentModelByCdp || deps.modelService?.getCurrentModel() || 'Auto (UI)';
            const headerLines = buildModeModelLines(currentModeName, currentModel, currentModel);

            let sessionLines: string[] = [];
            let isStatusTerminal = false;
            let currentStateIndicator = '⏳ Waiting for response...';
            const getStatusActivityText = () => renderedTimelineHtml;

            const refreshStatusMessage = (mode: 'streaming' | 'complete' | 'timeout' | 'error') => {
                if (isStatusTerminal && mode === 'streaming') return;
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                const nextText = buildTelegramStatusText({
                    activityLogText: getStatusActivityText(),
                    previewText: '',
                    elapsedSeconds: elapsed,
                    mode,
                    headerLines,
                    sessionLines,
                    stateIndicator: currentStateIndicator,
                });
                if (!nextText) {
                    return;
                }

                if (mode === 'complete' || mode === 'timeout' || mode === 'error') {
                    statusRenderer.request(nextText, true);
                    return;
                }

                statusRenderer.request(nextText);
            };

            // Prefetch session info once (or periodically)
            runtime.getActiveSessionInfo().then(async info => {
                if (info) {
                    const { buildSessionLines } = await import('../utils/streamMessageFormatter');
                    sessionLines = buildSessionLines(info.title, info.summary);
                    if (statusMessages.length > 0) {
                        refreshStatusMessage('streaming');
                    }
                }
            }).catch(() => { });

            // Send initial status message
            const initialStatusMsg = await channel.send({ text: 'Processing...' }).catch(() => null);
            if (initialStatusMsg) {
                statusMessages = [initialStatusMsg];
            }
            refreshStatusMessage('streaming');

            // eslint-disable-next-line no-async-promise-executor
            await new Promise<void>(async (resolve) => {
                const TIMEOUT_MS = 600_000;

                let settled = false;
                const settle = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(safetyTimer);
                    deps.activeMonitors?.delete(projectName);
                    resolve();
                };

                const monitoringTarget = initialMonitoringTarget
                    ?? await runtime.getMonitoringTarget(injectResult.cascadeId || currentCascadeId || null);
                if (!monitoringTarget) {
                    await channel.send({ text: '❌ gRPC client unavailable — cannot monitor response.' }).catch(logger.error);
                    settle();
                    return;
                }
                const { grpcClient, cascadeId } = monitoringTarget;
                const trajectoryRenderer = new AntigravityTrajectoryRenderer(cdp);

                const monitorConfig = {
                    onProgress: () => {
                        refreshStatusMessage('streaming');
                    },

                    onPhaseChange: (phase: string, text: string | null) => {
                        const len = text ? text.length : 0;
                        lastPhaseName = phase;

                        if (phase === 'thinking') {
                            currentStateIndicator = '🤔 Thinking...';
                        } else if (phase === 'generating') {
                            currentStateIndicator = `✍️ Generating (${len} chars)...`;
                        } else if (phase === 'complete') {
                            currentStateIndicator = '✅ Finished';
                        } else if (phase === 'error') {
                            currentStateIndicator = '❌ Error';
                            renderedTimelineHtml = '';
                        } else if (phase === 'quotaReached') {
                            currentStateIndicator = '⚠️ Quota Reached';
                            renderedTimelineHtml = '';
                        }
                        refreshStatusMessage('streaming');
                    },

                    onRenderedTimeline: (timeline: { content: string; format: 'text' | 'html' }) => {
                        if (timeline.format !== 'html') return;
                        if (!timeline.content || timeline.content.trim().length === 0) {
                            logger.debug('[TelegramHandler] onRenderedTimeline: empty content');
                            return;
                        }
                        renderedTimelineHtml = rawHtmlToTelegramHtml(timeline.content).trim();
                        if (!renderedTimelineHtml) {
                            logger.debug('[TelegramHandler] onRenderedTimeline: rawHtmlToTelegramHtml produced empty output');
                            return;
                        }
                        refreshStatusMessage('streaming');
                    },

                    onComplete: async (finalText: string) => {
                        isStatusTerminal = true;
                        try {

                            // Flash "Done" state on the card before replacing with final text
                            currentStateIndicator = `✅ Finished`;
                            refreshStatusMessage('complete');
                            await statusRenderer.flush();

                            const separated = splitOutputAndLogs(finalText || '');
                            const finalOutputText = separated.output || finalText || '';
                            if (finalOutputText && finalOutputText.trim().length > 0) {
                                logger.divider(`Output (${finalOutputText.length} chars)`);
                                console.info(finalOutputText);
                            }
                            logger.divider();

                            // Deliver the initial response to Telegram first
                            if (finalOutputText && finalOutputText.trim().length > 0) {
                                await deliverFinalTelegramText(null, channel, finalOutputText);
                            } else if (finalText && finalText.trim().length > 0) {
                                await deliverFinalTelegramText(null, channel, finalText);
                            } else {
                                await channel.send({ text: '(Empty response from Antigravity)' }).catch(logger.error);
                            }

                            // Clean up the streaming status card after delivering final text
                            if (statusMessages.length > 0) {
                                await deleteStreamingStatusMessages(statusMessages);
                                statusMessages = [];
                            }

                            // Intercept @claw commands and handle follow-up chain
                            if (deps.clawInterceptor && finalOutputText) {
                                const MAX_CLAW_DEPTH = 3;
                                let currentText = finalOutputText;
                                let clawDepth = 0;
                                let activeCascadeId = injectResult.cascadeId
                                    || deps.sessionStateStore?.getCurrentCascadeId(chatId)
                                    || cascadeId;

                                while (clawDepth < MAX_CLAW_DEPTH) {
                                    const clawResults = await deps.clawInterceptor.execute(currentText);
                                    if (clawResults.length === 0) break;

                                    for (const r of clawResults) {
                                        const icon = r.success ? '✅' : '❌';
                                        await channel.send({ text: `${icon} @claw:${r.command.action} — ${r.message}` }).catch(() => { });
                                    }

                                    // Inject results back into Antigravity for AI continuation
                                    const resultLines = clawResults.map(r =>
                                        `@claw:${r.command.action} — ${r.success ? 'OK' : 'FAIL'}\n${r.message}`
                                    );
                                    const feedback = `[ClawGravity Command Results]\n\n${resultLines.join('\n\n')}`;

                                    await new Promise(r => setTimeout(r, 2000));
                                    const followUpResult = await runtime.sendPromptWithMonitoringTarget({
                                        text: feedback,
                                        overrideCascadeId: activeCascadeId || undefined,
                                    });
                                    const ir = followUpResult.injectResult;
                                    if (!ir.ok) {
                                        logger.error(`[TelegramHandler] Failed to inject @claw results: ${ir.error}`);
                                        break;
                                    }
                                    if (ir.cascadeId) {
                                        deps.sessionStateStore?.setCurrentCascadeId(chatId, ir.cascadeId);
                                    }

                                    logger.done(`[TelegramHandler] @claw results injected — awaiting follow-up (depth=${clawDepth + 1})...`);

                                    const followUpTarget = followUpResult.monitoringTarget
                                        ?? await runtime.getMonitoringTarget(ir.cascadeId || activeCascadeId || null);
                                    if (!followUpTarget) {
                                        logger.warn('[TelegramHandler] @claw follow-up: gRPC unavailable');
                                        break;
                                    }
                                    activeCascadeId = followUpTarget.cascadeId;
                                    currentText = await new Promise<string>((resolve) => {
                                        const followUp = new GrpcResponseMonitor({
                                            grpcClient: followUpTarget.grpcClient,
                                            cascadeId: followUpTarget.cascadeId,
                                            maxDurationMs: 300_000,
                                            expectedUserMessage: feedback,
                                            onComplete: async (text: string) => resolve(text?.trim() || ''),
                                            onTimeout: async () => {
                                                logger.warn(`[TelegramHandler] @claw follow-up timed out (depth=${clawDepth + 1})`);
                                                resolve('');
                                            },
                                        });
                                        followUp.start();
                                    });

                                    clawDepth++;
                                    if (!currentText) break;

                                    // Deliver follow-up response to Telegram
                                    await sendTextChunked(channel, currentText);
                                }
                            }
                        } finally {
                            statusRenderer.dispose();
                            settle();
                        }
                    },
                    onTimeout: async (lastText: string) => {
                        isStatusTerminal = true;
                        try {
                            // Determine cause from monitor phase
                            const monitorPhase = monitor?.getPhase?.() || 'timeout';
                            const isError = monitorPhase === 'error';
                            const isQuota = monitorPhase === 'quotaReached';

                            // Update status message with correct mode
                            if (statusMessages.length > 0) {
                                refreshStatusMessage(isError || isQuota ? 'error' : 'timeout');
                                await statusRenderer.flush();
                            }

                            if (isQuota) {
                                await channel.send({ text: '⚠️ Model quota reached. Please try again later or switch models with /model.' }).catch(logger.error);
                            } else if (isError) {
                                if (lastText && lastText.trim().length > 0) {
                                    await sendTextChunked(channel, `❌ Error occurred. Partial response:\n${lastText}`);
                                } else {
                                    await channel.send({ text: '❌ An error occurred while generating the response.' }).catch(logger.error);
                                }
                            } else if (lastText && lastText.trim().length > 0) {
                                await sendTextChunked(channel, `(Timeout) ${lastText}`);
                            } else {
                                await channel.send({ text: 'Response timed out.' }).catch(logger.error);
                            }

                            // Clean up the streaming status card
                            if (statusMessages.length > 0) {
                                await deleteStreamingStatusMessages(statusMessages);
                                statusMessages = [];
                            }
                        } finally {
                            statusRenderer.dispose();
                            settle();
                        }
                    },
                };

                if (!cascadeId) {
                    await channel.send({ text: '❌ No cascade ID — cannot monitor response.' }).catch(logger.error);
                    settle();
                    return;
                }
                const monitor = new GrpcResponseMonitor({
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
                    settle();
                });

                // Periodically refresh status to update elapsed time (P0)
                const elapsedTimer = setInterval(() => {
                    if (settled) {
                        clearInterval(elapsedTimer);
                        return;
                    }
                    refreshStatusMessage('streaming');
                }, 1000);
            });
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

async function deliverFinalTelegramText(
    statusMsg: PlatformSentMessage | null,
    channel: PlatformChannel,
    text: string,
): Promise<void> {
    // Convert raw Markdown to Telegram-safe HTML via the unified pipeline
    const telegramHtml = markdownToTelegramHtmlViaUnified(text) || text;
    const chunks = splitTelegramText(telegramHtml);
    if (chunks.length === 0) {
        return;
    }

    if (statusMsg) {
        let editOk = false;
        try {
            await statusMsg.edit({ text: chunks[0] });
            editOk = true;
        } catch (editErr: any) {
            logger.warn(`[TelegramDeliver] statusMsg.edit failed: ${editErr?.message || editErr}`);
            // Edit failed (e.g. HTML parse error) — delete the stale streaming card
            // and fall through to send all chunks as new messages.
            await statusMsg.delete().catch(() => { });
        }

        if (editOk) {
            for (const chunk of chunks.slice(1)) {
                await channel.send({ text: chunk }).catch(logger.error);
            }
            return;
        }
    }

    for (const chunk of chunks) {
        await channel.send({ text: chunk }).catch(logger.error);
    }
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

function buildTelegramStatusText(options: {
    activityLogText: string;
    previewText?: string;
    elapsedSeconds: number;
    mode: 'streaming' | 'complete' | 'timeout' | 'error';
    headerLines?: string[];
    sessionLines?: string[];
    stateIndicator?: string;
}): string {
    const stateBarStr = options.stateIndicator || '';
    const stateBar = stateBarStr ? `<b>${escapeHtml(stateBarStr)}</b>` : '';

    const footerRaw = options.mode === 'complete'
        ? `✅ Done in ${options.elapsedSeconds}s`
        : options.mode === 'timeout'
            ? `⏱️ Timed out after ${options.elapsedSeconds}s`
            : options.mode === 'error'
                ? `❌ Error after ${options.elapsedSeconds}s`
                : `⏱️ ${options.elapsedSeconds}s`;
    const footer = `<i>${escapeHtml(footerRaw)}</i>`;

    const header = options.headerLines && options.headerLines.length > 0
        ? options.headerLines.map((line) => escapeHtml(line)).join('\n')
        : '';

    const sessionText = options.sessionLines && options.sessionLines.length > 0
        ? options.sessionLines.map((line) => escapeHtml(line)).join('\n')
        : '';

    const activityLogStr = options.activityLogText.trim();
    const sections: string[] = [];
    if (stateBar) sections.push(stateBar);
    if (header) sections.push(header);
    if (sessionText) sections.push(sessionText);
    if (activityLogStr) sections.push(activityLogStr);
    sections.push(footer);

    return sections.join('\n\n');
}

function createCoalescedStatusRenderer(
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
                const nextMessages = await syncStreamingStatusMessages(channel, getMessages(), nextText);
                setMessages(nextMessages);
                lastAppliedText = nextText;
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
            await flushPending();
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
): Promise<PlatformSentMessage[]> {
    const chunks = splitTelegramText(text);
    if (chunks.length === 0) {
        return existingMessages;
    }

    const nextMessages = existingMessages.slice();
    for (let i = 0; i < chunks.length; i++) {
        if (nextMessages[i]) {
            await nextMessages[i].edit({ text: chunks[i] });
            continue;
        }

        nextMessages[i] = await channel.send({ text: chunks[i] });
    }

    for (let i = chunks.length; i < nextMessages.length; i++) {
        await nextMessages[i].delete().catch(() => { });
    }

    return nextMessages.slice(0, chunks.length);
}

async function deleteStreamingStatusMessages(messages: PlatformSentMessage[]): Promise<void> {
    await Promise.all(messages.map((message) => message.delete().catch(() => { })));
}

// ---------------------------------------------------------------------------
// Passive PC → Telegram notification
// ---------------------------------------------------------------------------

/** Per-workspace passive response monitors to avoid duplicates. */
const passiveResponseMonitors = new Map<string, GrpcResponseMonitor>();

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
    extractionMode?: ExtractionMode,
    clawInterceptor?: ClawCommandInterceptor,
): Promise<void> {
    const projectName = runtime.getProjectName();
    // Forward the user message
    const preview = info.text.length > 200 ? info.text.slice(0, 200) + '…' : info.text;
    await channel.send({ text: `🖥️ ${preview}` }).catch(logger.error);

    // Start passive backend response monitor to capture the AI response
    startPassiveResponseMonitor(channel, runtime, projectName, info, activeMonitors, extractionMode, clawInterceptor);
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
    extractionMode?: ExtractionMode,
    clawInterceptor?: ClawCommandInterceptor,
): Promise<void> {
    // Stop previous passive monitor if still running
    const prev = passiveResponseMonitors.get(projectName);
    if (prev?.isActive()) {
        prev.stop().catch(() => { });
    }

    const startTime = Date.now();
    let renderedTimelineHtml = '';
    let statusMessages: PlatformSentMessage[] = [];
    const statusRenderer = createCoalescedStatusRenderer(
        channel,
        () => statusMessages,
        (nextMessages) => {
            statusMessages = nextMessages;
        },
    );

    let sessionLines: string[] = [];
    let isStatusTerminal = false;
    let currentStateIndicator = '⏳ Waiting for response...';
    const getStatusActivityText = () => renderedTimelineHtml;

    const refreshStatusMessage = (mode: 'streaming' | 'complete' | 'timeout' | 'error') => {
        if (isStatusTerminal && mode === 'streaming') return;
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        const nextText = buildTelegramStatusText({
            activityLogText: getStatusActivityText(),
            previewText: '',
            elapsedSeconds: elapsed,
            mode,
            sessionLines,
            stateIndicator: currentStateIndicator,
        });
        if (!nextText) return;

        if (mode === 'complete' || mode === 'timeout' || mode === 'error') {
            statusRenderer.request(nextText, true);
            return;
        }

        statusRenderer.request(nextText);
    };

    // Prefetch session info
    runtime.getActiveSessionInfo().then(async sessionInfo => {
        if (sessionInfo) {
            const { buildSessionLines } = await import('../utils/streamMessageFormatter');
            sessionLines = buildSessionLines(sessionInfo.title, sessionInfo.summary);
            if (statusMessages.length > 0) {
                refreshStatusMessage('streaming');
            }
        }
    }).catch(() => { });

    const ensureStatusMsg = async () => {
        if (statusMessages.length === 0) {
            const sent = await channel.send({ text: '🖥️ Processing...' }).catch(() => null);
            if (sent) {
                statusMessages = [sent];
            }
        }
    };

    const initialMonitoringTarget = await runtime.getMonitoringTarget(info.cascadeId || null);
    const trajectoryRenderer = new AntigravityTrajectoryRenderer(
        runtime.getConnectedCdp() ?? runtime.getCdpUnsafe(),
    );

    const monitorConfig = {
        onProgress: () => {
            ensureStatusMsg().then(() => refreshStatusMessage('streaming')).catch(() => { });
        },

        onRenderedTimeline: (timeline: { content: string; format: 'text' | 'html' }) => {
            if (timeline.format !== 'html') return;
            if (!timeline.content || timeline.content.trim().length === 0) return;
            renderedTimelineHtml = rawHtmlToTelegramHtml(timeline.content).trim();
            if (!renderedTimelineHtml) return;
            ensureStatusMsg().then(() => refreshStatusMessage('streaming')).catch(() => { });
        },

        onComplete: async (finalText: string) => {
            isStatusTerminal = true;
            passiveResponseMonitors.delete(projectName);
            activeMonitors?.delete(`passive:${projectName}`);
            try {
                if (!finalText || finalText.trim().length === 0) {
                    // Clean up status message if no output
                    if (statusMessages.length > 0) {
                        await deleteStreamingStatusMessages(statusMessages);
                        statusMessages = [];
                    }
                    return;
                }

                // Flash "Done" state on the card before resolving text
                currentStateIndicator = `✅ Finished`;
                await ensureStatusMsg().catch(() => { });
                refreshStatusMessage('complete');
                await statusRenderer.flush();

                // Deliver final text
                if (statusMessages.length > 0) {
                    await deliverFinalTelegramText(null, channel, finalText);
                } else {
                    await sendTextChunked(channel, finalText);
                }

                // Clean up the streaming status card after delivering final text
                if (statusMessages.length > 0) {
                    await deleteStreamingStatusMessages(statusMessages);
                    statusMessages = [];
                }

                // Handle @claw commands if interceptor is available
                if (!clawInterceptor) return;

                let currentText = finalText;
                let clawDepth = 0;
                const MAX_CLAW_DEPTH = 3;
                let activeCascadeId = initialMonitoringTarget?.cascadeId || info.cascadeId || null;

                while (clawDepth < MAX_CLAW_DEPTH) {
                    const clawResults = await clawInterceptor.execute(currentText);
                    if (clawResults.length === 0) break;

                    clawDepth++;
                    logger.info(`[TelegramPassive] Found @claw command(s) in AI response. Executing (Depth ${clawDepth})...`);

                    const resultLines = clawResults.map(r =>
                        `@claw:${r.command.action} — ${r.success ? 'OK' : 'FAIL'}\n${r.message}`
                    );
                    const feedback = `[ClawGravity Command Results]\n\n${resultLines.join('\n\n')}`;

                    for (const r of clawResults) {
                        const icon = r.success ? '✅' : '❌';
                        await channel.send({ text: `${icon} @claw:${r.command.action} — ${r.message}` }).catch(() => { });
                    }

                    const followUpResult = await runtime.sendPromptWithMonitoringTarget({
                        text: feedback,
                        overrideCascadeId: activeCascadeId || undefined,
                    });
                    const ir = followUpResult.injectResult;
                    if (!ir.ok) {
                        logger.warn(`[TelegramPassive] Failed to inject @claw results: ${ir.error}`);
                        break;
                    }
                    logger.debug(`[TelegramPassive] Injected @claw results back to Antigravity (length: ${feedback.length})`);

                    const followUpTarget = followUpResult.monitoringTarget
                        ?? await runtime.getMonitoringTarget(ir.cascadeId || activeCascadeId || null);
                    if (!followUpTarget) {
                        logger.warn('[TelegramPassive] @claw follow-up: gRPC unavailable');
                        break;
                    }
                    activeCascadeId = followUpTarget.cascadeId;

                    const followUpPromise = new Promise<string>((resolve) => {
                        const followUpMonitor = new GrpcResponseMonitor({
                            grpcClient: followUpTarget.grpcClient,
                            cascadeId: followUpTarget.cascadeId,
                            expectedUserMessage: feedback,
                            onComplete: (followUpText: string) => resolve(followUpText),
                            onTimeout: (lastText: string) => resolve(lastText || ''),
                        });

                        passiveResponseMonitors.set(projectName, followUpMonitor);
                        activeMonitors?.set(`passive:${projectName}`, followUpMonitor);

                        followUpMonitor.start().catch((err: any) => {
                            logger.error('[TelegramPassive] Failed to start follow-up monitor:', err?.message || err);
                            resolve('');
                        });
                    });

                    const nextText = await followUpPromise;
                    passiveResponseMonitors.delete(projectName);
                    activeMonitors?.delete(`passive:${projectName}`);

                    if (!nextText || nextText.trim().length === 0) break;

                    await sendTextChunked(channel, nextText);
                    currentText = nextText;

                    if (clawDepth >= MAX_CLAW_DEPTH) {
                        logger.warn(`[TelegramPassive] Reached MAX_CLAW_DEPTH (${MAX_CLAW_DEPTH}). Stopping @claw command execution.`);
                        await sendTextChunked(channel, `⚠️ Reached max @claw execution depth (${MAX_CLAW_DEPTH}). Stopping auto-execution.`);
                        break;
                    }
                }
            } finally {
                statusRenderer.dispose();
            }
        },
        onPhaseChange: (phase: string,) => {
            if (phase === 'thinking') {
                currentStateIndicator = '🤔 Thinking...';
            } else if (phase === 'generating') {
                currentStateIndicator = '✍️ Generating...';
            } else if (phase === 'complete') {
                currentStateIndicator = '✅ Finished';
            } else if (phase === 'error') {
                currentStateIndicator = '❌ Error';
                renderedTimelineHtml = '';
            } else if (phase === 'quotaReached') {
                currentStateIndicator = '⚠️ Quota Reached';
                renderedTimelineHtml = '';
            }
            ensureStatusMsg().then(() => refreshStatusMessage('streaming')).catch(() => { });
        },

        onTimeout: async (lastText: string) => {
            isStatusTerminal = true;
            passiveResponseMonitors.delete(projectName);
            activeMonitors?.delete(`passive:${projectName}`);

            // Determine cause from monitor phase
            const monitorPhase = monitor?.getPhase?.() || 'timeout';
            const isError = monitorPhase === 'error';
            const isQuota = monitorPhase === 'quotaReached';

            if (statusMessages.length > 0) {
                refreshStatusMessage(isError ? 'error' : 'timeout');
                await statusRenderer.flush();
            }

            if (isQuota) {
                await channel.send({ text: '⚠️ Model quota reached. Please try again later or switch models with /model.' }).catch(() => { });
            } else if (isError) {
                if (lastText && lastText.trim().length > 0) {
                    await sendTextChunked(channel, `❌ Error occurred. Partial response:\n${lastText}`);
                } else {
                    await channel.send({ text: '❌ An error occurred while generating the response.' }).catch(() => { });
                }
            }

            // Clean up the streaming status card
            if (statusMessages.length > 0) {
                await deleteStreamingStatusMessages(statusMessages);
                statusMessages = [];
            }
            statusRenderer.dispose();
        },
    };

    if (!initialMonitoringTarget) {
        logger.warn('[TelegramPassive] gRPC client or cascadeId unavailable — cannot start passive monitor');
        statusRenderer.dispose();
        return;
    }
    const monitor = new GrpcResponseMonitor({
        grpcClient: initialMonitoringTarget.grpcClient,
        cascadeId: initialMonitoringTarget.cascadeId,
        maxDurationMs: 600_000,
        expectedUserMessage: info.text,
        trajectoryRenderer,
        ...monitorConfig
    });

    passiveResponseMonitors.set(projectName, monitor);
    activeMonitors?.set(`passive:${projectName}`, monitor);
    monitor.startPassive().catch((err: any) => {
        logger.error('[TelegramPassive] Failed to start response monitor:', err?.message || err);
        passiveResponseMonitors.delete(projectName);
        activeMonitors?.delete(`passive:${projectName}`);
        statusRenderer.dispose();
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
