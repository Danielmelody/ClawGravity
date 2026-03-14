/**
 * Telegram wrapper functions.
 *
 * Convert Telegram-specific objects to the platform-agnostic types defined
 * in ../types.ts. Uses `TelegramBotLike` interface instead of importing
 * grammy directly, so the code compiles without grammy installed.
 */

import type {
    PlatformUser,
    PlatformChannel,
    PlatformMessage,
    PlatformSentMessage,
    PlatformAttachment,
    PlatformButtonInteraction,
    MessagePayload,
    FileAttachment,
    ComponentRow,
    ButtonDef,
    SelectMenuDef,
} from '../types';
import { rawHtmlToTelegramHtml } from './trajectoryRenderer';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// grammy-compatible interfaces (no grammy import needed)
// ---------------------------------------------------------------------------

export interface TelegramBotLike {
    /** Bot token — needed to construct file download URLs. */
    token?: string;
    start(): void | Promise<void>;
    stop(): void;
    on(event: string, handler: (...args: unknown[]) => unknown): void;
    api: {
        sendMessage(chatId: number | string, text: string, options?: Record<string, unknown>): Promise<unknown>;
        editMessageText(chatId: number | string, messageId: number, text: string, options?: Record<string, unknown>): Promise<unknown>;
        deleteMessage(chatId: number | string, messageId: number): Promise<unknown>;
        getChat(chatId: number | string): Promise<unknown>;
        answerCallbackQuery(callbackQueryId: string, options?: Record<string, unknown>): Promise<unknown>;
        setMessageReaction?(chatId: number | string, messageId: number, reaction: readonly unknown[], options?: Record<string, unknown>): Promise<unknown>;
        setMyCommands?(commands: readonly { command: string; description: string }[]): Promise<unknown>;
        sendPhoto?(chatId: number | string, photo: unknown, options?: Record<string, unknown>): Promise<unknown>;
        sendDocument?(chatId: number | string, document: unknown, options?: Record<string, unknown>): Promise<unknown>;
        getFile?(file_id: string): Promise<{ file_id: string; file_path?: string }>;
    };
    /**
     * Convert a Buffer to a platform-specific input file object.
     * For grammY this wraps Buffer in InputFile; set this when creating the bot.
     * If not provided, raw Buffer is passed through (works for test mocks).
     */
    toInputFile?: (data: Buffer, filename?: string) => unknown;
}

// ---------------------------------------------------------------------------
// 429 Rate-limit retry helper
// ---------------------------------------------------------------------------

/**
 * Wrap an async Telegram API call with automatic retry on 429 (Too Many Requests).
 * Extracts `retry_after` from the grammy error and waits before retrying.
 * Falls back to 5s if the delay can't be parsed. Retries up to `maxRetries` times.
 */
async function withRetry429<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err: unknown) {
            const errObj = err as Record<string, unknown>;
            const msg = (errObj?.message || errObj?.Description || '') as string;
            const is429 = errObj?.error_code === 429
                || msg.includes('429')
                || msg.includes('Too Many Requests');

            if (!is429 || attempt >= maxRetries) {
                throw err;
            }

            // Extract retry_after seconds from error message
            const match = msg.match(/retry after (\d+)/i);
            const delaySec = match ? Math.min(Number(match[1]), 60) : 5;
            await new Promise(r => setTimeout(r, delaySec * 1000));
        }
    }
}

export interface TelegramFrom {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    is_bot: boolean;
}

export interface TelegramPhotoSize {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
}

export interface TelegramDocument {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}

export interface TelegramMessageLike {
    message_id: number;
    from?: TelegramFrom;
    chat: { id: number; title?: string; type: string };
    text?: string;
    /** Photo messages store user text in caption, not text. */
    caption?: string;
    /** Array of photo sizes; last element is the largest. */
    photo?: TelegramPhotoSize[];
    /** Document attachment (files, including uncompressed images). */
    document?: TelegramDocument;
    date: number;
}

export interface TelegramCallbackQueryLike {
    id: string;
    from: TelegramFrom;
    message?: TelegramMessageLike;
    data?: string;
}

export interface TelegramSendOptions {
    text: string;
    parse_mode: 'HTML';
    reply_markup?: {
        inline_keyboard: ReadonlyArray<
            ReadonlyArray<{ text: string; callback_data: string }>
        >;
    };
}

// ---------------------------------------------------------------------------
// Inline keyboard builders
// ---------------------------------------------------------------------------

type InlineButton = { text: string; callback_data: string };

function buttonDefToInline(btn: ButtonDef): InlineButton {
    return { text: btn.label, callback_data: btn.customId };
}

