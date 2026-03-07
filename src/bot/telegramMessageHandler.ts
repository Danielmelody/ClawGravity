/**
 * Minimal Telegram message handler.
 *
 * Handles incoming PlatformMessage from Telegram:
 *   1. Resolves workspace from TelegramBindingRepository
 *   2. Connects to CDP
 *   3. Injects the prompt into Antigravity
 *   4. Monitors the response via ResponseMonitor
 *   5. Relays the response text back via PlatformChannel.send()
 */

import type { PlatformMessage, PlatformChannel, PlatformSentMessage } from '../platform/types';
import type { TelegramBindingRepository } from '../database/telegramBindingRepository';
import type { WorkspaceService } from '../services/workspaceService';
import { CdpBridge, registerApprovalWorkspaceChannel, ensureApprovalDetector, ensureErrorPopupDetector, ensurePlanningDetector, ensureRunCommandDetector, ensureUserMessageDetector } from '../services/cdpBridgeManager';
import type { UserMessageInfo } from '../services/userMessageDetector';
import { CdpService } from '../services/cdpService';
import { ResponseMonitor } from '../services/responseMonitor';
import { ProcessLogBuffer } from '../utils/processLogBuffer';
import { splitOutputAndLogs } from '../utils/discordFormatter';
import { parseTelegramProjectCommand, handleTelegramProjectCommand } from './telegramProjectCommand';
import { parseTelegramCommand, handleTelegramCommand } from './telegramCommands';
import { escapeHtml } from '../platform/telegram/telegramFormatter';
import type { ModeService } from '../services/modeService';
import type { ModelService } from '../services/modelService';
import { applyDefaultModel } from '../services/defaultModelApplicator';
import { logger } from '../utils/logger';
import { downloadTelegramPhotos } from '../utils/telegramImageHandler';
import { cleanupInboundImageAttachments } from '../utils/imageHandler';
import type { InboundImageAttachment } from '../utils/imageHandler';
import type { ExtractionMode } from '../utils/config';
import type { ChatSessionService } from '../services/chatSessionService';
import type { ScheduleService } from '../services/scheduleService';
import type { ScheduleRecord } from '../database/scheduleRepository';
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
    /** Shared map of active ResponseMonitors keyed by project name.
     *  Used by /stop to halt monitoring and prevent stale re-sends. */
    readonly activeMonitors?: Map<string, ResponseMonitor>;
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
                    activeMonitors: deps.activeMonitors,
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
            if (selectedSession && deps.chatSessionService) {
                const activationResult = await deps.chatSessionService.activateSessionByTitle(cdp, selectedSession);
                if (!activationResult.ok) {
                    await message.reply({
                        text: `Failed to activate joined session "${escapeHtml(selectedSession)}": ${escapeHtml(activationResult.error || 'unknown error')}`,
                    }).catch(logger.error);
                    return;
                }
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

            // Inject prompt (with or without images) into Antigravity
            logger.prompt(effectivePrompt);
            let injectResult;
            try {
                if (inboundImages.length > 0) {
                    injectResult = await cdp.injectMessageWithImageFiles(
                        effectivePrompt,
                        inboundImages.map((img) => img.localPath),
                    );

                    if (!injectResult.ok) {
                        // Fallback: send text-only with image reference
                        logger.warn('[TelegramHandler] Image injection failed, falling back to text-only');
                        injectResult = await cdp.injectMessage(effectivePrompt);
                    }
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

            const refreshStatusMessage = (mode: 'streaming' | 'complete' | 'timeout') => {
                if (!statusMsg) return;
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                const nextText = buildTelegramStatusText({
                    activityLogText: lastActivityLogText,
                    previewText: mode === 'streaming' ? latestPreviewText : '',
                    elapsedSeconds: elapsed,
                    mode,
                });
                if (!nextText || nextText === lastStatusRender) {
                    return;
                }
                lastStatusRender = nextText;
                statusMsg.edit({ text: nextText }).catch(() => { });
            };

            // Send initial status message
            statusMsg = await channel.send({ text: 'Processing...' }).catch(() => null);

            await new Promise<void>((resolve) => {
                const TIMEOUT_MS = 300_000;

                let settled = false;
                const settle = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(safetyTimer);
                    deps.activeMonitors?.delete(projectName);
                    resolve();
                };

                const monitor = new ResponseMonitor({
                    cdpService: cdp,
                    pollIntervalMs: 2000,
                    maxDurationMs: TIMEOUT_MS,
                    stopGoneConfirmCount: 3,
                    extractionMode: deps.extractionMode,

                    onProcessLog: (logText) => {
                        if (logText && logText.trim().length > 0) {
                            lastActivityLogText = processLogBuffer.append(logText);
                        }
                        refreshStatusMessage('streaming');
                    },

                    onProgress: (progressText) => {
                        latestPreviewText = progressText || '';
                        refreshStatusMessage('streaming');
                    },

                    onComplete: async (finalText) => {
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

                            // Merge the final response into the existing status message when possible.
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
                        } finally {
                            settle();
                        }
                    },
                    onTimeout: async (lastText) => {
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
                });

                const safetyTimer = setTimeout(() => {
                    logger.warn(`[TelegramHandler:${projectName}] Safety timeout — releasing queue after 300s`);
                    monitor.stop().catch(() => { });
                    settle();
                }, TIMEOUT_MS);

                // Register the monitor so /stop can access and stop it
                deps.activeMonitors?.set(projectName, monitor);

                monitor.start().catch((err: any) => {
                    logger.error(`[TelegramHandler:${projectName}] monitor.start() failed:`, err?.message || err);
                    settle();
                });
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
}): string {
    const MAX_LENGTH = 4096;
    const activityLogText = options.activityLogText.trim();
    const previewText = options.previewText.trim();
    const footer = options.mode === 'complete'
        ? `Status: Done in ${options.elapsedSeconds}s`
        : options.mode === 'timeout'
            ? `Status: Timed out after ${options.elapsedSeconds}s`
            : `Elapsed: ${options.elapsedSeconds}s`;

    const sections: string[] = [];
    if (activityLogText) {
        sections.push(`[activity]\n${activityLogText}`);
    }
    if (previewText && options.mode === 'streaming') {
        sections.push(`[streaming preview]\n${previewText}`);
    }
    sections.push(footer);

    const body = fitTelegramStatusBody(sections.join('\n\n'), MAX_LENGTH - 8);
    return `\`\`\`\n${body}\n\`\`\``;
}

function fitTelegramStatusBody(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
        return text;
    }

    const prefix = '... (earlier output truncated)\n';
    const tailLength = Math.max(0, maxLength - prefix.length);
    return `${prefix}${text.slice(-tailLength)}`;
}

// ---------------------------------------------------------------------------
// Passive PC → Telegram notification
// ---------------------------------------------------------------------------

/** Per-workspace passive response monitors to avoid duplicates. */
const passiveResponseMonitors = new Map<string, ResponseMonitor>();

/**
 * Handle a user message detected from the Antigravity PC UI.
 * Forwards the message text to the linked Telegram chat and starts a passive
 * ResponseMonitor to relay the AI response.
 */
async function handlePassiveUserMessage(
    channel: PlatformChannel,
    cdp: CdpService,
    projectName: string,
    info: { text: string },
    activeMonitors?: Map<string, ResponseMonitor>,
    extractionMode?: ExtractionMode,
): Promise<void> {
    // Forward the user message
    const preview = info.text.length > 200 ? info.text.slice(0, 200) + '…' : info.text;
    await channel.send({ text: `🖥️ ${preview}` }).catch(logger.error);

    // Start passive ResponseMonitor to capture AI response
    startPassiveResponseMonitor(channel, cdp, projectName, activeMonitors, extractionMode);
}

/**
 * Start a passive ResponseMonitor that sends the AI response to Telegram
 * when generation completes. If a monitor is already running for this
 * workspace, it is stopped and replaced.
 */
function startPassiveResponseMonitor(
    channel: PlatformChannel,
    cdp: CdpService,
    projectName: string,
    activeMonitors?: Map<string, ResponseMonitor>,
    extractionMode?: ExtractionMode,
): void {
    // Stop previous passive monitor if still running
    const prev = passiveResponseMonitors.get(projectName);
    if (prev?.isActive()) {
        prev.stop().catch(() => { });
    }

    const monitor = new ResponseMonitor({
        cdpService: cdp,
        pollIntervalMs: 2000,
        maxDurationMs: 300_000,
        extractionMode,
        onComplete: async (finalText: string) => {
            passiveResponseMonitors.delete(projectName);
            activeMonitors?.delete(`passive:${projectName}`);
            if (!finalText || finalText.trim().length === 0) return;

            await sendTextChunked(channel, finalText);
        },
        onTimeout: () => {
            passiveResponseMonitors.delete(projectName);
            activeMonitors?.delete(`passive:${projectName}`);
        },
    });

    passiveResponseMonitors.set(projectName, monitor);
    activeMonitors?.set(`passive:${projectName}`, monitor);
    monitor.startPassive().catch((err: any) => {
        logger.error('[TelegramPassive] Failed to start response monitor:', err?.message || err);
        passiveResponseMonitors.delete(projectName);
        activeMonitors?.delete(`passive:${projectName}`);
    });
}
