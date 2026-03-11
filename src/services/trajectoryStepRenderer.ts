/**
 * TrajectoryStepRenderer — native step-to-Telegram-HTML renderer.
 *
 * Replaces the CDP/Preact bundle rendering path by transforming backend
 * trajectory steps (text, tool calls, thinking, user input) directly into
 * Telegram-safe HTML for streaming delivery.
 *
 * Every exported function is PURE — no side effects, no I/O.
 *
 * Supported Telegram HTML tags:
 *   b, i, u, s, code, pre, a, blockquote
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StepRenderOptions {
    /** Show thinking blocks (default: true) */
    showThinking?: boolean;
    /** Show tool call lines (default: true) */
    showToolCalls?: boolean;
    /** Show tool call results (default: false — too verbose) */
    showToolResults?: boolean;
    /** Truncate thinking text beyond this length (default: 800) */
    maxThinkingChars?: number;
}

const DEFAULT_OPTIONS: Required<StepRenderOptions> = {
    showThinking: true,
    showToolCalls: true,
    showToolResults: false,
    maxThinkingChars: 800,
};
const PRE_BLOCK_PLACEHOLDER = '@@PRE_BLOCK_';
const CODE_SPAN_PLACEHOLDER = '@@CODE_SPAN_';
const TAG_SLOT_PLACEHOLDER = '@@TAG_SLOT_';

/**
 * Render trajectory steps into Telegram-safe HTML.
 *
 * This is the primary entry point. It receives the raw steps array from
 * `GetCascadeTrajectory` and the cascade run status, and produces a single
 * HTML string ready for delivery via the Telegram Bot API.
 *
 * Only renders steps after the LAST user input step (current turn).
 */
export function renderStepsToTelegramHtml(
    steps: any[],
    runStatus: string | null,
    options?: StepRenderOptions,
): string {
    if (!Array.isArray(steps) || steps.length === 0) return '';

    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Find the last user input step to anchor the current turn
    let anchorIndex = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i]?.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
            anchorIndex = i;
            break;
        }
    }

    // Render only steps after the anchor (the current turn's assistant response)
    const renderFrom = anchorIndex >= 0 ? anchorIndex + 1 : 0;
    const fragments: string[] = [];

    for (let i = renderFrom; i < steps.length; i++) {
        const step = steps[i];
        const rendered = renderStep(step, opts);
        if (rendered) {
            fragments.push(rendered);
        }
    }

    // Append running indicator
    const isRunning = runStatus === 'CASCADE_RUN_STATUS_RUNNING'
        || runStatus === 'RUNNING';
    if (isRunning && fragments.length > 0) {
        fragments.push('⏳');
    }

    return fragments.join('\n\n').trim();
}

// ---------------------------------------------------------------------------
// Per-step rendering
// ---------------------------------------------------------------------------

function renderStep(step: any, opts: Required<StepRenderOptions>): string | null {
    const type = step?.type;

    if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || type === 'CORTEX_STEP_TYPE_RESPONSE') {
        return renderAssistantStep(step, opts);
    }

    // Skip user input — already visible in the Telegram chat
    return null;
}

