import { t } from "../utils/i18n";
import { logger } from '../utils/logger';
import type { LogLevel } from '../utils/logger';
import { logBuffer } from '../utils/logBuffer';
import {
    Client, GatewayIntentBits, Events, Message,
    ChatInputCommandInteraction, Interaction,
    AttachmentBuilder, ButtonBuilder, ButtonStyle,
    ActionRowBuilder, EmbedBuilder,
    StringSelectMenuBuilder, MessageFlags,
} from 'discord.js';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

import { wrapDiscordChannel } from '../platform/discord/wrappers';
import type { PlatformType } from '../platform/types';
import { loadConfig, resolveResponseDeliveryMode } from '../utils/config';
import type { ExtractionMode } from '../utils/config';
import { parseMessageContent } from '../commands/messageParser';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { registerSlashCommands } from '../commands/registerSlashCommands';

import { ModeService, AVAILABLE_MODES, MODE_DISPLAY_NAMES, MODE_DESCRIPTIONS, MODE_UI_NAMES } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { applyDefaultModel } from '../services/defaultModelApplicator';
import { TemplateRepository } from '../database/templateRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { ScheduleRepository } from '../database/scheduleRepository';
import type { ScheduleRecord } from '../database/scheduleRepository';
import { WorkspaceService } from '../services/workspaceService';
import {
    WorkspaceCommandHandler,
    PROJECT_SELECT_ID,
    WORKSPACE_SELECT_ID,
} from '../commands/workspaceCommandHandler';
import { ChatCommandHandler } from '../commands/chatCommandHandler';
import {
    CleanupCommandHandler,
    CLEANUP_ARCHIVE_BTN,
    CLEANUP_DELETE_BTN,
    CLEANUP_CANCEL_BTN,
} from '../commands/cleanupCommandHandler';
import { ChannelManager } from '../services/channelManager';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { JoinCommandHandler } from '../commands/joinCommandHandler';
import { isSessionSelectId } from '../ui/sessionPickerUi';

