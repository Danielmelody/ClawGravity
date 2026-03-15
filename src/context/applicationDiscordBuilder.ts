import { Effect } from 'effect';
import { Message } from 'discord.js';
import type { Client } from 'discord.js';

import {
    ActivePromptSessionHandle,
    handleDiscordSlashInteraction,
} from '../bot/discordSlashInteractionHandler';
import { JoinCommandHandler } from '../commands/joinCommandHandler';
import { wrapDiscordChannel } from '../platform/discord/wrappers';
import type { AppConfig } from '../utils/config';
import type { PromptDispatchOptions } from '../services/promptDispatcher';
import { createInteractionCreateHandler } from '../events/interactionCreateHandler';
import type { InteractionCreateHandlerDeps } from '../events/interactionCreateHandler';
import { createMessageCreateHandler } from '../events/messageCreateHandler';
import type { MessageCreateHandlerDeps } from '../events/messageCreateHandler';
import {
    ensureWorkspaceRuntime,
    getCurrentCdp,
    parseApprovalCustomId,
    parseErrorPopupCustomId,
    parsePlanningCustomId,
    parseRunCommandCustomId,
    registerApprovalSessionChannel,
    registerApprovalWorkspaceChannel,
} from '../services/cdpBridgeManager';
import { sendAutoAcceptUI } from '../ui/autoAcceptUi';
import { sendModeUI } from '../ui/modeUi';
import { sendModelsUI } from '../ui/modelsUi';
import { ApplicationCommandHandlers } from './applicationCommandBuilder';
import {
    ApplicationContext,
    ApplicationContextTag,
} from './applicationContext';

export interface DiscordRuntimeArtifacts {
    readonly joinHandler: JoinCommandHandler;
    readonly interactionHandler: ReturnType<typeof createInteractionCreateHandler>;
    readonly messageHandler: ReturnType<typeof createMessageCreateHandler>;
}

export interface BuildDiscordRuntimeOptions {
    readonly config: AppConfig;
    readonly client: Client;
    readonly commandHandlers: ApplicationCommandHandlers;
    readonly handleScreenshot: MessageCreateHandlerDeps['handleScreenshot'];
    readonly autoRenameChannel: MessageCreateHandlerDeps['autoRenameChannel'];
    readonly activePromptSessions: Map<string, ActivePromptSessionHandle>;
    readonly scheduleJobCallback?: (schedule: import('../database/scheduleRepository').ScheduleRecord) => void;
}

