import type { PlatformChannel, PlatformMessage, PlatformSelectInteraction, SelectMenuDef } from '../platform/types';
import type { TelegramBindingRepository } from '../database/telegramBindingRepository';
import type { TelegramSessionRoutingRepository } from '../database/telegramSessionRoutingRepository';
import type { TelegramRecentMessageRepository } from '../database/telegramRecentMessageRepository';
import type { WorkspaceService } from '../services/workspaceService';
import type { ChatSessionService, ConversationHistoryEntry } from '../services/chatSessionService';
import type { CdpBridge } from '../services/cdpBridgeManager';
import type { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import type { ClawCommandInterceptor } from '../services/clawCommandInterceptor';
import type { WorkspaceRuntime } from '../services/workspaceRuntime';
import { ensureWorkspaceRuntime } from '../services/cdpBridgeManager';
import { extractCascadeRunStatus } from '../services/grpcCascadeClient';
import { startMonitorForActiveSession } from './telegramMessageHandler';
import { escapeHtml } from '../platform/telegram/trajectoryRenderer';
import { logger } from '../utils/logger';
import { formatRelativeTime } from '../utils/relativeTime';

export const TG_JOIN_SELECT_ID = 'tg_join_select';
const MAX_TELEGRAM_HISTORY_CHARS = 3800;

export interface TelegramSessionChannelRouting {
    readonly parentChannel: PlatformChannel;
    readonly threadChannel: PlatformChannel | null;
}

export class TelegramSessionStateStore {
    constructor(
        private readonly recentMessageRepo?: TelegramRecentMessageRepository,
        private readonly routingRepo?: TelegramSessionRoutingRepository
    ) { 
        if (routingRepo) {
            for (const r of routingRepo.getAllRoutings()) {
                // Prepopulate on boot
                // We recreate minimalist dummy objects that act as channels, 
                // because all the bot needs is the string IDs for `parentChannel.id` and `threadChannel.id`
                const parentChannel = { id: r.chatId } as PlatformChannel;
                const threadChannel = r.threadId ? { id: r.threadId } as PlatformChannel : null;
                this.channelRoutingByChatAndCascade.set(`${r.chatId}:${r.cascadeId}`, { parentChannel, threadChannel });
                if (r.threadId) {
                    this.cascadeByThreadId.set(r.threadId, r.cascadeId);
                }
            }
        }
    }

    private readonly selectedSessionByChat = new Map<string, { title: string, id: string }>();
    private readonly recentMessagesByChat = new Map<string, string[]>();
    private readonly inspectByChat = new Map<string, boolean>();
    private readonly channelRoutingByChatAndCascade = new Map<string, TelegramSessionChannelRouting>();
    private readonly cascadeByThreadId = new Map<string, string>();

    private getRoutingKey(chatId: string, cascadeId: string | null | undefined): string {
        return `${chatId}:${cascadeId || 'default'}`;
    }

    setSelectedSession(chatId: string, sessionTitle: string, cascadeId: string = ''): void {
        this.selectedSessionByChat.set(chatId, { title: sessionTitle, id: cascadeId });
    }

    getSelectedSession(chatId: string): { title: string, id: string } | null {
        return this.selectedSessionByChat.get(chatId) ?? null;
    }

    getCurrentCascadeId(chatId: string): string | null {
        const session = this.selectedSessionByChat.get(chatId);
        return session?.id || null;
    }

    setCurrentCascadeId(chatId: string, cascadeId: string): void {
        if (!cascadeId) return;
        const existing = this.selectedSessionByChat.get(chatId);
        this.selectedSessionByChat.set(chatId, {
            title: existing?.title || '',
            id: cascadeId,
        });
    }

    clearSelectedSession(chatId: string): void {
        this.selectedSessionByChat.delete(chatId);
        this.inspectByChat.delete(chatId);
        this.channelRoutingByChatAndCascade.delete(this.getRoutingKey(chatId, 'default'));
        const currentId = this.getCurrentCascadeId(chatId);
        if (currentId) {
            this.channelRoutingByChatAndCascade.delete(this.getRoutingKey(chatId, currentId));
        }
    }

    setInspect(chatId: string, enabled: boolean): void {
        this.inspectByChat.set(chatId, enabled);
    }

    getInspect(chatId: string): boolean {
        return this.inspectByChat.get(chatId) ?? false;
    }

    pushRecentMessage(chatId: string, text: string): void {
        const normalized = text.trim();
        if (!normalized) return;

        const list = this.recentMessagesByChat.get(chatId) ?? [];
        list.push(normalized);
        if (list.length > 10) {
            list.splice(0, list.length - 10);
        }
        this.recentMessagesByChat.set(chatId, list);
        this.recentMessageRepo?.addMessage(chatId, normalized);
    }

    getRecentMessages(chatId: string, limit = 2): string[] {
        const persisted = this.recentMessageRepo?.getRecentMessages(chatId, limit) ?? [];
        if (persisted.length > 0) {
            return persisted;
        }

        const list = this.recentMessagesByChat.get(chatId) ?? [];
        return list.slice(-limit);
    }

    setChannelRouting(
        chatId: string,
        parentChannel: PlatformChannel,
        threadChannel: PlatformChannel | null = null,
        cascadeId: string | null = null
    ): void {
        const cid = cascadeId ?? this.getCurrentCascadeId(chatId);
        const key = this.getRoutingKey(chatId, cid);
        this.channelRoutingByChatAndCascade.set(key, { parentChannel, threadChannel });
        if (threadChannel?.id && cid) {
            this.cascadeByThreadId.set(threadChannel.id, cid);
        }
        if (cid && this.routingRepo) {
            this.routingRepo.putRouting(chatId, cid, threadChannel?.id || null);
        }
    }

    getCascadeIdByThreadId(threadChannelId: string): string | null {
        return this.cascadeByThreadId.get(threadChannelId) ?? null;
    }

    getChannelRouting(chatId: string, cascadeId: string | null = null): TelegramSessionChannelRouting | null {
        const cid = cascadeId ?? this.getCurrentCascadeId(chatId);
        const key = this.getRoutingKey(chatId, cid);
        return this.channelRoutingByChatAndCascade.get(key) ?? null;
    }

    getParentChannel(chatId: string, cascadeId: string | null = null): PlatformChannel | null {
        return this.getChannelRouting(chatId, cascadeId)?.parentChannel ?? null;
    }

    getThreadChannel(chatId: string, cascadeId: string | null = null): PlatformChannel | null {
        return this.getChannelRouting(chatId, cascadeId)?.threadChannel ?? null;
    }
}

export interface TelegramJoinCommandDeps {
    readonly bridge: CdpBridge;
    readonly telegramBindingRepo: TelegramBindingRepository;
    readonly workspaceService?: WorkspaceService;
    readonly chatSessionService: ChatSessionService;
    readonly sessionStateStore: TelegramSessionStateStore;
    /** Shared active monitor map — allows /stop to halt streaming. */
    readonly activeMonitors?: Map<string, GrpcResponseMonitor>;
    /** Interceptor that scans AI responses for @claw commands. */
    readonly clawInterceptor?: ClawCommandInterceptor;
}

/** Shared workspace→runtime resolution used by both join command and join select. */
async function resolveBindingRuntime(
    deps: TelegramJoinCommandDeps,
    chatId: string,
    replyTarget: { reply: (opts: { text: string }) => Promise<unknown> },
): Promise<{ runtime: WorkspaceRuntime; projectName: string } | null> {
    const binding = deps.telegramBindingRepo.findByChatId(chatId);
    if (!binding) {
        await replyTarget.reply({
            text: 'No project is linked to this chat. Use /project to bind a workspace first.',
        }).catch(logger.error);
        return null;
    }

    const workspacePath = deps.workspaceService
        ? deps.workspaceService.getWorkspacePath(binding.workspacePath)
        : binding.workspacePath;

    try {
        const prepared = await ensureWorkspaceRuntime(deps.bridge, workspacePath);
        return { runtime: prepared.runtime as WorkspaceRuntime, projectName: prepared.projectName };
    } catch (err: unknown) {
        await replyTarget.reply({
            text: `Failed to connect to project: ${escapeHtml((err as Error)?.message || 'unknown error')}`,
        }).catch(logger.error);
        return null;
    }
}

/**
 * Stop all active and passive monitors for a specific chat within a project.
 * Mirrors the logic in telegramCommands.ts stopProjectMonitors.
 */
export async function stopChatMonitors(
    activeMonitors: Map<string, GrpcResponseMonitor> | undefined,
    projectName: string,
    chatId: string,
): Promise<void> {
    if (!activeMonitors) return;
    const monitorKey = `${projectName}:${chatId}`;
    for (const key of [monitorKey, `passive:${monitorKey}`]) {
        const monitor = activeMonitors.get(key);
        if (monitor?.isActive()) {
            await monitor.stop().catch(() => { });
        }
        activeMonitors.delete(key);
    }
}

export async function handleTelegramJoinCommand(
    deps: TelegramJoinCommandDeps,
    message: PlatformMessage,
): Promise<void> {
    const chatId = message.channel.id;
    const resolved = await resolveBindingRuntime(deps, chatId, message);
    if (!resolved) return;
    const { runtime } = resolved;

    let sessions;
    try {
        sessions = await runtime.listAllSessions(deps.chatSessionService);
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[TelegramJoin] listAllSessions failed: ${errMsg}`);
        await message.reply({ text: `Failed to list sessions: ${escapeHtml(errMsg || 'unknown error')}` }).catch(logger.error);
        return;
    }
    if (sessions.length === 0) {
        await message.reply({ text: 'No history sessions found in the Antigravity side panel.' }).catch(logger.error);
        return;
    }

    const currentTitle = deps.sessionStateStore.getSelectedSession(chatId);
    const selectMenu: SelectMenuDef = {
        type: 'selectMenu',
        customId: TG_JOIN_SELECT_ID,
        placeholder: 'Select a history session',
        options: sessions.slice(0, 25).map((session: { title: string; lastModifiedTime?: number; cascadeId?: string }) => {
            const timeStr = session.lastModifiedTime ? formatRelativeTime(session.lastModifiedTime) : '';
            const isCurrent = session.title === currentTitle?.title;
            const suffix = [
                timeStr,
                isCurrent ? 'current' : '',
            ].filter(Boolean).join(', ');
            const label = suffix ? `${session.title} (${suffix})` : session.title;
            return { label, value: session.title };
        }),
    };

    try {
        await message.reply({
            text: `Select a history session to join (${sessions.length} found):`,
            components: [{ components: [selectMenu] }],
        });
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[TelegramJoin] Failed to send session picker: ${errMsg}`);
        await message.reply({ text: `Failed to show session picker: ${escapeHtml(errMsg || 'unknown error')}` }).catch(logger.error);
    }
}

