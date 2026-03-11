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
    /** Show tool call input arguments (default: true) */
    showToolArgs?: boolean;
    /** Show tool call results (default: true) */
    showToolResults?: boolean;
    /** Truncate thinking text beyond this length (default: 800) */
    maxThinkingChars?: number;
}

const DEFAULT_OPTIONS: Required<StepRenderOptions> = {
    showThinking: true,
    showToolCalls: true,
    showToolArgs: true,
    showToolResults: true,
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

    // Catch error-only steps that aren't planner/response type
    const errorOnly = renderStepError(step, 'telegram');
    if (errorOnly) return errorOnly;

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
        const toolLines = renderToolCalls(planner.toolCalls, opts.showToolArgs, opts.showToolResults);
        if (toolLines) parts.push(toolLines);
    }

    // 3. Response text (Markdown → Telegram HTML)
    const responseText = planner?.response
        ?? step?.assistantResponse?.text
        ?? '';
    if (typeof responseText === 'string' && responseText.trim()) {
        parts.push(markdownToTelegramHtml(responseText));
    }

    // 4. Error information
    const errorHtml = renderStepError(step, 'telegram');
    if (errorHtml) parts.push(errorHtml);

    if (parts.length === 0) return null;
    return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Error rendering
// ---------------------------------------------------------------------------

/**
 * Extract and render error information from a trajectory step.
 * Checks step.error, step.plannerResponse.error, and step.response.error.
 * Returns null if no error is found.
 */
