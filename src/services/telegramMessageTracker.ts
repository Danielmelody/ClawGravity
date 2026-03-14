/**
 * Tracks Telegram message IDs sent by the bot, per chat.
 *
 * Used by `/clear` to bulk-delete bot-sent messages from the chat,
 * giving a visual "clear history" experience on the Telegram client side.
 *
 * The tracker keeps a bounded list of message IDs per chat (default 500).
 * Only messages sent after the tracker was initialized are tracked.
 */

import { logger } from '../utils/logger';

export class TelegramMessageTracker {
    /** chatId → list of Telegram message IDs (numbers) sent by the bot. */
    private readonly messagesByChatId = new Map<string, number[]>();
    private readonly maxPerChat: number;

    constructor(maxPerChat = 500) {
        this.maxPerChat = maxPerChat;
    }

    /** Record a message ID that the bot sent to a chat. */
    track(chatId: string, messageId: number): void {
        let list = this.messagesByChatId.get(chatId);
        if (!list) {
            list = [];
            this.messagesByChatId.set(chatId, list);
        }
        list.push(messageId);
        // Trim to bounded size
        if (list.length > this.maxPerChat) {
            list.splice(0, list.length - this.maxPerChat);
        }
    }

    /** Get all tracked message IDs for a chat, then clear the tracking list. */
    drain(chatId: string): number[] {
        const list = this.messagesByChatId.get(chatId) || [];
        this.messagesByChatId.delete(chatId);
        return list;
    }

    /**
     * Bulk delete all tracked bot messages from a Telegram chat.
     *
     * Uses deleteMessage one-by-one (Telegram Bot API doesn't have
     * a reliable bulk delete for bots). Errors per message are
     * silently swallowed (e.g. message already deleted, too old, etc.).
     *
     * Also deletes the user's command message (the /clear message itself)
     * if its ID is provided.
     *
     * @returns The number of messages successfully deleted.
     */
    async clearChat(
        chatId: string,
        botApi: { deleteMessage(chatId: number | string, messageId: number): Promise<unknown> },
        clearCommandMessageId?: number,
    ): Promise<number> {
        const messageIds = this.drain(chatId);

        // Also include the /clear command message itself
        if (clearCommandMessageId) {
            messageIds.push(clearCommandMessageId);
        }

        if (messageIds.length === 0) return 0;

        let deleted = 0;

        // Process in reverse order (newest first) since older messages
        // are more likely to exceed the 48-hour deletion limit.
        for (let i = messageIds.length - 1; i >= 0; i--) {
            try {
                await botApi.deleteMessage(chatId, messageIds[i]);
                deleted++;
            } catch (err: unknown) {
                // Silently skip — message may already be deleted, too old, or
                // the bot may lack permissions in this chat type.
                const errMsg = err instanceof Error ? err.message : String(err);
                logger.debug(`[TelegramMessageTracker] deleteMessage ${messageIds[i]} failed: ${errMsg}`);
            }
        }

        logger.info(`[TelegramMessageTracker] Cleared ${deleted}/${messageIds.length} messages in chat ${chatId}`);
        return deleted;
    }
}