// CDP integration services
import { CdpService } from '../services/cdpService';
import { ChatSessionService } from '../services/chatSessionService';
import { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import { ClawCommandInterceptor } from '../services/clawCommandInterceptor';
import { AgentRouter } from '../services/agentRouter';
import { ensureAntigravityRunning } from '../services/antigravityLauncher';
import { getAntigravityCdpHint } from '../utils/pathUtils';
import { AutoAcceptService } from '../services/autoAcceptService';
import { PromptDispatcher } from '../services/promptDispatcher';
import { ScheduleService } from '../services/scheduleService';
import {
    buildApprovalCustomId,
    CdpBridge,
    ensureApprovalDetector,
    ensureErrorPopupDetector,
    ensurePlanningDetector,
    ensureRunCommandDetector,
    ensureUserMessageDetector,
    getCurrentCdp,
    initCdpBridge,
    parseApprovalCustomId,
    parseErrorPopupCustomId,
    parsePlanningCustomId,
    parseRunCommandCustomId,
    registerApprovalSessionChannel,
    registerApprovalWorkspaceChannel,
} from '../services/cdpBridgeManager';
import { buildModeModelLines, buildSessionLines, fitForSingleEmbedDescription, splitForEmbedDescription } from '../utils/streamMessageFormatter';
import { formatForDiscord, splitOutputAndLogs } from '../utils/discordFormatter';
import { ProcessLogBuffer } from '../utils/processLogBuffer';
import {
    cleanupInboundImageAttachments,
    downloadInboundImageAttachments,
    InboundImageAttachment,
    isImageAttachment,
    toDiscordAttachment,
} from '../utils/imageHandler';
import { sendModeUI } from '../ui/modeUi';
import { sendModelsUI, buildModelsUI } from '../ui/modelsUi';
import { sendTemplateUI } from '../ui/templateUi';
import { sendAutoAcceptUI } from '../ui/autoAcceptUi';
import { sendOutputUI, OUTPUT_BTN_EMBED, OUTPUT_BTN_PLAIN } from '../ui/outputUi';
import { handleScreenshot } from '../ui/screenshotUi';
import { UserPreferenceRepository, OutputFormat } from '../database/userPreferenceRepository';
import { formatAsPlainText, splitPlainText } from '../utils/plainTextFormatter';
import { createInteractionCreateHandler } from '../events/interactionCreateHandler';
import { createMessageCreateHandler } from '../events/messageCreateHandler';

// Telegram platform support
import { Bot, InputFile } from 'grammy';
import { TelegramAdapter } from '../platform/telegram/telegramAdapter';
import { TelegramBindingRepository } from '../database/telegramBindingRepository';
import { TelegramRecentMessageRepository } from '../database/telegramRecentMessageRepository';
import { createTelegramMessageHandler, handlePassiveUserMessage } from './telegramMessageHandler';
import { wrapTelegramChannel } from '../platform/telegram/wrappers';
import { createTelegramSelectHandler } from './telegramProjectCommand';
import { createTelegramJoinSelectHandler, TelegramSessionStateStore } from './telegramJoinCommand';
import { EventRouter } from './eventRouter';
import { createPlatformButtonHandler } from '../handlers/buttonHandler';
import { createPlatformSelectHandler } from '../handlers/selectHandler';
import { createApprovalButtonAction } from '../handlers/approvalButtonAction';
import { createPlanningButtonAction } from '../handlers/planningButtonAction';
import { createErrorPopupButtonAction } from '../handlers/errorPopupButtonAction';
import { createRunCommandButtonAction } from '../handlers/runCommandButtonAction';
import { createModelButtonAction } from '../handlers/modelButtonAction';
import { createAutoAcceptButtonAction } from '../handlers/autoAcceptButtonAction';
import { createTemplateButtonAction } from '../handlers/templateButtonAction';
import { createModeSelectAction } from '../handlers/modeSelectAction';
import { clearShutdownHooks, registerShutdownHook, restartCurrentProcess } from '../services/processRestartService';

// =============================================================================
// Embed color palette (color-coded by phase)
// =============================================================================
const PHASE_COLORS = {
    sending: 0x5865F2,     // Blue
    thinking: 0x9B59B6,    // Purple
    generating: 0xF39C12,  // Gold
    complete: 0x2ECC71,    // Green
    timeout: 0xE74C3C,     // Red
    error: 0xC0392B,       // Dark Red
} as const;

const PHASE_ICONS = {
    sending: '📡',
    thinking: '🧠',
    generating: '✍️',
    complete: '✅',
    timeout: '⏰',
    error: '❌',
} as const;

const MAX_OUTBOUND_GENERATED_IMAGES = 4;
const RESPONSE_DELIVERY_MODE = resolveResponseDeliveryMode();

/** Tracks channel IDs where /stop was explicitly invoked by the user */
const userStopRequestedChannels = new Set<string>();
export const getResponseDeliveryModeForTest = (): string => RESPONSE_DELIVERY_MODE;

export function createSerialTaskQueueForTest(queueName: string, traceId: string): (task: () => Promise<void>, label?: string) => Promise<void> {
    let queue: Promise<void> = Promise.resolve();
    let queueDepth = 0;
    let taskSeq = 0;

    return (task: () => Promise<void>, label: string = 'queue-task'): Promise<void> => {
        taskSeq += 1;
        const seq = taskSeq;
        queueDepth += 1;

        queue = queue.then(async () => {
            try {
                await task();
            } catch (err: any) {
                logger.error(`[sendQueue:${traceId}:${queueName}] error #${seq} label=${label}:`, err?.message || err);
            } finally {
                queueDepth = Math.max(0, queueDepth - 1);
            }
        });

        return queue;
    };
}

async function restoreDiscordSessionsOnStartup(
    client: Client,
    bridge: CdpBridge,
    workspaceBindingRepo: WorkspaceBindingRepository,
    chatSessionRepo: ChatSessionRepository,
    workspaceService: WorkspaceService,
    chatSessionService: ChatSessionService,
): Promise<void> {
    const bindings = workspaceBindingRepo.findAll();
    if (bindings.length === 0) return;

    const restoredWorkspaces = new Set<string>();

    for (const binding of bindings) {
        if (restoredWorkspaces.has(binding.workspacePath)) continue;

        const session = chatSessionRepo.findLatestRestorableByWorkspace(binding.workspacePath);
        if (!session?.displayName) continue;

        try {
            const resolvedWorkspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
            const cdp = await bridge.pool.getOrConnect(resolvedWorkspacePath);
            const projectName = bridge.pool.extractProjectName(resolvedWorkspacePath);
            const channelManager = (client.channels as any);
            const discordChannel = channelManager?.fetch
                ? await channelManager.fetch(session.channelId).catch(() => null)
                : null;

            if (!discordChannel || !discordChannel.isTextBased?.()) {
                logger.warn(`[StartupRestore] Channel not found or not text-based: ${session.channelId}`);
                continue;
            }

            const platformChannel = wrapDiscordChannel(discordChannel as any);
            bridge.lastActiveWorkspace = projectName;
            bridge.lastActiveChannel = platformChannel;
            registerApprovalWorkspaceChannel(bridge, projectName, platformChannel);
            registerApprovalSessionChannel(bridge, projectName, session.displayName, platformChannel);

            ensureApprovalDetector(bridge, cdp, projectName);
            ensureErrorPopupDetector(bridge, cdp, projectName);
            ensurePlanningDetector(bridge, cdp, projectName);
            ensureRunCommandDetector(bridge, cdp, projectName);

            const activationResult = await chatSessionService.activateSessionByTitle(cdp, session.displayName);
            if (!activationResult.ok) {
                logger.warn(
                    `[StartupRestore] Failed to restore session "${session.displayName}" for ${binding.workspacePath}: ` +
                    `${activationResult.error || 'unknown error'}`,
                );
                continue;
            }

            restoredWorkspaces.add(binding.workspacePath);
            logger.info(`[StartupRestore] Restored session "${session.displayName}" for workspace ${binding.workspacePath}`);
        } catch (error: any) {
            logger.warn(`[StartupRestore] Failed to restore workspace ${binding.workspacePath}: ${error?.message || error}`);
        }
    }
}

/**
 * Send a Discord message (prompt) to Antigravity, wait for the response, and relay it back to Discord
 *
 * Message strategy:
 *   - Send new messages per phase instead of editing, to preserve history
 *   - Visualize the flow of planning/analysis/execution confirmation/implementation as logs
 */
async function sendPromptToAntigravity(
    bridge: CdpBridge,
    message: Message,
    prompt: string,
    cdp: CdpService,
    modeService: ModeService,
    modelService: ModelService,
    inboundImages: InboundImageAttachment[] = [],
    options?: {
        chatSessionService: ChatSessionService;
        chatSessionRepo: ChatSessionRepository;
        channelManager: ChannelManager;
        titleGenerator: TitleGeneratorService;
        userPrefRepo?: UserPreferenceRepository;
        onFullCompletion?: () => void;
        extractionMode?: ExtractionMode;
    }
): Promise<void> {
    // Completion signal — called exactly once when the entire prompt lifecycle ends
    let completionSignaled = false;
    const signalCompletion = (exitPath: string) => {
        if (completionSignaled) return;
        completionSignaled = true;
        logger.debug(`[sendPrompt:${message.channelId}] signalCompletion via ${exitPath}`);
        options?.onFullCompletion?.();
    };

    // Resolve output format once at the start (no mid-response switches)
    const outputFormat: OutputFormat = options?.userPrefRepo?.getOutputFormat(message.author.id) ?? 'embed';

    // Add reaction to acknowledge command receipt
    await message.react('👀').catch(() => { });

    const channel = (message.channel && 'send' in message.channel) ? message.channel as any : null;
    const monitorTraceId = `${message.channelId}:${message.id}`;
    const enqueueGeneral = createSerialTaskQueueForTest('general', monitorTraceId);
    const enqueueResponse = createSerialTaskQueueForTest('response', monitorTraceId);
    const enqueueActivity = createSerialTaskQueueForTest('activity', monitorTraceId);

    const sendEmbed = (
        title: string,
        description: string,
        color: number,
        fields?: { name: string; value: string; inline?: boolean }[],
        footerText?: string,
    ): Promise<void> => enqueueGeneral(async () => {
        if (!channel) return;

        if (outputFormat === 'plain') {
            const chunks = formatAsPlainText({ title, description, fields, footerText });
            for (const chunk of chunks) {
                await channel.send({ content: chunk }).catch(() => { });
            }
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();
        if (fields && fields.length > 0) {
            embed.addFields(...fields);
        }
        if (footerText) {
            embed.setFooter({ text: footerText });
        }
        await channel.send({ embeds: [embed] }).catch(() => { });
    }, 'send-embed');

    const shouldTryGeneratedImages = (inputPrompt: string, responseText: string): boolean => {
        const prompt = (inputPrompt || '').toLowerCase();
        const response = (responseText || '').toLowerCase();
        const imageIntentPattern = /(image|images|png|jpg|jpeg|gif|webp|illustration|diagram|render)/i;
        const imageUrlPattern = /https?:\/\/\S+\.(png|jpg|jpeg|gif|webp)/i;

        if (imageIntentPattern.test(prompt)) return true;
        if (response.includes('![') || imageUrlPattern.test(response)) return true;
        return false;
    };

    const sendGeneratedImages = async (responseText: string): Promise<void> => {
        if (!channel) return;
        if (!shouldTryGeneratedImages(prompt, responseText)) return;

        const extracted = await cdp.extractLatestResponseImages(MAX_OUTBOUND_GENERATED_IMAGES);
        if (extracted.length === 0) return;

        const files: AttachmentBuilder[] = [];
        for (let i = 0; i < extracted.length; i++) {
            const attachment = await toDiscordAttachment(extracted[i], i);
            if (attachment) files.push(attachment);
        }
        if (files.length === 0) return;

        await enqueueGeneral(async () => {
            await channel.send({
                content: t(`🖼️ Detected generated images (${files.length})`),
                files,
            }).catch(() => { });
        }, 'send-generated-images');
    };

    const tryEmergencyExtractText = async (): Promise<string> => {
        try {
            const contextId = cdp.getPrimaryContextId();
            const expression = `(() => {
                const panel = document.querySelector('.antigravity-agent-side-panel');
                const scope = panel || document;

                const candidateSelectors = [
                    '.rendered-markdown',
                    '.leading-relaxed.select-text',
                    '.flex.flex-col.gap-y-3',
                    '[data-message-author-role="assistant"]',
                    '[data-message-role="assistant"]',
                    '[class*="assistant-message"]',
                    '[class*="message-content"]',
                    '[class*="markdown-body"]',
                    '.prose',
                ];

                const looksLikeActivity = (text) => {
                    const normalized = (text || '').trim().toLowerCase();
                    if (!normalized) return true;
                    const activityPattern = /^(?:analy[sz]ing|reading|writing|running|searching|planning|thinking|processing|loading|executing|testing|debugging|analyzed|read|wrote|ran)/i;
                    return activityPattern.test(normalized) && normalized.length <= 220;
                };

                const clean = (text) => (text || '').replace(/\\r/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();

                const candidates = [];
                const seen = new Set();
                for (const selector of candidateSelectors) {
                    const nodes = scope.querySelectorAll(selector);
                    for (const node of nodes) {
                        if (!node || seen.has(node)) continue;
                        seen.add(node);
                        candidates.push(node);
                    }
                }

                for (let i = candidates.length - 1; i >= 0; i--) {
                    const node = candidates[i];
                    const text = clean(node.innerText || node.textContent || '');
                    if (!text || text.length < 20) continue;
                    if (looksLikeActivity(text)) continue;
                    if (/^(good|bad)$/i.test(text)) continue;
                    return text;
                }

                return '';
            })()`;

            const callParams: Record<string, unknown> = {
                expression,
                returnByValue: true,
                awaitPromise: true,
            };
            if (contextId !== null) callParams.contextId = contextId;
            const res = await cdp.call('Runtime.evaluate', callParams);
            const value = res?.result?.value;
            return typeof value === 'string' ? value.trim() : '';
        } catch {
            return '';
        }
    };

    const clearWatchingReaction = async (): Promise<void> => {
        const botId = message.client.user?.id;
        if (botId) {
            await message.reactions.resolve('👀')?.users.remove(botId).catch(() => { });
        }
    };

    if (!cdp.isConnected()) {
        await sendEmbed(
            `${PHASE_ICONS.error} Connection Error`,
            `Not connected to Antigravity.\nStart with \`${getAntigravityCdpHint(9223)}\`, then send a message to auto-connect.`,
            PHASE_COLORS.error,
        );
        await clearWatchingReaction();
        await message.react('❌').catch(() => { });
        signalCompletion('cdp-disconnected');
        return;
    }

    // Apply default model preference on CDP connect
    const defaultModelResult = await applyDefaultModel(cdp, modelService);
    if (defaultModelResult.stale && defaultModelResult.staleMessage && channel) {
        await channel.send(defaultModelResult.staleMessage).catch(() => { });
    }

    const localMode = modeService.getCurrentMode();
    const modeName = MODE_UI_NAMES[localMode] || localMode;
    const currentModel = (await cdp.getCurrentModel()) || modelService.getCurrentModel();
    const fastModel = currentModel;
    const planModel = currentModel;

    const sessionInfo = await cdp.getActiveSessionInfo();
    const sessionLines = sessionInfo ? buildSessionLines(sessionInfo.title, sessionInfo.summary) : [];

    const modelSuffix = (localMode === 'plan' && !currentModel?.includes('(Thinking)')) ? ' (Thinking)' : '';
    await sendEmbed(
        `${PHASE_ICONS.sending} [${modeName} - ${currentModel}${modelSuffix}] Sending...`,
        [...buildModeModelLines(modeName, fastModel, planModel), ...sessionLines].join('\n'),
        PHASE_COLORS.sending,
    );

    let isFinalized = false;
    let lastProgressText = '';
    let lastActivityLogText = '';
    const LIVE_RESPONSE_MAX_LEN = 3800;
    const LIVE_ACTIVITY_MAX_LEN = 3800;
    const processLogBuffer = new ProcessLogBuffer({
        maxChars: LIVE_ACTIVITY_MAX_LEN,
        maxEntries: 120,
        maxEntryLength: 220,
    });
    const liveResponseMessages: any[] = [];
    const liveActivityMessages: any[] = [];
    let lastLiveResponseKey = '';
    let lastLiveActivityKey = '';
    let liveResponseUpdateVersion = 0;
    let liveActivityUpdateVersion = 0;

    const ACTIVITY_PLACEHOLDER = t('Collecting process logs...');

    const buildLiveResponseDescriptions = (text: string): string[] => {
        const normalized = (text || '').trim();
        if (!normalized) {
            return [t('Waiting for output...')];
        }
        return splitForEmbedDescription(formatForDiscord(normalized), LIVE_RESPONSE_MAX_LEN);
    };

    const buildLiveActivityDescriptions = (text: string): string[] => {
        const normalized = (text || '').trim();
        if (!normalized) return [ACTIVITY_PLACEHOLDER];
        const formatted = formatForDiscord(normalized);
        return [fitForSingleEmbedDescription(formatted, LIVE_ACTIVITY_MAX_LEN)];
    };

    const appendProcessLogs = (text: string): string => {
        const normalized = (text || '').trim();
        if (!normalized) return processLogBuffer.snapshot();
        return processLogBuffer.append(normalized);
    };

    const upsertLiveResponseEmbeds = (
        title: string,
        rawText: string,
        color: number,
        footerText: string,
        opts?: {
            source?: string;
            expectedVersion?: number;
            skipWhenFinalized?: boolean;
        },
    ): Promise<void> => enqueueResponse(async () => {
        if (opts?.skipWhenFinalized && isFinalized) return;
        if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveResponseUpdateVersion) return;
        if (!channel) return;

        if (outputFormat === 'plain') {
            const formatted = formatForDiscord((rawText || '').trim());
            const plainChunks = splitPlainText(
                `**${title}**\n${formatted}\n_${footerText}_`,
            );
            const renderKey = `${title}|plain|${footerText}|${plainChunks.join('\n<<<PAGE_BREAK>>>\n')}`;
            if (renderKey === lastLiveResponseKey && liveResponseMessages.length > 0) return;
            lastLiveResponseKey = renderKey;

            for (let i = 0; i < plainChunks.length; i++) {
                if (!liveResponseMessages[i]) {
                    liveResponseMessages[i] = await channel.send({ content: plainChunks[i] }).catch(() => null);
                    continue;
                }
                await liveResponseMessages[i].edit({ content: plainChunks[i] }).catch(async () => {
                    liveResponseMessages[i] = await channel.send({ content: plainChunks[i] }).catch(() => null);
                });
            }
            while (liveResponseMessages.length > plainChunks.length) {
                const extra = liveResponseMessages.pop();
                if (!extra) continue;
                await extra.delete().catch(() => { });
            }
            return;
        }

        const descriptions = buildLiveResponseDescriptions(rawText);
        const renderKey = `${title}|${color}|${footerText}|${descriptions.join('\n<<<PAGE_BREAK>>>\n')}`;
        if (renderKey === lastLiveResponseKey && liveResponseMessages.length > 0) {
            return;
        }
        lastLiveResponseKey = renderKey;

        for (let i = 0; i < descriptions.length; i++) {
            const embed = new EmbedBuilder()
                .setTitle(descriptions.length > 1 ? `${title} (${i + 1}/${descriptions.length})` : title)
                .setDescription(descriptions[i])
                .setColor(color)
                .setFooter({ text: footerText })
                .setTimestamp();

            if (!liveResponseMessages[i]) {
                liveResponseMessages[i] = await channel.send({ embeds: [embed] }).catch(() => null);
                continue;
            }

            await liveResponseMessages[i].edit({ embeds: [embed] }).catch(async () => {
                liveResponseMessages[i] = await channel.send({ embeds: [embed] }).catch(() => null);
            });
        }

        // Delete excess messages if page count decreased
        while (liveResponseMessages.length > descriptions.length) {
            const extra = liveResponseMessages.pop();
            if (!extra) continue;
            await extra.delete().catch(() => { });
        }
    }, `upsert-response:${opts?.source ?? 'unknown'}`);

    const upsertLiveActivityEmbeds = (
        title: string,
        rawText: string,
        color: number,
        footerText: string,
        opts?: {
            source?: string;
            expectedVersion?: number;
            skipWhenFinalized?: boolean;
        },
    ): Promise<void> => enqueueActivity(async () => {
        if (opts?.skipWhenFinalized && isFinalized) return;
        if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveActivityUpdateVersion) return;
        if (!channel) return;

        if (outputFormat === 'plain') {
            const formatted = formatForDiscord((rawText || '').trim());
            const plainContent = `**${title}**\n${formatted}\n_${footerText}_`;
            const plainChunks = splitPlainText(plainContent);
            const renderKey = `${title}|plain|${footerText}|${plainChunks.join('\n<<<PAGE_BREAK>>>\n')}`;
            if (renderKey === lastLiveActivityKey && liveActivityMessages.length > 0) return;
            lastLiveActivityKey = renderKey;

            for (let i = 0; i < plainChunks.length; i++) {
                if (!liveActivityMessages[i]) {
                    liveActivityMessages[i] = await channel.send({ content: plainChunks[i] }).catch(() => null);
                    continue;
                }
                await liveActivityMessages[i].edit({ content: plainChunks[i] }).catch(async () => {
                    liveActivityMessages[i] = await channel.send({ content: plainChunks[i] }).catch(() => null);
                });
            }
            while (liveActivityMessages.length > plainChunks.length) {
                const extra = liveActivityMessages.pop();
                if (!extra) continue;
                await extra.delete().catch(() => { });
            }
            return;
        }

        const descriptions = buildLiveActivityDescriptions(rawText);
        const renderKey = `${title}|${color}|${footerText}|${descriptions.join('\n<<<PAGE_BREAK>>>\n')}`;
        if (renderKey === lastLiveActivityKey && liveActivityMessages.length > 0) {
            return;
        }
        lastLiveActivityKey = renderKey;

        for (let i = 0; i < descriptions.length; i++) {
            const embed = new EmbedBuilder()
                .setTitle(descriptions.length > 1 ? `${title} (${i + 1}/${descriptions.length})` : title)
                .setDescription(descriptions[i])
                .setColor(color)
                .setFooter({ text: footerText })
                .setTimestamp();

            if (!liveActivityMessages[i]) {
                liveActivityMessages[i] = await channel.send({ embeds: [embed] }).catch(() => null);
                continue;
            }

            await liveActivityMessages[i].edit({ embeds: [embed] }).catch(async () => {
                liveActivityMessages[i] = await channel.send({ embeds: [embed] }).catch(() => null);
            });
        }

        while (liveActivityMessages.length > descriptions.length) {
            const extra = liveActivityMessages.pop();
            if (!extra) continue;
            await extra.delete().catch(() => { });
        }
    }, `upsert-activity:${opts?.source ?? 'unknown'}`);


    try {

        logger.prompt(prompt);

        let injectResult;
        if (inboundImages.length > 0) {
            injectResult = await cdp.injectMessageWithImageFiles(
                prompt,
                inboundImages.map((image) => image.localPath),
            );
        } else {
            injectResult = await cdp.injectMessage(prompt);
        }

        if (!injectResult.ok) {
            isFinalized = true;
            await sendEmbed(
                `${PHASE_ICONS.error} Message Injection Failed`,
                `Failed to send message: ${injectResult.error}`,
                PHASE_COLORS.error,
            );
            await clearWatchingReaction();
            await message.react('❌').catch(() => { });
            signalCompletion('inject-failed');
            return;
        }

        const startTime = Date.now();
        await upsertLiveActivityEmbeds(
            `${PHASE_ICONS.thinking} Process Log`,
            '',
            PHASE_COLORS.thinking,
            t('⏱️ Elapsed: 0s | Process log'),
            { source: 'initial' },
        );

        const grpcClient = await cdp.getGrpcClient();
        const cascadeId = injectResult.cascadeId || (grpcClient ? await cdp.getActiveCascadeId() : null);

        if (!grpcClient || !cascadeId) {
            isFinalized = true;
            await sendEmbed(
                `${PHASE_ICONS.error} Monitor Unavailable`,
                'gRPC monitor unavailable. Unable to track the response stream.',
                PHASE_COLORS.error,
            );
            await clearWatchingReaction();
            await message.react('❌').catch(() => { });
            signalCompletion('grpc-unavailable');
            return;
        }

        const renderQuotaReached = async (elapsed: number, source: 'complete' | 'timeout') => {
            const finalLogText = lastActivityLogText || processLogBuffer.snapshot();
            if (finalLogText && finalLogText.trim().length > 0) {
                logger.divider('Process Log');
                console.info(finalLogText);
            }
            logger.divider();

            liveActivityUpdateVersion += 1;
            await upsertLiveActivityEmbeds(
                `${PHASE_ICONS.thinking} Process Log`,
                finalLogText || ACTIVITY_PLACEHOLDER,
                PHASE_COLORS.thinking,
                t(`⏱️ Time: ${elapsed}s | Process log`),
                {
                    source,
                    expectedVersion: liveActivityUpdateVersion,
                },
            );

            liveResponseUpdateVersion += 1;
            await upsertLiveResponseEmbeds(
                '⚠️ Model Quota Reached',
                'Model quota limit reached. Please wait or switch to a different model.',
                0xFF6B6B,
                t(`⏱️ Time: ${elapsed}s | Quota Reached`),
                {
                    source,
                    expectedVersion: liveResponseUpdateVersion,
                },
            );

            try {
                const modelsPayload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
                if (modelsPayload && channel) {
                    await channel.send({ ...modelsPayload });
                }
            } catch (e) {
                logger.error('[Quota] Failed to send model selection UI:', e);
            }
        };

        const monitor = new GrpcResponseMonitor({
            grpcClient,
            cascadeId,
            maxDurationMs: 300000,

            onPhaseChange: (_phase, _text) => {
                // Phase transitions are already logged inside GrpcResponseMonitor.setPhase()
            },

            onProcessLog: (logText) => {
                if (isFinalized) return;
                if (logText && logText.trim().length > 0) {
                    lastActivityLogText = appendProcessLogs(logText);
                }
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                liveActivityUpdateVersion += 1;
                const activityVersion = liveActivityUpdateVersion;
                upsertLiveActivityEmbeds(
                    `${PHASE_ICONS.thinking} Process Log`,
                    lastActivityLogText || ACTIVITY_PLACEHOLDER,
                    PHASE_COLORS.thinking,
                    t(`⏱️ Elapsed: ${elapsed}s | Process log`),
                    {
                        source: 'process-log',
                        expectedVersion: activityVersion,
                        skipWhenFinalized: true,
                    },
                ).catch(() => { });
            },

            onProgress: (text) => {
                if (isFinalized) return;
                if (text && text.trim().length > 0) {
                    lastProgressText = text;
                }
            },

            onComplete: async (finalText) => {
                isFinalized = true;

                try {
                    // If the user explicitly pressed /stop, skip output display entirely
                    const wasStoppedByUser = userStopRequestedChannels.delete(message.channelId);
                    if (wasStoppedByUser) {
                        logger.info(`[sendPromptToAntigravity:${monitorTraceId}] Stopped by user — skipping output`);
                        await clearWatchingReaction();
                        await message.react('⏹️').catch(() => { });
                        return;
                    }

                    try {
                        const elapsed = Math.round((Date.now() - startTime) / 1000);
                        const isQuotaError = monitor.getPhase() === 'quotaReached';

                        // Quota early exit — skip text extraction, output logging, and embed entirely
                        if (isQuotaError) {
                            await renderQuotaReached(elapsed, 'complete');
                            await clearWatchingReaction();
                            await message.react('⚠️').catch(() => { });
                            return;
                        }

                        // Normal path — extract final text
                        const responseText = (finalText && finalText.trim().length > 0)
                            ? finalText
                            : lastProgressText;
                        const emergencyText = (!responseText || responseText.trim().length === 0)
                            ? await tryEmergencyExtractText()
                            : '';
                        const finalResponseText = responseText && responseText.trim().length > 0
                            ? responseText
                            : emergencyText;
                        const separated = splitOutputAndLogs(finalResponseText);
                        const finalOutputText = separated.output || finalResponseText;
                        // Process logs are now collected by onProcessLog callback directly;
                        // sanitizeActivityLines is NOT applied because it would strip the very
                        // content we want to display (activity messages, tool names, etc.)
                        const finalLogText = lastActivityLogText || processLogBuffer.snapshot();
                        if (finalLogText && finalLogText.trim().length > 0) {
                            logger.divider('Process Log');
                            console.info(finalLogText);
                        }
                        if (finalOutputText && finalOutputText.trim().length > 0) {
                            logger.divider(`Output (${finalOutputText.length} chars)`);
                            console.info(finalOutputText);
                        }
                        logger.divider();

                        liveActivityUpdateVersion += 1;
                        const activityVersion = liveActivityUpdateVersion;
                        await upsertLiveActivityEmbeds(
                            `${PHASE_ICONS.thinking} Process Log`,
                            finalLogText || ACTIVITY_PLACEHOLDER,
                            PHASE_COLORS.thinking,
                            t(`⏱️ Time: ${elapsed}s | Process log`),
                            {
                                source: 'complete',
                                expectedVersion: activityVersion,
                            },
                        );

                        liveResponseUpdateVersion += 1;
                        const responseVersion = liveResponseUpdateVersion;
                        if (finalOutputText && finalOutputText.trim().length > 0) {
                            await upsertLiveResponseEmbeds(
                                `${PHASE_ICONS.complete} Final Output`,
                                finalOutputText,
                                PHASE_COLORS.complete,
                                t(`⏱️ Time: ${elapsed}s | Complete`),
                                {
                                    source: 'complete',
                                    expectedVersion: responseVersion,
                                },
                            );
                        } else {
                            await upsertLiveResponseEmbeds(
                                `${PHASE_ICONS.complete} Complete`,
                                t('Failed to extract response. Use `/screenshot` to verify.'),
                                PHASE_COLORS.complete,
                                t(`⏱️ Time: ${elapsed}s | Complete`),
                                {
                                    source: 'complete',
                                    expectedVersion: responseVersion,
                                },
                            );
                        }

                        if (options && message.guild) {
                            try {
                                const sessionInfo = await options.chatSessionService.getCurrentSessionInfo(cdp);
                                if (sessionInfo && sessionInfo.hasActiveChat && sessionInfo.title && sessionInfo.title !== t('(Untitled)')) {
                                    const session = options.chatSessionRepo.findByChannelId(message.channelId);
                                    const projectName = session
                                        ? bridge.pool.extractProjectName(session.workspacePath)
                                        : cdp.getCurrentWorkspaceName();
                                    if (projectName) {
                                        registerApprovalSessionChannel(bridge, projectName, sessionInfo.title, wrapDiscordChannel(message.channel as any));
                                    }

                                    const newName = options.titleGenerator.sanitizeForChannelName(sessionInfo.title);
                                    if (session && session.displayName !== sessionInfo.title) {
                                        const formattedName = `${session.sessionNumber}-${newName}`;
                                        await options.channelManager.renameChannel(message.guild, message.channelId, formattedName);
                                        options.chatSessionRepo.updateDisplayName(message.channelId, sessionInfo.title);
                                    }
                                }
                            } catch (e) {
                                logger.error('[Rename] Failed to get title from Antigravity and rename:', e);
                            }
                        }

                        await sendGeneratedImages(finalOutputText || '');
                        await clearWatchingReaction();
                        await message.react(finalOutputText && finalOutputText.trim().length > 0 ? '✅' : '⚠️').catch(() => { });
                    } catch (error) {
                        logger.error(`[sendPromptToAntigravity:${monitorTraceId}] onComplete failed:`, error);
                    }
                } finally {
                    signalCompletion('onComplete');
                }
            },

            onTimeout: async (lastText) => {
                isFinalized = true;
                try {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    if (monitor.getPhase() === 'quotaReached') {
                        await renderQuotaReached(elapsed, 'timeout');
                        await clearWatchingReaction();
                        await message.react('⚠️').catch(() => { });
                        return;
                    }

                    const timeoutText = (lastText && lastText.trim().length > 0)
                        ? lastText
                        : lastProgressText;
                    const separated = splitOutputAndLogs(timeoutText || '');
                    const sanitizedTimeoutLogs = lastActivityLogText || processLogBuffer.snapshot();
                    const payload = separated.output && separated.output.trim().length > 0
                        ? t(`${separated.output}\n\n[Monitor Ended] Timeout after 5 minutes.`)
                        : 'Monitor ended after 5 minutes. No text was retrieved.';

                    liveResponseUpdateVersion += 1;
                    const responseVersion = liveResponseUpdateVersion;
                    await upsertLiveResponseEmbeds(
                        `${PHASE_ICONS.timeout} Timeout`,
                        payload,
                        PHASE_COLORS.timeout,
                        `⏱️ Elapsed: ${elapsed}s | Timeout`,
                        {
                            source: 'timeout',
                            expectedVersion: responseVersion,
                        },
                    );

                    liveActivityUpdateVersion += 1;
                    const activityVersion = liveActivityUpdateVersion;
                    await upsertLiveActivityEmbeds(
                        `${PHASE_ICONS.thinking} Process Log`,
                        sanitizedTimeoutLogs || ACTIVITY_PLACEHOLDER,
                        PHASE_COLORS.thinking,
                        t(`⏱️ Time: ${elapsed}s | Process log`),
                        {
                            source: 'timeout',
                            expectedVersion: activityVersion,
                        },
                    );
                    await clearWatchingReaction();
                    await message.react('⚠️').catch(() => { });
                } catch (error) {
                    logger.error(`[sendPromptToAntigravity:${monitorTraceId}] onTimeout failed:`, error);
                } finally {
                    signalCompletion('onTimeout');
                }
            },
        });

        await monitor.start();

        // 1-second elapsed timer — updates footer independently of process log events
        const elapsedTimer = setInterval(() => {
            if (isFinalized) {
                clearInterval(elapsedTimer);
                return;
            }
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            liveActivityUpdateVersion += 1;
            const activityVersion = liveActivityUpdateVersion;
            upsertLiveActivityEmbeds(
                `${PHASE_ICONS.thinking} Process Log`,
                lastActivityLogText || ACTIVITY_PLACEHOLDER,
                PHASE_COLORS.thinking,
                t(`⏱️ Elapsed: ${elapsed}s | Process log`),
                {
                    source: 'elapsed-tick',
                    expectedVersion: activityVersion,
                    skipWhenFinalized: true,
                },
            ).catch(() => { });
        }, 1000);

    } catch (e: any) {
        isFinalized = true;
        await sendEmbed(
            `${PHASE_ICONS.error} Error`,
            t(`Error occurred during processing: ${e.message}`),
            PHASE_COLORS.error,
        );
        await clearWatchingReaction();
        await message.react('❌').catch(() => { });
        signalCompletion('top-level-catch');
    }
}

