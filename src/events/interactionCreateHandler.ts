import {
    ButtonInteraction,
    ChatInputCommandInteraction,
    EmbedBuilder,
    Interaction,
    MessageFlags,
} from 'discord.js';

import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { disableAllButtons } from '../utils/discordButtonUtils';
import { TEMPLATE_BTN_PREFIX, parseTemplateButtonId } from '../ui/templateUi';
import {
    AUTOACCEPT_BTN_OFF,
    AUTOACCEPT_BTN_ON,
    AUTOACCEPT_BTN_REFRESH,
} from '../ui/autoAcceptUi';
import {
    OUTPUT_BTN_EMBED,
    OUTPUT_BTN_PLAIN,
    sendOutputUI,
} from '../ui/outputUi';
import { UserPreferenceRepository, OutputFormat } from '../database/userPreferenceRepository';
import type { ModelQuota } from '../services/quotaService';
import { ChatCommandHandler } from '../commands/chatCommandHandler';
import {
    CleanupCommandHandler,
    CLEANUP_ARCHIVE_BTN,
    CLEANUP_CANCEL_BTN,
    CLEANUP_DELETE_BTN,
} from '../commands/cleanupCommandHandler';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { WorkspaceCommandHandler } from '../commands/workspaceCommandHandler';
import { PROJECT_PAGE_PREFIX, parseProjectPageId, isProjectSelectId } from '../ui/projectListUi';
import { CdpBridge } from '../services/cdpBridgeManager';
import { CdpService } from '../services/cdpService';
import { MODE_DISPLAY_NAMES, ModeService } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { AutoAcceptService } from '../services/autoAcceptService';
import { JoinCommandHandler } from '../commands/joinCommandHandler';
import { isSessionSelectId } from '../ui/sessionPickerUi';
import { extractWithRetry } from '../handlers/buttonActionUtils';

export interface InteractionCreateHandlerDeps {
    config: { allowedUserIds: string[] };
    bridge: CdpBridge;
    cleanupHandler: CleanupCommandHandler;
    modeService: ModeService;
    modelService: ModelService;
    slashCommandHandler: SlashCommandHandler;
    wsHandler: WorkspaceCommandHandler;
    chatHandler: ChatCommandHandler;
    client: unknown;
    sendModeUI: (target: { editReply: (opts: Record<string, unknown>) => Promise<unknown> }, modeService: ModeService, deps?: import('../ui/modeUi').ModeUiDeps) => Promise<void>;
    sendModelsUI: (
        target: { editReply: (opts: Record<string, unknown>) => Promise<unknown> },
        deps: { getCurrentCdp: () => CdpService | null; fetchQuota: () => Promise<ModelQuota[]> },
    ) => Promise<void>;
    sendAutoAcceptUI: (
        target: { editReply: (opts: Record<string, unknown>) => Promise<unknown> },
        autoAcceptService: AutoAcceptService,
    ) => Promise<void>;
    handleScreenshot?: (...args: unknown[]) => Promise<void>;
    getCurrentCdp: (bridge: CdpBridge) => CdpService | null;
    parseApprovalCustomId: (customId: string) => { action: 'approve' | 'always_allow' | 'deny'; projectName: string | null; channelId: string | null } | null;
    parsePlanningCustomId: (customId: string) => { action: 'open' | 'proceed'; projectName: string | null; channelId: string | null } | null;
    parseErrorPopupCustomId: (customId: string) => { action: 'dismiss' | 'copy_debug' | 'retry'; projectName: string | null; channelId: string | null } | null;
    parseRunCommandCustomId: (customId: string) => { action: 'run' | 'reject'; projectName: string | null; channelId: string | null } | null;
    handleSlashInteraction: (
        interaction: ChatInputCommandInteraction,
        handler: SlashCommandHandler,
        bridge: CdpBridge,
        wsHandler: WorkspaceCommandHandler,
        chatHandler: ChatCommandHandler,
        cleanupHandler: CleanupCommandHandler,
        modeService: ModeService,
        modelService: ModelService,
        autoAcceptService: AutoAcceptService,
        client: unknown,
    ) => Promise<void>;
    handleTemplateUse?: (interaction: ButtonInteraction, templateId: number) => Promise<void>;
    joinHandler?: JoinCommandHandler;
    userPrefRepo?: UserPreferenceRepository;
}

