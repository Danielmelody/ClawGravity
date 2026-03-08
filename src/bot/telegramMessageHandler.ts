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
import { CdpBridge, registerApprovalWorkspaceChannel, ensureApprovalDetector, ensureErrorPopupDetector, ensurePlanningDetector, ensureRunCommandDetector, ensureUserMessageDetector } from '../services/cdpBridgeManager';
import type { UserMessageInfo } from '../services/userMessageDetector';
import { CdpService } from '../services/cdpService';
import { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import { ProcessLogBuffer } from '../utils/processLogBuffer';
import { splitOutputAndLogs } from '../utils/discordFormatter';
import { parseTelegramProjectCommand, handleTelegramProjectCommand } from './telegramProjectCommand';
import { parseTelegramCommand, handleTelegramCommand } from './telegramCommands';
import { escapeHtml } from '../platform/telegram/telegramFormatter';
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
        if (cmd) {
            await handleTelegramCommand(
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
                },
                message,
                cmd,
            );
            return;
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

        await enqueueForWorkspace(workspacePath, async () => {
            const cdpStartTime = Date.now();
            logger.debug(`[TelegramHandler] getOrConnect start (elapsed=${cdpStartTime - handlerEntryTime}ms)`);
            let cdp: CdpService;
            try {
                cdp = await deps.bridge.pool.getOrConnect(workspacePath);
            } catch (e: any) {
                await message.reply({
                    text: `Failed to connect to workspace: ${e.message}`,
                }).catch(logger.error);
                return;
            }
            logger.debug(`[TelegramHandler] getOrConnect done (took=${Date.now() - cdpStartTime}ms)`);

            const projectName = deps.bridge.pool.extractProjectName(workspacePath);
            deps.bridge.lastActiveWorkspace = projectName;
            deps.bridge.lastActiveChannel = message.channel;
            registerApprovalWorkspaceChannel(deps.bridge, projectName, message.channel);

            const selectedSession = deps.sessionStateStore?.getSelectedSession(chatId);
            if (selectedSession?.id) {
                cdp.setCachedCascadeId(selectedSession.id);
            }

            // Always push ModeService's mode to Antigravity on CDP connect.
            // ModeService is the source of truth (what the user sees in /mode UI).
            // Without this, Antigravity could be in a different mode (e.g. Planning)
            // while the user believes they're in Fast mode.
            if (deps.modeService) {
                const currentMode = deps.modeService.getCurrentMode();
                const syncRes = await cdp.setUiMode(currentMode);
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

            // Start detectors (platform-agnostic now)
            ensureApprovalDetector(deps.bridge, cdp, projectName);
            ensureErrorPopupDetector(deps.bridge, cdp, projectName);
            ensurePlanningDetector(deps.bridge, cdp, projectName);
            ensureRunCommandDetector(deps.bridge, cdp, projectName);

            // Start passive mirroring: forward PC-typed messages + AI responses to Telegram
            ensureUserMessageDetector(deps.bridge, cdp, projectName, (info: UserMessageInfo) => {
                handlePassiveUserMessage(message.channel, cdp, projectName, info, deps.activeMonitors, deps.extractionMode)
                    .catch((err: any) => logger.error('[TelegramPassive] Error handling PC message:', err));
            });

            // Acknowledge receipt
            await message.react('\u{1F440}').catch(() => { });

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

            // Determine the prompt text — use default for image-only messages
            const effectivePrompt = promptText || 'Please review the attached images and respond accordingly.';

            // Register echo hash so UserMessageDetector skips this message
            // (prevents Telegram-sent messages from being echoed back as "PC" messages)
            const userMsgDetector = deps.bridge.pool.getUserMessageDetector?.(projectName);
            if (userMsgDetector) {
                userMsgDetector.addEchoHash(effectivePrompt);
            }

            // Inject prompt (with or without images) into Antigravity
            logger.prompt(effectivePrompt);
            let injectResult;
            try {
                if (inboundImages.length > 0) {
                    injectResult = await cdp.injectMessageWithImageFiles(
                        effectivePrompt,
                        inboundImages.map((img) => img.localPath),
                    );
                } else {
                    injectResult = await cdp.injectMessage(effectivePrompt);
                }
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

            // Monitor the response
            const channel = message.channel;
            const startTime = Date.now();
            const processLogBuffer = new ProcessLogBuffer({ maxChars: 3500, maxEntries: 120, maxEntryLength: 220 });
            let lastActivityLogText = '';
            let latestPreviewText = '';
            let statusMsg: PlatformSentMessage | null = null;
            let lastStatusRender = '';

            const localMode = deps.modeService?.getCurrentMode() || 'fast';
            const currentModeName = MODE_UI_NAMES[localMode] || localMode;
            const currentModelByCdp = await cdp.getCurrentModel().catch(() => null);
            const currentModel = currentModelByCdp || deps.modelService?.getCurrentModel() || 'Auto (UI)';
            const headerLines = buildModeModelLines(currentModeName, currentModel, currentModel);

            let sessionLines: string[] = [];
            const refreshStatusMessage = (mode: 'streaming' | 'complete' | 'timeout') => {
                if (!statusMsg) return;
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                const nextText = buildTelegramStatusText({
                    activityLogText: lastActivityLogText,
                    previewText: mode === 'streaming' ? latestPreviewText : '',
                    elapsedSeconds: elapsed,
                    mode,
                    headerLines,
                    sessionLines,
                });
                if (!nextText || nextText === lastStatusRender) {
                    return;
                }
                lastStatusRender = nextText;
                statusMsg.edit({ text: nextText }).catch(() => { });
            };

            // Prefetch session info once (or periodically)
            cdp.getActiveSessionInfo().then(async info => {
                if (info) {
                    const { buildSessionLines } = await import('../utils/streamMessageFormatter');
                    sessionLines = buildSessionLines(info.title, info.summary);
                    refreshStatusMessage('streaming');
                }
            }).catch(() => { });

            // Send initial status message
            statusMsg = await channel.send({ text: 'Processing...' }).catch(() => null);
            refreshStatusMessage('streaming');

            await new Promise<void>(async (resolve) => {
                const TIMEOUT_MS = 600_000;
                const SAFETY_IDLE_MS = 120_000; // Reset safety timer on each activity

                let settled = false;
                const settle = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(safetyTimer);
                    deps.activeMonitors?.delete(projectName);
                    resolve();
                };

                const grpcClient = await cdp.getGrpcClient();
                if (!grpcClient) {
                    await channel.send({ text: '❌ gRPC client unavailable — cannot monitor response.' }).catch(logger.error);
                    settle();
                    return;
                }
                const cascadeId = injectResult.cascadeId || await cdp.getActiveCascadeId();

                const monitorConfig = {
                    onProcessLog: (logText: string) => {
                        if (logText && logText.trim().length > 0) {
                            lastActivityLogText = processLogBuffer.append(logText);
                        }
                        refreshStatusMessage('streaming');
                        renewSafetyTimer();
                    },

                    onProgress: (progressText: string) => {
                        latestPreviewText = progressText || '';
                        refreshStatusMessage('streaming');
                        renewSafetyTimer();
                    },

                    onPhaseChange: (phase: string, text: string | null) => {
                        if (phase === 'thinking') {
                            lastActivityLogText = '🤔 Thinking / Planning...';
                        }
                        refreshStatusMessage('streaming');
                        renewSafetyTimer();
                    },

                    onComplete: async (finalText: string) => {
                        try {
                            const elapsed = Math.round((Date.now() - startTime) / 1000);

                            // Console log output (mirroring Discord handler pattern)
                            const finalLogText = lastActivityLogText || processLogBuffer.snapshot();
                            if (finalLogText && finalLogText.trim().length > 0) {
                                logger.divider('Process Log');
                                console.info(finalLogText);
                            }

                            const separated = splitOutputAndLogs(finalText || '');
                            const finalOutputText = separated.output || finalText || '';
                            if (finalOutputText && finalOutputText.trim().length > 0) {
                                logger.divider(`Output (${finalOutputText.length} chars)`);
                                console.info(finalOutputText);
                            }
                            logger.divider();

                            // Deliver the initial response to Telegram first
                            if (finalOutputText && finalOutputText.trim().length > 0) {
                                await deliverFinalTelegramText(statusMsg, channel, finalOutputText);
                            } else if (finalText && finalText.trim().length > 0) {
                                await deliverFinalTelegramText(statusMsg, channel, finalText);
                            } else {
                                if (statusMsg) {
                                    await statusMsg.delete().catch(() => { });
                                }
                                await channel.send({ text: '(Empty response from Antigravity)' }).catch(logger.error);
                            }

                            // Intercept @claw commands and handle follow-up chain
                            if (deps.clawInterceptor && finalOutputText) {
                                const MAX_CLAW_DEPTH = 3;
                                let currentText = finalOutputText;
                                let clawDepth = 0;

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
                                    const ir = await cdp.injectMessage(feedback);
                                    if (!ir.ok) {
                                        logger.error(`[TelegramHandler] Failed to inject @claw results: ${ir.error}`);
                                        break;
                                    }

                                    logger.done(`[TelegramHandler] @claw results injected — awaiting follow-up (depth=${clawDepth + 1})...`);

                                    const fuClient = await cdp.getGrpcClient();
                                    const fuCascadeId = ir.cascadeId || (fuClient ? await cdp.getActiveCascadeId() : null);
                                    if (!fuClient || !fuCascadeId) {
                                        logger.warn('[TelegramHandler] @claw follow-up: gRPC unavailable');
                                        break;
                                    }
                                    currentText = await new Promise<string>((resolve) => {
                                        const followUp = new GrpcResponseMonitor({
                                            grpcClient: fuClient,
                                            cascadeId: fuCascadeId,
                                            maxDurationMs: 300_000,
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
                            settle();
                        }
                    },
                    onTimeout: async (lastText: string) => {
                        try {
                            // Update status message on timeout
                            if (statusMsg) {
                                latestPreviewText = '';
                                refreshStatusMessage('timeout');
                            }

                            if (lastText && lastText.trim().length > 0) {
                                await sendTextChunked(channel, `(Timeout) ${lastText}`);
                            } else {
                                await channel.send({ text: 'Response timed out.' }).catch(logger.error);
                            }
                        } finally {
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
                    ...monitorConfig
                });

                let safetyTimer = setTimeout(() => {
                    logger.warn(`[TelegramHandler:${projectName}] Safety timeout — releasing queue after idle period`);
                    monitor.stop().catch(() => { });
                    settle();
                }, TIMEOUT_MS);

                // Renew safety timer on activity — prevents premature timeout during long tool-calling sessions
                const renewSafetyTimer = () => {
                    clearTimeout(safetyTimer);
                    safetyTimer = setTimeout(() => {
                        logger.warn(`[TelegramHandler:${projectName}] Safety timeout — no activity for ${SAFETY_IDLE_MS / 1000}s`);
                        monitor.stop().catch(() => { });
                        settle();
                    }, SAFETY_IDLE_MS);
                };

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
                }, 3000);
            });
        });
    };
}

/** Split long text into Telegram-safe chunks (max 4096 chars). */
async function sendTextChunked(
    channel: PlatformChannel,
    text: string,
): Promise<void> {
    const MAX_LENGTH = 4096;
    let remaining = text;
    while (remaining.length > 0) {
        const chunk = remaining.slice(0, MAX_LENGTH);
        remaining = remaining.slice(MAX_LENGTH);
        await channel.send({ text: chunk }).catch(logger.error);
    }
}

async function deliverFinalTelegramText(
    statusMsg: PlatformSentMessage | null,
    channel: PlatformChannel,
    text: string,
): Promise<void> {
    const chunks = splitTelegramText(text);
    if (chunks.length === 0) {
        return;
    }

    if (statusMsg) {
        await statusMsg.edit({ text: chunks[0] }).catch(() => { });
        for (const chunk of chunks.slice(1)) {
            await channel.send({ text: chunk }).catch(logger.error);
        }
        return;
    }

    for (const chunk of chunks) {
        await channel.send({ text: chunk }).catch(logger.error);
    }
}

function splitTelegramText(text: string): string[] {
    const MAX_LENGTH = 4096;
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
        chunks.push(remaining.slice(0, MAX_LENGTH));
        remaining = remaining.slice(MAX_LENGTH);
    }
    return chunks;
}

function buildTelegramStatusText(options: {
    activityLogText: string;
    previewText: string;
    elapsedSeconds: number;
    mode: 'streaming' | 'complete' | 'timeout';
    headerLines?: string[];
    sessionLines?: string[];
}): string {
    const MAX_LENGTH = 4096;
    const footer = options.mode === 'complete'
        ? `Status: Done in ${options.elapsedSeconds}s`
        : options.mode === 'timeout'
            ? `Status: Timed out after ${options.elapsedSeconds}s`
            : `Elapsed: ${options.elapsedSeconds}s`;

    const header = options.headerLines && options.headerLines.length > 0
        ? options.headerLines.join('\n')
        : '';

    // Calculate space for preview and activity log
    const reservedChars = header.length + footer.length + 100; // conservative overhead
    let maxBodyChars = MAX_LENGTH - reservedChars;
    if (maxBodyChars < 100) maxBodyChars = 100;

    let preview = (options.previewText && options.mode === 'streaming')
        ? options.previewText.trim()
        : '';

    if (preview.length > maxBodyChars / 2) {
        const previewTail = maxBodyChars / 2;
        preview = '... (earlier output truncated)\n' + preview.slice(-previewTail);
    }
    const previewSection = preview ? `[streaming preview]\n${preview}` : '';

    let activityLog = options.activityLogText.trim();
    const remainingForLog = maxBodyChars - previewSection.length;
    if (activityLog.length > remainingForLog) {
        const prefix = '... (earlier log entries truncated)\n';
        const tailLength = Math.max(0, remainingForLog - prefix.length);
        activityLog = prefix + activityLog.slice(-tailLength);
    }
    const activitySection = activityLog ? `[activity]\n${activityLog}` : '';

    const sections: string[] = [];
    if (header) sections.push(header);
    if (options.sessionLines && options.sessionLines.length > 0) {
        sections.push(options.sessionLines.join('\n'));
    }
    if (activitySection) sections.push(activitySection);
    if (previewSection) sections.push(previewSection);
    sections.push(footer);

    const body = sections.join('\n\n');
    return `\`\`\`\n${body}\n\`\`\``;
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
    cdp: CdpService,
    projectName: string,
    info: UserMessageInfo,
    activeMonitors?: Map<string, GrpcResponseMonitor>,
    extractionMode?: ExtractionMode,
    clawInterceptor?: ClawCommandInterceptor,
): Promise<void> {
    // Forward the user message
    const preview = info.text.length > 200 ? info.text.slice(0, 200) + '…' : info.text;
    await channel.send({ text: `🖥️ ${preview}` }).catch(logger.error);

    // Start passive backend response monitor to capture the AI response
    startPassiveResponseMonitor(channel, cdp, projectName, info, activeMonitors, extractionMode, clawInterceptor);
}

/**
 * Start a passive backend response monitor that sends the AI response to Telegram
 * when generation completes. If a monitor is already running for this
 * workspace, it is stopped and replaced.
 */
async function startPassiveResponseMonitor(
    channel: PlatformChannel,
    cdp: CdpService,
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
    const processLogBuffer = new ProcessLogBuffer({ maxChars: 3500, maxEntries: 120, maxEntryLength: 220 });
    let lastActivityLogText = '';
    let latestPreviewText = '';
    let statusMsg: PlatformSentMessage | null = null;
    let lastStatusRender = '';
    let statusMsgSent = false;

    let sessionLines: string[] = [];
    const refreshStatusMessage = (mode: 'streaming' | 'complete' | 'timeout') => {
        if (!statusMsg) return;
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        const nextText = buildTelegramStatusText({
            activityLogText: lastActivityLogText,
            previewText: mode === 'streaming' ? latestPreviewText : '',
            elapsedSeconds: elapsed,
            mode,
            sessionLines,
        });
        if (!nextText || nextText === lastStatusRender) return;
        lastStatusRender = nextText;
        statusMsg.edit({ text: nextText }).catch(() => { });
    };

    // Prefetch session info
    cdp.getActiveSessionInfo().then(async sessionInfo => {
        if (sessionInfo) {
            const { buildSessionLines } = await import('../utils/streamMessageFormatter');
            sessionLines = buildSessionLines(sessionInfo.title, sessionInfo.summary);
            refreshStatusMessage('streaming');
        }
    }).catch(() => { });

    const ensureStatusMsg = async () => {
        if (!statusMsgSent) {
            statusMsgSent = true;
            statusMsg = await channel.send({ text: '🖥️ Processing...' }).catch(() => null);
        }
    };

    const grpcClient = await cdp.getGrpcClient();
    const cascadeId = info.cascadeId || (grpcClient ? await cdp.getActiveCascadeId() : null);

    const monitorConfig = {
        onProcessLog: (logText: string) => {
            if (logText && logText.trim().length > 0) {
                lastActivityLogText = processLogBuffer.append(logText);
            }
            ensureStatusMsg().then(() => refreshStatusMessage('streaming')).catch(() => { });
        },

        onProgress: (progressText: string) => {
            latestPreviewText = progressText || '';
            ensureStatusMsg().then(() => refreshStatusMessage('streaming')).catch(() => { });
        },

        onComplete: async (finalText: string) => {
            passiveResponseMonitors.delete(projectName);
            activeMonitors?.delete(`passive:${projectName}`);
            if (!finalText || finalText.trim().length === 0) {
                // Clean up status message if no output
                if (statusMsg) statusMsg.delete().catch(() => { });
                return;
            }

            // Deliver final text — merge into status message or send new
            if (statusMsg) {
                await deliverFinalTelegramText(statusMsg, channel, finalText);
                statusMsg = null;
            } else {
                await sendTextChunked(channel, finalText);
            }

            // Handle @claw commands if interceptor is available
            if (!clawInterceptor) return;

            let currentText = finalText;
            let clawDepth = 0;
            const MAX_CLAW_DEPTH = 3;

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

                const ir = await cdp.injectMessage(feedback);
                logger.debug(`[TelegramPassive] Injected @claw results back to Antigravity (length: ${feedback.length})`);

                const fuClient = await cdp.getGrpcClient();
                const fuCascadeId = ir.cascadeId || (fuClient ? await cdp.getActiveCascadeId() : null);
                if (!fuClient || !fuCascadeId) {
                    logger.warn('[TelegramPassive] @claw follow-up: gRPC unavailable');
                    break;
                }

                const followUpPromise = new Promise<string>((resolve) => {
                    const followUpMonitor = new GrpcResponseMonitor({
                        grpcClient: fuClient,
                        cascadeId: fuCascadeId,
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
        },
        onTimeout: (lastText: string) => {
            passiveResponseMonitors.delete(projectName);
            activeMonitors?.delete(`passive:${projectName}`);
            if (statusMsg) {
                refreshStatusMessage('timeout');
            }
        },
    };

    if (!grpcClient || !cascadeId) {
        logger.warn('[TelegramPassive] gRPC client or cascadeId unavailable — cannot start passive monitor');
        return;
    }
    const monitor = new GrpcResponseMonitor({
        grpcClient,
        cascadeId,
        maxDurationMs: 600_000,
        ...monitorConfig
    });

    passiveResponseMonitors.set(projectName, monitor);
    activeMonitors?.set(`passive:${projectName}`, monitor);
    monitor.startPassive().catch((err: any) => {
        logger.error('[TelegramPassive] Failed to start response monitor:', err?.message || err);
        passiveResponseMonitors.delete(projectName);
        activeMonitors?.delete(`passive:${projectName}`);
    });
}
