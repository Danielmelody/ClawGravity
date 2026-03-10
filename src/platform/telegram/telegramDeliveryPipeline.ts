/**
 * Telegram Delivery Pipeline — pure transform functions.
 *
 * Every function in this module is PURE (no side-effects) except
 * `executeDelivery()` which performs Telegram API calls.
 *
 * Data flow (complete delivery):
 *
 *   DeliverySnapshot ──► planDelivery() ──► DeliveryPlan ──► executeDelivery()
 *        (frozen)          (pure)          (immutable)         (effects)
 *
 * Each step is logged via PipelineSession for post-mortem debugging.
 */

import { logger } from '../../utils/logger';
import { rawHtmlToTelegramHtml, markdownToTelegramHtmlViaUnified } from './trajectoryRenderer';
import type { DeliverySnapshot } from './messageDeliveryState';
import type { PipelineSession } from '../../utils/pipelineDebugLog';
import type { PlatformChannel, PlatformSentMessage } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeliveryMode = 'rendered-html' | 'text-to-html' | 'empty';

/** Immutable plan produced by the pure pipeline. */
export interface DeliveryPlan {
    readonly mode: DeliveryMode;
    readonly reason: string;
    readonly telegramHtml: string;
    readonly chunks: string[];
    /** The cleaned-up text for afterComplete hooks. */
    readonly deliveredText: string | null;
}

export interface DeliveryOptions {
    readonly renderOnlyOnComplete: boolean;
}

// ---------------------------------------------------------------------------
// Pure pipeline: DeliverySnapshot → DeliveryPlan
// ---------------------------------------------------------------------------

/**
 * Pure function that transforms a frozen DeliverySnapshot into a DeliveryPlan.
 *
 * Steps:
 *   1. splitOutputAndLogs(finalText) → extract output from chrome/logs
 *   2. Choose mode: rendered-html vs text-delivery vs empty
 *   3. Convert content to Telegram-safe HTML
 *   4. Split into ≤4096-char chunks
 *
 * No side effects. No shared state. Deterministic.
 */
export function planDelivery(
    pipeline: PipelineSession,
    snapshot: DeliverySnapshot,
    options: DeliveryOptions,
): DeliveryPlan {
    // ── Step 1: Choose delivery mode ─────────────────────────────────────
    // Prefer Markdown → Telegram HTML (pure function, no CDP dependency).
    // Fall back to CDP-rendered HTML only if no finalText is available.
    const mode = pipeline.step(
        'chooseDeliveryMode',
        {
            renderOnlyOnComplete: options.renderOnlyOnComplete,
            preferredFormat: snapshot.preferredFormat,
            htmlClock: snapshot.htmlClock,
            htmlLength: snapshot.html.length,
            finalTextLength: snapshot.finalText.length,
        },
        (): DeliveryMode => {
            if (snapshot.finalText.trim()) {
                return 'text-to-html';
            }
            if (snapshot.html.trim()) {
                logger.debug(
                    `[DeliveryPipeline] No finalText but rendered HTML exists `
                    + `(${snapshot.html.length} chars, htmlClock=${snapshot.htmlClock}). `
                    + `Using rendered-html fallback.`,
                );
                return 'rendered-html';
            }
            return 'empty';
        },
    );

    // ── Step 2: Convert to Telegram HTML ───────────────────────────────────
    const telegramHtml = pipeline.step(
        'convertToTelegramHtml',
        { mode, inputLength: mode === 'rendered-html' ? snapshot.html.length : snapshot.finalText.length },
        (): string => {
            if (mode === 'rendered-html') {
                return rawHtmlToTelegramHtml(snapshot.html).trim();
            }
            if (mode === 'text-to-html') {
                return markdownToTelegramHtmlViaUnified(snapshot.finalText).trim();
            }
            return '';
        },
    );

    // ── Step 3: Split into chunks ──────────────────────────────────────────
    const chunks = pipeline.step(
        'splitIntoChunks',
        { telegramHtmlLength: telegramHtml.length },
        () => splitTelegramText(telegramHtml),
    );

    // ── Step 4: Derive deliveredText for afterComplete hooks ───────────────
    // Strip HTML tags to give hooks plain text (used by inspect mode & claw).
    const deliveredText = pipeline.step(
        'resolveDeliveredText',
        { mode, telegramHtmlLength: telegramHtml.length },
        (): string | null => {
            if ((mode === 'rendered-html' || mode === 'text-to-html') && telegramHtml.trim()) {
                return stripHtmlTags(telegramHtml).trim() || null;
            }
            return null;
        },
    );

    // ── Build reason string for debugging ──────────────────────────────────
    const reason = mode === 'rendered-html'
        ? `Rendered HTML (htmlClock=${snapshot.htmlClock}, content=${snapshot.html.length} chars)`
        : mode === 'text-to-html'
            ? `Text-to-HTML fallback (finalText=${snapshot.finalText.length} chars, htmlClock=${snapshot.htmlClock})`
            : `Empty — no rendered HTML available (htmlClock=${snapshot.htmlClock})`;

    return { mode, reason, telegramHtml, chunks, deliveredText };
}

// ---------------------------------------------------------------------------
// Effects: DeliveryPlan → Telegram API
// ---------------------------------------------------------------------------

