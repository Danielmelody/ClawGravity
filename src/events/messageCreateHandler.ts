import { EmbedBuilder, Message, TextChannel } from 'discord.js';

import { parseMessageContent } from '../commands/messageParser';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { WorkspaceCommandHandler } from '../commands/workspaceCommandHandler';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { UserPreferenceRepository } from '../database/userPreferenceRepository';
import { formatAsPlainText } from '../utils/plainTextFormatter';
import type { PlatformChannel } from '../platform/types';
import { wrapDiscordChannel } from '../platform/discord/wrappers';
import {
    CdpBridge,
    ensureWorkspaceRuntime as ensureWorkspaceRuntimeFn,
    getCurrentCdp as getCurrentCdpFn,
    registerApprovalSessionChannel as registerApprovalSessionChannelFn,
    registerApprovalWorkspaceChannel as registerApprovalWorkspaceChannelFn,
} from '../services/cdpBridgeManager';
import { ChatSessionService } from '../services/chatSessionService';
import { CdpService } from '../services/cdpService';
import { ChannelManager } from '../services/channelManager';
import { ModeService } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { buildConnectedProjectsDescription, buildDiscordStatusFields } from '../ui/discordStatus';
import {
    cleanupInboundImageAttachments as cleanupInboundImageAttachmentsFn,
    downloadInboundImageAttachments as downloadInboundImageAttachmentsFn,
    InboundImageAttachment,
    isImageAttachment as isImageAttachmentFn,
} from '../utils/imageHandler';
import { logger } from '../utils/logger';
import { WorkspaceRuntime } from '../services/workspaceRuntime';
import { WorkspaceQueue } from '../bot/workspaceQueue';

export interface MessageCreateHandlerDeps {
    config: { allowedUserIds: string[]; extractionMode?: import('../utils/config').ExtractionMode };
    bridge: CdpBridge;
    modeService: ModeService;
    modelService: ModelService;
    slashCommandHandler: SlashCommandHandler;
    wsHandler: WorkspaceCommandHandler;
    chatSessionService: ChatSessionService;
    chatSessionRepo: ChatSessionRepository;
    channelManager: ChannelManager;
    titleGenerator: TitleGeneratorService;
    client: unknown;
    sendPromptToAntigravity: (
        bridge: CdpBridge,
        message: Message,
        prompt: string,
        cdp: CdpService,
        modeService: ModeService,
        modelService: ModelService,
        inboundImages?: InboundImageAttachment[],
        options?: Record<string, unknown>,
    ) => Promise<void>;
    autoRenameChannel: (
        message: Message,
        chatSessionRepo: ChatSessionRepository,
        titleGenerator: TitleGeneratorService,
        channelManager: ChannelManager,
        cdp?: CdpService,
    ) => Promise<void>;
    handleScreenshot: (target: Message, cdp: CdpService | null) => Promise<void>;
    getCurrentCdp?: (bridge: CdpBridge) => CdpService | null;
    ensureWorkspaceRuntime?: (
        bridge: CdpBridge,
        workspacePath: string,
        options?: { enableActionDetectors?: boolean },
    ) => Promise<{ runtime: WorkspaceRuntime; cdp: CdpService; projectName: string }>;
    registerApprovalWorkspaceChannel?: (bridge: CdpBridge, projectName: string, channel: PlatformChannel) => void;
    registerApprovalSessionChannel?: (bridge: CdpBridge, projectName: string, sessionTitle: string, channel: PlatformChannel) => void;
    downloadInboundImageAttachments?: (message: Message) => Promise<InboundImageAttachment[]>;
    cleanupInboundImageAttachments?: (attachments: InboundImageAttachment[]) => Promise<void>;
    isImageAttachment?: (contentType: string | null | undefined, fileName: string | null | undefined) => boolean;
    userPrefRepo?: UserPreferenceRepository;
}