function renderStepError(step: any, mode: 'telegram' | 'discord'): string | null {
    const errorField = step?.error || step?.plannerResponse?.error || step?.response?.error;
    if (!errorField) return null;

    const errorMessage = typeof errorField === 'string'
        ? errorField
        : errorField?.message || JSON.stringify(errorField);

    if (!errorMessage || !errorMessage.trim()) return null;

    const truncated = errorMessage.length > 1000 ? errorMessage.slice(0, 1000) + '…' : errorMessage;

    if (mode === 'telegram') {
        return `❌ <b>Error</b>\n<blockquote expandable>${escapeHtml(truncated)}</blockquote>`;
    }
    // Discord markdown
    return `❌ **Error**\n> ${truncated.split('\n').join('\n> ')}`;
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

/**
 * Render tool calls in compact Antigravity-style format.
 *
 * Visual structure (Telegram HTML):
 *   ✅ <b>Searched</b> <code>*jscpd*</code>  <i>12 results</i>
 *   ✅ <b>Analyzed</b> <code>.jscpd.json #L1-26</code>
 *   ✅ <b>Ran command</b>
 *   <blockquote expandable><pre>npx jscpd src/ 2>&1</pre></blockquote>
 */
function renderToolCalls(toolCalls: any[], showArgs: boolean, showResults: boolean): string | null {
    const lines: string[] = [];

    for (const tc of toolCalls) {
        const status = resolveToolStatus(tc);
        const statusIcon = status === 'pending' ? '⏳' : status === 'error' ? '❌' : '✅';
        const summary = buildCompactToolSummary(tc);

        let line = statusIcon;
        if (showArgs && summary.subject) {
            line += ` <b>${escapeHtml(summary.label)}</b> <code>${escapeHtml(summary.subject)}</code>`;
        } else {
            line += ` <b>${escapeHtml(summary.label)}</b>`;
        }
        if (showResults && summary.resultBrief) {
            line += `  <i>${escapeHtml(summary.resultBrief)}</i>`;
        }

        lines.push(line);
        if (showArgs && summary.codePreview) {
            lines.push(`<blockquote expandable><pre>${escapeHtml(summary.codePreview)}</pre></blockquote>`);
        }
        if (showResults && summary.resultPreview) {
            lines.push(`<blockquote expandable><pre>${escapeHtml(summary.resultPreview)}</pre></blockquote>`);
        }
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

// ---------------------------------------------------------------------------
// Compact tool call summary (Antigravity-style)
// ---------------------------------------------------------------------------

interface CompactToolSummary {
    /** Human-readable action label (e.g. "Searched", "Analyzed", "Ran command") */
    label: string;
    /** Key subject (e.g. query text, filename) */
    subject: string;
    /** Brief result summary (e.g. "12 results") */
    resultBrief: string;
    /** Code preview for commands — shown in a separate expandable block */
    codePreview?: string;
    /** Brief result output excerpt — shown in a separate expandable block after the line */
    resultPreview?: string;
}

/** Parse tool arguments into a raw object for compact summary extraction. */
function getToolArgsObject(tc: any): Record<string, any> | null {
    const direct = tc?.arguments || tc?.function?.arguments || tc?.input;
    if (direct && typeof direct === 'object') return direct;
    if (typeof direct === 'string' && direct.trim()) {
        try { return JSON.parse(direct); } catch { return null; }
    }
    const json = tc?.argumentsJson;
    if (typeof json === 'string' && json.trim()) {
        try { return JSON.parse(json); } catch { return null; }
    }
    return null;
}

/** Extract a human-readable result count from a tool result string. */
function extractResultCount(result: string | null): string {
    if (!result) return '';
    const foundMatch = result.match(/Found\s+(\d+)\s+results?/i);
    if (foundMatch) return `${foundMatch[1]} results`;
    const countMatch = result.match(/(\d+)\s+results?/i);
    if (countMatch) return `${countMatch[1]} results`;
    if (/no results found/i.test(result)) return '0 results';
    return '';
}

/** Extract a brief status indicator from a tool result, e.g. line count, exit code. */
function extractBriefStatus(result: string | null, patterns: RegExp[]): string {
    if (!result) return '';
    for (const p of patterns) {
        const m = result.match(p);
        if (m) return m[1] ?? m[0];
    }
    return '';
}

/** Get the last component of a file path. */
function fileBasename(filePath: string): string {
    return filePath.split(/[/\\]/).pop() || filePath;
}

/** Shorten a path to the last N segments for readability. */
function shortenPath(filePath: string, segments = 2): string {
    const parts = filePath.split(/[/\\]/).filter(Boolean);
    if (parts.length <= segments) return parts.join('/');
    return '…/' + parts.slice(-segments).join('/');
}

/**
 * Extract the diff block and compute +/- stats from an edit tool result.
 *
 * The result typically contains:
 *   [diff_block_start]
 *   @@ -10,5 +10,8 @@
 *   +added line
 *   -removed line
 *    context line
 *   [diff_block_end]
 */
function extractDiffFromResult(result: string | null): { diffText: string | null; stats: string | null } {
    if (!result) return { diffText: null, stats: null };

    // Extract diff block content
    const blockMatch = result.match(/\[diff_block_start\]\s*\n([\s\S]*?)\n\s*\[diff_block_end\]/);
    const diffText = blockMatch?.[1]?.trim() || null;

    // Count added/removed lines from the diff (lines starting with + or - but not @@ headers)
    if (diffText) {
        const lines = diffText.split('\n');
        let added = 0;
        let removed = 0;
        for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) added++;
            else if (line.startsWith('-') && !line.startsWith('---')) removed++;
        }
        const stats = (added || removed) ? `+${added}/-${removed}` : null;
        return { diffText, stats };
    }

    // Fallback: try to extract from @@ hunk headers
    const hunkMatches = result.matchAll(/@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/g);
    const hunks = [...hunkMatches];
    if (hunks.length > 0) {
        return { diffText: null, stats: `${hunks.length} hunks` };
    }

    return { diffText: null, stats: null };
}

/**
 * Produce a human-readable result brief for `run_command` by examining
 * the command line and its output. Falls back to generic exit status.
 */
function extractCommandResultBrief(cmdLine: string, result: string | null, exitBrief: string): string {
    if (!result) {
        return exitBrief === '0' ? 'success' : exitBrief || '';
    }

    const cmd = cmdLine.toLowerCase();

    // git commit → extract short commit hash + message (check BEFORE diff-stat since
    // commit output often includes "N files changed" on subsequent lines)
    const commitMatch = result.match(/\[[\w/.-]+\s+([a-f0-9]{7,})\]\s+(.{1,60})/);
    if (commitMatch) {
        return `${commitMatch[1]} ${commitMatch[2]}`;
    }

    // git diff --stat → "3 files changed, +10/-5"
    // Capture insertions and deletions separately with non-greedy patterns
    const diffStatMatch = result.match(/(\d+)\s+files?\s+changed/i);
    if (diffStatMatch) {
        const files = diffStatMatch[1];
        const insMatch = result.match(/(\d+)\s+insertions?\(\+\)/i);
        const delMatch = result.match(/(\d+)\s+deletions?\(-\)/i);
        const ins = insMatch?.[1];
        const del = delMatch?.[1];
        let brief = `${files} files changed`;
        if (ins || del) brief += `, +${ins || 0}/-${del || 0}`;
        return brief;
    }

    // git status → summarize file states
    if (cmd.includes('git') && cmd.includes('status')) {
        const modifiedCount = (result.match(/^\s*modified:/gm) || []).length;
        const newFileCount = (result.match(/^\s*new file:/gm) || []).length;
        const deletedCount = (result.match(/^\s*deleted:/gm) || []).length;
        const untrackedCount = (result.match(/^\s*Untracked files:/gm) || []).length;
        const parts: string[] = [];
        if (modifiedCount) parts.push(`${modifiedCount} modified`);
        if (newFileCount) parts.push(`${newFileCount} new`);
        if (deletedCount) parts.push(`${deletedCount} deleted`);
        if (untrackedCount) parts.push('untracked');
        if (/nothing to commit.*working tree clean/i.test(result)) return 'clean';
        if (parts.length > 0) return parts.join(', ');
    }

    // git log → count commits shown
    const logCommits = (result.match(/^commit [a-f0-9]{40}/gm) || []).length;
    if (logCommits > 0) return `${logCommits} commits`;

    // npm/pnpm test → pass/fail summary
    const testMatch = result.match(/(\d+)\s+(?:tests?\s+)?passed.*?(\d+)\s+(?:tests?\s+)?failed/i)
        || result.match(/Tests:\s*(\d+)\s+passed/i);
    if (testMatch) return testMatch[0].slice(0, 50);

    // npm run build / tsc → errors
    const tscErrors = result.match(/Found\s+(\d+)\s+errors?/i);
    if (tscErrors) return `${tscErrors[1]} errors`;
    if (cmd.includes('build') && /compiled successfully/i.test(result)) return 'compiled';

    // Generic fallback
    if (exitBrief === 'completed successfully' || exitBrief === '0') return 'success';
    if (exitBrief) return exitBrief;
    return '';
}

/**
 * Build a compact Antigravity-style summary for a tool call.
 * Maps raw tool names to human-readable labels and extracts key details.
 */
function buildCompactToolSummary(tc: any): CompactToolSummary {
    const name = (tc.name || tc.toolName || tc.function?.name || '').toLowerCase();
    const args = getToolArgsObject(tc);
    const result = extractToolResult(tc);

    // ── Complete tool mapping from Antigravity SDK CortexStepType ──
    // Handles both snake_case (gRPC/trajectory) and camelCase (SDK) variants.
    switch (name) {

        // ── Search tools ────────────────────────────────────────────────
        case 'grep_search':
        case 'grepsearch': {
            const query = args?.Query || '';
            // Show scope if searching a specific path (not project root)
            const scope = args?.SearchPath && !args.SearchPath.endsWith('/')
                ? ` in ${fileBasename(args.SearchPath)}`
                : '';
            return { label: 'Searched', subject: query + scope, resultBrief: extractResultCount(result) };
        }
        case 'find_by_name':
        case 'findbyname': {
            const pattern = args?.Pattern || '';
            const dir = args?.SearchDirectory ? ` in ${fileBasename(args.SearchDirectory)}` : '';
            return { label: 'Searched', subject: pattern + dir, resultBrief: extractResultCount(result) };
        }
        case 'codebase_search':
        case 'codebasesearch':
            return { label: 'Searched', subject: args?.query || args?.Query || '', resultBrief: extractResultCount(result) };
        case 'search_web':
        case 'searchweb':
            return { label: 'Web searched', subject: args?.query || '', resultBrief: '' };

        // ── File viewing tools ──────────────────────────────────────────
        case 'view_file':
        case 'viewfile': {
            const fp = args?.AbsolutePath || args?.path || '';
            const s = args?.StartLine;
            const e = args?.EndLine;
            const range = s && e ? `#L${s}-${e}` : s ? `#L${s}` : '';
            // Extract total lines from result if available
            const linesBrief = extractBriefStatus(result, [/Total Lines:\s*(\d+)/i]);
            return {
                label: 'Analyzed',
                subject: `${fileBasename(fp)} ${range}`.trim(),
                resultBrief: linesBrief ? `${linesBrief} lines` : '',
            };
        }
        case 'view_file_outline':
        case 'viewfileoutline':
            return { label: 'Viewed outline', subject: fileBasename(args?.AbsolutePath || args?.path || ''), resultBrief: '' };
        case 'view_code_item':
        case 'viewcodeitem': {
            const sym = args?.node_identifier || args?.symbol || '';
            const file = args?.file ? fileBasename(args.file) : '';
            const subj = file ? `${sym} in ${file}` : sym;
            return { label: 'Viewed symbol', subject: subj, resultBrief: '' };
        }
        case 'view_content_chunk':
            return { label: 'Read chunk', subject: `#${args?.position ?? '?'}`, resultBrief: '' };
        case 'read_url_content':
        case 'readurlcontent':
            return { label: 'Read URL', subject: (args?.Url || '').replace(/^https?:\/\//, '').slice(0, 60), resultBrief: '' };

        // ── File modification tools ─────────────────────────────────────
        case 'write_to_file':
        case 'writetofile': {
            const fn = fileBasename(args?.TargetFile || '');
            const desc = args?.Description;
            return { label: 'Created', subject: fn, resultBrief: typeof desc === 'string' ? desc.slice(0, 60) : '' };
        }
        case 'replace_file_content':
        case 'multi_replace_file_content':
        case 'writecascadeedit':
        case 'write_cascade_edit': {
            const fn = fileBasename(args?.TargetFile || args?.file || '');
            const desc = args?.Description;
            const { diffText, stats } = extractDiffFromResult(result);
            const briefParts: string[] = [];
            if (stats) briefParts.push(stats);
            if (typeof desc === 'string') briefParts.push(desc.slice(0, 60));
            return {
                label: 'Edited',
                subject: fn,
                resultBrief: briefParts.join(' · '),
                resultPreview: diffText || undefined,
            };
        }
        case 'propose_code':
        case 'proposecode':
            return { label: 'Proposed edit', subject: fileBasename(args?.TargetFile || args?.file || ''), resultBrief: '' };

        // ── Terminal / command tools ─────────────────────────────────────
        case 'run_command':
        case 'runcommand': {
            const cmdLine = args?.CommandLine || args?.command || '';
            const isShort = cmdLine.length <= 60 && !cmdLine.includes('\n');
            const exitBrief = extractBriefStatus(result, [
                /exit code[:\s]+(\d+)/i,
                /completed successfully/i,
                /command failed/i,
            ]);
            const resultSummary = extractCommandResultBrief(cmdLine, result, exitBrief);
            return {
                label: 'Ran command',
                subject: isShort ? cmdLine : '',
                resultBrief: resultSummary,
                codePreview: isShort ? undefined : (cmdLine || undefined),
            };
        }
        case 'shell_exec':
        case 'shellexec':
            return { label: 'Ran shell', subject: '', resultBrief: '', codePreview: args?.command || args?.CommandLine || undefined };
        case 'command_status': {
            const statusBrief = extractBriefStatus(result, [/status[:\s]+"?(running|done|completed)"?/i]);
            return { label: 'Checked command', subject: args?.CommandId ? `#${args.CommandId}` : '', resultBrief: statusBrief };
        }
        case 'send_command_input':
        case 'sendcommandinput': {
            const inputPreview = args?.Input ? args.Input.trim().slice(0, 40) : '';
            return { label: 'Sent input', subject: inputPreview, resultBrief: '' };
        }
        case 'read_terminal':
        case 'readterminal':
            return { label: 'Read terminal', subject: args?.Name || '', resultBrief: '' };

        // ── Directory tools ─────────────────────────────────────────────
        case 'list_dir':
        case 'list_directory':
        case 'listdirectory': {
            const dirPath = args?.DirectoryPath || args?.path || '';
            const dirSubject = shortenPath(dirPath);
            // Try to extract entry count from result
            const entryCount = extractBriefStatus(result, [/(\d+)\s+(?:children|entries|items|files)/i]);
            return { label: 'Listed', subject: dirSubject, resultBrief: entryCount ? `${entryCount} entries` : '' };
        }

        // ── Browser tools ───────────────────────────────────────────────
        case 'open_browser_url':
        case 'openbrowserurl':
            return { label: 'Opened browser', subject: (args?.url || '').replace(/^https?:\/\//, '').slice(0, 60), resultBrief: '' };
        case 'read_browser_page':
        case 'readbrowserpage':
            return { label: 'Read browser page', subject: args?.url ? args.url.replace(/^https?:\/\//, '').slice(0, 50) : '', resultBrief: '' };
        case 'list_browser_pages':
        case 'listbrowserpages': {
            const pageCt = extractBriefStatus(result, [/(\d+)\s+pages?/i]);
            return { label: 'Listed browser pages', subject: '', resultBrief: pageCt ? `${pageCt} pages` : '' };
        }

        // ── Agent / MCP tools ───────────────────────────────────────────
        case 'mcp_tool':
        case 'mcptool': {
            const server = args?.server || args?.ServerName || '';
            const tool = args?.tool || args?.toolName || args?.name || '';
            const mcpSubj = server ? `${server}:${tool}` : tool;
            return { label: 'MCP tool', subject: mcpSubj, resultBrief: '' };
        }
        case 'invoke_subagent':
        case 'invokesubagent':
            return { label: 'Invoked subagent', subject: args?.agent || args?.name || '', resultBrief: '' };

        // ── Memory / Knowledge tools ────────────────────────────────────
        case 'memory':
            return { label: 'Memory', subject: args?.action || '', resultBrief: '' };
        case 'knowledge_generation':
        case 'knowledgegeneration':
            return { label: 'Generated knowledge', subject: '', resultBrief: '' };

        // ── Miscellaneous ───────────────────────────────────────────────
        case 'generate_image':
            return { label: 'Generated image', subject: args?.ImageName || args?.Prompt?.slice(0, 40) || '', resultBrief: '' };
        case 'read_resource':
            return { label: 'Read resource', subject: args?.Uri || '', resultBrief: '' };
        case 'wait':
            return { label: 'Waiting', subject: args?.duration ? `${args.duration}ms` : '', resultBrief: '' };
        case 'task_boundary':
        case 'taskboundary':
            return { label: 'Task', subject: args?.TaskName || '', resultBrief: args?.TaskStatus || '' };
        case 'notify_user':
        case 'notifyuser':
            return { label: 'Notified user', subject: '', resultBrief: '' };

        default: {
            // Handle MCP server tools: mcp_<server>_<tool> → "MCP: <tool>"
            if (name.startsWith('mcp_')) {
                const parts = name.split('_');
                const serverPart = parts.length > 2 ? parts[1] : '';
                const toolPart = parts.length > 2 ? parts.slice(2).join('_') : parts.slice(1).join('_');
                return { label: 'MCP', subject: serverPart ? `${serverPart}:${toolPart}` : toolPart, resultBrief: '' };
            }
            return { label: name || 'unknown', subject: '', resultBrief: '' };
        }
    }
}

/**
 * Extract tool call result/output. No truncation — the caller wraps
 * long content in expandable blockquotes.
 */
function extractToolResult(tc: any): string | null {
    if (typeof tc?.result === 'string') return tc.result;
    if (typeof tc?.output === 'string') return tc.output;
    if (tc?.toolCallResult != null) {
        return typeof tc.toolCallResult === 'string'
            ? tc.toolCallResult
            : JSON.stringify(tc.toolCallResult, null, 2);
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
            const cards: string[] = [];
            for (const tc of planner.toolCalls) {
                const status = resolveToolStatus(tc);
                const statusIcon = status === 'pending' ? '⏳' : status === 'error' ? '❌' : '✅';
                const summary = buildCompactToolSummary(tc);

                let card = statusIcon;
                if (opts.showToolArgs && summary.subject) {
                    card += ` **${summary.label}** \`${summary.subject}\``;
                } else {
                    card += ` **${summary.label}**`;
                }
                if (opts.showToolResults && summary.resultBrief) {
                    card += `  *${summary.resultBrief}*`;
                }
                cards.push(card);
                if (opts.showToolArgs && summary.codePreview) {
                    cards.push(`\`\`\`\n${summary.codePreview}\n\`\`\``);
                }
                if (opts.showToolResults && summary.resultPreview) {
                    cards.push(`\`\`\`\n${summary.resultPreview}\n\`\`\``);
                }
            }
            if (cards.length > 0) parts.push(cards.join('\n'));
        }

        const responseText = planner?.response ?? step?.assistantResponse?.text ?? '';
        if (typeof responseText === 'string' && responseText.trim()) {
            parts.push(responseText);
        }

        // Error information
        const errorMd = renderStepError(step, 'discord');
        if (errorMd) parts.push(errorMd);

        if (parts.length === 0) return null;
        return parts.join('\n\n');
    }

    // Catch error-only steps that aren't planner/response type
    const errorOnly = renderStepError(step, 'discord');
    if (errorOnly) return errorOnly;

    return null;
}
