import { AttachmentBuilder, ChatInputCommandInteraction, Message } from 'discord.js';

import { CdpService } from '../services/cdpService';
import { ScreenshotService } from '../services/screenshotService';
import type { MessagePayload, FileAttachment } from '../platform/types';

/**
 * Build a platform-agnostic MessagePayload containing the screenshot.
 * Returns a payload with the screenshot as a file attachment, or an error text.
 */
export async function buildScreenshotPayload(
    cdp: CdpService | null,
): Promise<MessagePayload> {
    if (!cdp) {
        return { text: 'Not connected to Antigravity.' };
    }

    try {
        const screenshot = new ScreenshotService({ cdpService: cdp });
        const result = await screenshot.capture({ format: 'png' });
        if (result.success && result.buffer) {
            const file: FileAttachment = {
                name: 'screenshot.png',
                data: result.buffer,
                contentType: 'image/png',
            };
            return { files: [file] };
        }
        return { text: `Screenshot failed: ${result.error ?? 'Unknown error'}` };
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return { text: `Screenshot error: ${message}` };
    }
}

/**
 * Capture a screenshot and send it to Discord
 */
export async function handleScreenshot(
    target: Message | ChatInputCommandInteraction,
    cdp: CdpService | null,
): Promise<void> {
    if (!cdp) {
        const content = 'Not connected to Antigravity.';
        if (target instanceof Message) {
            await target.reply(content);
        } else {
            await target.editReply({ content });
        }
        return;
    }

    try {
        const screenshot = new ScreenshotService({ cdpService: cdp });
        const result = await screenshot.capture({ format: 'png' });
        if (result.success && result.buffer) {
            const attachment = new AttachmentBuilder(result.buffer, { name: 'screenshot.png' });
            if (target instanceof Message) {
                await target.reply({ files: [attachment] });
            } else {
                await target.editReply({ files: [attachment] });
            }
        } else {
            const content = `Screenshot failed: ${result.error}`;
            if (target instanceof Message) {
                await target.reply(content);
            } else {
                await target.editReply({ content });
            }
        }
    } catch (e: unknown) {
        const content = `Screenshot error: ${e instanceof Error ? e.message : String(e)}`;
        if (target instanceof Message) {
            await target.reply(content);
        } else {
            await target.editReply({ content });
        }
    }
}