export async function handleTelegramJoinSelect(
    deps: TelegramJoinCommandDeps,
    interaction: PlatformSelectInteraction,
): Promise<void> {
    const selectedTitle = interaction.values[0];
    if (!selectedTitle) return;

    const chatId = interaction.channel.id;
    const resolved = await resolveBindingRuntime(deps, chatId, interaction);
    if (!resolved) return;
    const { runtime, projectName } = resolved;

    // Stop any monitors streaming from the previous session before switching
    await stopChatMonitors(deps.activeMonitors, projectName, chatId);

    const sessions = await runtime.listAllSessions(deps.chatSessionService);
    // Exact match first; fall back to prefix match in case callback_data was
    // truncated to fit Telegram's 64-byte limit.
    let selectedSession = sessions.find((s: { title: string; cascadeId?: string }) => s.title === selectedTitle);
    if (!selectedSession && selectedTitle.length > 0) {
        selectedSession = sessions.find((s: { title: string; cascadeId?: string }) => s.title.startsWith(selectedTitle));
    }
    const resolvedTitle = selectedSession?.title || selectedTitle;
    const cascadeId = selectedSession?.cascadeId || '';

    deps.sessionStateStore.setSelectedSession(chatId, resolvedTitle, cascadeId);

    if (cascadeId) {
        await runtime.setActiveCascade(cascadeId);
        
        // Auto-create and bind a Forum Topic if it lacks one
        const existingThread = deps.sessionStateStore.getThreadChannel(chatId, cascadeId);
        if (!existingThread && typeof interaction.channel.createThread === 'function') {
            const threadChannel = await interaction.channel.createThread(`Session: ${resolvedTitle}`).catch((error: unknown) => {
                logger.debug(`[TelegramJoin] Failed to auto-create topic for switched session: ${error instanceof Error ? error.message : String(error)}`);
                return null;
            });
            if (threadChannel) {
                deps.sessionStateStore.setChannelRouting(chatId, interaction.channel, threadChannel, cascadeId);
                logger.info(`[TelegramJoin] Auto-bound session ${cascadeId.slice(0, 8)} to new topic`);
            }
        }
    }

    // Check if the switched-to cascade is still actively streaming.
    // If so, start a passive monitor to capture and relay its remaining output.
    if (cascadeId) {
        const monitoringTarget = await runtime.getMonitoringTarget(cascadeId);
        if (monitoringTarget) {
            try {
                const traj = await monitoringTarget.grpcClient.rawRPC('GetCascadeTrajectory', { cascadeId });
                const runStatus = extractCascadeRunStatus(traj);
                if (runStatus === 'CASCADE_RUN_STATUS_RUNNING') {
                    logger.info(`[TelegramJoin] Cascade ${cascadeId.slice(0, 12)}... is still streaming — starting passive monitor`);
                    await startMonitorForActiveSession(
                        interaction.channel, runtime, cascadeId,
                        deps.activeMonitors, deps.clawInterceptor,
                        deps.sessionStateStore,
                    );
                }
            } catch (err: unknown) {
                logger.debug(`[TelegramJoin] runStatus check failed: ${(err as Error)?.message || err}`);
            }
        }
    }

    await interaction.update({
        text: `Joined history session: <b>${escapeHtml(resolvedTitle)}</b>\nLoading conversation history into Telegram...`,
        components: [],
    }).catch(logger.error);

    const history = await runtime.getConversationHistory(deps.chatSessionService, {
        maxMessages: 500,
        maxScrollSteps: 40,
    });

    const chunks = formatConversationHistory(resolvedTitle, history.messages, history.truncated);
    if (chunks.length === 0) {
        await interaction.followUp({
            text: 'No visible conversation history could be extracted from Antigravity.',
        }).catch(logger.error);
        return;
    }

    for (const chunk of chunks) {
        try {
            await interaction.followUp({ text: chunk });
        } catch (error) {
            logger.error(error);
        }
    }
}

