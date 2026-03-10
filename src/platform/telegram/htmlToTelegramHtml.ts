/**
 * Generic HTML → Telegram-safe HTML sanitizer.
 *
 * Takes standard HTML (from remark-rehype or any other source) and strips it
 * down to only the tags supported by Telegram's Bot API:
 *   b, strong, i, em, u, ins, s, strike, del, a, code, pre, blockquote,
 *   span (class="tg-spoiler"), tg-spoiler, tg-emoji
 *
 * All other tags are unwrapped (their text content is preserved).
 * <style>, <script>, <svg> blocks are removed entirely.
 *
 * This module is a PURE FUNCTION with zero side effects — safe for concurrent
 * use across multiple sessions.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tags whose content is entirely discarded. */
const VOID_CONTENT_TAGS = new Set(['style', 'script', 'svg', 'noscript']);

/** Tags that Telegram's Bot API accepts. */
const TG_ALLOWED_TAGS = new Set([
    'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
    'a', 'code', 'pre', 'blockquote',
    'tg-spoiler', 'tg-emoji',
]);

/** Tags that map to a Telegram-supported equivalent. */
const TAG_ALIASES: Record<string, string> = {
    strong: 'b',
    em: 'i',
    ins: 'u',
    strike: 's',
    del: 's',
};

import { decodeHtmlEntities } from '../../utils/htmlEntities';

// ---------------------------------------------------------------------------
// Core sanitizer
// ---------------------------------------------------------------------------

/**
 * Convert standard HTML to Telegram-safe HTML.
 *
 * Strategy:
 *   1. Remove void-content blocks (<style>, <script>, <svg>) entirely
 *   2. Walk through every tag:
 *     a. Telegram-allowed → keep (with attribute filtering)
 *     b. Semantic mapping → convert (e.g. <h1> → <b>text</b>\n)
 *     c. Everything else → unwrap (keep text, drop tag)
 *   3. Escape any remaining raw `<`, `>`, `&` in text nodes
 *   4. Collapse excessive whitespace
 */
