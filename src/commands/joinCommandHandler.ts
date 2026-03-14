import { t } from '../utils/i18n';
import {
    ChatInputCommandInteraction,
    Client,
    EmbedBuilder,
    StringSelectMenuInteraction,
} from 'discord.js';
import { ChatSessionService } from '../services/chatSessionService';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { ChannelManager } from '../services/channelManager';
import { CdpConnectionPool } from '../services/cdpConnectionPool';
import {
    CdpBridge,
    ensureWorkspaceRuntime,
    getCurrentChatTitle,
} from '../services/cdpBridgeManager';
import { CdpService } from '../services/cdpService';
import { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import { WorkspaceRuntime } from '../services/workspaceRuntime';
import { WorkspaceService } from '../services/workspaceService';
import { buildSessionPickerUI } from '../ui/sessionPickerUi';
import { logger } from '../utils/logger';
import type { ExtractionMode } from '../utils/config';

/** Maximum embed description length (Discord limit is 4096) */
const MAX_EMBED_DESC = 4000;

/**
 * Handler for /history and /mirror commands
 *
 * /history — List Antigravity sessions and connect to one via a select menu.
 * /mirror — Toggle PC-to-Discord message mirroring ON/OFF.
 */
export class JoinCommandHandler {
    private static readonly DISCORD_MIRROR_SINK_PREFIX = 'discord:mirror:';
    private readonly chatSessionService: ChatSessionService;
    private readonly chatSessionRepo: ChatSessionRepository;
    private readonly bindingRepo: WorkspaceBindingRepository;
    private readonly channelManager: ChannelManager;
    private readonly pool: CdpConnectionPool;
    private readonly workspaceService: WorkspaceService;
    private readonly client: Client;
    private readonly extractionMode?: ExtractionMode;

    /** Active gRPC response monitors per workspace (for AI response mirroring) */
    private readonly activeResponseMonitors = new Map<string, GrpcResponseMonitor>();

    constructor(
        chatSessionService: ChatSessionService,
        chatSessionRepo: ChatSessionRepository,
        bindingRepo: WorkspaceBindingRepository,
        channelManager: ChannelManager,
        pool: CdpConnectionPool,
        workspaceService: WorkspaceService,
        client: Client,
        extractionMode?: ExtractionMode,
    ) {
        this.chatSessionService = chatSessionService;
        this.chatSessionRepo = chatSessionRepo;
        this.bindingRepo = bindingRepo;
        this.channelManager = channelManager;
        this.pool = pool;
        this.workspaceService = workspaceService;
        this.client = client;
        this.extractionMode = extractionMode;
    }

    /**
     * Resolve a project name (from DB) to its full absolute path.
     * The DB stores only the project name; CDP needs the full path for launching.
     */
    private resolveProjectPath(projectName: string): string {
        return this.workspaceService.getWorkspacePath(projectName);
    }

    /**
     * Resolve the project name bound to the current channel.
     * Returns null if no binding exists (after sending an error reply).
     */
    private resolveProjectForChannel(
        channelId: string,
    ): string | null {
        const binding = this.bindingRepo.findByChannelId(channelId);
        const session = this.chatSessionRepo.findByChannelId(channelId);
        return binding?.workspacePath ?? session?.workspacePath ?? null;
    }

    /**
     * Resolve the project name and full path for the current channel,
     * replying with an error if no binding exists.
     * Returns null if no project is bound (after sending an error reply).
     */
    private async resolveProjectWithPath(
        interaction: ChatInputCommandInteraction,
    ): Promise<{ projectName: string; projectPath: string } | null> {
        const projectName = this.resolveProjectForChannel(interaction.channelId);
        if (!projectName) {
            await interaction.editReply({
                content: t('⚠️ No project is bound to this channel. Use `/project` first.'),
            });
            return null;
        }
        const projectPath = this.resolveProjectPath(projectName);
        return { projectName, projectPath };
    }

    private getMirrorSinkKey(projectName: string): string {
        return `${JoinCommandHandler.DISCORD_MIRROR_SINK_PREFIX}${projectName}`;
    }

    private getSendableChannel(channelId: string): { send: (...args: unknown[]) => Promise<unknown> } | null {
        const channel = this.client.channels.cache.get(channelId);
        return channel && 'send' in channel ? channel as { send: (...args: unknown[]) => Promise<unknown> } : null;
    }

    private async getRecentMessagesToReplay(
        interaction: StringSelectMenuInteraction,
        limit = 2,
    ): Promise<string[]> {
        const channel = interaction.channel;
        if (!channel || !('messages' in channel) || typeof channel.messages?.fetch !== 'function') {
            return [];
        }

        try {
            const fetched = await channel.messages.fetch({ limit: 10 });
            return fetched
                .filter((msg) => !msg.author?.bot && typeof msg.content === 'string' && msg.content.trim().length > 0)
                .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
                .map((msg) => msg.content.trim())
                .slice(-limit);
        } catch (error) {
            logger.warn('[Join] Failed to fetch recent messages for replay:', error);
            return [];
        }
    }

    private async replayRecentMessagesToSession(
        interaction: StringSelectMenuInteraction,
        runtime: WorkspaceRuntime,
        targetChannelId: string,
    ): Promise<string[]> {
        const messages = await this.getRecentMessagesToReplay(interaction, 2);
        if (messages.length === 0) return [];

        const replayed: string[] = [];

        for (const text of messages) {
            const injectResult = await runtime.sendPrompt({ text, echoText: text });
            if (!injectResult.ok) {
                logger.warn(`[Join] Failed to replay message into joined session: ${injectResult.error}`);
                continue;
            }

            replayed.push(text);
        }

        const targetChannel = this.getSendableChannel(targetChannelId);
        if (targetChannel && replayed.length > 0) {
            const preview = replayed
                .map((text, index) => `${index + 1}. ${text.slice(0, 240)}`)
                .join('\n');

            const embed = new EmbedBuilder()
                .setTitle(t('↪ Imported Recent Messages'))
                .setDescription(preview)
                .setColor(0x95A5A6)
                .setFooter({ text: t('Automatically replayed after joining the session') })
                .setTimestamp();

            await targetChannel.send({ embeds: [embed] }).catch((error: Error) => {
                logger.warn('[Join] Failed to send replay summary:', error);
            });
        }

        return replayed;
    }

    /**
     * /history — Show session picker for the workspace bound to this channel.
     */
    async handleJoin(
        interaction: ChatInputCommandInteraction,
        bridge: CdpBridge,
    ): Promise<void> {
        const resolved = await this.resolveProjectWithPath(interaction);
        if (!resolved) return;
        const { projectPath } = resolved;

        let runtime;
        try {
            const prepared = await ensureWorkspaceRuntime(bridge, projectPath);
            runtime = prepared.runtime;
        } catch (e: unknown) {
            await interaction.editReply({
                content: t(`⚠️ Failed to connect to project: ${(e as Error).message}`),
            });
            return;
        }

        const sessions = await runtime.listAllSessions(this.chatSessionService);
        const { embeds, components } = buildSessionPickerUI(sessions);

        await interaction.editReply({ embeds, components });
    }

    /**
     * Handle session selection from the /history picker.
     *
     * Flow:
     *   1. Check if a channel already exists for this session (by displayName)
     *   2. If yes → reply with a link to that channel
     *   3. If no → create a new channel, bind it, activate session, start mirroring
     */
    async handleJoinSelect(
        interaction: StringSelectMenuInteraction,
        bridge: CdpBridge,
    ): Promise<void> {
        const selectedTitle = interaction.values[0];
        const guild = interaction.guild;

        if (!guild) {
            await interaction.editReply({ content: t('⚠️ This command can only be used in a server.') });
            return;
        }

        const projectName = this.resolveProjectForChannel(interaction.channelId);

        if (!projectName) {
            await interaction.editReply({ content: t('⚠️ No project is bound to this channel.') });
            return;
        }

        const projectPath = this.resolveProjectPath(projectName);

        // Step 1: Check if a channel already exists for this session
        const existingSession = this.chatSessionRepo.findByDisplayName(projectName, selectedTitle);
        if (existingSession) {
            const embed = new EmbedBuilder()
                .setTitle(t('🔗 Session Already Connected'))
                .setDescription(t(`This session already has a channel:\n→ <#${existingSession.channelId}>`))
                .setColor(0x3498DB)
                .setTimestamp();
            await interaction.editReply({ embeds: [embed], components: [] });
            return;
        }

        // Step 2: Connect to CDP
        let runtime;
        try {
            const prepared = await ensureWorkspaceRuntime(bridge, projectPath);
            runtime = prepared.runtime;
        } catch (e: unknown) {
            await interaction.editReply({ content: t(`⚠️ Failed to connect to project: ${(e as Error).message}`) });
            return;
        }

        // Step 3: Activate the session in Antigravity
        const activateResult = await runtime.activateSessionByTitle(this.chatSessionService, selectedTitle);
        if (!activateResult.ok) {
            await interaction.editReply({ content: t(`⚠️ Failed to join session: ${activateResult.error}`) });
            return;
        }

        // Step 4: Create a new Discord channel for this session
        const categoryResult = await this.channelManager.ensureCategory(guild, projectName);
        const categoryId = categoryResult.categoryId;
        const sessionNumber = this.chatSessionRepo.getNextSessionNumber(categoryId);
        const channelName = this.channelManager.sanitizeChannelName(`${sessionNumber}-${selectedTitle}`);
        const channelResult = await this.channelManager.createSessionChannel(guild, categoryId, channelName);
        const newChannelId = channelResult.channelId;

        // Step 5: Register binding and session
        this.bindingRepo.upsert({
            channelId: newChannelId,
            workspacePath: projectName,
            guildId: guild.id,
        });

        this.chatSessionRepo.create({
            channelId: newChannelId,
            categoryId,
            workspacePath: projectName,
            sessionNumber,
            guildId: guild.id,
        });

        this.chatSessionRepo.updateDisplayName(newChannelId, selectedTitle);

        // Step 6: Start mirroring (routes dynamically to all bound session channels)
        try {
            await this.startMirroring(bridge, projectPath, projectName);
        } catch (error) {
            logger.warn('[Join] Failed to start mirroring after joining session:', error);
        }

        const replayedMessages = await this.replayRecentMessagesToSession(
            interaction,
            runtime,
            newChannelId,
        );

        const embed = new EmbedBuilder()
            .setTitle(t('🔗 Joined Session'))
            .setDescription(t(
                `Connected to: **${selectedTitle}**\n→ <#${newChannelId}>\n\n` +
                `${replayedMessages.length > 0 ? `↪ Replayed ${replayedMessages.length} recent message(s) into this session.\n` : ''}` +
                `📡 Mirroring is **ON** — PC messages will appear in the new channel.\n` +
                `Use \`/mirror\` to toggle.`,
            ))
            .setColor(0x2ECC71)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed], components: [] });
    }

    /**
     * /mirror — Toggle mirroring ON/OFF for the current channel's workspace.
     */
    async handleMirror(
        interaction: ChatInputCommandInteraction,
        bridge: CdpBridge,
    ): Promise<void> {
        const resolved = await this.resolveProjectWithPath(interaction);
        if (!resolved) return;
        const { projectName, projectPath } = resolved;

        const runtime = this.pool.getOrCreateRuntime(projectPath);
        const detector = this.pool.getUserMessageDetector(projectName);

        if (detector?.isActive()) {
            // Turn OFF — remove this handler's sink, then stop the detector only if
            // no other runtime consumers are still subscribed.
            runtime.removeUserMessageSink(this.getMirrorSinkKey(projectName));
            if (!runtime.hasUserMessageSinks()) {
                detector.stop();
            }
            const responseMonitor = this.activeResponseMonitors.get(projectName);
            if (responseMonitor?.isActive()) {
                await responseMonitor.stop();
                this.activeResponseMonitors.delete(projectName);
            }

            const embed = new EmbedBuilder()
                .setTitle(t('📡 Mirroring OFF'))
                .setDescription(t('PC-to-Discord message mirroring has been stopped.'))
                .setColor(0x95A5A6)
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } else {
            // Turn ON
            try {
                await this.startMirroring(bridge, projectPath, projectName);
            } catch (e: unknown) {
                await interaction.editReply({
                    content: t(`⚠️ Failed to connect to project: ${(e as Error).message}`),
                });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(t('📡 Mirroring ON'))
                .setDescription(t(
                    'PC-to-Discord message mirroring is now active.\n' +
                    'Messages typed in Antigravity will appear in the corresponding session channel.',
                ))
                .setColor(0x2ECC71)
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        }
    }

    /**
     * Start user message mirroring for a project.
     *
     * When a PC message is detected, the callback resolves the correct Discord
     * channel via chatSessionRepo.findByDisplayName. Only explicitly joined
     * sessions (with a displayName binding) receive mirrored messages.
     */
    private async startMirroring(
        bridge: CdpBridge,
        projectPath: string,
        projectName: string,
    ): Promise<void> {
        // Force re-prime the runtime-backed detector so it does not treat the
        // newly joined session's last visible message as a fresh PC input.
        const existing = this.pool.getUserMessageDetector(projectName);
        if (existing?.isActive()) {
            existing.stop();
        }

        let runtimeCdp: CdpService | null = null;
        const prepared = await ensureWorkspaceRuntime(bridge, projectPath, {
            userMessageSinkKey: this.getMirrorSinkKey(projectName),
            onUserMessage: (info) => {
                if (!runtimeCdp) return;
                this.routeMirroredMessage(runtimeCdp, projectName, info)
                    .catch((err) => {
                        logger.error('[Mirror] Error routing mirrored message:', err);
                    });
            },
        });
        runtimeCdp = prepared.cdp;
    }

    /**
     * Route a mirrored PC message to the correct Discord channel and
     * start a passive gRPC response monitor to capture the AI response.
     *
     * Routing: chatSessionRepo.findByDisplayName only — single lookup path.
     * Sessions without an explicit channel binding are silently skipped.
     */
    private async routeMirroredMessage(
        cdp: CdpService,
        projectName: string,
        info: { text: string },
    ): Promise<void> {
        const chatTitle = await getCurrentChatTitle(cdp);

        if (!chatTitle) {
            logger.debug('[Mirror] No chat title detected, skipping');
            return;
        }

        const session = this.chatSessionRepo.findByDisplayName(projectName, chatTitle);
        if (!session) {
            logger.debug(`[Mirror] No bound channel for session "${chatTitle}", skipping`);
            return;
        }

        const channel = this.client.channels.cache.get(session.channelId);
        if (!channel || !('send' in channel)) return;
        const sendable = channel as { send: (...args: unknown[]) => Promise<unknown> };

        // Mirror the user message
        const userEmbed = new EmbedBuilder()
            .setDescription(`🖥️ ${info.text}`)
            .setColor(0x95A5A6)
            .setFooter({ text: `Typed in Antigravity · ${chatTitle}` })
            .setTimestamp();

        await sendable.send({ embeds: [userEmbed] }).catch((err: Error) => {
            logger.error('[Mirror] Failed to send user message:', err);
        });

        // Start passive gRPC response monitor to capture the AI response
        void this.startResponseMirror(cdp, projectName, sendable, chatTitle, info.text);
    }

    /**
     * Start a passive gRPC response monitor that sends the AI response to Discord
     * when generation completes.
     */
    private async startResponseMirror(
        cdp: CdpService,
        projectName: string,
        channel: { send: (...args: unknown[]) => Promise<unknown> },
        chatTitle: string,
        promptText: string,
    ): Promise<void> {
        // Stop previous monitor if still running
        const prev = this.activeResponseMonitors.get(projectName);
        if (prev?.isActive()) {
            prev.stop().catch(() => { });
        }

        const grpcClient = await cdp.getGrpcClient();
        const cascadeId = grpcClient ? await cdp.getActiveCascadeId() : null;
        if (!grpcClient || !cascadeId) {
            logger.warn(`[Mirror] gRPC monitor unavailable for workspace "${projectName}"`);
            this.activeResponseMonitors.delete(projectName);
            return;
        }

        const monitor = new GrpcResponseMonitor({
            grpcClient,
            cascadeId,
            maxDurationMs: 300000,
            expectedUserMessage: promptText,
            onComplete: (finalText: string) => {
                this.activeResponseMonitors.delete(projectName);
                if (!finalText || finalText.trim().length === 0) return;

                const text = finalText.length > MAX_EMBED_DESC
                    ? finalText.slice(0, MAX_EMBED_DESC) + '\n…(truncated)'
                    : finalText;

                const embed = new EmbedBuilder()
                    .setDescription(text)
                    .setColor(0x5865F2)
                    .setFooter({ text: `Antigravity response · ${chatTitle}` })
                    .setTimestamp();

                channel.send({ embeds: [embed] }).catch((err: Error) => {
                    logger.error('[Mirror] Failed to send AI response:', err);
                });
            },
            onTimeout: () => {
                this.activeResponseMonitors.delete(projectName);
            },
        });

        this.activeResponseMonitors.set(projectName, monitor);
        monitor.startPassive().catch((err) => {
            logger.error('[Mirror] Failed to start response monitor:', err);
            this.activeResponseMonitors.delete(projectName);
        });
    }
}
