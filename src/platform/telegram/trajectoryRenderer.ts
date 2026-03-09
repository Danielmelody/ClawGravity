/**
 * Trajectory Renderer — converts raw Markdown (from gRPC trajectory) into
 * Telegram-safe HTML through a unified marked → sanitize pipeline.
 *
 * This module is a PURE FUNCTION with zero side effects — safe for concurrent
 * use across multiple sessions.
 *
 * Architecture:
 *   Raw Markdown (from gRPC onComplete/onProgress)
 *        │
 *        ▼
 *   marked.parse() → standard HTML
 *        │
 *        ▼
 *   htmlToTelegramHtml() → Telegram-safe HTML
 *        │
 *        ▼
 *   Telegram Bot API
 *
 * NOTE: We use the EXISTING global `marked` instance (configured by
 * telegramFormatter.ts) which already handles bold→<b>, italic→<i>, etc.
 * Then we pipe its output through htmlToTelegramHtml for sanitization.
 *
 * The telegramFormatter's markdownToTelegramHtml() already converts Markdown
 * to Telegram-safe HTML. This module extends that by also being able to accept
 * and sanitize RAW HTML (e.g. from DOM extraction).
 */

import { htmlToTelegramHtml } from './htmlToTelegramHtml';
import { markdownToTelegramHtml } from './telegramFormatter';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert raw Markdown text (as received from gRPC trajectory) to
 * Telegram-safe HTML.
 *
 * Uses the existing telegramFormatter's `markdownToTelegramHtml()` which
 * leverages the globally-configured `marked` instance with Telegram-friendly
 * renderers, then pipes through htmlToTelegramHtml for additional
 * sanitization of any raw HTML that slips through.
 *
 * This is the primary rendering entry point. Call this with:
 * - `onComplete` finalText from GrpcResponseMonitor
 * - `onProgress` text for live previews
 * - Any Markdown string
 */
export function markdownToTelegramHtmlViaUnified(markdown: string): string {
    if (!markdown || !markdown.trim()) return '';

    // Step 1: Markdown → Telegram HTML (via telegramFormatter's marked config)
    const telegramHtml = markdownToTelegramHtml(markdown);

    // Step 2: Additional sanitization — handle any raw HTML tags that
    // marked's html() renderer may have passed through
    return htmlToTelegramHtml(telegramHtml);
}

/**
 * Convert raw HTML (e.g. from DOM extraction or any HTML source) directly
 * to Telegram-safe HTML. Does NOT parse Markdown — only sanitizes HTML.
 *
 * Use this when you already have HTML and want to make it Telegram-safe.
 */
export function rawHtmlToTelegramHtml(html: string): string {
    if (!html || !html.trim()) return '';
    return htmlToTelegramHtml(html);
}

/**
 * Re-export for convenience.
 */
export { htmlToTelegramHtml } from './htmlToTelegramHtml';
