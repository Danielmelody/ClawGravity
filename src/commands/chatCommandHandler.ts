import { t } from "../utils/i18n";
import {
    ChatInputCommandInteraction,
    EmbedBuilder,
    ChannelType,
} from 'discord.js';
import { ChatSessionService } from '../services/chatSessionService';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { ChannelManager } from '../services/channelManager';
import { CdpConnectionPool } from '../services/cdpConnectionPool';
import { WorkspaceService } from '../services/workspaceService';

/**
 * Handler for chat session related commands
 *
 * Commands:
 *   - /new: Create a new session channel under the category + start a new chat in Antigravity
 *   - /clear: Clear current conversation history by starting a new backend session (no new channel)
 *   - /chat: Display current session info + list all sessions in the same project (unified)
 */
export class ChatCommandHandler {
    private readonly chatSessionService: ChatSessionService;
    private readonly chatSessionRepo: ChatSessionRepository;
    private readonly bindingRepo: WorkspaceBindingRepository;
    private readonly channelManager: ChannelManager;
    private readonly pool: CdpConnectionPool | null;
    private readonly workspaceService: WorkspaceService;

    constructor(
        chatSessionService: ChatSessionService,
        chatSessionRepo: ChatSessionRepository,
        bindingRepo: WorkspaceBindingRepository,
        channelManager: ChannelManager,
        workspaceService: WorkspaceService,
        pool?: CdpConnectionPool,
    ) {
        this.chatSessionService = chatSessionService;
        this.chatSessionRepo = chatSessionRepo;
        this.bindingRepo = bindingRepo;
        this.channelManager = channelManager;
        this.workspaceService = workspaceService;
        this.pool = pool ?? null;
    }

    /** Resolve workspace name from the current channel. */
    private resolveWorkspaceName(channelId: string): string | undefined {
        const currentSession = this.chatSessionRepo.findByChannelId(channelId);
        const binding = this.bindingRepo.findByChannelId(channelId);
        return currentSession?.workspacePath ?? binding?.workspacePath;
    }

    /**
     * /new -- Create a new session channel under the category and start a new chat in Antigravity
     */
    async handleNew(interaction: ChatInputCommandInteraction): Promise<void> {
        const guild = interaction.guild;
        if (!guild) {
            await interaction.editReply({ content: t('⚠️ This command can only be used in a server.') });
            return;
        }

        const channel = interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.editReply({ content: t('⚠️ Please execute in a text channel.') });
            return;
        }

        // Check if the current channel is under a project category
        const parentId = 'parentId' in channel ? channel.parentId : null;
        if (!parentId) {
            await interaction.editReply({
                content: t('⚠️ Please run in a project category channel.\nUse `/project` to create a project first.'),
            });
            return;
        }

        // Determine the project path
        const workspaceName = this.resolveWorkspaceName(interaction.channelId);
        if (!workspaceName) {
            await interaction.editReply({
                content: t('⚠️ Please run in a project category channel.\nUse `/project` to create a project first.'),
            });
            return;
        }

        // Convert workspace name to full path
        const workspacePath = this.workspaceService.getWorkspacePath(workspaceName);

        // Switch project (connect to the correct workbench page)
        let runtime;
        if (this.pool) {
            try {
                runtime = this.pool.getOrCreateRuntime(workspacePath);
                await runtime.ready();
            } catch (e: any) {
                await interaction.editReply({
                    content: t(`⚠️ Failed to switch project: ${e.message}`),
                });
                return;
            }
        }

        if (!runtime) {
            await interaction.editReply({
                content: t('⚠️ CDP pool is not initialized or cannot connect to workspace.'),
            });
            return;
        }

        // Create a new session channel
        const sessionNumber = this.chatSessionRepo.getNextSessionNumber(parentId);
        const channelName = `session-${sessionNumber}`;
        const sessionResult = await this.channelManager.createSessionChannel(guild, parentId, channelName);
        const newChannelId = sessionResult.channelId;

        // Register binding and session
        this.bindingRepo.upsert({
            channelId: newChannelId,
            workspacePath: workspaceName,
            guildId: guild.id,
        });

        this.chatSessionRepo.create({
            channelId: newChannelId,
            categoryId: parentId,
            workspacePath: workspaceName,
            sessionNumber,
            guildId: guild.id,
        });

