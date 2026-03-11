/**
 * Trajectory Renderer — converts raw Markdown (from LS API trajectory) into
 * Telegram-safe HTML through a unified marked → sanitize pipeline.
 *
 * This module is a PURE FUNCTION with zero side effects — safe for concurrent
 * use across multiple sessions.
 */

import { htmlToTelegramHtml } from './htmlToTelegramHtml';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function rawHtmlToTelegramHtml(html: string): string {
    if (!html || !html.trim()) return '';
    return htmlToTelegramHtml(html);
}

/**
 * Escapes characters that have special meaning in HTML.
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