function renderAssistantStep(step: any, opts: Required<StepRenderOptions>): string | null {
    const parts: string[] = [];
    const planner = step?.plannerResponse;

    // 1. Thinking block
    if (opts.showThinking && planner?.thinking) {
        const thinking = renderThinking(planner.thinking, opts.maxThinkingChars);
        if (thinking) parts.push(thinking);
    }

    // 2. Tool calls
    if (opts.showToolCalls && Array.isArray(planner?.toolCalls) && planner.toolCalls.length > 0) {
        const toolLines = renderToolCalls(planner.toolCalls, opts.showToolResults);
        if (toolLines) parts.push(toolLines);
    }

    // 3. Response text (Markdown → Telegram HTML)
    const responseText = planner?.response
        ?? step?.assistantResponse?.text
        ?? '';
    if (typeof responseText === 'string' && responseText.trim()) {
        parts.push(markdownToTelegramHtml(responseText));
    }

    if (parts.length === 0) return null;
    return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

function renderThinking(thinking: string, maxChars: number): string | null {
    if (typeof thinking !== 'string') return null;
    let text = thinking.trim();
    if (!text) return null;

    if (text.length > maxChars) {
        text = text.slice(0, maxChars) + '…';
    }

    return `💭 <blockquote expandable>${escapeHtml(text)}</blockquote>`;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

function renderToolCalls(toolCalls: any[], showResults: boolean): string | null {
    const lines: string[] = [];

    for (const tc of toolCalls) {
        const name = tc.name || tc.toolName || tc.function?.name || 'unknown_tool';
        const status = resolveToolStatus(tc);
        const statusIcon = status === 'pending' ? '⏳' : status === 'error' ? '❌' : '✅';

        let line = `${statusIcon} <code>${escapeHtml(name)}</code>`;

        if (showResults && status !== 'pending') {
            const result = extractToolResult(tc);
            if (result) {
                const truncated = result.length > 200 ? result.slice(0, 200) + '…' : result;
                line += `\n<pre>${escapeHtml(truncated)}</pre>`;
            }
        }

        lines.push(line);
    }

    return lines.length > 0 ? lines.join('\n') : null;
}

function resolveToolStatus(tc: any): 'pending' | 'success' | 'error' {
    const status = tc?.status || tc?.toolCallStatus || '';
    if (status === 'completed' || status === 'done' || status === 'success') return 'success';
    if (status === 'error') return 'error';

    const hasResult = tc?.result !== undefined
        || tc?.output !== undefined
        || tc?.toolCallResult !== undefined;
    if (hasResult) return 'success';

    return 'pending';
}

function extractToolResult(tc: any): string | null {
    if (typeof tc?.result === 'string') return tc.result;
    if (typeof tc?.output === 'string') return tc.output;
    if (tc?.toolCallResult != null) {
        return typeof tc.toolCallResult === 'string'
            ? tc.toolCallResult
            : JSON.stringify(tc.toolCallResult).slice(0, 500);
    }
    return null;
}

// ---------------------------------------------------------------------------
// Markdown → Telegram HTML
// ---------------------------------------------------------------------------

/**
 * Lightweight Markdown to Telegram HTML converter.
 *
 * Handles: bold, italic, strikethrough, inline code, code blocks,
 * links, headers, lists (ordered + unordered), blockquotes.
 *
 * No external dependencies. Designed for the subset of Markdown
 * typically found in AI assistant responses.
 */
export function markdownToTelegramHtml(md: string): string {
    if (!md) return '';

    let result = md;

    // Normalize line endings
    result = result.replace(/\r\n/g, '\n');

    // Fenced code blocks (``` ... ```) — must be processed BEFORE inline escaping
    result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
        return `<pre>${escapeHtml(code.trimEnd())}</pre>`;
    });

    // Split into lines for block-level processing, but preserve <pre> blocks
    const preBlocks: string[] = [];
    result = result.replace(/<pre>[\s\S]*?<\/pre>/g, (match) => {
        const idx = preBlocks.length;
        preBlocks.push(match);
        return `${PRE_BLOCK_PLACEHOLDER}${idx}@@`;
    });

    // Process line-by-line for block elements
    const lines = result.split('\n');
    const processed: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // Pre block placeholder — pass through
        if (line.includes(PRE_BLOCK_PLACEHOLDER)) {
            processed.push(line);
            continue;
        }

        // Headers → bold
        line = line.replace(/^#{1,6}\s+(.+)$/, '<b>$1</b>');

        // Blockquotes
        line = line.replace(/^>\s?(.*)$/, '<blockquote>$1</blockquote>');

        // Unordered list items
        line = line.replace(/^[\s]*[-*+]\s+(.+)$/, '• $1');

        // Ordered list items
        line = line.replace(/^[\s]*(\d+)\.\s+(.+)$/, '$1. $2');

        // Horizontal rules
        line = line.replace(/^[-*_]{3,}$/, '—');

        // Inline formatting (process after block-level)
        line = processInlineFormatting(line);

        processed.push(line);
    }

    result = processed.join('\n');

    // Restore pre blocks
    for (let i = 0; i < preBlocks.length; i++) {
        result = result.replace(`${PRE_BLOCK_PLACEHOLDER}${i}@@`, preBlocks[i]);
    }

    // Merge consecutive blockquotes
    result = result.replace(/<\/blockquote>\n<blockquote>/g, '\n');

    // Collapse excessive newlines
    result = result.replace(/\n{3,}/g, '\n\n');

    return result.trim();
}

/**
 * Process inline Markdown formatting within a single line.
 * Handles: bold, italic, strikethrough, inline code, links, images.
 */