/**
 * Separator for select menu callback_data: customId + SEP + value.
 * Uses ASCII Unit Separator (0x1F) to avoid collisions with button
 * customIds that legitimately contain colons (e.g. "approve_action:proj:ch").
 */
export const SELECT_CALLBACK_SEP = '\x1f';

/**
 * Telegram inline keyboard callback_data is limited to 64 bytes.
 * Truncate a string to fit within the given byte budget, respecting
 * multi-byte Unicode characters (never split a surrogate pair).
 */
const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64;

function truncateToBytes(str: string, maxBytes: number): string {
    const buf = Buffer.from(str, 'utf-8');
    if (buf.length <= maxBytes) return str;
    // Slice to maxBytes and decode back — Buffer.toString handles
    // incomplete multi-byte sequences gracefully (replaces trailing
    // partial chars). We then re-encode to verify and trim if needed.
    let truncated = buf.subarray(0, maxBytes).toString('utf-8');
    // Remove any replacement character at the end from a split codepoint
    while (truncated.length > 0 && Buffer.from(truncated, 'utf-8').length > maxBytes) {
        truncated = truncated.slice(0, -1);
    }
    return truncated;
}

function selectMenuToInlineRows(menu: SelectMenuDef): ReadonlyArray<ReadonlyArray<InlineButton>> {
    return menu.options.map((opt) => {
        const raw = `${menu.customId}${SELECT_CALLBACK_SEP}${opt.value}`;
        const callbackData = truncateToBytes(raw, TELEGRAM_MAX_CALLBACK_DATA_BYTES);
        return [{ text: opt.label, callback_data: callbackData }];
    });
}

function componentRowsToInlineKeyboard(
    rows: readonly ComponentRow[],
): ReadonlyArray<ReadonlyArray<InlineButton>> {
    const keyboard: Array<ReadonlyArray<InlineButton>> = [];

    for (const row of rows) {
        let buttons: InlineButton[] = [];
        for (const comp of row.components) {
            if (comp.type === 'button') {
                // Telegram inline keyboards do not support disabled buttons;
                // skip them so resolved overlays don't re-show clickable buttons.
                if (comp.disabled) continue;
                buttons = [...buttons, buttonDefToInline(comp)];
            } else if (comp.type === 'selectMenu') {
                // A select menu becomes multiple rows (one per option)
                const menuRows = selectMenuToInlineRows(comp);
                // Flush any accumulated buttons first
                if (buttons.length > 0) {
                    keyboard.push([...buttons]);
                    buttons = [];
                }
                for (const menuRow of menuRows) {
                    keyboard.push(menuRow);
                }
            }
        }
        if (buttons.length > 0) {
            keyboard.push(buttons);
        }
    }

    return keyboard;
}

// ---------------------------------------------------------------------------
// toTelegramPayload
// ---------------------------------------------------------------------------

/**
 * Convert a platform-agnostic MessagePayload to Telegram send options.
 *
 * - RichContent is rendered to HTML via richContentToHtml
 * - ComponentRow[] become inline_keyboard
 * - text + richContent are combined into one HTML message
 */
export function toTelegramPayload(payload: MessagePayload): TelegramSendOptions {
    const parts: string[] = [];

    if (payload.text) {
        parts.push(payload.text);
    }

    if (payload.richContent) {
        const rc = payload.richContent;
        const rcParts: string[] = [];
        if (rc.title) rcParts.push(`<b>${rawHtmlToTelegramHtml(rc.title)}</b>`);
        if (rc.description) rcParts.push(rawHtmlToTelegramHtml(rc.description));
        if (rc.fields) {
            rc.fields.forEach(f => {
                rcParts.push(`<b>${rawHtmlToTelegramHtml(f.name)}</b>\n${rawHtmlToTelegramHtml(f.value)}`);
            });
        }
        if (rc.footer) rcParts.push(`<i>${rawHtmlToTelegramHtml(rc.footer)}</i>`);
        
        if (rcParts.length > 0) {
            parts.push(rcParts.join('\n\n'));
        }
    }

    const text = parts.join('\n\n') || ' ';

    const options: TelegramSendOptions = {
        text,
        parse_mode: 'HTML',
    };

    if (payload.components !== undefined) {
        if (payload.components.length > 0) {
            const keyboard = componentRowsToInlineKeyboard(payload.components);
            if (keyboard.length > 0) {
                return {
                    ...options,
                    reply_markup: { inline_keyboard: keyboard },
                };
            }
        }
        // Explicitly empty components array => remove existing keyboard
        return {
            ...options,
            reply_markup: { inline_keyboard: [] },
        };
    }

    return options;
}