export async function buildDiscordRuntimeArtifacts(
    context: ApplicationContext,
    options: BuildDiscordRuntimeOptions,
): Promise<DiscordRuntimeArtifacts> {
    return Effect.runPromise(
        Effect.gen(function* () {
            const ctx = yield* ApplicationContextTag;
            const joinHandler = new JoinCommandHandler({
                chatSessionService: ctx.chatSessionService,
                chatSessionRepo: ctx.chatSessionRepo,
                bindingRepo: ctx.workspaceBindingRepo,
                channelManager: ctx.channelManager,
                pool: ctx.bridge.pool,
                workspaceService: ctx.workspaceService,
                client: options.client,
                extractionMode: options.config.extractionMode,
            });

            const handleTemplateUse: NonNullable<InteractionCreateHandlerDeps['handleTemplateUse']> = async (
                interaction,
                templateId,
            ) => {
                const template = ctx.templateRepo.findById(templateId);
                if (!template) {
                    await interaction.followUp({
                        content: 'Template not found. It may have been deleted.',
                        flags: 1 << 6,
                    });
                    return;
                }

                const channelId = interaction.channelId;
                const workspacePath = options.commandHandlers.workspace.getWorkspaceForChannel(channelId);

                let cdp;
                if (workspacePath) {
                    try {
                        const prepared = await ensureWorkspaceRuntime(ctx.bridge, workspacePath, {
                            enableActionDetectors: true,
                        });
                        cdp = prepared.cdp;
                        const projectName = prepared.projectName;
                        ctx.bridge.lastActiveWorkspace = projectName;
                        const platformChannel = interaction.channel
                            ? wrapDiscordChannel(interaction.channel as import('discord.js').TextChannel)
                            : null;
                        ctx.bridge.lastActiveChannel = platformChannel;
                        if (platformChannel) {
                            registerApprovalWorkspaceChannel(ctx.bridge, projectName, platformChannel);
                        }
                        const session = ctx.chatSessionRepo.findByChannelId(channelId);
                        if (session?.displayName && platformChannel) {
                            registerApprovalSessionChannel(
                                ctx.bridge,
                                projectName,
                                session.displayName,
                                platformChannel,
                            );
                        }
                    } catch (error: unknown) {
                        await interaction.followUp({
                            content: `Failed to connect to workspace: ${(error as Error).message}`,
                            flags: 1 << 6,
                        });
                        return;
                    }
                } else {
                    cdp = getCurrentCdp(ctx.bridge);
                }

                if (!cdp) {
                    await interaction.followUp({
                        content: 'Not connected to CDP. Please connect to a project first.',
                        flags: 1 << 6,
                    });
                    return;
                }

                const followUp = await interaction.followUp({
                    content: `Executing template **${template.name}**...`,
                });

                if (followUp instanceof Message) {
                    await ctx.promptDispatcher.send({
                        message: followUp,
                        prompt: template.prompt,
                        cdp,
                        inboundImages: [],
                        options: {
                            chatSessionService: ctx.chatSessionService,
                            chatSessionRepo: ctx.chatSessionRepo,
                            channelManager: ctx.channelManager,
                            titleGenerator: ctx.titleGenerator,
                            userPrefRepo: ctx.userPrefRepo,
                            extractionMode: options.config.extractionMode,
                        } satisfies PromptDispatchOptions,
                    });
                }
            };

            const interactionHandler = createInteractionCreateHandler({
                config: options.config,
                bridge: ctx.bridge,
                cleanupHandler: options.commandHandlers.cleanup,
                modeService: ctx.modeService,
                modelService: ctx.modelService,
                slashCommandHandler: options.commandHandlers.slash,
                wsHandler: options.commandHandlers.workspace,
                chatHandler: options.commandHandlers.chat,
                client: options.client,
                sendModeUI,
                sendModelsUI,
                sendAutoAcceptUI,
                getCurrentCdp,
                parseApprovalCustomId,
                parseErrorPopupCustomId,
                parsePlanningCustomId,
                parseRunCommandCustomId,
                joinHandler,
                userPrefRepo: ctx.userPrefRepo,
                handleSlashInteraction: (
                    interaction,
                    handler,
                    bridge,
                    wsHandler,
                    chatHandler,
                    cleanupHandler,
                    modeService,
                    modelService,
                    autoAcceptService,
                    _client,
                ) => handleDiscordSlashInteraction({
                    interaction,
                    slashCommandHandler: handler,
                    bridge,
                    wsHandler,
                    chatHandler,
                    cleanupHandler,
                    modeService,
                    autoAcceptService,
                    templateRepo: ctx.templateRepo,
                    joinHandler,
                    userPrefRepo: ctx.userPrefRepo,
                    scheduleService: ctx.scheduleService,
                    scheduleJobCallback: options.scheduleJobCallback,
                    activePromptSessions: options.activePromptSessions,
                }),
                handleTemplateUse,
            });

            const messageHandler = createMessageCreateHandler({
                config: options.config,
                bridge: ctx.bridge,
                modeService: ctx.modeService,
                modelService: ctx.modelService,
                slashCommandHandler: options.commandHandlers.slash,
                wsHandler: options.commandHandlers.workspace,
                chatSessionService: ctx.chatSessionService,
                chatSessionRepo: ctx.chatSessionRepo,
                channelManager: ctx.channelManager,
                titleGenerator: ctx.titleGenerator,
                client: options.client,
                sendPromptToAntigravity: async (
                    _bridge,
                    message,
                    prompt,
                    cdp,
                    _modeService,
                    _modelService,
                    inboundImages = [],
                    promptOptions,
                ) => ctx.promptDispatcher.send({
                    message,
                    prompt,
                    cdp,
                    inboundImages,
                    options: promptOptions as PromptDispatchOptions | undefined,
                }),
                autoRenameChannel: options.autoRenameChannel,
                handleScreenshot: options.handleScreenshot,
                userPrefRepo: ctx.userPrefRepo,
            });

            return {
                joinHandler,
                interactionHandler,
                messageHandler,
            } satisfies DiscordRuntimeArtifacts;
        }).pipe(
            Effect.provideService(ApplicationContextTag, context),
        ),
    );
}
