import { marked } from 'marked';
import type { RichContent, RichContentField } from '../types';

/** Escape characters that are special in HTML. */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

marked.use({
    renderer: {
        html({ text }) {
            // Preserve Telegram safe tags, escape the rest
            const tagPlaceholders: string[] = [];
            let result = text.replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|a|code|pre|blockquote|span|tg-spoiler|tg-emoji)\b[^>]*>/gi, (tag) => {
                const idx = tagPlaceholders.length;
                tagPlaceholders.push(tag);
                return `\x00TAG${idx}\x00`;
            });
            result = result.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return result.replace(/\x00TAG(\d+)\x00/g, (_m, idx) => tagPlaceholders[Number(idx)]);
        },
        text({ text }) { return escapeHtml(text); },
        paragraph(token) {
            return this.parser.parseInline(token.tokens || []) + '\n\n';
        },
        strong({ text }) { return `<b>${text}</b>`; },
        em({ text }) { return `<i>${text}</i>`; },
        del({ text }) { return `<s>${text}</s>`; },
        codespan({ text }) { return `<code>${escapeHtml(text)}</code>`; },
        code({ text, lang }) {
            return `<pre><code>${escapeHtml(text)}</code></pre>\n`;
        },
        link({ href, title, text }) { return `<a href="${href}">${text}</a>`; },
        heading({ text, depth }) { return `<b>${text}</b>\n\n`; },
        blockquote({ text }) { return `<blockquote>${text}</blockquote>\n`; },
        list({ items, ordered, start }) {
            return items ? items.map((i: any) => i.text ? `• ${i.text}\n` : "").join("") : "\n";
        },
        listitem({ text, task, checked }) {
            return `• ${text}\n`;
        },
        br() { return '\n'; },
        hr() { return '\n—\n'; }
    },
    gfm: true,
    breaks: true
});

/**
 * Convert a limited subset of Markdown to Telegram HTML.
 */
export function markdownToTelegramHtml(text: string): string {
    if (!text) return '';

    // Parse using marked
    let html = marked.parse(text) as string;

    // Marked returns a string, but it might have double newlines from paragraph
    // Let's clean it up slightly and sanitize unauthorized tags
    html = html.trim();
    return html;
}

// ---------------------------------------------------------------------------
// RichContent -> Telegram HTML
// ---------------------------------------------------------------------------

function formatField(field: RichContentField): string {
    const escapedName = escapeHtml(field.name);
    const convertedValue = markdownToTelegramHtml(field.value);
    return `<b>${escapedName}:</b> ${convertedValue}`;
}

function formatFields(fields: readonly RichContentField[]): string {
    const parts: string[] = [];
    let inlineGroup: string[] = [];

    for (const field of fields) {
        if (field.inline) {
            inlineGroup = [...inlineGroup, formatField(field)];
        } else {
            if (inlineGroup.length > 0) {
                parts.push(inlineGroup.join(' | '));
                inlineGroup = [];
            }
            parts.push(formatField(field));
        }
    }

    if (inlineGroup.length > 0) {
        parts.push(inlineGroup.join(' | '));
    }

    return parts.join('\n');
}

export function richContentToHtml(rc: RichContent): string {
    const sections: string[] = [];

    if (rc.title) {
        sections.push(`<b>${escapeHtml(rc.title)}</b>`);
    }

    if (rc.description) {
        sections.push(markdownToTelegramHtml(rc.description));
    }

    if (rc.fields && rc.fields.length > 0) {
        sections.push(formatFields(rc.fields));
    }

    let html = sections.join('\n\n');

    if (rc.footer) {
        html += `\n\n<i>${escapeHtml(rc.footer)}</i>`;
    }

    return html;
}
