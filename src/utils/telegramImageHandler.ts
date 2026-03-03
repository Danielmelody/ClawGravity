/**
 * Telegram image download utility.
 *
 * Downloads photos from Telegram Bot API and saves them to a temp directory,
 * producing InboundImageAttachment[] that can be passed to
 * cdp.injectMessageWithImageFiles().
 *
 * Reuses shared types and helpers from imageHandler.ts.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import type { PlatformAttachment } from '../platform/types';
import type { TelegramBotLike } from '../platform/telegram/wrappers';
import type { InboundImageAttachment } from './imageHandler';
import { sanitizeFileName, mimeTypeToExtension } from './imageHandler';
import { logger } from './logger';

const MAX_TELEGRAM_IMAGE_ATTACHMENTS = 4;
const TEMP_IMAGE_DIR = path.join(os.tmpdir(), 'lazy-gravity-images');

/**
 * Extract the Telegram file_id from a telegram-file:// URL.
 * Returns null if the URL doesn't match the expected scheme.
 */
function extractFileId(url: string): string | null {
    const prefix = 'telegram-file://';
    if (!url.startsWith(prefix)) return null;
    return url.slice(prefix.length);
}

/**
 * Download Telegram photo attachments to local temp files.
 *
 * Uses the Telegram Bot API getFile endpoint to resolve file_id → file_path,
 * then downloads the file via https://api.telegram.org/file/bot<token>/<path>.
 *
 * @param attachments - PlatformAttachment[] from the wrapped Telegram message
 * @param botToken - The bot token for constructing download URLs
 * @param api - The bot API object (needs getFile method)
 * @returns Downloaded images as InboundImageAttachment[]
 */
export async function downloadTelegramPhotos(
    attachments: readonly PlatformAttachment[],
    botToken: string,
    api: TelegramBotLike['api'],
): Promise<InboundImageAttachment[]> {
    if (!api.getFile) {
        logger.warn('[TelegramImageHandler] bot.api.getFile is not available');
        return [];
    }

    const imageAttachments = attachments
        .filter((att) => (att.contentType || '').startsWith('image/'))
        .slice(0, MAX_TELEGRAM_IMAGE_ATTACHMENTS);

    if (imageAttachments.length === 0) return [];

    await fs.mkdir(TEMP_IMAGE_DIR, { recursive: true });

    const downloaded: InboundImageAttachment[] = [];

    for (let i = 0; i < imageAttachments.length; i++) {
        const attachment = imageAttachments[i];
        const fileId = extractFileId(attachment.url);
        if (!fileId) {
            logger.warn(`[TelegramImageHandler] Invalid file URL: ${attachment.url}`);
            continue;
        }

        try {
            // Resolve file_id to file_path via Bot API
            const fileInfo = await api.getFile(fileId);
            if (!fileInfo.file_path) {
                logger.warn(`[TelegramImageHandler] No file_path returned for file_id=${fileId}`);
                continue;
            }

            // Download the file
            const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;
            const response = await fetch(downloadUrl);
            if (!response.ok) {
                logger.warn(
                    `[TelegramImageHandler] Download failed (file_id=${fileId}, status=${response.status})`,
                );
                continue;
            }

            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length === 0) continue;

            const mimeType = attachment.contentType || 'image/jpeg';
            const ext = mimeTypeToExtension(mimeType);
            const name = sanitizeFileName(attachment.name || `telegram-photo-${i + 1}.${ext}`);
            const localPath = path.join(
                TEMP_IMAGE_DIR,
                `${Date.now()}-tg-${i}-${name}`,
            );

            await fs.writeFile(localPath, bytes);
            downloaded.push({
                localPath,
                url: downloadUrl,
                name,
                mimeType,
            });
        } catch (error: any) {
            logger.warn(
                `[TelegramImageHandler] Failed to download photo (file_id=${fileId}):`,
                error?.message || error,
            );
        }
    }

    return downloaded;
}