// ---------------------------------------------------------------------------
// HTML tag stripping helper (for fallback plain-text delivery)
// ---------------------------------------------------------------------------

/**
 * Strip ALL HTML tags from text and decode common HTML entities.
 * Used when Telegram rejects HTML parse_mode — produces clean plain text.
 */
function stripAllHtmlTags(html: string): string {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ---------------------------------------------------------------------------
// Shared send-with-HTML-fallback helper
// ---------------------------------------------------------------------------

/**
 * Send a Telegram message with automatic HTML-fallback retry.
 * Shared by channel.send() and callbackQuery.followUp() to avoid duplication.
 */
async function sendWithHtmlFallback(
    api: TelegramBotLike['api'],
    chatId: number | string,
    payload: MessagePayload,
    extraSendOptions?: Record<string, unknown>,
): Promise<PlatformSentMessage> {
    const opts = toTelegramPayload(payload);
    const { text, ...rest } = opts;
    const sendOpts = extraSendOptions ? { ...rest, ...extraSendOptions } : rest;
    try {
        const sent = await withRetry429(() => api.sendMessage(chatId, text, sendOpts));
        return wrapTelegramSentMessage(sent, api, chatId);
    } catch (_err: unknown) {
        const errMsg = _err instanceof Error ? _err.message : String(_err);
        logger.warn(`[TgSend] HTML parse failed, falling back. Error: ${errMsg}`);
        const rawText = stripAllHtmlTags(text);
        const sent = await withRetry429(() => api.sendMessage(chatId, rawText || '(empty)', { reply_markup: rest.reply_markup, ...extraSendOptions }));
        return wrapTelegramSentMessage(sent, api, chatId);
    }
}

// ---------------------------------------------------------------------------
// Entity wrappers
// ---------------------------------------------------------------------------

/** Wrap a Telegram user object to a PlatformUser. */
export function wrapTelegramUser(from: TelegramFrom): PlatformUser {
    const displayParts = [from.first_name];
    if (from.last_name) {
        displayParts.push(from.last_name);
    }

    return {
        id: String(from.id),
        platform: 'telegram',
        username: from.username ?? String(from.id),
        displayName: displayParts.join(' '),
        isBot: from.is_bot,
    };
}

/**
 * Try to send a file attachment via Telegram photo/document API.
 * Returns the sent message, or null if file sending is not available.
 *
 * @param toInputFile - Optional converter that wraps Buffer for the Telegram API.
 *   grammY requires Buffer wrapped in InputFile; pass `bot.toInputFile` here.
 */
async function trySendFile(
    api: TelegramBotLike['api'],
    chatId: number | string,
    file: FileAttachment,
    caption: string | undefined,
    extraOptions?: Record<string, unknown>,
    toInputFile?: TelegramBotLike['toInputFile'],
): Promise<unknown | null> {
    const isImage = file.contentType?.startsWith('image/') || file.name.match(/\.(png|jpe?g|gif|webp)$/i);
    // grammY requires Buffer wrapped in InputFile; use toInputFile if available.
    const inputFile = toInputFile ? toInputFile(file.data, file.name) : file.data;

    if (isImage && api.sendPhoto) {
        return api.sendPhoto(chatId, inputFile, {
            caption,
            parse_mode: caption ? 'HTML' : undefined,
            ...extraOptions,
        });
    }

    if (api.sendDocument) {
        return api.sendDocument(chatId, inputFile, {
            caption,
            parse_mode: caption ? 'HTML' : undefined,
            ...extraOptions,
        });
    }

    return null;
}

/**
 * Try to send a file attachment from a MessagePayload.
 * Returns a wrapped PlatformSentMessage if successful, or null to fall back to text.
 */
async function trySendFileFromPayload(
    api: TelegramBotLike['api'],
    chatId: number | string,
    payload: MessagePayload,
    extraOptions: Record<string, unknown> | undefined,
    toInputFile: TelegramBotLike['toInputFile'] | undefined,
): Promise<PlatformSentMessage | null> {
    if (!payload.files || payload.files.length === 0) return null;

    const file = payload.files[0];
    const opts = payload.text || payload.richContent
        ? toTelegramPayload({ text: payload.text, richContent: payload.richContent })
        : null;
    const caption = opts?.text;

    const sent = await trySendFile(api, chatId, file, caption, extraOptions, toInputFile);
    if (sent) {
        return wrapTelegramSentMessage(sent, api, chatId);
    }
    return null;
}

/** Wrap a Telegram chat as a PlatformChannel. */
export function wrapTelegramChannel(
    api: TelegramBotLike['api'],
    chatId: number | string,
    toInputFile?: TelegramBotLike['toInputFile'],
): PlatformChannel {
    const chatIdStr = String(chatId);

    return {
        id: chatIdStr,
        platform: 'telegram',
        name: undefined,
        async send(payload: MessagePayload): Promise<PlatformSentMessage> {
            // Handle file attachments (e.g., screenshots)
            const fileSent = await trySendFileFromPayload(api, chatId, payload, undefined, toInputFile);
            if (fileSent) return fileSent;

            return sendWithHtmlFallback(api, chatId, payload);
        },
    };
}

/**
 * Build PlatformAttachment[] from a Telegram photo message.
 * Uses the largest photo size (last in the array) and constructs
 * the download URL from the bot token and file_id.
 */
function buildPhotoAttachments(
    photo: TelegramPhotoSize[],
    botToken?: string,
): PlatformAttachment[] {
    if (photo.length === 0) return [];

    // Telegram sends multiple sizes; last is the largest
    const largest = photo[photo.length - 1];

    // URL is constructed later during download via getFile API.
    // Store file_id as the URL so the download utility can resolve it.
    const url = botToken
        ? `telegram-file://${largest.file_id}`
        : `telegram-file://${largest.file_id}`;

    return [{
        name: `photo-${largest.file_unique_id}.jpg`,
        contentType: 'image/jpeg',
        url,
        size: largest.file_size ?? 0,
    }];
}

/**
 * Build PlatformAttachment[] from a Telegram document message.
 * Only produces attachments for image documents (mime_type starts with 'image/').
 */
function buildDocumentAttachments(
    doc: TelegramDocument,
): PlatformAttachment[] {
    // Only treat documents with image mime types as image attachments
    if (!doc.mime_type || !doc.mime_type.startsWith('image/')) return [];

    return [{
        name: doc.file_name || `doc-${doc.file_unique_id}`,
        contentType: doc.mime_type,
        url: `telegram-file://${doc.file_id}`,
        size: doc.file_size ?? 0,
    }];
}

/** Wrap a Telegram message as a PlatformMessage. */
export function wrapTelegramMessage(
    msg: TelegramMessageLike,
    api: TelegramBotLike['api'],
    toInputFile?: TelegramBotLike['toInputFile'],
    botToken?: string,
): PlatformMessage {
    const author = msg.from
        ? wrapTelegramUser(msg.from)
        : {
            id: '0',
            platform: 'telegram' as const,
            username: 'unknown',
            displayName: 'Unknown',
            isBot: false,
        };

    const channel = wrapTelegramChannel(api, msg.chat.id, toInputFile);

    // Photo messages: use caption as content, build attachments from photo array.
    // Document messages: fall back to document attachment if no photo and doc is an image.
    const content = msg.text ?? msg.caption ?? '';
    const attachments: readonly PlatformAttachment[] = msg.photo
        ? buildPhotoAttachments(msg.photo, botToken)
        : msg.document
            ? buildDocumentAttachments(msg.document)
            : [];

    return {
        id: String(msg.message_id),
        platform: 'telegram',
        content,
        author,
        channel,
        attachments,
        createdAt: new Date(msg.date * 1000),
        async react(emoji: string): Promise<void> {
            // Telegram Bot API 7.0+ setMessageReaction — limited to 79 emoji.
            // Silently ignore failures (unsupported emoji, old API, etc.).
            if (api.setMessageReaction) {
                await api.setMessageReaction(
                    msg.chat.id,
                    msg.message_id,
                    [{ type: 'emoji', emoji }],
                ).catch(() => { });
            }
        },
        async reply(payload: MessagePayload): Promise<PlatformSentMessage> {
            // Handle file attachments (e.g., screenshots)
            const fileSent = await trySendFileFromPayload(
                api, msg.chat.id, payload,
                { reply_to_message_id: msg.message_id },
                toInputFile,
            );
            if (fileSent) return fileSent;

            const opts = toTelegramPayload(payload);
            const { text, ...rest } = opts;
            let sent;
            try {
                sent = await withRetry429(() => api.sendMessage(msg.chat.id, text, {
                    ...rest,
                    reply_to_message_id: msg.message_id,
                }));
            } catch {
                logger.warn(`[TgMsgReply] HTML parse failed, falling back to raw text.`);
                const rawText = stripAllHtmlTags(text);
                sent = await withRetry429(() => api.sendMessage(msg.chat.id, rawText || '(empty)', {
                    reply_markup: rest.reply_markup,
                    reply_to_message_id: msg.message_id,
                }));
            }
            return wrapTelegramSentMessage(sent, api, msg.chat.id);
        },
    };
}

/**
 * Validate that a chatId is usable for sending messages.
 * Throws a descriptive error if the chatId is synthetic (0).
 */
function assertValidChatId(chatId: number | string): void {
    if (chatId === 0 || chatId === '0') {
        throw new Error(
            'Cannot send message: callback query has no associated chat (chatId is 0). ' +
            'Use answerCallbackQuery instead.',
        );
    }
}

/** Wrap a Telegram callback query as a PlatformButtonInteraction. */
export function wrapTelegramCallbackQuery(
    query: TelegramCallbackQueryLike,
    api: TelegramBotLike['api'],
): PlatformButtonInteraction {
    const user = wrapTelegramUser(query.from);
    const chatId = query.message?.chat.id ?? 0;
    const channel = wrapTelegramChannel(api, chatId);
    const messageId = query.message ? String(query.message.message_id) : '0';
    const callbackQueryId = query.id;

    return {
        id: query.id,
        platform: 'telegram',
        customId: query.data ?? '',
        user,
        channel,
        messageId,
        async deferUpdate(): Promise<void> {
            // Acknowledge the callback query to dismiss the loading indicator
            await api.answerCallbackQuery(callbackQueryId);
        },
        async reply(payload: MessagePayload): Promise<void> {
            assertValidChatId(chatId);
            const opts = toTelegramPayload(payload);
            const { text, ...rest } = opts;
            try {
                await withRetry429(() => api.sendMessage(chatId, text, rest));
            } catch {
                logger.warn(`[TgReply] HTML parse failed, falling back to raw text.`);
                const rawText = stripAllHtmlTags(text);
                await withRetry429(() => api.sendMessage(chatId, rawText || '(empty)', { reply_markup: rest.reply_markup }));
            }
        },
        async update(payload: MessagePayload): Promise<void> {
            if (!query.message) return;
            assertValidChatId(chatId);
            const messageId = query.message.message_id;
            const opts = toTelegramPayload(payload);
            const { text, ...rest } = opts;
            try {
                await withRetry429(() => api.editMessageText(chatId, messageId, text, rest));
            } catch {
                logger.warn(`[TgUpdate] HTML parse failed, falling back to raw text.`);
                const rawText = stripAllHtmlTags(text);
                await withRetry429(() => api.editMessageText(chatId, messageId, rawText || '(empty)', { reply_markup: rest.reply_markup }));
            }
        },
        async editReply(payload: MessagePayload): Promise<void> {
            // Semantically identical to update for Telegram callback queries
            return this.update(payload);
        },
        async followUp(payload: MessagePayload): Promise<PlatformSentMessage> {
            assertValidChatId(chatId);
            return sendWithHtmlFallback(api, chatId, payload);
        },
    };
}

// ---------------------------------------------------------------------------
// Sent message wrapper
// ---------------------------------------------------------------------------

/** Wrap a Telegram API send result as a PlatformSentMessage. */
export function wrapTelegramSentMessage(
    msg: unknown,
    api: TelegramBotLike['api'],
    chatId: number | string,
): PlatformSentMessage {
    const msgObj = msg as Record<string, unknown>;
    const msgId = String(msgObj.message_id ?? msgObj.id ?? '0');

    return {
        id: msgId,
        platform: 'telegram',
        channelId: String(chatId),
        async edit(payload: MessagePayload): Promise<PlatformSentMessage> {
            const opts = toTelegramPayload(payload);
            const { text, ...rest } = opts;
            try {
                const edited = await withRetry429(() => api.editMessageText(chatId, Number(msgId), text, rest));
                return wrapTelegramSentMessage(edited, api, chatId);
            } catch (_err: unknown) {
                const errMsg = _err instanceof Error ? _err.message : String(_err);
                // HTML parse error — retry with raw text, no parse_mode
                logger.warn(`[TgEdit] HTML parse failed, falling back to raw text. Error: ${errMsg}. Text starts: ${text.slice(0, 200)}`);
                const rawText = stripAllHtmlTags(text);
                const edited = await withRetry429(() => api.editMessageText(chatId, Number(msgId), rawText, { reply_markup: rest.reply_markup }));
                return wrapTelegramSentMessage(edited, api, chatId);
            }
        },
        async delete(): Promise<void> {
            await api.deleteMessage(chatId, Number(msgId));
        },
    };
}