export function htmlToTelegramHtml(html: string): string {
    if (!html) return '';

    let result = html;

    // ── Phase 1: Remove void-content blocks ──────────────────────────────
    for (const tag of VOID_CONTENT_TAGS) {
        const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
        result = result.replace(re, '');
    }

    // ── Phase 2: Semantic tag conversions ─────────────────────────────────
    // Headings → bold + newline
    result = result.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_m, content) => {
        return `\n<b>${stripTags(content).trim()}</b>\n\n`;
    });

    // Paragraphs → text + double newline
    result = result.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, content) => {
        return `${content.trim()}\n\n`;
    });

    // Expandable thought headers / summary rows
    result = result.replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, (_m, content) => {
        const text = collapseInlineWhitespace(stripTags(content));
        return text ? `\n<b>${text}</b>\n\n` : '';
    });

    // Horizontal rules
    result = result.replace(/<hr\s*\/?>/gi, '\n—\n');

    // Line breaks
    result = result.replace(/<br\s*\/?>/gi, '\n');

    // Preserve image alt text when present (e.g. file-type chips/icons)
    result = result.replace(/<img\b([^>]*)\/?>/gi, (_m, attrs) => {
        const altMatch = attrs.match(/\balt=["']([^"']*?)["']/i);
        const alt = altMatch?.[1]?.trim();
        return alt ? `${alt} ` : '';
    });

    // Preserve structured file-link metadata on anchors when the visible
    // content is icon-only or split across wrapper spans.
    result = result.replace(/<a\b([^>]*)>/gi, (_m, attrs) => {
        const hrefMatch = attrs.match(/\bhref=["']([^"']*?)["']/i);
        const href = hrefMatch?.[1];
        const filePathMatch = attrs.match(/\bdata-file-path=["']([^"']+?)["']/i);
        const lineNumberMatch = attrs.match(/\bdata-line-number=["']([^"']+?)["']/i);
        const endLineNumberMatch = attrs.match(/\bdata-end-line-number=["']([^"']+?)["']/i);

        const metaParts: string[] = [];
        if (filePathMatch?.[1]) {
            metaParts.push(filePathMatch[1].split(/[\\/]/).filter(Boolean).pop() || filePathMatch[1]);
        }
        if (lineNumberMatch?.[1]) {
            const lineRange = endLineNumberMatch?.[1]
                ? `#L${lineNumberMatch[1]}-${endLineNumberMatch[1]}`
                : `#L${lineNumberMatch[1]}`;
            metaParts.push(lineRange);
        }

        const metaPrefix = metaParts.length > 0 ? `${metaParts.join(' ')} ` : '';
        return href ? `<a href="${href}">${metaPrefix}` : `<a>${metaPrefix}`;
    });

    // Preserve Telegram spoilers without letting generic span handling
    // leak orphan </span> tags into the output.
    result = result.replace(/<span\b[^>]*class=["']tg-spoiler["'][^>]*>([\s\S]*?)<\/span>/gi, (_m, content) => {
        return `<tg-spoiler>${content}</tg-spoiler>`;
    });

    // ── Phase 2b: Checkboxes (BEFORE list processing so stripNonTgTags doesn't eat them)
    result = result.replace(/<input[^>]*type=["']checkbox["'][^>]*checked[^>]*\/?>/gi, '✅ ');
    result = result.replace(/<input[^>]*checked[^>]*type=["']checkbox["'][^>]*\/?>/gi, '✅ ');
    result = result.replace(/<input[^>]*type=["']checkbox["'][^>]*\/?>/gi, '☐ ');

    // ── Phase 2c: Lists ──────────────────────────────────────────────────
    // Process lists inside-out (handle nested lists)
    for (let pass = 0; pass < 5; pass++) {
        const hadLists = result.match(/<[uo]l[^>]*>/i);
        if (!hadLists) break;

        // Ordered lists
        result = result.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, items) => {
            let idx = 0;
            const processed = items.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_lm: string, content: string) => {
                idx++;
                return `${idx}. ${stripNonTgTags(content).trim()}\n`;
            });
            return processed + '\n';
        });

        // Unordered lists
        result = result.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, items) => {
            const processed = items.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_lm: string, content: string) => {
                return `• ${stripNonTgTags(content).trim()}\n`;
            });
            return processed + '\n';
        });
    }

    // Clean up any remaining <li> tags
    result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, content) => {
        return `• ${stripNonTgTags(content).trim()}\n`;
    });

    // Preserve span boundaries for status chips / file refs before generic unwrapping.
    result = result.replace(/<span[^>]*>([\s\S]*?)<\/span>/gi, (_m, content) => {
        const text = collapseInlineWhitespace(stripNonTgTags(content));
        return text ? `${text} ` : '';
    });
    result = result.replace(/<\/?span\b[^>]*>/gi, '');

    // Common Antigravity layout wrappers often carry meaningful row boundaries.
    for (let pass = 0; pass < 5; pass++) {
        const hadBlocks = result.match(/<(details|div|section|article|label|button)[^>]*>/i);
        if (!hadBlocks) break;

        result = result.replace(/<(details|section|article|div|label|button)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, content) => {
            const text = normalizeBlockText(stripNonTgTags(content));
            return text ? `${text}\n` : '';
        });
    }

    // ── Phase 3: Filter tags ─────────────────────────────────────────────
    // Keep allowed tags, strip everything else (preserving content)
    result = result.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (fullMatch, tagName, attrs) => {
        const tag = tagName.toLowerCase();
        const isClosing = fullMatch.startsWith('</');

        // Tags we want to completely remove (but we already handled void-content)
        if (VOID_CONTENT_TAGS.has(tag)) return '';

        // Check if it's a Telegram-allowed tag
        if (!TG_ALLOWED_TAGS.has(tag)) {
            // Not allowed — unwrap (drop the tag, keep content)
            return '';
        }

        // Apply tag aliases (strong→b, em→i, etc.)
        const mappedTag = TAG_ALIASES[tag] || tag;

        if (isClosing) {
            return `</${mappedTag}>`;
        }

        // For <a> tags, preserve href
        if (mappedTag === 'a') {
            const hrefMatch = attrs.match(/href=["']([^"']*?)["']/i);
            if (hrefMatch) {
                return `<a href="${hrefMatch[1]}">`;
            }
            return '<a>';
        }

        // For <code> and <pre>, strip all attributes (Telegram rejects class=)
        if (mappedTag === 'code' || mappedTag === 'pre') {
            return `<${mappedTag}>`;
        }

        // All other allowed tags: strip attributes
        return `<${mappedTag}>`;
    });

    // ── Phase 4: Clean up ────────────────────────────────────────────────
    // Decode HTML entities in text nodes, then re-escape for Telegram
    // First, decode everything
    result = decodeHtmlEntities(result);

    // Re-escape text that's NOT inside tags
    // We need to be careful not to escape the < and > that are part of our allowed tags
    result = reEscapeTextNodes(result);

    // Collapse excessive newlines (max 2 consecutive)
    result = result.replace(/\n{3,}/g, '\n\n');
    result = result.replace(/[ \t]+\n/g, '\n');
    result = result.replace(/\n[ \t]+/g, '\n');
    result = result.replace(/[ \t]{2,}/g, ' ');

    // Trim
    result = result.trim();

    return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Remove ALL HTML tags from text, returning plain text only. */
function stripTags(html: string): string {
    return html.replace(/<[^>]*>/g, '');
}

/** Remove only non-Telegram tags, preserving inline formatting like <code>, <b>, <i>. */
function stripNonTgTags(html: string): string {
    return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (fullMatch, tagName) => {
        const tag = tagName.toLowerCase();
        if (TG_ALLOWED_TAGS.has(tag)) return fullMatch;
        return '';
    });
}

function collapseInlineWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function normalizeBlockText(text: string): string {
    return text
        .split(/\n+/)
        .map((line) => collapseInlineWhitespace(line))
        .filter(Boolean)
        .join('\n');
}

/**
 * Re-escape `&`, `<`, `>` in text nodes only.
 * Preserves the `<tag>` and `</tag>` of our allowed Telegram tags.
 */
function reEscapeTextNodes(html: string): string {
    // Split by allowed tags, escape text between them
    const allowedTagPattern = /<\/?(b|i|u|s|a|code|pre|blockquote|tg-spoiler|tg-emoji)\b[^>]*>/gi;

    const parts: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = allowedTagPattern.exec(html)) !== null) {
        // Text before this tag
        if (match.index > lastIndex) {
            parts.push(escapeTextSegment(html.slice(lastIndex, match.index)));
        }
        // The tag itself (preserved as-is)
        parts.push(match[0]);
        lastIndex = match.index + match[0].length;
    }

    // Remaining text after last tag
    if (lastIndex < html.length) {
        parts.push(escapeTextSegment(html.slice(lastIndex)));
    }

    return parts.join('');
}

/** Escape &, <, > in a text segment (no tags expected). */
function escapeTextSegment(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