export function createMessageCreateHandler(deps: MessageCreateHandlerDeps) {
    const getCurrentCdp = deps.getCurrentCdp ?? getCurrentCdpFn;
    const ensureWorkspaceRuntime = deps.ensureWorkspaceRuntime ?? ensureWorkspaceRuntimeFn;
    const registerApprovalWorkspaceChannel = deps.registerApprovalWorkspaceChannel ?? registerApprovalWorkspaceChannelFn;
    const registerApprovalSessionChannel = deps.registerApprovalSessionChannel ?? registerApprovalSessionChannelFn;
    const downloadInboundImageAttachments = deps.downloadInboundImageAttachments ?? downloadInboundImageAttachmentsFn;
    const cleanupInboundImageAttachments = deps.cleanupInboundImageAttachments ?? cleanupInboundImageAttachmentsFn;
    const isImageAttachment = deps.isImageAttachment ?? isImageAttachmentFn;

    // Per-workspace prompt queue: serializes send→response cycles
    const promptQueue = new WorkspaceQueue();

    return async (message: Message): Promise<void> => {
        if (message.author.bot) return;

        if (!deps.config.allowedUserIds.includes(message.author.id)) {
            return;
        }

        const parsed = parseMessageContent(message.content);

        if (parsed.isCommand && parsed.commandName) {
            if (parsed.commandName === 'autoaccept') {
                const result = deps.bridge.autoAccept.handle(parsed.args?.[0]);
                await message.reply({ content: result.message }).catch(logger.error);
                return;
            }

            if (parsed.commandName === 'screenshot') {
                await deps.handleScreenshot(message, getCurrentCdp(deps.bridge));
                await message.reply({ content: '💡 You can also use the slash command `/screenshot`.' }).catch(() => { });
                return;
            }

            if (parsed.commandName === 'status') {
                const activeNames = deps.bridge.pool.getActiveWorkspaceNames();
                const currentMode = deps.modeService.getCurrentMode();

                const statusFields = buildDiscordStatusFields(
                    activeNames.length,
                    currentMode,
                    deps.bridge.autoAccept.isEnabled(),
                );
                const statusDescription = buildConnectedProjectsDescription({
                    bridge: deps.bridge,
                    workspaceNames: activeNames,
                });

                const statusOutputFormat = deps.userPrefRepo?.getOutputFormat(message.author.id) ?? 'embed';
                if (statusOutputFormat === 'plain') {
                    const chunks = formatAsPlainText({
                        title: '🔧 Bot Status',
                        description: statusDescription,
                        fields: statusFields,
                        footerText: 'Use the slash command /status for more detailed information',
                    });
                    await message.reply({ content: chunks[0] });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setTitle('🔧 Bot Status')
                    .setColor(activeNames.length > 0 ? 0x00CC88 : 0x888888)
                    .addFields(...statusFields)
                    .setDescription(statusDescription)
                    .setFooter({ text: '💡 Use the slash command /status for more detailed information' })
                    .setTimestamp();

                await message.reply({ embeds: [embed] });
                return;
            }

            const slashOnlyCommands = ['help', 'stop', 'model', 'mode', 'project', 'chat', 'new', 'clear', 'cleanup', 'session', 'mirror', 'output'];
            if (slashOnlyCommands.includes(parsed.commandName)) {
                await message.reply({
                    content: `💡 Please use \`/${parsed.commandName}\` as a slash command.\nType \`/${parsed.commandName}\` in the Discord input field to see suggestions.`,
                }).catch(logger.error);
                return;
            }

            const result = await deps.slashCommandHandler.handleCommand(parsed.commandName, parsed.args || []);

            await message.reply({
                content: result.message,
            }).catch(logger.error);

            if (result.prompt) {
                const cdp = getCurrentCdp(deps.bridge);
                if (cdp) {
                    await deps.sendPromptToAntigravity(deps.bridge, message, result.prompt, cdp, deps.modeService, deps.modelService, [], {
                        chatSessionService: deps.chatSessionService,
                        chatSessionRepo: deps.chatSessionRepo,
                        channelManager: deps.channelManager,
                        titleGenerator: deps.titleGenerator,
                        userPrefRepo: deps.userPrefRepo,
                        extractionMode: deps.config.extractionMode,
                    });
                } else {
                    await message.reply('Not connected to CDP. Send a message first to connect to a project.');
                }
            }
            return;
        }

        const hasImageAttachments = Array.from(message.attachments.values())
            .some((attachment) => isImageAttachment(attachment.contentType, attachment.name));
        if (message.content.trim() || hasImageAttachments) {
            const promptText = message.content.trim() || 'Please review the attached images and respond accordingly.';
            const inboundImages = await downloadInboundImageAttachments(message);

            if (hasImageAttachments && inboundImages.length === 0) {
                await message.reply('Failed to retrieve attached images. Please wait and try again.').catch(() => { });
                return;
            }

            const workspacePath = deps.wsHandler.getWorkspaceForChannel(message.channelId);

            try {
                if (workspacePath) {
                    const projectLabel = deps.bridge.pool.extractProjectName(workspacePath);

                    // Track queue depth for hourglass reactions
                    const currentDepth = promptQueue.getDepth(workspacePath);
                    const newDepth = promptQueue.incrementDepth(workspacePath);

                    if (currentDepth > 0) {
                        logger.info(
                            `[Queue:${projectLabel}] Enqueued (depth: ${newDepth}, channel: ${message.channelId})`,
                        );
                        await message.react('⏳').catch(() => { });
                    } else {
                        logger.info(
                            `[Queue:${projectLabel}] Processing immediately (depth: ${newDepth}, channel: ${message.channelId})`,
                        );
                    }

                    const queueStartTime = Date.now();
                    await promptQueue.enqueue(workspacePath, async () => {
                        const waitMs = Date.now() - queueStartTime;
                        if (waitMs > 100) {
                            logger.info(
                                `[Queue:${projectLabel}] Task started after ${Math.round(waitMs / 1000)}s wait (channel: ${message.channelId})`,
                            );
                        }

                        // Remove hourglass when task starts processing
                        const botId = message.client.user?.id;
                        if (botId) {
                            await message.reactions.resolve('⏳')?.users.remove(botId).catch(() => { });
                        }

                        try {
                            const prepared = await ensureWorkspaceRuntime(deps.bridge, workspacePath, {
                                enableActionDetectors: true,
                            });
                            const runtime = prepared.runtime;
                            const cdp = prepared.cdp;
                            const projectName = prepared.projectName;

                            deps.bridge.lastActiveWorkspace = projectName;
                            const platformChannel = wrapDiscordChannel(message.channel as TextChannel);
                            deps.bridge.lastActiveChannel = platformChannel;
                            registerApprovalWorkspaceChannel(deps.bridge, projectName, platformChannel);

                            const session = deps.chatSessionRepo.findByChannelId(message.channelId);
                            if (session?.displayName) {
                                registerApprovalSessionChannel(deps.bridge, projectName, session.displayName, platformChannel);
                            }

                            if (session?.isRenamed && session.displayName) {
                                const activationResult = await runtime.activateSessionByTitle(deps.chatSessionService, session.displayName);
                                if (!activationResult.ok) {
                                    const reason = activationResult.error ? ` (${activationResult.error})` : '';
                                    await message.reply(
                                        `⚠️ Could not route this message to the bound session (${session.displayName}). ` +
                                        `Please open /chat and verify the session${reason}.`,
                                    ).catch(() => { });
                                    return;
                                }
                            } else if (session && !session.isRenamed) {
                                try {
                                    const chatResult = await runtime.startNewChat(deps.chatSessionService);
                                    if (!chatResult.ok) {
                                        logger.warn('[MessageCreate] Failed to start new chat in Antigravity:', chatResult.error);
                                        (message.channel as { send: (content: string) => Promise<unknown> }).send(`⚠️ Could not open a new chat in Antigravity. Sending to existing chat.`).catch(() => { });
                                    }
                                } catch (err) {
                                    logger.error('[MessageCreate] startNewChat error:', err);
                                    (message.channel as { send: (content: string) => Promise<unknown> }).send(`⚠️ Could not open a new chat in Antigravity. Sending to existing chat.`).catch(() => { });
                                }
                            }

                            await deps.autoRenameChannel(message, deps.chatSessionRepo, deps.titleGenerator, deps.channelManager, cdp);

                            // Re-register session channel after autoRenameChannel sets displayName
                            const updatedSession = deps.chatSessionRepo.findByChannelId(message.channelId);
                            if (updatedSession?.displayName) {
                                registerApprovalSessionChannel(deps.bridge, projectName, updatedSession.displayName, platformChannel);
                            }

                            // Register echo hash so UserMessageDetector skips this message
                            const userMsgDetector = deps.bridge.pool.getUserMessageDetector?.(projectName);
                            if (userMsgDetector) {
                                userMsgDetector.addEchoHash(promptText);
                            }

                            // Wait for full response cycle (onComplete/onTimeout) before releasing the queue.
                            // Safety timeout (3600s) prevents permanent queue deadlock if onFullCompletion
                            // is never called due to a bug.
                            const QUEUE_SAFETY_TIMEOUT_MS = 3600_000;
                            const promptStartTime = Date.now();
                            await new Promise<void>((resolve) => {
                                const safetyTimer = setTimeout(() => {
                                    logger.warn(
                                        `[Queue:${projectName}] Safety timeout — releasing queue after 3600s ` +
                                        `(channel: ${message.channelId})`,
                                    );
                                    resolve();
                                }, QUEUE_SAFETY_TIMEOUT_MS);
                                let settled = false;
                                const settle = () => {
                                    if (settled) return;
                                    settled = true;
                                    clearTimeout(safetyTimer);
                                    const elapsed = Math.round((Date.now() - promptStartTime) / 1000);
                                    logger.info(
                                        `[Queue:${projectName}] Prompt completed in ${elapsed}s ` +
                                        `(channel: ${message.channelId})`,
                                    );
                                    resolve();
                                };
                                deps.sendPromptToAntigravity(deps.bridge, message, promptText, cdp, deps.modeService, deps.modelService, inboundImages, {
                                    chatSessionService: deps.chatSessionService,
                                    chatSessionRepo: deps.chatSessionRepo,
                                    channelManager: deps.channelManager,
                                    titleGenerator: deps.titleGenerator,
                                    userPrefRepo: deps.userPrefRepo,
                                    extractionMode: deps.config.extractionMode,
                                    onFullCompletion: settle,
                                }).catch((err: unknown) => {
                                    // sendPromptToAntigravity rejected before onFullCompletion fired
                                    // (e.g. setup code threw before top-level try/catch).
                                    // Release the queue immediately instead of waiting for safety timeout.
                                    const errorMessage = err instanceof Error ? err.message : String(err);
                                    logger.error(
                                        `[Queue:${projectName}] sendPromptToAntigravity rejected early ` +
                                        `(channel: ${message.channelId}):`, errorMessage,
                                    );
                                    settle();
                                });
                            });
                        } catch (e: unknown) {
                            const errorMessage = e instanceof Error ? e.message : String(e);
                            logger.error(
                                `[Queue:${projectLabel}] Task failed (channel: ${message.channelId}):`,
                                errorMessage,
                            );
                            await message.reply(`Failed to connect to workspace: ${errorMessage}`);
                        } finally {
                            const remainingDepth = promptQueue.decrementDepth(workspacePath);
                            if (remainingDepth > 0) {
                                logger.info(
                                    `[Queue:${projectLabel}] Task done, ${remainingDepth} remaining`,
                                );
                            }
                        }
                    });
                } else {
                    await message.reply('No project is configured for this channel. Please create or select one with `/project`.');
                }
            } finally {
                await cleanupInboundImageAttachments(inboundImages);
            }
        }
    };
}