export function createTelegramJoinSelectHandler(
    deps: TelegramJoinCommandDeps,
): (interaction: PlatformSelectInteraction) => Promise<void> {
    return async (interaction: PlatformSelectInteraction): Promise<void> => {
        if (interaction.customId !== TG_JOIN_SELECT_ID) {
            logger.debug(`[TelegramJoin] Unhandled customId: ${interaction.customId}`);
            return;
        }

        await handleTelegramJoinSelect(deps, interaction);
    };
}

function formatConversationHistory(
    title: string,
    messages: readonly ConversationHistoryEntry[],
    truncated: boolean,
): string[] {
    if (messages.length === 0) {
        return [];
    }

    const header = [
        `<b>History: ${escapeHtml(title)}</b>`,
        truncated ? '<i>Showing the latest 500 messages. Older entries were truncated.</i>' : '',
    ].filter(Boolean).join('\n');

    const parts: string[] = [];
    let current = header;

    for (const message of messages) {
        const speaker = message.role === 'user' ? 'You' : 'Antigravity';
        const block = `\n\n<b>${speaker}</b>\n${escapeHtml(message.text)}`;
        if ((current + block).length <= MAX_TELEGRAM_HISTORY_CHARS) {
            current += block;
            continue;
        }

        if (current.trim()) {
            parts.push(current);
        }

        const blockPrefix = `<b>${speaker}</b>\n`;
        const body = escapeHtml(message.text);
        if ((blockPrefix + body).length <= MAX_TELEGRAM_HISTORY_CHARS) {
            current = `${header}\n\n${blockPrefix}${body}`;
            continue;
        }

        const slices = chunkLongText(body, MAX_TELEGRAM_HISTORY_CHARS - blockPrefix.length - 32);
        current = `${header}\n\n${blockPrefix}${slices.shift() ?? ''}`;
        for (const slice of slices) {
            parts.push(current);
            current = `${header}\n\n${blockPrefix}${slice}`;
        }
    }

    if (current.trim()) {
        parts.push(current);
    }

    return parts;
}

function chunkLongText(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLength) {
        let splitAt = remaining.lastIndexOf('\n', maxLength);
        if (splitAt < Math.floor(maxLength * 0.6)) {
            splitAt = remaining.lastIndexOf(' ', maxLength);
        }
        if (splitAt < Math.floor(maxLength * 0.6)) {
            splitAt = maxLength;
        }
        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) {
        chunks.push(remaining);
    }
    return chunks.length > 0 ? chunks : [''];
}