// =============================================================================
// Bot main entry point
// =============================================================================

export const startBot = async (cliLogLevel?: LogLevel) => {
    clearShutdownHooks();
    const config = loadConfig();
    logger.setLogLevel(cliLogLevel ?? config.logLevel);

    const dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : 'antigravity.db';
    const db = new Database(dbPath);
    const modeService = new ModeService();
    const modelService = new ModelService();
    const templateRepo = new TemplateRepository(db);
    const userPrefRepo = new UserPreferenceRepository(db);

    // Eagerly load default model from DB (single-user bot optimization)
    try {
        const firstUser = db.prepare('SELECT user_id FROM user_preferences LIMIT 1').get() as { user_id: string } | undefined;
        if (firstUser) {
            const savedDefault = userPrefRepo.getDefaultModel(firstUser.user_id);
            modelService.loadDefaultModel(savedDefault);
        }
    } catch {
        // DB may not have user_preferences yet — safe to ignore
    }
    const workspaceBindingRepo = new WorkspaceBindingRepository(db);
    const chatSessionRepo = new ChatSessionRepository(db);
    const workspaceService = new WorkspaceService(config.workspaceBaseDir);
    const channelManager = new ChannelManager();

    // Auto-launch Antigravity with CDP port if not already running
    await ensureAntigravityRunning();

    // Initialize CDP bridge (lazy connection: pool creation only)
    const bridge = initCdpBridge(config.autoApproveFileEdits);

    // Initialize CDP-dependent services (constructor CDP dependency removed)
    const chatSessionService = new ChatSessionService();
    const titleGenerator = new TitleGeneratorService();
    const promptDispatcher = new PromptDispatcher({
        bridge,
        modeService,
        modelService,
        sendPromptImpl: sendPromptToAntigravity,
    });

    // Initialize command handlers (joinHandler is created after client, see below)
    const wsHandler = new WorkspaceCommandHandler(workspaceBindingRepo, chatSessionRepo, workspaceService, channelManager);
    const chatHandler = new ChatCommandHandler(chatSessionService, chatSessionRepo, workspaceBindingRepo, channelManager, workspaceService, bridge.pool);
    const cleanupHandler = new CleanupCommandHandler(chatSessionRepo, workspaceBindingRepo);

    const slashCommandHandler = new SlashCommandHandler(templateRepo);

    // Initialize ScheduleService
    const scheduleRepo = new ScheduleRepository(db);
    const scheduleService = new ScheduleService(scheduleRepo);
    registerShutdownHook('core:schedules', () => {
        scheduleService.stopAll();
    });
    registerShutdownHook('core:connections', () => {
        bridge.pool.disconnectAll();
    });
    registerShutdownHook('core:database', () => {
        try {
            db.close();
        } catch {
            // Ignore close errors during shutdown.
        }
    });

    /**
     * Check if Antigravity is currently generating a response via the backend trajectory status.
     * Returns true if busy, false if idle.
     */
    async function isAntigravityBusy(cdp: CdpService): Promise<boolean> {
        try {
            const grpcClient = await cdp.getGrpcClient();
            const cascadeId = grpcClient ? await cdp.getActiveCascadeId() : null;
            if (!grpcClient || !cascadeId) return false;

            const traj = await grpcClient.rawRPC('GetCascadeTrajectory', { cascadeId });
            const status = traj?.trajectory?.cascadeRunStatus || traj?.status || '';
            return status === 'CASCADE_RUN_STATUS_RUNNING';
        } catch {
            return false; // If we can't check, assume not busy
        }
    }

    /**
     * Wait for Antigravity to finish generating (stop button disappears).
     * Returns true if idle within timeout, false if still busy.
     */
    async function waitForIdle(cdp: CdpService, maxWaitMs: number = 300_000): Promise<boolean> {
        const checkIntervalMs = 10_000; // Check every 10 seconds
        const maxChecks = Math.ceil(maxWaitMs / checkIntervalMs);

        for (let i = 0; i < maxChecks; i++) {
            const busy = await isAntigravityBusy(cdp);
            if (!busy) return true;
            logger.debug(`[ScheduleJob] Antigravity is busy, waiting... (${i + 1}/${maxChecks})`);
            await new Promise(r => setTimeout(r, checkIntervalMs));
        }
        return false;
    }

    // Shared notification function — gets wired up once Telegram platform initializes.
    // scheduleJobCallback can call this to broadcast cron results to all bound chats.
    let telegramNotify: ((text: string) => Promise<void>) | null = null;

    // ClawCommandInterceptor — scans AI output for @claw directives and auto-executes them.
    // Declared here (before scheduleJobCallback) so the callback can reference it.
    let clawInterceptor: ClawCommandInterceptor | null = null;

    // Resolve Claw workspace — dedicated directory for the agent's tasks and memory.
    // This keeps scheduled work isolated from the user's active conversations.
    const clawWorkspacePath = config.clawWorkspace
        ?? path.join(config.workspaceBaseDir, '__claw__');

    // Ensure the Claw workspace directory exists
    if (!fs.existsSync(clawWorkspacePath)) {
        fs.mkdirSync(clawWorkspacePath, { recursive: true });
        logger.info(`[Claw] Created agent workspace: ${clawWorkspacePath}`);
    }

    // Auto-launch Antigravity with the agent workspace if not already open.
    // This ensures scheduled tasks always have a dedicated CDP endpoint.
    // Only launch if there are active schedules — avoids opening an empty
    // Antigravity window on every startup when no cron tasks are configured.
    const enabledSchedules = scheduleRepo.findEnabled();
    if (enabledSchedules.length === 0) {
        logger.debug('[Claw] No enabled schedules — skipping dedicated Antigravity auto-launch');
    } else {
        logger.info(`[Claw] ${enabledSchedules.length} enabled schedule(s) found — ensuring dedicated Antigravity instance...`);
        (async () => {
            const http = await import('http');
            const { execFile } = await import('child_process');
            const { CDP_PORTS } = await import('../utils/cdpPorts');
            const clawProjectName = path.basename(clawWorkspacePath);

            // Check if the agent workspace is already open in a DEDICATED Antigravity instance.
            // A port is "dedicated" if it only contains the agent workbench pages,
            // i.e. not shared with the user's active projects.
            const checkPort = (port: number): Promise<{ titles: string[]; hasClaw: boolean }> => {
                return new Promise((resolve) => {
                    const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
                        let data = '';
                        res.on('data', (chunk: string) => (data += chunk));
                        res.on('end', () => {
                            try {
                                const tabs = JSON.parse(data);
                                const titles = tabs
                                    .filter((t: any) => t.type === 'page' && t.url?.includes('workbench'))
                                    .map((t: any) => t.title || '');
                                const hasClaw = titles.some((t: string) => t.includes(clawProjectName));
                                resolve({ titles, hasClaw });
                            } catch { resolve({ titles: [], hasClaw: false }); }
                        });
                    });
                    req.on('error', () => resolve({ titles: [], hasClaw: false }));
                    req.setTimeout(2000, () => { req.destroy(); resolve({ titles: [], hasClaw: false }); });
                });
            };

            for (const port of CDP_PORTS) {
                const { titles, hasClaw } = await checkPort(port);
                if (hasClaw) {
                    // Check if this port is dedicated to the agent workspace only
                    const nonClawTitles = titles.filter(t => !t.includes(clawProjectName));
                    if (nonClawTitles.length === 0) {
                        // Only the agent workspace on this port — it's a dedicated instance
                        logger.info(`[Claw] "${clawProjectName}" workspace already open on DEDICATED CDP port ${port}`);
                        return;
                    } else {
                        // Shared port — agent workspace is open in the user's window, need a separate one
                        logger.warn(
                            `[Claw] "${clawProjectName}" found on CDP port ${port} but shared with: ${nonClawTitles.join(', ')}. ` +
                            `Launching a dedicated instance...`
                        );
                        // Don't return — fall through to launch a new window
                    }
                }
            }

            // Find an available port (one that is NOT responding = free)
            const net = await import('net');
            const isPortFree = (port: number): Promise<boolean> => {
                return new Promise((resolve) => {
                    const server = net.createServer();
                    server.once('error', () => resolve(false));
                    server.once('listening', () => { server.close(() => resolve(true)); });
                    server.listen(port, '127.0.0.1');
                });
            };

            let freePort: number | null = null;
            for (const port of CDP_PORTS) {
                if (await isPortFree(port)) {
                    freePort = port;
                    break;
                }
            }

            if (!freePort) {
                logger.warn(`[Claw] No free CDP port available to auto-launch "${clawProjectName}" workspace. Scheduled tasks may fail.`);
                return;
            }

            logger.info(`[Claw] Launching Antigravity for "${clawProjectName}" workspace on CDP port ${freePort}...`);
            try {
                const { getAntigravityCliPath: getCliPath } = await import('../utils/pathUtils');
                const antigravityCli = getCliPath();
                const { spawn } = await import('child_process');
                const child = spawn(antigravityCli, [
                    '--new-window',
                    `--remote-debugging-port=${freePort}`,
                    clawWorkspacePath,
                ], { stdio: 'ignore', detached: true });
                child.unref();
                child.once('error', (err) => {
                    logger.warn(`[Claw] Failed to launch Antigravity: ${err?.message || err}`);
                });
                logger.info(`[Claw] Antigravity launched for "${clawProjectName}" workspace (port ${freePort})`);
            } catch (err: any) {
                logger.warn(`[Claw] Failed to auto-launch Antigravity: ${err?.message || err}`);
            }
        })();
    } // end: else (enabledSchedules.length > 0)

    // Auto-generate GEMINI.md — Antigravity reads this to learn about @claw commands.
    // Regenerated on every boot to keep instructions up-to-date.
    const geminiMdPath = path.join(clawWorkspacePath, 'GEMINI.md');
    const geminiMdContent = [
        '# 🦞 ClawGravity Agent Instructions',
        '',
        '> This workspace is your dedicated home for autonomous operations.',
        '> You can invoke ClawGravity features and manage your own scheduled tasks.',
        '',
        '## Heartbeat System',
        '',
        '`HEARTBEAT.md` is your periodic task checklist. When a heartbeat cron fires,',
        'you will be asked to read and execute this checklist. The checklist is yours to edit.',
        '',
        'Example HEARTBEAT.md:',
        '```markdown',
        '- [ ] Check CLAW.md for pending tasks',
        '- [ ] Review any new files in this workspace',
        '- [ ] If nothing needs attention, reply with HEARTBEAT_OK',
        '```',
        '',
        'You can update HEARTBEAT.md at any time to change what your heartbeat checks for.',
        '',
        '## @claw Command Protocol',
        '',
        'To invoke ClawGravity features, include a `@claw` code block in your response.',
        'ClawGravity intercepts these blocks and executes them automatically.',
        '',
        '### Schedule a recurring task',
        '',
        '````',
        '```@claw',
        'action: schedule_add',
        'cron: */5 * * * *',
        'prompt: Read HEARTBEAT.md and execute the checklist. Update CLAW.md with results.',
        '```',
        '````',
        '',
        '- `cron`: Standard cron expression (minute hour day-of-month month day-of-week)',
        '- `prompt`: The message sent to you in a NEW session when the cron fires',
        '',
        '### List active schedules',
        '',
        '````',
        '```@claw',
        'action: schedule_list',
        '```',
        '````',
        '',
        '### Remove a schedule',
        '',
        '````',
        '```@claw',
        'action: schedule_remove',
        'id: 1',
        '```',
        '````',
        '',
        '## Persistent Memory',
        '',
        '**CLAW.md** — your persistent memory file. Read/write freely.',
        'Each scheduled task runs in a new chat session with NO previous context.',
        'CLAW.md is your ONLY way to persist state across sessions.',
        '',
        '## Multi-Agent Communication',
        '',
        'You can communicate with other Antigravity instances running on this machine.',
        'Each instance is identified by its workspace/project name.',
        '',
        '### List available agents',
        '',
        '````',
        '```@claw',
        'action: agent_list',
        '```',
        '````',
        '',
        '### Delegate a task to another agent',
        '',
        '````',
        '```@claw',
        'action: agent_send',
        'to: ProjectName',
        'message: Describe the task you want the sub-agent to perform.',
        '```',
        '````',
        '',
        '- The sub-agent runs the task in a new isolated session.',
        '- A concise **summary** is automatically extracted and injected back into your conversation.',
        '- The full output is saved to a file (path shown in result). Use `agent_read` if you need the full details.',
        '- Use `agent_list` first to discover available agents.',
        '- The sub-agent sees your task with a `[Sub-Agent Task]` prefix.',
        '',
        '### Read an agent response',
        '',
        '````',
        '```@claw',
        'action: agent_read',
        'file: /path/to/response/file.md',
        '```',
        '````',
        '',
        '- Use this to read the full response after receiving a notification.',
        '- Only read when you need the full content — the preview may be sufficient.',
        '',
        '## Important Rules',
        '',
        '- Each scheduled task opens a **new session** — no conversation history carries over',
        '- Always read CLAW.md at the start of a scheduled task to restore context',
        '- Write important state back to CLAW.md before your response ends',
        '- This workspace is separate from the user\'s coding projects',
        '',
    ].join('\n');
    fs.writeFileSync(geminiMdPath, geminiMdContent, 'utf-8');
    logger.debug(`[Claw] GEMINI.md written to ${geminiMdPath}`);

    // Ensure HEARTBEAT.md exists — the agent's periodic task checklist
    const heartbeatPath = path.join(clawWorkspacePath, 'HEARTBEAT.md');
    if (!fs.existsSync(heartbeatPath)) {
        fs.writeFileSync(heartbeatPath, [
            '# 🦞 Heartbeat Checklist',
            '',
            '> This checklist runs on each heartbeat. Edit it to customize your periodic tasks.',
            '',
            '- [ ] Read CLAW.md for any pending tasks or reminders',
            '- [ ] Check if there are any new files or changes in this workspace',
            '- [ ] If nothing needs attention, reply with HEARTBEAT_OK',
            '',
        ].join('\n'), 'utf-8');
        logger.info(`[Claw] Created heartbeat checklist: ${heartbeatPath}`);
    }

    // Also ensure CLAW.md memory file exists
    const clawMemoryPath = path.join(clawWorkspacePath, 'CLAW.md');
    if (!fs.existsSync(clawMemoryPath)) {
        fs.writeFileSync(clawMemoryPath, [
            '# 🦞 Claw Agent Memory',
            '',
            '> Persistent memory across scheduled tasks and sessions.',
            '> Write here to remember things between tasks.',
            '',
            '## Notes',
            '',
            '_No entries yet._',
            '',
        ].join('\n'), 'utf-8');
        logger.info(`[Claw] Created memory file: ${clawMemoryPath}`);
    }

    /**
     * Schedule job callback: dispatches the prompt to Antigravity via CDP.
     * This runs when a cron-scheduled task fires.
     *
     * Execution flow:
     *   1. Connect CDP to the dedicated agent workspace (separate Antigravity instance)
     *   2. Wait for any previous task to finish (busy detection)
     *   3. Open a new chat session (isolation)
     *   4. Inject the scheduled prompt
     *
     * IMPORTANT: The agent workspace must be opened in a SEPARATE Antigravity
     * window for scheduled tasks to work without interfering with the user.
     */
    const scheduleJobCallback = async (schedule: ScheduleRecord) => {
        logger.info(`[ScheduleJob] Firing schedule #${schedule.id}: "${schedule.prompt.slice(0, 80)}..." → claw-workspace=${clawWorkspacePath}`);
        try {
            const cdp = await bridge.pool.getOrConnect(clawWorkspacePath);
            const projectName = bridge.pool.extractProjectName(clawWorkspacePath);

            // Safety check: is the claw workspace currently generating from a previous task?
            const busy = await isAntigravityBusy(cdp);
            if (busy) {
                logger.warn(`[ScheduleJob] Schedule #${schedule.id}: Claw workspace is busy — waiting for previous task...`);

                const becameIdle = await waitForIdle(cdp, 300_000);
                if (!becameIdle) {
                    logger.error(`[ScheduleJob] Schedule #${schedule.id}: Still busy after 5min — SKIPPING`);
                    return;
                }

                logger.info(`[ScheduleJob] Schedule #${schedule.id}: Claw workspace idle — proceeding`);
                await new Promise(r => setTimeout(r, 3000));
            }

            bridge.lastActiveWorkspace = projectName;

            // Open a new Antigravity session for this task
            const newChatResult = await chatSessionService.startNewChat(cdp);
            if (newChatResult.ok) {
                logger.debug(`[ScheduleJob] Schedule #${schedule.id}: New session opened`);
                await new Promise(r => setTimeout(r, 1500));
            } else {
                logger.warn(`[ScheduleJob] Schedule #${schedule.id}: Could not open new session: ${newChatResult.error}`);
            }

            const injectResult = await cdp.injectMessage(schedule.prompt);
            if (!injectResult.ok) {
                logger.error(`[ScheduleJob] Schedule #${schedule.id} inject failed: ${injectResult.error}`);
                return;
            }

            logger.done(`[ScheduleJob] Schedule #${schedule.id} prompt injected — monitoring response...`);

            const grpcClient = await cdp.getGrpcClient();
            const cascadeId = injectResult.cascadeId || (grpcClient ? await cdp.getActiveCascadeId() : null);
            if (!grpcClient || !cascadeId) {
                logger.error(`[ScheduleJob] Schedule #${schedule.id}: gRPC monitor unavailable`);
                if (telegramNotify) {
                    await (telegramNotify as (text: string) => Promise<void>)(
                        `🦞 Schedule #${schedule.id} failed: gRPC monitor unavailable.`,
                    ).catch(() => { });
                }
                return;
            }

            // Monitor the AI response and relay to Telegram
            const monitor = new GrpcResponseMonitor({
                grpcClient,
                cascadeId,
                maxDurationMs: 300_000,
                onComplete: async (finalText) => {
                    let outputText = finalText?.trim() || '';
                    if (outputText.length === 0) {
                        logger.warn(`[ScheduleJob] Schedule #${schedule.id}: Empty response from Antigravity`);
                        return;
                    }

                    const MAX_CLAW_DEPTH = 3;
                    let clawDepth = 0;

                    // Process response — handle @claw command chains with follow-up injection
                    while (true) {
                        const label = clawDepth > 0 ? ` (follow-up #${clawDepth})` : '';
                        logger.divider(`Schedule #${schedule.id} Response${label}`);
                        console.info(outputText.slice(0, 500));
                        logger.divider();

                        // Broadcast to Telegram
                        if (telegramNotify) {
                            const header = `🦞 <b>Schedule #${schedule.id}${label}</b>\n\n`;
                            const truncated = outputText.length > 3500 ? outputText.slice(0, 3500) + '...' : outputText;
                            await (telegramNotify as (text: string) => Promise<void>)(header + truncated).catch((e: any) =>
                                logger.error(`[ScheduleJob] Telegram notify failed:`, e?.message || e)
                            );
                        }

                        // Intercept @claw commands
                        const interceptor = clawInterceptor;
                        if (!interceptor || clawDepth >= MAX_CLAW_DEPTH) break;

                        const results = await interceptor.execute(outputText);
                        if (results.length === 0) break;

                        for (const r of results) {
                            logger.info(`[ScheduleJob] @claw:${r.command.action} → ${r.success ? 'OK' : 'FAIL'}: ${r.message}`);
                        }

                        // Format results and inject back into Antigravity for AI continuation
                        const resultLines = results.map(r =>
                            `@claw:${r.command.action} — ${r.success ? 'OK' : 'FAIL'}\n${r.message}`
                        );
                        const feedback = `[ClawGravity Command Results]\n\n${resultLines.join('\n\n')}`;

                        await new Promise(r => setTimeout(r, 2000));
                        const injectResult = await cdp.injectMessage(feedback);
                        if (!injectResult.ok) {
                            logger.error(`[ScheduleJob] Failed to inject @claw results: ${injectResult.error}`);
                            break;
                        }

                        logger.done(`[ScheduleJob] @claw results injected — awaiting follow-up (depth=${clawDepth + 1})...`);

                        // Wait for the follow-up AI response
                        const followUpGrpcClient = await cdp.getGrpcClient();
                        const followUpCascadeId = injectResult.cascadeId || (followUpGrpcClient ? await cdp.getActiveCascadeId() : null);
                        if (!followUpGrpcClient || !followUpCascadeId) {
                            logger.error(`[ScheduleJob] Schedule #${schedule.id}: gRPC monitor unavailable for @claw follow-up`);
                            break;
                        }

                        outputText = await new Promise<string>((resolve) => {
                            const followUp = new GrpcResponseMonitor({
                                grpcClient: followUpGrpcClient,
                                cascadeId: followUpCascadeId,
                                maxDurationMs: 300_000,
                                onComplete: async (text) => resolve(text?.trim() || ''),
                                onTimeout: async () => {
                                    logger.warn(`[ScheduleJob] @claw follow-up timed out (depth=${clawDepth + 1})`);
                                    resolve('');
                                },
                            });
                            followUp.start();
                        });

                        clawDepth++;
                        if (outputText.length === 0) break;
                    }
                },
                onTimeout: async (lastText) => {
                    logger.warn(`[ScheduleJob] Schedule #${schedule.id}: Response timed out`);
                    if (telegramNotify && lastText) {
                        await (telegramNotify as (text: string) => Promise<void>)(`🦞 Schedule #${schedule.id} timed out:\n\n${lastText.slice(0, 2000)}`).catch(() => { });
                    }
                },
            });
            monitor.start();

        } catch (err: any) {
            const msg = err?.message || String(err);
            if (msg.includes('No matching') || msg.includes('ECONNREFUSED') || msg.includes('not found')) {
                logger.error(`[ScheduleJob] Schedule #${schedule.id}: Cannot connect to "${path.basename(clawWorkspacePath)}" workspace. Please open "${clawWorkspacePath}" in a separate Antigravity window.`);
            } else {
                logger.error(`[ScheduleJob] Schedule #${schedule.id} failed:`, msg);
            }
        }
    };

    // Restore persisted schedules on startup
    const restoredCount = scheduleService.restoreAll(scheduleJobCallback);
    if (restoredCount > 0) {
        logger.info(`[Schedule] Restored ${restoredCount} scheduled task(s)`);
    }

    // Create AgentRouter for multi-agent communication
    const agentRouter = new AgentRouter({
        pool: bridge.pool,
        chatSessionService,
        workspaceService,
        extractionMode: config.extractionMode,
    });
    logger.info(`[Claw] Agent router ready — multi-agent communication enabled`);

    // Now instantiate the interceptor (after scheduleJobCallback is defined)
    clawInterceptor = new ClawCommandInterceptor({
        scheduleService,
        jobCallback: scheduleJobCallback,
        clawWorkspacePath,
        agentRouter,
        onAgentResponse: async (fromAgent: string, summary: string, outputPath: string) => {
            // Inject the concise summary back to the parent agent (context-safe)
            try {
                const senderCdp = getCurrentCdp(bridge);
                if (senderCdp) {
                    const notification = [
                        `[Sub-Agent Result from: ${fromAgent}]`,
                        '',
                        summary,
                        '',
                        outputPath ? `Full output saved to: ${outputPath}` : '',
                    ].filter(Boolean).join('\n');

                    await senderCdp.injectMessage(notification);
                    logger.done(`[Claw] Injected sub-agent summary from "${fromAgent}" (${summary.length} chars)`);
                } else {
                    logger.warn(`[Claw] Cannot inject sub-agent result from "${fromAgent}": no active CDP connection`);
                }
            } catch (err: any) {
                logger.error(`[Claw] Failed to inject sub-agent result: ${err?.message || err}`);
            }
        },
    });
    logger.info(`[Claw] Command interceptor ready — @claw directives in AI responses will auto-execute`);

    // Discord platform — only initialise the Discord client when the platform is enabled
    if (config.platforms.includes('discord')) {

        if (!config.discordToken || !config.clientId) {
            logger.error('Discord platform enabled but discordToken or clientId is missing. Skipping Discord initialization.');
        } else {

            const discordToken = config.discordToken;
            const discordClientId = config.clientId;

            const client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent,
                ]
            });

            const joinHandler = new JoinCommandHandler(chatSessionService, chatSessionRepo, workspaceBindingRepo, channelManager, bridge.pool, workspaceService, client, config.extractionMode);

            client.once(Events.ClientReady, async (readyClient) => {
                logger.info(`Ready! Logged in as ${readyClient.user.tag} | extractionMode=${config.extractionMode}`);

                try {
                    await registerSlashCommands(discordToken, discordClientId, config.guildId);
                } catch (error) {
                    logger.warn('Failed to register slash commands, but text commands remain available.');
                }

                // Startup dashboard embed
                try {
                    const os = await import('os');
                    const pkg = await import('../../package.json');
                    const version = pkg.default?.version ?? pkg.version ?? 'unknown';
                    const projects = workspaceService.scanWorkspaces();

                    // Eagerly connect CDP to read actual model/mode from Antigravity UI
                    let cdpModel: string | null = null;
                    let cdpMode: string | null = null;
                    if (projects.length > 0) {
                        try {
                            const cdp = await bridge.pool.getOrConnect(projects[0]);
                            cdpModel = await cdp.getCurrentModel();
                            cdpMode = await cdp.getCurrentMode();
                        } catch (e) {
                            logger.debug('Startup CDP probe failed (will use defaults):', e instanceof Error ? e.message : e);
                        }
                    }

                    // Check CDP connection status
                    const activeWorkspaces = bridge.pool.getActiveWorkspaceNames();
                    const cdpStatus = activeWorkspaces.length > 0
                        ? `Connected (${activeWorkspaces.join(', ')})`
                        : 'Not connected';

                    const startupModel = cdpModel || modelService.getDefaultModel() || modelService.getCurrentModel() || 'Not synced';
                    const startupMode = cdpMode || modeService.getCurrentMode();
                    // Sync model service with actual UI state
                    if (cdpModel) modelService.setModel(cdpModel, true);
                    if (cdpMode) modeService.setMode(cdpMode);

                    const dashboardEmbed = new EmbedBuilder()
                        .setTitle('ClawGravity Online')
                        .setColor(0x57F287)
                        .addFields(
                            { name: 'Version', value: version, inline: true },
                            { name: 'Node.js', value: process.versions.node, inline: true },
                            { name: 'OS', value: `${os.platform()} ${os.release()}`, inline: true },
                            { name: 'CDP', value: cdpStatus, inline: true },
                            { name: 'Model', value: startupModel, inline: true },
                            { name: 'Mode', value: startupMode, inline: true },
                            { name: 'Projects', value: `${projects.length} registered`, inline: true },
                            { name: 'Extraction', value: config.extractionMode, inline: true },
                        )
                        .setFooter({ text: `Started at ${new Date().toLocaleString()}` })
                        .setTimestamp();

                    // Send to the first available text channel in the guild
                    const guild = readyClient.guilds.cache.first();
                    if (guild) {
                        const channel = guild.channels.cache.find(
                            (ch) => ch.isTextBased() && !ch.isVoiceBased() && ch.permissionsFor(readyClient.user)?.has('SendMessages'),
                        );
                        if (channel && channel.isTextBased()) {
                            await channel.send({ embeds: [dashboardEmbed] });
                            logger.info('Startup dashboard embed sent.');
                        }
                    }
                } catch (error) {
                    logger.warn('Failed to send startup dashboard embed:', error);
                }

                try {
                    await restoreDiscordSessionsOnStartup(
                        client,
                        bridge,
                        workspaceBindingRepo,
                        chatSessionRepo,
                        workspaceService,
                        chatSessionService,
                    );
                } catch (error) {
                    logger.warn('Failed to restore Discord sessions on startup:', error);
                }
            });

            registerShutdownHook('platform:discord', () => {
                client.destroy();
            });

            // [Discord Interactions API] Slash command interaction handler
            client.on(Events.InteractionCreate, createInteractionCreateHandler({
                config,
                bridge,
                cleanupHandler,
                modeService,
                modelService,
                slashCommandHandler,
                wsHandler,
                chatHandler,
                client,
                sendModeUI,
                sendModelsUI,
                sendAutoAcceptUI,
                getCurrentCdp,
                parseApprovalCustomId,
                parseErrorPopupCustomId,
                parsePlanningCustomId,
                parseRunCommandCustomId,
                joinHandler,
                userPrefRepo,
                handleSlashInteraction: async (
                    interaction,
                    handler,
                    bridgeArg,
                    wsHandlerArg,
                    chatHandlerArg,
                    cleanupHandlerArg,
                    modeServiceArg,
                    modelServiceArg,
                    autoAcceptServiceArg,
                    clientArg,
                ) => handleSlashInteraction(
                    interaction,
                    handler,
                    bridgeArg,
                    wsHandlerArg,
                    chatHandlerArg,
                    cleanupHandlerArg,
                    modeServiceArg,
                    modelServiceArg,
                    autoAcceptServiceArg,
                    clientArg,
                    promptDispatcher,
                    templateRepo,
                    joinHandler,
                    userPrefRepo,
                    scheduleService,
                    scheduleJobCallback,
                ),
                handleTemplateUse: async (interaction, templateId) => {
                    const template = templateRepo.findById(templateId);
                    if (!template) {
                        await interaction.followUp({
                            content: 'Template not found. It may have been deleted.',
                            flags: MessageFlags.Ephemeral,
                        });
                        return;
                    }

                    // Resolve CDP via workspace binding (same flow as text messages)
                    const channelId = interaction.channelId;
                    const workspacePath = wsHandler.getWorkspaceForChannel(channelId);

                    let cdp: CdpService | null = null;
                    if (workspacePath) {
                        try {
                            cdp = await bridge.pool.getOrConnect(workspacePath);
                            const projectName = bridge.pool.extractProjectName(workspacePath);
                            bridge.lastActiveWorkspace = projectName;
                            const platformCh = wrapDiscordChannel(interaction.channel as any);
                            bridge.lastActiveChannel = platformCh;
                            registerApprovalWorkspaceChannel(bridge, projectName, platformCh);
                            const session = chatSessionRepo.findByChannelId(channelId);
                            if (session?.displayName) {
                                registerApprovalSessionChannel(bridge, projectName, session.displayName, platformCh);
                            }
                            ensureApprovalDetector(bridge, cdp, projectName);
                            ensureErrorPopupDetector(bridge, cdp, projectName);
                            ensurePlanningDetector(bridge, cdp, projectName);
                            ensureRunCommandDetector(bridge, cdp, projectName);
                        } catch (e: any) {
                            await interaction.followUp({
                                content: `Failed to connect to workspace: ${e.message}`,
                                flags: MessageFlags.Ephemeral,
                            });
                            return;
                        }
                    } else {
                        cdp = getCurrentCdp(bridge);
                    }

                    if (!cdp) {
                        await interaction.followUp({
                            content: 'Not connected to CDP. Please connect to a project first.',
                            flags: MessageFlags.Ephemeral,
                        });
                        return;
                    }

                    const followUp = await interaction.followUp({
                        content: `Executing template **${template.name}**...`,
                    });

                    if (followUp instanceof Message) {
                        await promptDispatcher.send({
                            message: followUp,
                            prompt: template.prompt,
                            cdp,
                            inboundImages: [],
                            options: {
                                chatSessionService,
                                chatSessionRepo,
                                channelManager,
                                titleGenerator,
                                userPrefRepo,
                                extractionMode: config.extractionMode,
                            },
                        });
                    }
                },
            }));

            // [Text message handler]
            client.on(Events.MessageCreate, createMessageCreateHandler({
                config,
                bridge,
                modeService,
                modelService,
                slashCommandHandler,
                wsHandler,
                chatSessionService,
                chatSessionRepo,
                channelManager,
                titleGenerator,
                client,
                sendPromptToAntigravity: async (
                    _bridge,
                    message,
                    prompt,
                    cdp,
                    _modeService,
                    _modelService,
                    inboundImages = [],
                    options,
                ) => promptDispatcher.send({
                    message,
                    prompt,
                    cdp,
                    inboundImages,
                    options,
                }),
                autoRenameChannel,
                handleScreenshot,
                userPrefRepo,
            }));

            await client.login(discordToken);

        } // end: else (credentials present)
    } // end: Discord platform gate

    // Telegram platform
    if (config.platforms.includes('telegram') && config.telegramToken) {
        try {
            const telegramBot = new Bot(config.telegramToken);
            // Attach toInputFile so wrappers can convert Buffer to grammY InputFile
            (telegramBot as any).toInputFile = (data: Buffer, filename?: string) => new InputFile(data, filename);
            // Retry getMe() up to 3 times to handle transient network failures
            const botInfo = await (async () => {
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        return await telegramBot.api.getMe();
                    } catch (err: any) {
                        if (attempt === 3) throw err;
                        logger.warn(`[Telegram] getMe() failed (attempt ${attempt}/3): ${err?.message ?? err}. Retrying in 3s...`);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
                throw new Error('getMe() failed after 3 attempts');
            })();

            const telegramBindingRepo = new TelegramBindingRepository(db);
            const telegramRecentMessageRepo = new TelegramRecentMessageRepository(db);
            const telegramAdapter = new TelegramAdapter(telegramBot as any, String(botInfo.id));
            const telegramSessionStateStore = new TelegramSessionStateStore(telegramRecentMessageRepo);

            const activeMonitors = new Map<string, GrpcResponseMonitor>();
            const telegramHandler = createTelegramMessageHandler({
                bridge,
                telegramBindingRepo,
                workspaceService,
                modeService,
                modelService,
                extractionMode: config.extractionMode,
                templateRepo,
                fetchQuota: () => bridge.quota.fetchQuota(),
                activeMonitors,
                botToken: config.telegramToken,
                botApi: telegramBot.api as any,
                chatSessionService,
                sessionStateStore: telegramSessionStateStore,
                scheduleService,
                scheduleJobCallback,
                clawInterceptor,
            });

            // Wire up the telegramNotify function so scheduled tasks can broadcast to Telegram
            telegramNotify = async (text: string) => {
                // Only send to direct/private chats (positive chatId), not group chats
                const bindings = telegramBindingRepo.findAll()
                    .filter((b: { chatId: string }) => !b.chatId.startsWith('-'));
                if (bindings.length === 0) return;
                const results = await Promise.allSettled(
                    bindings.map((b: { chatId: string }) =>
                        telegramBot.api.sendMessage(b.chatId, text, { parse_mode: 'HTML' })
                    ),
                );
                const failed = results.filter((r: PromiseSettledResult<unknown>) => r.status === 'rejected');
                if (failed.length > 0) {
                    logger.warn(`[Claw] Telegram notify failed for ${failed.length}/${bindings.length} chat(s)`);
                }
            };
            logger.debug(`[Claw] Telegram notify wired up for schedule results`);

            // Compose select handlers: project select + mode select
            const projectSelectHandler = createTelegramSelectHandler({
                workspaceService,
                telegramBindingRepo,
            });
            const joinSelectHandler = createTelegramJoinSelectHandler({
                bridge,
                telegramBindingRepo,
                workspaceService,
                chatSessionService,
                sessionStateStore: telegramSessionStateStore,
            });
            const modeSelectAction = createModeSelectAction({ bridge, modeService });
            const telegramSelectHandler = createPlatformSelectHandler({
                actions: [
                    modeSelectAction,
                ],
            });
            // Composite handler that routes to the right handler
            const compositeSelectHandler = async (interaction: import('../platform/types').PlatformSelectInteraction) => {
                if (interaction.customId === 'mode_select') {
                    await telegramSelectHandler(interaction);
                    return;
                }
                if (interaction.customId === 'tg_join_select') {
                    await joinSelectHandler(interaction);
                    return;
                }
                await projectSelectHandler(interaction);
            };

            const allowedUsers = new Map<PlatformType, ReadonlySet<string>>();
            if (config.telegramAllowedUserIds && config.telegramAllowedUserIds.length > 0) {
                allowedUsers.set('telegram', new Set(config.telegramAllowedUserIds));
            } else {
                logger.warn('Telegram platform enabled but TELEGRAM_ALLOWED_USER_IDS is empty — all users will be denied access.');
            }

            const telegramButtonHandler = createPlatformButtonHandler({
                actions: [
                    createApprovalButtonAction({ bridge }),
                    createPlanningButtonAction({ bridge }),
                    createErrorPopupButtonAction({ bridge }),
                    createRunCommandButtonAction({ bridge }),
                    createModelButtonAction({ bridge, fetchQuota: () => bridge.quota.fetchQuota(), modelService, userPrefRepo }),
                    createAutoAcceptButtonAction({ autoAcceptService: bridge.autoAccept }),
                    createTemplateButtonAction({ bridge, templateRepo }),
                ],
            });

            const eventRouter = new EventRouter(
                { allowedUsers },
                {
                    onMessage: telegramHandler,
                    onButtonInteraction: telegramButtonHandler,
                    onSelectInteraction: compositeSelectHandler,
                },
            );
            // Register bot commands BEFORE starting polling so Telegram shows "/" suggestions
            await telegramBot.api.setMyCommands([
                { command: 'start', description: 'Welcome message' },
                { command: 'project', description: 'Manage workspace bindings' },
                { command: 'status', description: 'Show bot status and connections' },
                { command: 'mode', description: 'Switch execution mode' },
                { command: 'model', description: 'Switch LLM model' },
                { command: 'screenshot', description: 'Capture Antigravity screenshot' },
                { command: 'autoaccept', description: 'Toggle auto-accept mode' },
                { command: 'template', description: 'List prompt templates' },
                { command: 'template_add', description: 'Add a prompt template' },
                { command: 'template_delete', description: 'Delete a prompt template' },
                { command: 'project_create', description: 'Create a new workspace' },
                { command: 'new', description: 'Start a new chat session' },
                { command: 'clear', description: 'Clear conversation history' },
                { command: 'history', description: 'View a history session' },
                { command: 'schedule', description: 'List scheduled tasks' },
                { command: 'schedule_add', description: 'Add a scheduled task' },
                { command: 'schedule_remove', description: 'Remove a scheduled task' },
                { command: 'logs', description: 'Show recent log entries' },
                { command: 'stop', description: 'Interrupt active LLM generation' },
                { command: 'restart', description: 'Fully restart the bot process' },
                { command: 'help', description: 'Show available commands' },
                { command: 'ping', description: 'Check bot latency' },
            ]).catch((e: unknown) => {
                logger.warn('Failed to register Telegram commands:', e instanceof Error ? e.message : e);
            });

            eventRouter.registerAdapter(telegramAdapter);
            await eventRouter.startAll();

            registerShutdownHook('platform:telegram', async () => {
                for (const monitor of activeMonitors.values()) {
                    await monitor.stop().catch(() => { });
                }
                activeMonitors.clear();
                await eventRouter.stopAll();
            });

            logger.info(`Telegram bot started: @${botInfo.username} (${config.telegramAllowedUserIds?.length ?? 0} allowed users)`);

            // Send startup message to all bound Telegram chats
            const bindings = telegramBindingRepo.findAll();
            if (bindings.length > 0) {
                const os = await import('os');
                const pkg = await import('../../package.json');
                const version = pkg.default?.version ?? pkg.version ?? 'unknown';
                const projects = workspaceService.scanWorkspaces();

                // Eagerly connect CDP to read actual model/mode from Antigravity UI
                let tgCdpModel: string | null = null;
                let tgCdpMode: string | null = null;
                if (projects.length > 0) {
                    try {
                        const cdp = await bridge.pool.getOrConnect(projects[0]);
                        tgCdpModel = await cdp.getCurrentModel();
                        tgCdpMode = await cdp.getCurrentMode();
                    } catch (e) {
                        logger.debug('Telegram startup CDP probe failed (will use defaults):', e instanceof Error ? e.message : e);
                    }
                }

                const activeWorkspaces = bridge.pool.getActiveWorkspaceNames();
                const cdpStatus = activeWorkspaces.length > 0
                    ? `Connected (${activeWorkspaces.join(', ')})`
                    : 'Not connected';

                const tgStartupModel = tgCdpModel || modelService.getDefaultModel() || modelService.getCurrentModel() || 'Not synced';
                const tgStartupMode = tgCdpMode || modeService.getCurrentMode();
                // Sync model service with actual UI state
                if (tgCdpModel) modelService.setModel(tgCdpModel, true);
                if (tgCdpMode) modeService.setMode(tgCdpMode);

                const startupText = [
                    '<b>ClawGravity Online</b>',
                    '',
                    `Version: ${version}`,
                    `Node.js: ${process.versions.node}`,
                    `OS: ${os.platform()} ${os.release()}`,
                    `CDP: ${cdpStatus}`,
                    `Model: ${tgStartupModel}`,
                    `Mode: ${tgStartupMode}`,
                    `Projects: ${projects.length} registered`,
                    `Extraction: ${config.extractionMode}`,
                    '',
                    `<i>Started at ${new Date().toLocaleString()}</i>`,
                ].join('\n');

                const sendWithRetry = async (chatId: number | string, text: string, retries = 3, delayMs = 2000): Promise<void> => {
                    for (let attempt = 1; attempt <= retries; attempt++) {
                        try {
                            await telegramBot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
                            return;
                        } catch (err) {
                            if (attempt < retries) {
                                logger.debug(`[Telegram] Startup message attempt ${attempt}/${retries} failed, retrying in ${delayMs}ms...`);
                                await new Promise((r) => setTimeout(r, delayMs));
                            } else {
                                throw err;
                            }
                        }
                    }
                };

                const results = await Promise.allSettled(
                    bindings.map((binding) => sendWithRetry(binding.chatId, startupText)),
                );
                const failed = results.filter((r) => r.status === 'rejected');
                if (failed.length > 0) {
                    logger.warn(`[Telegram] Startup message failed for ${failed.length}/${bindings.length} chat(s) after retries: ${(failed[0] as PromiseRejectedResult).reason?.message ?? 'unknown error'}`);
                } else {
                    logger.info(`Telegram startup message sent to ${bindings.length} bound chat(s).`);
                }

                // Eagerly start passive mirroring for all bound workspaces
                // so that PC-typed messages are forwarded to Telegram even if the user
                // never sends a message from Telegram first.
                for (const binding of bindings) {
                    try {
                        const bWorkspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
                        const cdp = await bridge.pool.getOrConnect(bWorkspacePath);
                        const bProjectName = bridge.pool.extractProjectName(bWorkspacePath);
                        const tgChannel = wrapTelegramChannel(telegramBot.api as any, binding.chatId, (data: Buffer, filename?: string) => new InputFile(data, filename));

                        // Start the UserMessageDetector with passive notification callback
                        ensureUserMessageDetector(bridge, cdp, bProjectName, (info) => {
                            handlePassiveUserMessage(tgChannel, cdp, bProjectName, info, activeMonitors, config.extractionMode)
                                .catch((err: any) => logger.error('[TelegramPassive:Startup] Error handling PC message:', err?.message || err));
                        });
                        logger.info(`[TelegramPassive] Eager mirroring started for ${bProjectName} → chat ${binding.chatId}`);
                    } catch (e: any) {
                        logger.warn(`[TelegramPassive] Failed to start eager mirroring for ${binding.workspacePath}: ${e?.message || e}`);
                    }
                }
            }
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            logger.error('Failed to start Telegram adapter:', message);
        }
    }
};