function processInlineFormatting(line: string): string {
    // Inline code (must be first to protect content inside backticks)
    const codeSpans: string[] = [];
    line = line.replace(/`([^`\n]+)`/g, (_m, code) => {
        const idx = codeSpans.length;
        codeSpans.push(`<code>${escapeHtml(code)}</code>`);
        return `${CODE_SPAN_PLACEHOLDER}${idx}@@`;
    });

    // Protect existing Telegram-safe HTML tags (from block-level processing)
    // Only protect tags that Telegram supports: b, i, u, s, code, pre, a, blockquote
    const tagSlots: string[] = [];
    line = line.replace(/<\/?(?:b|i|u|s|code|pre|a|blockquote)(?:\s[^>]*)?\s*>/g, (tag) => {
        const idx = tagSlots.length;
        tagSlots.push(tag);
        return `${TAG_SLOT_PLACEHOLDER}${idx}@@`;
    });

    // Escape HTML in the remaining text (non-code, non-tag parts)
    const codeSlotPattern = new RegExp(`${CODE_SPAN_PLACEHOLDER}\\d+@@`, 'g');
    const codeParts = line.split(codeSlotPattern);
    const codeMatches = line.match(codeSlotPattern) || [];
    let escaped = '';
    for (let i = 0; i < codeParts.length; i++) {
        escaped += escapeHtml(codeParts[i]);
        if (i < codeMatches.length) {
            const idx = parseInt(codeMatches[i].replace(CODE_SPAN_PLACEHOLDER, '').replace('@@', ''), 10);
            escaped += codeSpans[idx];
        }
    }
    line = escaped;

    // Restore protected tags
    for (let i = 0; i < tagSlots.length; i++) {
        line = line.replace(`${TAG_SLOT_PLACEHOLDER}${i}@@`, tagSlots[i]);
    }

    // Images → alt text (Telegram doesn't support inline images)
    line = line.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

    // Links [text](url)
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Bold + italic (***text*** or ___text___)
    line = line.replace(/\*{3}(.+?)\*{3}/g, '<b><i>$1</i></b>');
    line = line.replace(/_{3}(.+?)_{3}/g, '<b><i>$1</i></b>');

    // Bold (**text** or __text__)
    line = line.replace(/\*{2}(.+?)\*{2}/g, '<b>$1</b>');
    line = line.replace(/_{2}(.+?)_{2}/g, '<b>$1</b>');

    // Italic (*text* or _text_) — avoid matching mid-word underscores
    line = line.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<i>$1</i>');
    line = line.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<i>$1</i>');

    // Strikethrough (~~text~~)
    line = line.replace(/~~(.+?)~~/g, '<s>$1</s>');

    return line;
}

// ---------------------------------------------------------------------------
// HTML Escaping
// ---------------------------------------------------------------------------

/** Escape characters that have special meaning in HTML. */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Render trajectory steps into Discord Markdown.
 */
export function renderStepsToDiscordMarkdown(
    steps: any[],
    runStatus: string | null,
    options?: StepRenderOptions,
): string {
    if (!Array.isArray(steps) || steps.length === 0) return '';

    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Find the last user input step to anchor the current turn
    let anchorIndex = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i]?.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
            anchorIndex = i;
            break;
        }
    }

    const renderFrom = anchorIndex >= 0 ? anchorIndex + 1 : 0;
    const fragments: string[] = [];

    for (let i = renderFrom; i < steps.length; i++) {
        const step = steps[i];
        const rendered = renderDiscordStep(step, opts);
        if (rendered) {
            fragments.push(rendered);
        }
    }

    const isRunning = runStatus === 'CASCADE_RUN_STATUS_RUNNING'
        || runStatus === 'RUNNING';
    if (isRunning && fragments.length > 0) {
        fragments.push('⏳');
    }

    return fragments.join('\n\n').trim();
}

function renderDiscordStep(step: any, opts: Required<StepRenderOptions>): string | null {
    const type = step?.type;

    if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || type === 'CORTEX_STEP_TYPE_RESPONSE') {
        const parts: string[] = [];
        const planner = step?.plannerResponse;

        if (opts.showThinking && planner?.thinking) {
            let text = planner.thinking.trim();
            if (text) {
                if (text.length > opts.maxThinkingChars) {
                    text = text.slice(0, opts.maxThinkingChars) + '…';
                }
                parts.push(`> 💭 **Thinking**\n> ${text.split('\n').join('\n> ')}`);
            }
        }

        if (opts.showToolCalls && Array.isArray(planner?.toolCalls) && planner.toolCalls.length > 0) {
            const lines: string[] = [];
            for (const tc of planner.toolCalls) {
                const name = tc.name || tc.toolName || tc.function?.name || 'unknown_tool';
                const status = resolveToolStatus(tc);
                const statusIcon = status === 'pending' ? '⏳' : status === 'error' ? '❌' : '✅';

                let line = `${statusIcon} \`${name}\``;

                if (opts.showToolResults && status !== 'pending') {
                    const result = extractToolResult(tc);
                    if (result) {
                        const truncated = result.length > 200 ? result.slice(0, 200) + '…' : result;
                        line += `\n\`\`\`\n${truncated}\n\`\`\``;
                    }
                }
                lines.push(line);
            }
            if (lines.length > 0) parts.push(lines.join('\n'));
        }

        const responseText = planner?.response ?? step?.assistantResponse?.text ?? '';
        if (typeof responseText === 'string' && responseText.trim()) {
            parts.push(responseText);
        }

        if (parts.length === 0) return null;
        return parts.join('\n\n');
    }

    return null;
}
