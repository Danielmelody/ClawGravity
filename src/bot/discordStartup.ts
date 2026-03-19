import { Client, EmbedBuilder } from 'discord.js';

import { registerSlashCommands } from '../commands/registerSlashCommands';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { wrapDiscordChannel } from '../platform/discord/wrappers';
import {
    CdpBridge,
    ensureWorkspaceRuntime,
    registerApprovalSessionChannel,
    registerApprovalWorkspaceChannel,
} from '../services/cdpBridgeManager';
import { ChatSessionService } from '../services/chatSessionService';
import { ModeService } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { buildStartupStatusSnapshot } from '../services/startupStatus';
import { WorkspaceService } from '../services/workspaceService';
import { logger } from '../utils/logger';
import { APP_VERSION } from '../utils/version';

interface RestoreDiscordSessionsOnStartupDeps {
    readonly client: Client;
    readonly bridge: CdpBridge;
    readonly workspaceBindingRepo: WorkspaceBindingRepository;
    readonly chatSessionRepo: ChatSessionRepository;
    readonly workspaceService: WorkspaceService;
    readonly chatSessionService: ChatSessionService;
}

export interface DiscordStartupTasksDeps extends RestoreDiscordSessionsOnStartupDeps {
    readonly discordToken: string;
    readonly discordClientId: string;
    readonly guildId?: string;
    readonly modeService: ModeService;
    readonly modelService: ModelService;
}

async function restoreDiscordSessionsOnStartup({
    client,
    bridge,
    workspaceBindingRepo,
    chatSessionRepo,
    workspaceService,
    chatSessionService,
}: RestoreDiscordSessionsOnStartupDeps): Promise<void> {
    const bindings = workspaceBindingRepo.findAll();
    if (bindings.length === 0) return;

    const restoredWorkspaces = new Set<string>();

    for (const binding of bindings) {
        if (restoredWorkspaces.has(binding.workspacePath)) continue;

        const session = chatSessionRepo.findLatestRestorableByWorkspace(binding.workspacePath);
        if (!session?.displayName) continue;

        try {
            const resolvedWorkspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
            const prepared = await ensureWorkspaceRuntime(bridge, resolvedWorkspacePath, {
                enableActionDetectors: true,
            });
            const runtime = prepared.runtime;
            const projectName = prepared.projectName;
            const discordChannel = client.channels.fetch
                ? await client.channels.fetch(session.channelId).catch(() => null)
                : null;

            if (!discordChannel || !discordChannel.isTextBased?.()) {
                logger.warn(`[StartupRestore] Channel not found or not text-based: ${session.channelId}`);
                continue;
            }

            const platformChannel = wrapDiscordChannel(discordChannel as import('discord.js').TextChannel);
            bridge.lastActiveWorkspace = projectName;
            bridge.lastActiveChannel = platformChannel;
            registerApprovalWorkspaceChannel(bridge, projectName, platformChannel);
            registerApprovalSessionChannel(bridge, projectName, session.displayName, platformChannel);

            const activationResult = await runtime.activateSessionByTitle(chatSessionService, session.displayName);
            if (!activationResult.ok) {
                logger.warn(
                    `[StartupRestore] Failed to restore session "${session.displayName}" for ${binding.workspacePath}: ` +
                    `${activationResult.error || 'unknown error'}`,
                );
                continue;
            }

            restoredWorkspaces.add(binding.workspacePath);
            logger.info(`[StartupRestore] Restored session "${session.displayName}" for workspace ${binding.workspacePath}`);
        } catch (error: unknown) {
            logger.warn(`[StartupRestore] Failed to restore workspace ${binding.workspacePath}: ${(error as Error).message || error}`);
        }
    }
}

async function sendDiscordStartupDashboard({
    client,
    bridge,
    workspaceService,
    modeService,
    modelService,
}: Pick<
    DiscordStartupTasksDeps,
    'client' | 'bridge' | 'workspaceService' | 'modeService' | 'modelService'
>): Promise<void> {
    const os = await import('os');
    const projects = workspaceService.scanWorkspaces();

    let cdpModel: string | null = null;
    let cdpMode: string | null = null;
    if (projects.length > 0) {
        try {
            const prepared = await ensureWorkspaceRuntime(bridge, projects[0]);
            const cdp = prepared.cdp;
            cdpModel = await cdp.getCurrentModel();
            cdpMode = await cdp.getCurrentMode();
        } catch (error: unknown) {
            logger.debug(
                'Startup CDP probe failed (will use defaults):',
                error instanceof Error ? error.message : error,
            );
        }
    }

    const {
        cdpStatus,
        startupModel,
        startupMode,
    } = buildStartupStatusSnapshot({
        bridge,
        cdpMode,
        cdpModel,
        modeService,
        modelService,
    });

    const dashboardEmbed = new EmbedBuilder()
        .setTitle('ClawGravity Online')
        .setColor(0x57F287)
        .addFields(
            { name: 'Version', value: APP_VERSION, inline: true },
            { name: 'Node.js', value: process.versions.node, inline: true },
            { name: 'OS', value: `${os.platform()} ${os.release()}`, inline: true },
            { name: 'CDP', value: cdpStatus, inline: true },
            { name: 'Projects', value: `${projects.length} registered`, inline: true },
        )
        .setFooter({ text: `${startupMode} | ${startupModel}` })
        .setTimestamp();

    const guild = client.guilds.cache.first();
    if (!guild) return;
    const botUser = client.user;
    if (!botUser) return;

    const channel = guild.channels.cache.find(
        (candidate) =>
            candidate.isTextBased()
            && !candidate.isVoiceBased()
            && candidate.permissionsFor(botUser)?.has('SendMessages'),
    );
    if (!channel || !channel.isTextBased()) return;

    await channel.send({ embeds: [dashboardEmbed] });
    logger.info('Startup dashboard embed sent.');
}

export async function runDiscordStartupTasks(
    deps: DiscordStartupTasksDeps,
): Promise<void> {
    try {
        await registerSlashCommands(deps.discordToken, deps.discordClientId, deps.guildId);
    } catch {
        logger.warn('Failed to register slash commands, but text commands remain available.');
    }

    try {
        await sendDiscordStartupDashboard(deps);
    } catch (error: unknown) {
        logger.warn('Failed to send startup dashboard embed:', error);
    }

    try {
        await restoreDiscordSessionsOnStartup(deps);
    } catch (error: unknown) {
        logger.warn('Failed to restore Discord sessions on startup:', error);
    }
}