// ---------------------------------------------------------------------------
// Shared helpers to reduce internal duplication
// ---------------------------------------------------------------------------

/** Check if a Discord API error indicates an expired interaction. */
function isInteractionExpired(err: unknown): boolean {
    const error = err as { code?: number };
    return error?.code === 10062 || error?.code === 40060;
}

/** Build an updated embed with action history for interaction updates. */
function buildActionHistoryEmbed(
    interaction: ButtonInteraction,
    fallbackTitle: string,
    actionLabel: string,
    color: number,
): EmbedBuilder {
    const originalEmbed = interaction.message.embeds[0];
    const updatedEmbed = originalEmbed
        ? EmbedBuilder.from(originalEmbed)
        : new EmbedBuilder().setTitle(fallbackTitle);
    const historyText = `${actionLabel} by <@${interaction.user.id}> (${new Date().toLocaleString('ja-JP')})`;
    updatedEmbed
        .setColor(color)
        .addFields({ name: 'Action History', value: historyText, inline: false })
        .setTimestamp();
    return updatedEmbed;
}

/** Refresh the models UI — identical pattern used in 4+ button handlers. */
async function refreshModelsUI(
    interaction: ButtonInteraction,
    deps: InteractionCreateHandlerDeps,
): Promise<void> {
    await deps.sendModelsUI(
        { editReply: async (data: Record<string, unknown>) => await interaction.editReply(data) },
        {
            getCurrentCdp: () => deps.getCurrentCdp(deps.bridge),
            fetchQuota: async () => deps.bridge.quota.fetchQuota() as Promise<ModelQuota[]>,
        },
    );
}

/**
 * Update the interaction with a new embed and disabled buttons.
 * Catches (and logs as warning) any "interaction expired" errors.
 */
async function updateInteractionWithEmbed(
    interaction: ButtonInteraction,
    updatedEmbed: EmbedBuilder,
    logTag: string,
): Promise<void> {
    try {
        await interaction.update({
            embeds: [updatedEmbed],
            components: disableAllButtons(interaction.message.components),
        });
    } catch (interactionError: unknown) {
        if (!isInteractionExpired(interactionError)) throw interactionError;
        logger.warn(`[${logTag}] Interaction expired.`);
    }
}

/** Check if a user has permission and reply if not. Returns false if denied. */
async function checkPermission(
    interaction: { user: { id: string }; reply: (options: { content: string; flags?: number }) => Promise<unknown> },
    allowedUserIds: string[],
): Promise<boolean> {
    if (allowedUserIds.includes(interaction.user.id)) return true;
    await interaction.reply({ content: t('You do not have permission.'), flags: MessageFlags.Ephemeral }).catch(logger.error);
    return false;
}

