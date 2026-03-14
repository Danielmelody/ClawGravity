import { Message } from 'discord.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';

const MAX_INBOUND_IMAGE_ATTACHMENTS = 4;
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|webp|gif|bmp)$/i;
const TEMP_IMAGE_DIR = path.join(os.tmpdir(), 'claw-gravity-images');

export interface InboundImageAttachment {
    localPath: string;
    url: string;
    name: string;
    mimeType: string;
}

export function isImageAttachment(contentType: string | null | undefined, fileName: string | null | undefined): boolean {
    if ((contentType || '').toLowerCase().startsWith('image/')) return true;
    return IMAGE_EXT_PATTERN.test(fileName || '');
}

export function mimeTypeToExtension(mimeType: string): string {
    const normalized = (mimeType || '').toLowerCase();
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
    if (normalized.includes('webp')) return 'webp';
    if (normalized.includes('gif')) return 'gif';
    if (normalized.includes('bmp')) return 'bmp';
    return 'png';
}

export function sanitizeFileName(fileName: string): string {
    const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return sanitized || `image-${Date.now()}.png`;
}

export async function downloadInboundImageAttachments(message: Message): Promise<InboundImageAttachment[]> {
    const allAttachments = Array.from(message.attachments.values());
    const imageAttachments = allAttachments
        .filter((attachment) => isImageAttachment(attachment.contentType, attachment.name))
        .slice(0, MAX_INBOUND_IMAGE_ATTACHMENTS);

    if (imageAttachments.length === 0) return [];

    await fs.mkdir(TEMP_IMAGE_DIR, { recursive: true });

    const downloaded: InboundImageAttachment[] = [];
    let index = 0;
    for (const attachment of imageAttachments) {
        try {
            const response = await fetch(attachment.url);
            if (!response.ok) {
                logger.warn(`[ImageBridge] Attachment image download failed (id=${attachment.id || 'unknown'}, status=${response.status})`);
                continue;
            }

            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length === 0) continue;

            const mimeType = attachment.contentType || 'image/png';
            const hasExt = IMAGE_EXT_PATTERN.test(attachment.name || '');
            const ext = mimeTypeToExtension(mimeType);
            const originalName = sanitizeFileName(attachment.name || `discord-image-${index + 1}.${ext}`);
            const name = hasExt ? originalName : `${originalName}.${ext}`;
            const localPath = path.join(
                TEMP_IMAGE_DIR,
                `${Date.now()}-${message.id}-${index}-${name}`,
            );

            await fs.writeFile(localPath, bytes);
            downloaded.push({
                localPath,
                url: attachment.url,
                name,
                mimeType,
            });
            index += 1;
        } catch (error: unknown) {
            logger.warn(`[ImageBridge] Attachment image processing failed (id=${attachment.id || 'unknown'})`, (error as Error)?.message || error);
        }
    }

    return downloaded;
}

export async function cleanupInboundImageAttachments(attachments: InboundImageAttachment[]): Promise<void> {
    for (const image of attachments) {
        await fs.unlink(image.localPath).catch(() => { });
    }
}