/**
 * Execute the delivery plan by sending/editing Telegram messages.
 *
 * This is the ONLY function with side effects in the pipeline.
 * It receives all inputs explicitly — no shared state.
 */
export async function executeDelivery(
    pipeline: PipelineSession,
    plan: DeliveryPlan,
    channel: PlatformChannel,
    existingMessages: PlatformSentMessage[],
): Promise<PlatformSentMessage[]> {
    if (plan.mode === 'empty' || plan.chunks.length === 0) {
        pipeline.observe('executeDelivery', { mode: plan.mode, action: 'skip' });
        return existingMessages;
    }

    return pipeline.stepAsync(
        'executeDelivery',
        { mode: plan.mode, chunkCount: plan.chunks.length, existingMessageCount: existingMessages.length },
        async () => {
            const nextMessages = existingMessages.slice();

            for (let i = 0; i < plan.chunks.length; i++) {
                const existing = nextMessages[i];
                if (existing) {
                    try {
                        nextMessages[i] = await existing.edit({ text: plan.chunks[i] });
                        continue;
                    } catch (err: any) {
                        logger.warn(`[DeliveryPipeline] edit failed for msg #${i}: ${err?.message || err}`);
                        const isLengthError = isTelegramLengthError(err);
                        const replacement = await channel.send({ text: plan.chunks[i] }).catch((sendErr: any) => {
                            logger.error(`[DeliveryPipeline] send failed for chunk #${i}: ${sendErr?.message || sendErr}`);
                            return null;
                        });
                        if (replacement) {
                            if (!isLengthError) {
                                await existing.delete().catch(() => { });
                            }
                            nextMessages[i] = replacement;
                            continue;
                        }
                    }
                    continue;
                }

                const sent = await channel.send({ text: plan.chunks[i] }).catch((sendErr: any) => {
                    logger.error(`[DeliveryPipeline] send failed for chunk #${i}: ${sendErr?.message || sendErr}`);
                    return null;
                });
                if (sent) {
                    nextMessages[i] = sent;
                }
            }

            // Delete excess messages from previous renders
            for (let i = plan.chunks.length; i < nextMessages.length; i++) {
                await nextMessages[i].delete().catch(() => { });
            }

            return nextMessages.slice(0, plan.chunks.length);
        },
    );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isTelegramLengthError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || '');
    return /(message is too long|too long|text_too_long|message_too_long|caption is too long|entities too long)/i.test(message);
}

/** Strip HTML tags to produce plain text (for afterComplete hooks). */
function stripHtmlTags(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Split Telegram HTML into chunks that fit the 4096-char limit.
 *
 * Tracks open HTML tags and re-opens/closes them across chunk boundaries
 * so each chunk is valid standalone HTML. Prefers splitting at newline
 * boundaries to avoid breaking words.
 *
 * PURE FUNCTION — no side effects.
 */
export function splitTelegramText(text: string): string[] {
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) return text.length > 0 ? [text] : [];

    type OpenTag = { name: string; openTag: string };
    const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
    const chunks: string[] = [];
    const openTags: OpenTag[] = [];
    let current = '';
    let cursor = 0;

    const buildClosingTags = () => openTags.slice().reverse().map((tag) => `</${tag.name}>`).join('');
    const buildOpeningTags = () => openTags.map((tag) => tag.openTag).join('');
    const flushChunk = () => {
        if (!current) return;
        chunks.push(current + buildClosingTags());
        current = buildOpeningTags();
    };
    const splitTextSegment = (segment: string, maxLen: number): [string, string] => {
        if (segment.length <= maxLen) {
            return [segment, ''];
        }
        const candidate = segment.slice(0, maxLen);
        const lastNewline = candidate.lastIndexOf('\n');
        const splitAt = lastNewline > maxLen / 2 ? lastNewline + 1 : maxLen;
        return [segment.slice(0, splitAt), segment.slice(splitAt)];
    };
    const appendText = (segment: string) => {
        let remaining = segment;
        while (remaining.length > 0) {
            const closingTags = buildClosingTags();
            const available = MAX_LENGTH - current.length - closingTags.length;
            if (available <= 0) {
                flushChunk();
                continue;
            }
            const [piece, rest] = splitTextSegment(remaining, available);
            current += piece;
            remaining = rest;
            if (remaining.length > 0) {
                flushChunk();
            }
        }
    };

    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(text)) !== null) {
        if (match.index > cursor) {
            appendText(text.slice(cursor, match.index));
        }

        const fullTag = match[0];
        const rawName = match[1] || '';
        const tagName = rawName.toLowerCase();
        const isClosing = fullTag.startsWith('</');
        const isSelfClosing = fullTag.endsWith('/>') || tagName === 'tg-emoji';

        if ((current.length + fullTag.length + buildClosingTags().length) > MAX_LENGTH) {
            flushChunk();
        }
        current += fullTag;

        if (isClosing) {
            const idx = openTags.map((tag) => tag.name).lastIndexOf(tagName);
            if (idx >= 0) {
                openTags.splice(idx, 1);
            }
        } else if (!isSelfClosing) {
            openTags.push({ name: tagName, openTag: fullTag });
        }

        cursor = match.index + fullTag.length;
    }

    if (cursor < text.length) {
        appendText(text.slice(cursor));
    }

    if (current) {
        chunks.push(current + buildClosingTags());
    }

    return chunks.filter((chunk) => chunk.length > 0);
}
