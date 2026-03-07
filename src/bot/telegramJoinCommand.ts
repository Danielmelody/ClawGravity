import type { PlatformMessage, PlatformSelectInteraction, SelectMenuDef } from '../platform/types';
import type { TelegramBindingRepository } from '../database/telegramBindingRepository';
import type { TelegramRecentMessageRepository } from '../database/telegramRecentMessageRepository';
import type { WorkspaceService } from '../services/workspaceService';
import type { ChatSessionService, ConversationHistoryEntry } from '../services/chatSessionService';
import type { CdpBridge } from '../services/cdpBridgeManager';
import { escapeHtml } from '../platform/telegram/telegramFormatter';
import { logger } from '../utils/logger';

export const TG_JOIN_SELECT_ID = 'tg_join_select';
const MAX_TELEGRAM_HISTORY_CHARS = 3800;

export class TelegramSessionStateStore {
    constructor(private readonly recentMessageRepo?: TelegramRecentMessageRepository) {}

    private readonly selectedSessionByChat = new Map<string, string>();
    private readonly recentMessagesByChat = new Map<string, string[]>();

    setSelectedSession(chatId: string, sessionTitle: string): void {
        this.selectedSessionByChat.set(chatId, sessionTitle);
    }

    getSelectedSession(chatId: string): string | null {
        return this.selectedSessionByChat.get(chatId) ?? null;
    }

    clearSelectedSession(chatId: string): void {
        this.selectedSessionByChat.delete(chatId);
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
}

export async function handleTelegramJoinCommand(
    deps: TelegramJoinCommandDeps,
    message: PlatformMessage,
): Promise<void> {
    const chatId = message.channel.id;
    const binding = deps.telegramBindingRepo.findByChatId(chatId);
    if (!binding) {
        await message.reply({
            text: 'No project is linked to this chat. Use /project to bind a workspace first.',
        }).catch(logger.error);
        return;
    }

    const workspacePath = deps.workspaceService
        ? deps.workspaceService.getWorkspacePath(binding.workspacePath)
        : binding.workspacePath;

    let cdp;
    try {
        cdp = await deps.bridge.pool.getOrConnect(workspacePath);
    } catch (err: any) {
        await message.reply({ text: `Failed to connect to project: ${escapeHtml(err?.message || 'unknown error')}` }).catch(logger.error);
        return;
    }

    const sessions = await deps.chatSessionService.listAllSessions(cdp);
    if (sessions.length === 0) {
        await message.reply({ text: 'No history sessions found in the Antigravity side panel.' }).catch(logger.error);
        return;
    }

    const currentTitle = deps.sessionStateStore.getSelectedSession(chatId);
    const selectMenu: SelectMenuDef = {
        type: 'selectMenu',
        customId: TG_JOIN_SELECT_ID,
        placeholder: 'Select a history session',
        options: sessions.slice(0, 25).map((session) => ({
            label: session.title === currentTitle ? `${session.title} (current)` : session.title,
            value: session.title,
        })),
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
    const binding = deps.telegramBindingRepo.findByChatId(chatId);
    if (!binding) {
        await interaction.reply({
            text: 'No project is linked to this chat. Use /project first.',
        }).catch(logger.error);
        return;
    }

    const workspacePath = deps.workspaceService
        ? deps.workspaceService.getWorkspacePath(binding.workspacePath)
        : binding.workspacePath;

    let cdp;
    try {
        cdp = await deps.bridge.pool.getOrConnect(workspacePath);
    } catch (err: any) {
        await interaction.reply({
            text: `Failed to connect to project: ${escapeHtml(err?.message || 'unknown error')}`,
        }).catch(logger.error);
        return;
    }

    const activateResult = await deps.chatSessionService.activateSessionByTitle(cdp, selectedTitle);
    if (!activateResult.ok) {
        await interaction.reply({
            text: `Failed to join session: ${escapeHtml(activateResult.error || 'unknown error')}`,
        }).catch(logger.error);
        return;
    }

    deps.sessionStateStore.setSelectedSession(chatId, selectedTitle);

    await interaction.update({
        text: `Joined history session: <b>${escapeHtml(selectedTitle)}</b>\nLoading conversation history into Telegram...`,
        components: [],
    }).catch(logger.error);

    const history = await deps.chatSessionService.getConversationHistory(cdp, {
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