/** Defer an update, returning false (so caller can bail) on expiry or error. */
async function safeDeferUpdate(
    interaction: { deferUpdate: () => Promise<unknown> },
    logTag: string,
): Promise<boolean> {
    try {
        await interaction.deferUpdate();
        return true;
    } catch (deferError: unknown) {
        if (isInteractionExpired(deferError)) {
            logger.warn(`[${logTag}] deferUpdate expired. Skipping.`);
        } else {
            logger.error(`[${logTag}] deferUpdate failed:`, deferError);
        }
        return false;
    }
}
export function createInteractionCreateHandler(deps: InteractionCreateHandlerDeps) {
    return async (interaction: Interaction): Promise<void> => {
        if (interaction.isButton()) {
            if (!deps.config.allowedUserIds.includes(interaction.user.id)) {
                await interaction.reply({ content: t('You do not have permission.'), flags: MessageFlags.Ephemeral }).catch(logger.error);
                return;
            }

            try {
                const approvalAction = deps.parseApprovalCustomId(interaction.customId);
                if (approvalAction) {
                    if (approvalAction.channelId && approvalAction.channelId !== interaction.channelId) {
                        await interaction.reply({
                            content: t('This approval action is linked to a different session channel.'),
                            flags: MessageFlags.Ephemeral,
                        }).catch(logger.error);
                        return;
                    }

                    const projectName = approvalAction.projectName ?? deps.bridge.lastActiveWorkspace;
                    const detector = projectName
                        ? deps.bridge.pool.getApprovalDetector(projectName)
                        : undefined;

                    if (!detector) {
                        try {
                            await interaction.reply({ content: t('Approval detector not found.'), flags: MessageFlags.Ephemeral });
                        } catch { /* ignore */ }
                        return;
                    }

                    let success = false;
                    let actionLabel = '';
                    if (approvalAction.action === 'approve') {
                        success = await detector.approveButton();
                        actionLabel = t('Allow');
                    } else if (approvalAction.action === 'always_allow') {
                        success = await detector.alwaysAllowButton();
                        actionLabel = t('Allow Chat');
                    } else {
                        success = await detector.denyButton();
                        actionLabel = t('Deny');
                    }

                    try {
                        if (success) {
                            const updatedEmbed = buildActionHistoryEmbed(
                                interaction, 'Approval Request', actionLabel,
                                approvalAction.action === 'deny' ? 0xE74C3C : 0x2ECC71,
                            );
                            await updateInteractionWithEmbed(interaction, updatedEmbed, 'Approval');
                        } else {
                            await interaction.reply({ content: 'Approval button not found.', flags: MessageFlags.Ephemeral });
                        }
                    } catch (interactionError: unknown) {
                        if (!isInteractionExpired(interactionError)) throw interactionError;
                        logger.warn('[Approval] Interaction expired.');
                    }
                    return;
                }

                const planningAction = deps.parsePlanningCustomId(interaction.customId);
                if (planningAction) {
                    if (planningAction.channelId && planningAction.channelId !== interaction.channelId) {
                        await interaction.reply({
                            content: t('This planning action is linked to a different session channel.'),
                            flags: MessageFlags.Ephemeral,
                        }).catch(logger.error);
                        return;
                    }

                    const planWorkspaceDirName = planningAction.projectName ?? deps.bridge.lastActiveWorkspace;
                    const planDetector = planWorkspaceDirName
                        ? deps.bridge.pool.getPlanningDetector(planWorkspaceDirName)
                        : undefined;

                    if (!planDetector) {
                        try {
                            await interaction.reply({ content: t('Planning detector not found.'), flags: MessageFlags.Ephemeral });
                        } catch { /* ignore */ }
                        return;
                    }

                    try {
                        if (planningAction.action === 'open') {
                            await interaction.deferUpdate();

                            const clicked = await planDetector.clickOpenButton();
                            if (!clicked) {
                                await interaction.followUp({ content: t('Open button not found.'), flags: MessageFlags.Ephemeral });
                                return;
                            }

                            // Extract plan content with retry (initial 500ms delay for DOM)
                            await new Promise((resolve) => setTimeout(resolve, 500));
                            const planContent = await extractWithRetry(
                                () => planDetector.extractPlanContent(),
                            );

                            // Update original embed with action history
                            const updatedEmbed = buildActionHistoryEmbed(
                                interaction, 'Planning Mode', 'Open', 0x3498DB,
                            );

                            await interaction.editReply({
                                embeds: [updatedEmbed],
                                components: interaction.message.components,
                            });

                            // Send plan content as a new message in the same channel
                            if (planContent && interaction.channel && 'send' in interaction.channel) {
                                // Discord embed description limit is 4096 chars
                                const MAX_PLAN_CONTENT = 4096;
                                const truncated = planContent.length > MAX_PLAN_CONTENT
                                    ? planContent.substring(0, MAX_PLAN_CONTENT - 15) + '\n\n(truncated)'
                                    : planContent;

                                const planEmbed = new EmbedBuilder()
                                    .setTitle(t('Plan Content'))
                                    .setDescription(truncated)
                                    .setColor(0x3498DB)
                                    .setTimestamp();

                                await (interaction.channel as { send: (opts: Record<string, unknown>) => Promise<unknown> }).send({ embeds: [planEmbed] }).catch(logger.error);
                            } else if (!planContent) {
                                await interaction.followUp({
                                    content: t('Could not extract plan content from the editor.'),
                                    flags: MessageFlags.Ephemeral,
                                }).catch(logger.error);
                            }
                        } else {
                            // Proceed action
                            const clicked = await planDetector.clickProceedButton();

                            const updatedEmbed = buildActionHistoryEmbed(
                                interaction, 'Planning Mode', 'Proceed',
                                clicked ? 0x2ECC71 : 0xE74C3C,
                            );
                            await updateInteractionWithEmbed(interaction, updatedEmbed, 'Planning');
                        }
                    } catch (planError: unknown) {
                        if (isInteractionExpired(planError)) {
                            logger.warn('[Planning] Interaction expired.');
                        } else {
                            logger.error('[Planning] Error handling planning button:', planError);
                            try {
                                const interactionWithState = interaction as { replied?: boolean; deferred?: boolean };
                                if (!interactionWithState.replied && !interactionWithState.deferred) {
                                    await interaction.reply({ content: t('An error occurred while processing the planning action.'), flags: MessageFlags.Ephemeral });
                                } else {
                                    await interaction.followUp({ content: t('An error occurred while processing the planning action.'), flags: MessageFlags.Ephemeral }).catch(logger.error);
                                }
                            } catch { /* ignore */ }
                        }
                    }
                    return;
                }

                const errorPopupAction = deps.parseErrorPopupCustomId(interaction.customId);
                if (errorPopupAction) {
                    if (errorPopupAction.channelId && errorPopupAction.channelId !== interaction.channelId) {
                        await interaction.reply({
                            content: t('This error popup action is linked to a different session channel.'),
                            flags: MessageFlags.Ephemeral,
                        }).catch(logger.error);
                        return;
                    }

                    const errorWorkspaceDirName = errorPopupAction.projectName ?? deps.bridge.lastActiveWorkspace;
                    const errorDetector = errorWorkspaceDirName
                        ? deps.bridge.pool.getErrorPopupDetector(errorWorkspaceDirName)
                        : undefined;

                    if (!errorDetector) {
                        try {
                            await interaction.reply({ content: t('Error popup detector not found.'), flags: MessageFlags.Ephemeral });
                        } catch { /* ignore */ }
                        return;
                    }

                    try {
                        if (errorPopupAction.action === 'dismiss') {
                            const clicked = await errorDetector.clickDismissButton();

                            const updatedEmbed = buildActionHistoryEmbed(
                                interaction, 'Agent Error', 'Dismiss',
                                clicked ? 0x95A5A6 : 0xE74C3C,
                            );
                            await updateInteractionWithEmbed(interaction, updatedEmbed, 'ErrorPopup');
                        } else if (errorPopupAction.action === 'copy_debug') {
                            await interaction.deferUpdate();

                            const clicked = await errorDetector.clickCopyDebugInfoButton();
                            if (!clicked) {
                                await interaction.followUp({ content: t('Copy debug info button not found.'), flags: MessageFlags.Ephemeral });
                                return;
                            }

                            // Wait for clipboard to be populated
                            await new Promise((resolve) => setTimeout(resolve, 300));

                            const clipboardContent = await errorDetector.readClipboard();

                            // Update original embed with action history
                            const updatedEmbed = buildActionHistoryEmbed(
                                interaction, 'Agent Error', 'Copy debug info', 0x3498DB,
                            );

                            await interaction.editReply({
                                embeds: [updatedEmbed],
                                components: interaction.message.components,
                            });

                            // Send debug info as a new message
                            if (clipboardContent && interaction.channel && 'send' in interaction.channel) {
                                const MAX_DEBUG_CONTENT = 4096;
                                const truncated = clipboardContent.length > MAX_DEBUG_CONTENT
                                    ? clipboardContent.substring(0, MAX_DEBUG_CONTENT - 15) + '\n\n(truncated)'
                                    : clipboardContent;

                                const debugEmbed = new EmbedBuilder()
                                    .setTitle(t('Debug Info'))
                                    .setDescription(`\`\`\`\n${truncated}\n\`\`\``)
                                    .setColor(0x3498DB)
                                    .setTimestamp();

                                await (interaction.channel as { send: (opts: Record<string, unknown>) => Promise<unknown> }).send({ embeds: [debugEmbed] }).catch(logger.error);
                            } else if (!clipboardContent) {
                                await interaction.followUp({
                                    content: t('Could not read debug info from clipboard.'),
                                    flags: MessageFlags.Ephemeral,
                                }).catch(logger.error);
                            }
                        } else {
                            // Retry action
                            const clicked = await errorDetector.clickRetryButton();

                            const updatedEmbed = buildActionHistoryEmbed(
                                interaction, 'Agent Error', 'Retry',
                                clicked ? 0x2ECC71 : 0xE74C3C,
                            );
                            await updateInteractionWithEmbed(interaction, updatedEmbed, 'ErrorPopup');
                        }
                    } catch (errorPopupError: unknown) {
                        if (isInteractionExpired(errorPopupError)) {
                            logger.warn('[ErrorPopup] Interaction expired.');
                        } else {
                            logger.error('[ErrorPopup] Error handling error popup button:', errorPopupError);
                            try {
                                const interactionWithState = interaction as { replied?: boolean; deferred?: boolean };
                                if (!interactionWithState.replied && !interactionWithState.deferred) {
                                    await interaction.reply({ content: t('An error occurred while processing the error popup action.'), flags: MessageFlags.Ephemeral });
                                } else {
                                    await interaction.followUp({ content: t('An error occurred while processing the error popup action.'), flags: MessageFlags.Ephemeral }).catch(logger.error);
                                }
                            } catch { /* ignore */ }
                        }
                    }
                    return;
                }

                const runCommandAction = deps.parseRunCommandCustomId(interaction.customId);
                if (runCommandAction) {
                    if (runCommandAction.channelId && runCommandAction.channelId !== interaction.channelId) {
                        await interaction.reply({
                            content: t('This run command action is linked to a different session channel.'),
                            flags: MessageFlags.Ephemeral,
                        }).catch(logger.error);
                        return;
                    }

                    const runCmdWorkspace = runCommandAction.projectName ?? deps.bridge.lastActiveWorkspace;
                    const runCmdDetector = runCmdWorkspace
                        ? deps.bridge.pool.getRunCommandDetector(runCmdWorkspace)
                        : undefined;

                    if (!runCmdDetector) {
                        try {
                            await interaction.reply({ content: t('Run command detector not found.'), flags: MessageFlags.Ephemeral });
                        } catch { /* ignore */ }
                        return;
                    }

                    let success = false;
                    let actionLabel = '';
                    if (runCommandAction.action === 'run') {
                        success = await runCmdDetector.runButton();
                        actionLabel = t('Run');
                    } else {
                        success = await runCmdDetector.rejectButton();
                        actionLabel = t('Reject');
                    }

                    try {
                        if (success) {
                            const updatedEmbed = buildActionHistoryEmbed(
                                interaction, 'Run Command', actionLabel,
                                runCommandAction.action === 'reject' ? 0xE74C3C : 0x2ECC71,
                            );
                            await updateInteractionWithEmbed(interaction, updatedEmbed, 'RunCommand');
                        } else {
                            await interaction.reply({ content: t('Run command button not found.'), flags: MessageFlags.Ephemeral });
                        }
                    } catch (interactionError: unknown) {
                        if (!isInteractionExpired(interactionError)) throw interactionError;
                        logger.warn('[RunCommand] Interaction expired.');
                    }
                    return;
                }

                if (interaction.customId === CLEANUP_ARCHIVE_BTN) {
                    await deps.cleanupHandler.handleArchive(interaction);
                    return;
                }
                if (interaction.customId === CLEANUP_DELETE_BTN) {
                    await deps.cleanupHandler.handleDelete(interaction);
                    return;
                }
                if (interaction.customId === CLEANUP_CANCEL_BTN) {
                    await deps.cleanupHandler.handleCancel(interaction);
                    return;
                }

                if (interaction.customId === 'model_set_default_btn') {
                    await interaction.deferUpdate();
                    const cdp = deps.getCurrentCdp(deps.bridge);
                    if (!cdp) {
                        await interaction.followUp({ content: 'Not connected to CDP.', flags: MessageFlags.Ephemeral });
                        return;
                    }
                    const currentModel = await cdp.getCurrentModel();
                    if (!currentModel) {
                        await interaction.followUp({ content: 'No current model detected.', flags: MessageFlags.Ephemeral });
                        return;
                    }
                    deps.modelService.setDefaultModel(currentModel);
                    if (deps.userPrefRepo) {
                        deps.userPrefRepo.setDefaultModel(interaction.user.id, currentModel);
                    }
                    await refreshModelsUI(interaction, deps);
                    await interaction.followUp({ content: `Default model set to **${currentModel}**.`, flags: MessageFlags.Ephemeral });
                    return;
                }

                if (interaction.customId === 'model_clear_default_btn') {
                    await interaction.deferUpdate();
                    deps.modelService.setDefaultModel(null);
                    if (deps.userPrefRepo) {
                        deps.userPrefRepo.setDefaultModel(interaction.user.id, null);
                    }
                    await refreshModelsUI(interaction, deps);
                    await interaction.followUp({ content: 'Default model cleared.', flags: MessageFlags.Ephemeral });
                    return;
                }

                if (interaction.customId === 'model_refresh_btn') {
                    await interaction.deferUpdate();
                    await refreshModelsUI(interaction, deps);
                    return;
                }

                if (interaction.customId.startsWith('model_btn_')) {
                    await interaction.deferUpdate();

                    const modelName = interaction.customId.replace('model_btn_', '');
                    const cdp = deps.getCurrentCdp(deps.bridge);

                    if (!cdp) {
                        await interaction.followUp({ content: 'Not connected to CDP.', flags: MessageFlags.Ephemeral });
                        return;
                    }

                    const res = await cdp.setUiModel(modelName);

                    if (!res.ok) {
                        await interaction.followUp({ content: res.error || 'Failed to change model.', flags: MessageFlags.Ephemeral });
                    } else {
                        await refreshModelsUI(interaction, deps);
                        await interaction.followUp({ content: `Model changed to **${res.model}**!`, flags: MessageFlags.Ephemeral });
                    }
                    return;
                }

                if (interaction.customId === AUTOACCEPT_BTN_REFRESH) {
                    await interaction.deferUpdate();
                    await deps.sendAutoAcceptUI(
                        { editReply: async (data: Record<string, unknown>) => await interaction.editReply(data) },
                        deps.bridge.autoAccept,
                    );
                    return;
                }

                if (interaction.customId === AUTOACCEPT_BTN_ON || interaction.customId === AUTOACCEPT_BTN_OFF) {
                    await interaction.deferUpdate();

                    const action = interaction.customId === AUTOACCEPT_BTN_ON ? 'on' : 'off';
                    const result = deps.bridge.autoAccept.handle(action);

                    await deps.sendAutoAcceptUI(
                        { editReply: async (data: Record<string, unknown>) => await interaction.editReply(data) },
                        deps.bridge.autoAccept,
                    );

                    await interaction.followUp({
                        content: result.message,
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                if (interaction.customId === OUTPUT_BTN_EMBED || interaction.customId === OUTPUT_BTN_PLAIN) {
                    if (deps.userPrefRepo) {
                        await interaction.deferUpdate();

                        const format: OutputFormat = interaction.customId === OUTPUT_BTN_PLAIN ? 'plain' : 'embed';
                        deps.userPrefRepo.setOutputFormat(interaction.user.id, format);

                        await sendOutputUI(
                            { editReply: async (data: Record<string, unknown>) => await interaction.editReply(data) },
                            format,
                        );

                        const label = format === 'plain' ? 'Plain Text' : 'Embed';
                        await interaction.followUp({
                            content: `Output format changed to **${label}**.`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    return;
                }

                if (interaction.customId.startsWith(`${PROJECT_PAGE_PREFIX}:`)) {
                    const page = parseProjectPageId(interaction.customId);
                    if (!isNaN(page) && page >= 0) {
                        await deps.wsHandler.handlePageButton(interaction, page);
                    }
                    return;
                }

                if (interaction.customId.startsWith(TEMPLATE_BTN_PREFIX)) {
                    await interaction.deferUpdate();
                    const templateId = parseTemplateButtonId(interaction.customId);
                    if (!isNaN(templateId) && deps.handleTemplateUse) {
                        await deps.handleTemplateUse(interaction, templateId);
                    }
                    return;
                }
            } catch (error) {
                logger.error('Error during button interaction handling:', error);

                try {
                    const interactionWithState = interaction as { replied?: boolean; deferred?: boolean };
                    if (!interactionWithState.replied && !interactionWithState.deferred) {
                        await interaction.reply({ content: 'An error occurred while processing the button action.', flags: MessageFlags.Ephemeral });
                    } else {
                        await interaction.followUp({ content: 'An error occurred while processing the button action.', flags: MessageFlags.Ephemeral }).catch(logger.error);
                    }
                } catch (e) {
                    logger.error('Failed to send error message as well:', e);
                }
            }
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'mode_select') {
            if (!await checkPermission(interaction, deps.config.allowedUserIds)) return;

            if (!await safeDeferUpdate(interaction, 'Mode')) return;

            try {
                const selectedMode = interaction.values[0];

                deps.modeService.setMode(selectedMode);

                const cdp = deps.getCurrentCdp(deps.bridge);
                if (cdp) {
                    const res = await cdp.setUiMode(selectedMode);
                    if (!res.ok) {
                        logger.warn(`[Mode] UI mode switch failed: ${res.error}`);
                    }
                }

                await deps.sendModeUI({ editReply: async (data: Record<string, unknown>) => await interaction.editReply(data) }, deps.modeService);
                await interaction.followUp({ content: `Mode changed to **${MODE_DISPLAY_NAMES[selectedMode] || selectedMode}**!`, flags: MessageFlags.Ephemeral });
            } catch (error: unknown) {
                logger.error('Error during mode dropdown handling:', error);
                try {
                    if (interaction.deferred || interaction.replied) {
                        await interaction.followUp({ content: 'An error occurred while changing the mode.', flags: MessageFlags.Ephemeral }).catch(logger.error);
                    }
                } catch (e) {
                    logger.error('Failed to send error message:', e);
                }
            }
            return;
        }

        if (interaction.isStringSelectMenu() && isSessionSelectId(interaction.customId)) {
            if (!await checkPermission(interaction, deps.config.allowedUserIds)) return;

            if (!await safeDeferUpdate(interaction, 'SessionSelect')) return;

            try {
                if (deps.joinHandler) {
                    await deps.joinHandler.handleJoinSelect(interaction, deps.bridge);
                }
            } catch (error) {
                logger.error('Session selection error:', error);
            }
            return;
        }

        if (interaction.isStringSelectMenu() && isProjectSelectId(interaction.customId)) {
            if (!await checkPermission(interaction, deps.config.allowedUserIds)) return;

            if (!interaction.guild) {
                await interaction.reply({ content: 'This can only be used in a server.', flags: MessageFlags.Ephemeral }).catch(logger.error);
                return;
            }

            try {
                await deps.wsHandler.handleSelectMenu(interaction, interaction.guild);
            } catch (error) {
                logger.error('Workspace selection error:', error);
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        const commandInteraction = interaction as ChatInputCommandInteraction;

        if (!deps.config.allowedUserIds.includes(interaction.user.id)) {
            await commandInteraction.reply({
                content: 'You do not have permission to use this command.',
                flags: MessageFlags.Ephemeral,
            }).catch(logger.error);
            return;
        }

        try {
            if (commandInteraction.commandName === 'logs') {
                await commandInteraction.deferReply({ flags: MessageFlags.Ephemeral });
            } else {
                await commandInteraction.deferReply();
            }
        } catch (deferError: unknown) {
            const error = deferError as { code?: number };
            if (error?.code === 10062) {
                logger.warn('[SlashCommand] Interaction expired (deferReply failed). Skipping.');
                return;
            }
            throw deferError;
        }

        try {
            await deps.handleSlashInteraction(
                commandInteraction,
                deps.slashCommandHandler,
                deps.bridge,
                deps.wsHandler,
                deps.chatHandler,
                deps.cleanupHandler,
                deps.modeService,
                deps.modelService,
                deps.bridge.autoAccept,
                deps.client,
            );
        } catch (error) {
            logger.error('Error during slash command handling:', error);
            try {
                await commandInteraction.editReply({ content: 'An error occurred while processing the command.' });
            } catch (replyError) {
                logger.error('Failed to send error response:', replyError);
            }
        }
    };
}
