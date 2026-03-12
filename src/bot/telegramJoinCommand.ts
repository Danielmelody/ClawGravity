import type { PlatformMessage, PlatformSelectInteraction, SelectMenuDef } from '../platform/types';
import type { TelegramBindingRepository } from '../database/telegramBindingRepository';
import type { TelegramRecentMessageRepository } from '../database/telegramRecentMessageRepository';
import type { WorkspaceService } from '../services/workspaceService';
import type { ChatSessionService, ConversationHistoryEntry } from '../services/chatSessionService';
import type { CdpBridge } from '../services/cdpBridgeManager';
import type { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import type { ClawCommandInterceptor } from '../services/clawCommandInterceptor';
import { ensureWorkspaceRuntime } from '../services/cdpBridgeManager';
import { startMonitorForActiveSession } from './telegramMessageHandler';
import { escapeHtml } from '../platform/telegram/trajectoryRenderer';
import { logger } from '../utils/logger';
import { formatRelativeTime } from '../utils/relativeTime';

export const TG_JOIN_SELECT_ID = 'tg_join_select';
const MAX_TELEGRAM_HISTORY_CHARS = 3800;

export class TelegramSessionStateStore {
    constructor(private readonly recentMessageRepo?: TelegramRecentMessageRepository) { }

    private readonly selectedSessionByChat = new Map<string, { title: string, id: string }>();
    private readonly recentMessagesByChat = new Map<string, string[]>();
    private readonly inspectByChat = new Map<string, boolean>();

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
    replyTarget: { reply: (opts: { text: string }) => Promise<any> },
): Promise<{ runtime: any } | null> {
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
        return { runtime: prepared.runtime };
    } catch (err: any) {
        await replyTarget.reply({
            text: `Failed to connect to project: ${escapeHtml(err?.message || 'unknown error')}`,
        }).catch(logger.error);
        return null;
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

    const sessions = await runtime.listAllSessions(deps.chatSessionService);
    if (sessions.length === 0) {
        await message.reply({ text: 'No history sessions found in the Antigravity side panel.' }).catch(logger.error);
        return;
    }

    const currentTitle = deps.sessionStateStore.getSelectedSession(chatId);
    const selectMenu: SelectMenuDef = {
        type: 'selectMenu',
        customId: TG_JOIN_SELECT_ID,
        placeholder: 'Select a history session',
        options: sessions.slice(0, 25).map((session: any) => {
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

    await message.reply({
        text: `Select a history session to join (${sessions.length} found):`,
        components: [{ components: [selectMenu] }],
    }).catch(logger.error);
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
    const { runtime } = resolved;

    const sessions = await runtime.listAllSessions(deps.chatSessionService);
    const selectedSession = sessions.find((s: any) => s.title === selectedTitle);
    const cascadeId = selectedSession?.cascadeId || '';

    deps.sessionStateStore.setSelectedSession(chatId, selectedTitle, cascadeId);

    if (cascadeId) {
        await runtime.setActiveCascade(cascadeId);
    }

    // Check if the switched-to cascade is still actively streaming.
    // If so, start a passive monitor to capture and relay its remaining output.
    if (cascadeId) {
        const monitoringTarget = await runtime.getMonitoringTarget(cascadeId);
        if (monitoringTarget) {
            try {
                const traj = await monitoringTarget.grpcClient.rawRPC('GetCascadeTrajectory', { cascadeId });
                const runStatus = traj?.trajectory?.cascadeRunStatus
                    || traj?.cascadeRunStatus
                    || traj?.trajectory?.status
                    || traj?.status
                    || null;
                if (runStatus === 'CASCADE_RUN_STATUS_RUNNING') {
                    logger.info(`[TelegramJoin] Cascade ${cascadeId.slice(0, 12)}... is still streaming — starting passive monitor`);
                    await startMonitorForActiveSession(
                        interaction.channel, runtime, cascadeId,
                        deps.activeMonitors, deps.clawInterceptor,
                        deps.sessionStateStore,
                    );
                }
            } catch (err: any) {
                logger.debug(`[TelegramJoin] runStatus check failed: ${err?.message || err}`);
            }
        }
    }

    await interaction.update({
        text: `Joined history session: <b>${escapeHtml(selectedTitle)}</b>\nLoading conversation history into Telegram...`,
        components: [],
    }).catch(logger.error);

    const history = await runtime.getConversationHistory(deps.chatSessionService, {
        maxMessages: 500,
        maxScrollSteps: 40,
    });

    const chunks = formatConversationHistory(selectedTitle, history.messages, history.truncated);
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