        const embed = new EmbedBuilder()
            .setTitle(t('💬 Started a new session'))
            .setDescription(t(`Created a new chat session\n→ <#${newChannelId}>`))
            .setColor(0x00CC88)
            .addFields(
                { name: t('Session'), value: channelName, inline: true },
                { name: t('Project'), value: workspacePath, inline: true },
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }

    /**
     * /clear -- Clear current conversation history by starting a new backend session.
     * Unlike /new, this does NOT create a new Discord channel — the user stays in the same channel.
     */
    async handleClear(interaction: ChatInputCommandInteraction): Promise<void> {
        // Resolve workspace from current channel
        const workspaceName = this.resolveWorkspaceName(interaction.channelId);

        if (!workspaceName) {
            await interaction.editReply({
                content: t('⚠️ No project bound to this channel. Use `/project` first.'),
            });
            return;
        }

        const workspacePath = this.workspaceService.getWorkspacePath(workspaceName);

        let runtime;
        if (this.pool) {
            try {
                runtime = this.pool.getOrCreateRuntime(workspacePath);
            } catch (e: any) {
                await interaction.editReply({
                    content: t(`⚠️ Failed to connect: ${e.message}`),
                });
                return;
            }
        }

        if (!runtime) {
            await interaction.editReply({
                content: t('⚠️ CDP pool is not initialized or cannot connect to workspace.'),
            });
            return;
        }

        try {
            const result = await runtime.startNewChat(this.chatSessionService);
            if (result.ok) {
                const embed = new EmbedBuilder()
                    .setTitle(t('🗑️ History Cleared'))
                    .setDescription(t('Conversation history has been cleared. Starting fresh.'))
                    .setColor(0xE67E22)
                    .addFields(
                        { name: t('Project'), value: workspacePath, inline: true },
                    )
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            } else {
                await interaction.editReply({
                    content: t(`⚠️ Failed to clear history: ${result.error || 'unknown error'}`),
                });
            }
        } catch (e: any) {
            await interaction.editReply({
                content: t(`⚠️ Failed to clear history: ${e.message}`),
            });
        }
    }

    /**
     * /chat -- Display current session info + list all sessions in the same project (unified view)
     */
    async handleChat(interaction: ChatInputCommandInteraction): Promise<void> {
        const session = this.chatSessionRepo.findByChannelId(interaction.channelId);

        if (!session) {
            // Channel not managed by session -- get info directly from Antigravity
            const activeNames = this.pool?.getActiveWorkspaceNames() ?? [];
            const anyCdp = activeNames.length > 0 ? this.pool?.getConnected(activeNames[0]) : null;
            const info = anyCdp
                ? await this.chatSessionService.getCurrentSessionInfo(anyCdp)
                : { title: t('(CDP Disconnected)'), hasActiveChat: false };

            const embed = new EmbedBuilder()
                .setTitle(t('💬 Chat Session Info'))
                .setColor(info.hasActiveChat ? 0x00CC88 : 0x888888)
                .addFields(
                    { name: t('Title'), value: info.title, inline: true },
                    { name: t('Status'), value: info.hasActiveChat ? t('🟢 Active') : t('⚪ Inactive'), inline: true },
                )
                .setDescription(t('※ Non-session channel.\nUse `/project` to create a project first.'))
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            return;
        }

        // Get all sessions in the same category
        const allSessions = this.chatSessionRepo.findByCategoryId(session.categoryId);

        // Build session list
        const sessionList = allSessions.map((s) => {
            const name = s.displayName ? `${s.displayName}` : `session-${s.sessionNumber}`;
            const current = s.channelId === interaction.channelId ? t(' ← **Current**') : '';
            return `• <#${s.channelId}> — ${name}${current}`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setTitle(t('💬 Chat Session Info'))
            .setColor(0x00CC88)
            .addFields(
                { name: t('Current session'), value: t(`#${session.sessionNumber} — ${session.displayName || '(Unset)'}`), inline: false },
                { name: t('Project'), value: session.workspacePath, inline: true },
                { name: t('Total sessions'), value: `${allSessions.length}`, inline: true },
            )
            .setDescription(t(`**Sessions:**\n${sessionList}`))
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
}