/**
 * Auto-rename channel on first message send
 */
async function autoRenameChannel(
    message: Message,
    chatSessionRepo: ChatSessionRepository,
    titleGenerator: TitleGeneratorService,
    channelManager: ChannelManager,
    cdp?: CdpService,
): Promise<void> {
    const session = chatSessionRepo.findByChannelId(message.channelId);
    if (!session || session.isRenamed) return;

    const guild = message.guild;
    if (!guild) return;

    try {
        const title = await titleGenerator.generateTitle(message.content, cdp);
        const newName = `${session.sessionNumber}-${title}`;
        await channelManager.renameChannel(guild, message.channelId, newName);
        chatSessionRepo.updateDisplayName(message.channelId, title);
    } catch (err) {
        logger.error('[AutoRename] Rename failed:', err);
    }
}

/**
 * Handle Discord Interactions API slash commands
 */
async function handleSlashInteraction(
    interaction: ChatInputCommandInteraction,
    handler: SlashCommandHandler,
    bridge: CdpBridge,
    wsHandler: WorkspaceCommandHandler,
    chatHandler: ChatCommandHandler,
    cleanupHandler: CleanupCommandHandler,
    modeService: ModeService,
    modelService: ModelService,
    autoAcceptService: AutoAcceptService,
    _client: Client,
    promptDispatcher: PromptDispatcher,
    templateRepo: TemplateRepository,
    joinHandler?: JoinCommandHandler,
    userPrefRepo?: UserPreferenceRepository,
    scheduleService?: ScheduleService,
    scheduleJobCallback?: (schedule: ScheduleRecord) => void,
): Promise<void> {
    const commandName = interaction.commandName;

    switch (commandName) {
        case 'help': {
            const helpFields = [
                {
                    name: '💬 Chat', value: [
                        '`/new` — Start a new chat session',
                        '`/clear` — Clear conversation history',
                        '`/chat` — Show current session info + list',
                    ].join('\n')
                },
                {
                    name: '🔗 Session', value: [
                        '`/history` — View an existing Antigravity session history',
                        '`/mirror` — Toggle PC→Discord mirroring ON/OFF',
                    ].join('\n')
                },
                {
                    name: '⏹️ Control', value: [
                        '`/stop` — Interrupt active LLM generation',
                        '`/screenshot` — Capture Antigravity screen',
                    ].join('\n')
                },
                {
                    name: '⚙️ Settings', value: [
                        '`/mode` — Display and change execution mode',
                        '`/model [name]` — Display and change LLM model',
                        '`/output [format]` — Toggle Embed / Plain Text output',
                    ].join('\n')
                },
                {
                    name: '📁 Projects', value: [
                        '`/project` — Display project list',
                        '`/project create <name>` — Create a new project',
                    ].join('\n')
                },
                {
                    name: '📝 Templates', value: [
                        '`/template list` — Show templates with execute buttons (click to run)',
                        '`/template add <name> <prompt>` — Register a template',
                        '`/template delete <name>` — Delete a template',
                    ].join('\n')
                },
                {
                    name: '🔧 System', value: [
                        '`/status` — Display overall bot status',
                        '`/autoaccept` — Toggle auto-approve mode for approval dialogs via buttons',
                        '`/schedule` — Manage scheduled tasks (add/list/remove)',
                        '`/restart` — Fully restart the bot process',
                        '`/logs [lines] [level]` — View recent bot logs',
                        '`/cleanup [days]` — Clean up unused channels/categories',
                        '`/help` — Show this help',
                    ].join('\n')
                },
            ];

            const helpOutputFormat = userPrefRepo?.getOutputFormat(interaction.user.id) ?? 'embed';
            if (helpOutputFormat === 'plain') {
                const chunks = formatAsPlainText({
                    title: '📖 ClawGravity Commands',
                    description: 'Commands for controlling Antigravity from Discord.',
                    fields: helpFields,
                    footerText: 'Text messages are sent directly to Antigravity',
                });
                await interaction.editReply({ content: chunks[0] });
                break;
            }

            const embed = new EmbedBuilder()
                .setTitle('📖 ClawGravity Commands')
                .setColor(0x5865F2)
                .setDescription('Commands for controlling Antigravity from Discord.')
                .addFields(...helpFields)
                .setFooter({ text: 'Text messages are sent directly to Antigravity' })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
        }

        case 'mode': {
            await sendModeUI(interaction, modeService, { getCurrentCdp: () => getCurrentCdp(bridge) });
            break;
        }

        case 'model': {
            const modelName = interaction.options.getString('name');
            if (!modelName) {
                await sendModelsUI(interaction, {
                    getCurrentCdp: () => getCurrentCdp(bridge),
                    fetchQuota: async () => bridge.quota.fetchQuota(),
                });
            } else {
                const cdp = getCurrentCdp(bridge);
                if (!cdp) {
                    await interaction.editReply({ content: 'Not connected to CDP.' });
                    break;
                }
                const res = await cdp.setUiModel(modelName);
                if (res.ok) {
                    await interaction.editReply({ content: `Model changed to **${res.model}**.` });
                } else {
                    await interaction.editReply({ content: res.error || 'Failed to change model.' });
                }
            }
            break;
        }

        case 'template': {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'list') {
                const templates = templateRepo.findAll();
                await sendTemplateUI(interaction, templates);
                break;
            }

            let args: string[];
            switch (subcommand) {
                case 'add': {
                    const name = interaction.options.getString('name', true);
                    const prompt = interaction.options.getString('prompt', true);
                    args = ['add', name, prompt];
                    break;
                }
                case 'delete': {
                    const name = interaction.options.getString('name', true);
                    args = ['delete', name];
                    break;
                }
                default:
                    args = [];
            }

            const result = await handler.handleCommand('template', args);
            await interaction.editReply({ content: result.message });
            break;
        }

        case 'status': {
            const activeNames = bridge.pool.getActiveWorkspaceNames();
            const currentModel = (() => {
                const cdp = getCurrentCdp(bridge);
                return cdp ? 'CDP Connected' : 'Disconnected';
            })();
            const currentMode = modeService.getCurrentMode();

            const mirroringWorkspaces = activeNames.filter(
                (name) => bridge.pool.getUserMessageDetector(name)?.isActive(),
            );
            const mirrorStatus = mirroringWorkspaces.length > 0
                ? `📡 ON (${mirroringWorkspaces.join(', ')})`
                : '⚪ OFF';

            const statusFields = [
                { name: 'CDP Connection', value: activeNames.length > 0 ? `🟢 ${activeNames.length} project(s) connected` : '⚪ Disconnected', inline: true },
                { name: 'Mode', value: MODE_DISPLAY_NAMES[currentMode] || currentMode, inline: true },
                { name: 'Auto Approve', value: autoAcceptService.isEnabled() ? '🟢 ON' : '⚪ OFF', inline: true },
                { name: 'Mirroring', value: mirrorStatus, inline: true },
            ];

            let statusDescription = '';
            if (activeNames.length > 0) {
                const lines = activeNames.map((name) => {
                    const cdp = bridge.pool.getConnected(name);
                    const contexts = cdp ? cdp.getContexts().length : 0;
                    const detectorActive = bridge.pool.getApprovalDetector(name)?.isActive() ? ' [Detecting]' : '';
                    const mirrorActive = bridge.pool.getUserMessageDetector(name)?.isActive() ? ' [Mirror]' : '';
                    return `• **${name}** — Contexts: ${contexts}${detectorActive}${mirrorActive}`;
                });
                statusDescription = `**Connected Projects:**\n${lines.join('\n')}`;
            } else {
                statusDescription = 'Send a message to auto-connect to a project.';
            }

            const statusOutputFormat = userPrefRepo?.getOutputFormat(interaction.user.id) ?? 'embed';
            if (statusOutputFormat === 'plain') {
                const chunks = formatAsPlainText({
                    title: '🔧 Bot Status',
                    description: statusDescription,
                    fields: statusFields,
                });
                await interaction.editReply({ content: chunks[0] });
                break;
            }

            const embed = new EmbedBuilder()
                .setTitle('🔧 Bot Status')
                .setColor(activeNames.length > 0 ? 0x00CC88 : 0x888888)
                .addFields(...statusFields)
                .setDescription(statusDescription)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            break;
        }

        case 'autoaccept': {
            const requestedMode = interaction.options.getString('mode');
            if (!requestedMode) {
                await sendAutoAcceptUI(interaction, autoAcceptService);
                break;
            }

            const result = autoAcceptService.handle(requestedMode);
            await interaction.editReply({ content: result.message });
            break;
        }

        case 'output': {
            if (!userPrefRepo) {
                await interaction.editReply({ content: 'Output preference service not available.' });
                break;
            }

            const requestedFormat = interaction.options.getString('format');
            if (!requestedFormat) {
                const currentFormat = userPrefRepo.getOutputFormat(interaction.user.id);
                await sendOutputUI(interaction, currentFormat);
                break;
            }

            const format: OutputFormat = requestedFormat === 'plain' ? 'plain' : 'embed';
            userPrefRepo.setOutputFormat(interaction.user.id, format);
            const label = format === 'plain' ? 'Plain Text' : 'Embed';
            await interaction.editReply({ content: `Output format changed to **${label}**.` });
            break;
        }

        case 'screenshot': {
            await handleScreenshot(interaction, getCurrentCdp(bridge));
            break;
        }

        case 'stop': {
            const cdp = getCurrentCdp(bridge);
            if (!cdp) {
                await interaction.editReply({ content: '⚠️ Not connected to CDP. Please connect to a project first.' });
                break;
            }

            try {
                const grpcClient = await cdp.getGrpcClient();
                const cascadeId = grpcClient ? await cdp.getActiveCascadeId() : null;
                if (!grpcClient || !cascadeId) {
                    const embed = new EmbedBuilder()
                        .setTitle('⚠️ Could Not Stop')
                        .setDescription('No active backend stream found.')
                        .setColor(0xF39C12)
                        .setTimestamp();
                    await interaction.editReply({ embeds: [embed] });
                    break;
                }

                await grpcClient.cancelCascade(cascadeId);
                userStopRequestedChannels.add(interaction.channelId);
                const embed = new EmbedBuilder()
                    .setTitle('⏹️ Generation Interrupted')
                    .setDescription('AI response generation was safely stopped.')
                    .setColor(0xE74C3C)
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            } catch (e: any) {
                await interaction.editReply({ content: `❌ Error during stop processing: ${e.message}` });
            }
            break;
        }

        case 'project': {
            const wsSub = interaction.options.getSubcommand(false);
            if (wsSub === 'create') {
                if (!interaction.guild) {
                    await interaction.editReply({ content: 'This command can only be used in a server.' });
                    break;
                }
                await wsHandler.handleCreate(interaction, interaction.guild);
            } else {
                // /project list or /project (default)
                await wsHandler.handleShow(interaction);
            }
            break;
        }

        case 'new': {
            await chatHandler.handleNew(interaction);
            break;
        }

        case 'clear': {
            await chatHandler.handleClear(interaction);
            break;
        }

        case 'chat': {
            await chatHandler.handleChat(interaction);
            break;
        }

        case 'history': {
            if (joinHandler) {
                await joinHandler.handleJoin(interaction, bridge);
            } else {
                await interaction.editReply({ content: t('⚠️ Join handler not available.') });
            }
            break;
        }

        case 'mirror': {
            if (joinHandler) {
                await joinHandler.handleMirror(interaction, bridge);
            } else {
                await interaction.editReply({ content: t('⚠️ Mirror handler not available.') });
            }
            break;
        }

        case 'cleanup': {
            await cleanupHandler.handleCleanup(interaction);
            break;
        }

        case 'ping': {
            const apiLatency = interaction.client.ws.ping;
            await interaction.editReply({ content: `🏓 Pong! API Latency is **${apiLatency}ms**.` });
            break;
        }

        case 'logs': {
            const lines = interaction.options.getInteger('lines') ?? 50;
            const level = interaction.options.getString('level') as LogLevel | null;
            const entries = logBuffer.getRecent(lines, level ?? undefined);

            if (entries.length === 0) {
                await interaction.editReply({ content: 'No log entries found.' });
                break;
            }

            const formatted = entries
                .map((e) => `${e.timestamp.slice(11, 19)} ${e.message}`)
                .join('\n');

            const MAX_CONTENT = 1900;
            const codeBlock = formatted.length <= MAX_CONTENT
                ? `\`\`\`\n${formatted}\n\`\`\``
                : `\`\`\`\n${formatted.slice(0, MAX_CONTENT)}\n\`\`\`\n(truncated — showing ${MAX_CONTENT} chars of ${formatted.length})`;

            await interaction.editReply({ content: codeBlock });
            break;
        }

        case 'schedule': {
            if (!scheduleService || !scheduleJobCallback) {
                await interaction.editReply({ content: '⚠️ Schedule service not available.' });
                break;
            }

            const scheduleSub = interaction.options.getSubcommand();

            if (scheduleSub === 'add') {
                const cronExpr = interaction.options.getString('cron', true);
                const prompt = interaction.options.getString('prompt', true);

                // Resolve workspace for this channel
                const workspacePath = wsHandler.getWorkspaceForChannel(interaction.channelId);
                if (!workspacePath) {
                    await interaction.editReply({ content: '⚠️ No workspace bound to this channel. Use `/project` first.' });
                    break;
                }

                try {
                    const record = scheduleService.addSchedule(
                        cronExpr,
                        prompt,
                        workspacePath,
                        scheduleJobCallback,
                    );
                    const embed = new EmbedBuilder()
                        .setTitle('📅 Schedule Created')
                        .setColor(0x57F287)
                        .addFields(
                            { name: 'ID', value: `#${record.id}`, inline: true },
                            { name: 'Cron', value: `\`${cronExpr}\``, inline: true },
                            { name: 'Prompt', value: prompt.slice(0, 200), inline: false },
                        )
                        .setTimestamp();
                    await interaction.editReply({ embeds: [embed] });
                } catch (err: any) {
                    await interaction.editReply({ content: `❌ Failed to create schedule: ${err?.message || 'unknown error'}` });
                }
            } else if (scheduleSub === 'remove') {
                const scheduleId = interaction.options.getInteger('id', true);
                const removed = scheduleService.removeSchedule(scheduleId);
                if (removed) {
                    await interaction.editReply({ content: `🗑️ Schedule #${scheduleId} removed.` });
                } else {
                    await interaction.editReply({ content: `⚠️ Schedule #${scheduleId} not found.` });
                }
            } else {
                // 'list' or default
                const schedules = scheduleService.listSchedules();
                if (schedules.length === 0) {
                    await interaction.editReply({ content: '📅 No scheduled tasks. Use `/schedule add` to create one.' });
                    break;
                }

                const lines = schedules.map((s: ScheduleRecord) => {
                    const status = s.enabled ? '✅' : '⏸️';
                    const workspace = s.workspacePath.split(/[\\/]/).pop() || s.workspacePath;
                    return `${status} **#${s.id}** \`${s.cronExpression}\` → ${s.prompt.slice(0, 80)}${s.prompt.length > 80 ? '...' : ''} (📁 ${workspace})`;
                });

                const embed = new EmbedBuilder()
                    .setTitle('📅 Scheduled Tasks')
                    .setColor(0x5865F2)
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: 'Use /schedule remove <id> to delete' })
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            }
            break;
        }

        case 'restart': {
            try {
                await interaction.editReply({ content: '🔄 Restarting bot process...' });
                const result = await restartCurrentProcess();
                if (!result.ok) {
                    await interaction.editReply({ content: `❌ Bot restart failed: ${result.error || 'unknown error'}` });
                }
            } catch (e: any) {
                await interaction.editReply({ content: `❌ Bot restart failed: ${e.message}` });
            }
            break;
        }

        default:
            await interaction.editReply({
                content: `Unknown command: /${commandName}`,
            });
    }
}
