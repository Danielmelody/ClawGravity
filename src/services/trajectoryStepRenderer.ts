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
    /** Current mode name (e.g. "Fast", "Planning") — shown in the Generating footer */
    modeName?: string;
    /** Current model name (e.g. "Gemini 2.5 Pro") — shown in the Generating footer */
    modelName?: string;
}

const DEFAULT_OPTIONS: Required<StepRenderOptions> = {
    showThinking: true,
    showToolCalls: true,
    showToolArgs: true,
    showToolResults: true,
    maxThinkingChars: 800,
    modeName: '',
    modelName: '',
};
const PRE_BLOCK_PLACEHOLDER = '@@PRE_BLOCK_';
const CODE_SPAN_PLACEHOLDER = '@@CODE_SPAN_';
const TAG_SLOT_PLACEHOLDER = '@@TAG_SLOT_';

/** Generic trajectory step type */
interface TrajectoryStep {
    type?: string;
    status?: string;
    metadata?: {
        toolCall?: {
            id?: string;
        };
        internalMetadata?: {
            statusTransitions?: Array<{ updatedStatus?: string }>;
        };
    };
    plannerResponse?: {
        toolCalls?: ToolCall[];
        thinking?: string;
        response?: string;
        error?: unknown;
    };
    assistantResponse?: {
        text?: string;
    };
    response?: {
        error?: unknown;
    };
    error?: unknown;
    userInput?: unknown;
    [key: string]: unknown;
}

/** Tool call type */
interface ToolCall {
    id?: string;
    status?: string;
    toolCallStatus?: string;
    toolCallResult?: unknown;
    name?: string;
    toolName?: string;
    function?: {
        name?: string;
        arguments?: unknown;
    };
    arguments?: unknown;
    input?: unknown;
    argumentsJson?: string;
    result?: unknown;
    output?: unknown;
}

/**
 * Pre-process the trajectory steps to enrich plannerResponse tool calls
 * with their runtime execution results from subsequent tool steps.
 */
function enrichToolCallsWithResults(steps: TrajectoryStep[]) {
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && Array.isArray(step.plannerResponse?.toolCalls)) {
            for (const tc of step.plannerResponse.toolCalls) {
                if (!tc.id) continue;
                // Find execution step for this tool call
                const execStep = steps.find(s => s?.metadata?.toolCall?.id === tc.id && s !== step);
                if (execStep) {
                    // Enrich status
                    const transitions = execStep.metadata?.internalMetadata?.statusTransitions || [];
                    const lastStatus = transitions[transitions.length - 1]?.updatedStatus;
                    if (lastStatus === 'CORTEX_STEP_STATUS_DONE') {
                        tc.status = 'completed';
                    } else if (lastStatus === 'CORTEX_STEP_STATUS_ERROR') {
                        tc.status = 'error';
                    } else if (lastStatus === 'CORTEX_STEP_STATUS_RUNNING') {
                        tc.status = 'pending';
                    } else if (execStep.status === 'CORTEX_STEP_STATUS_DONE') {
                        tc.status = 'completed';
                    }

                    // Enrich result
                    // The result payload is typically the key that isn't standard
                    const payloadKey = Object.keys(execStep).find(k =>
                        !['type', 'status', 'metadata', 'error', 'userInput', 'plannerResponse'].includes(k)
                    );
                    if (payloadKey) {
                        tc.toolCallResult = execStep[payloadKey];
                    }
                }
            }
        }
    }
}

/**
 * Recursively search an object for a command ID value.
 * Looks for keys like "commandId", "CommandId", "command_id" at any depth.
 */
function findCommandIdInObject(obj: unknown): string | null {
    if (obj == null || typeof obj !== 'object') return null;
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        const lk = key.toLowerCase();
        if ((lk === 'commandid' || lk === 'command_id') && typeof record[key] === 'string') {
            const val = record[key] as string;
            if (/^[a-f0-9-]{8,}$/i.test(val)) return val;
        }
    }
    // Recurse one level into object values
    for (const val of Object.values(record)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            const found = findCommandIdInObject(val);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Build a map from CommandId → CommandLine by scanning all run_command tool calls.
 * Used so that `command_status` can display the actual command instead of just the UUID.
 */
function buildCommandIndex(steps: TrajectoryStep[]): Map<string, string> {
    const index = new Map<string, string>();
    for (const step of steps) {
        const tcs = step?.plannerResponse?.toolCalls;
        if (!Array.isArray(tcs)) continue;
        for (const tc of tcs) {
            const name = (tc.name || tc.toolName || tc.function?.name || '').toLowerCase();
            if (name !== 'run_command' && name !== 'runcommand') continue;
            const args = getToolArgsObject(tc);
            if (!args) continue;
            const cmdLine = (args.CommandLine as string) || (args.command as string) || '';
            if (!cmdLine) continue;

            // 1. Try to find commandId in the raw structured result object
            const rawResult = tc?.result ?? tc?.output ?? tc?.toolCallResult;
            if (rawResult && typeof rawResult === 'object') {
                const structuredId = findCommandIdInObject(rawResult);
                if (structuredId) {
                    index.set(structuredId, cmdLine);
                }
            }

            // 2. Try regex on the text representation of the result
            const resultText = extractToolResult(tc);
            if (resultText) {
                const idMatch = resultText.match(/(?:command[_\s-]*id|CommandId)[:\s"]+([a-f0-9-]{8,})/i);
                if (idMatch) {
                    index.set(idMatch[1], cmdLine);
                }
            }

            // 3. Scan the matching execution step directly for command IDs
            //    (covers cases where enrichment didn't properly attach results)
            if (tc.id) {
                const execStep = steps.find(s => s?.metadata?.toolCall?.id === tc.id && s !== step);
                if (execStep) {
                    // Search all non-standard keys of the execution step for a command ID
                    for (const key of Object.keys(execStep)) {
                        if (['type', 'status', 'metadata', 'error', 'userInput', 'plannerResponse'].includes(key)) continue;
                        const payload = execStep[key];
                        if (payload && typeof payload === 'object') {
                            const foundId = findCommandIdInObject(payload);
                            if (foundId) {
                                index.set(foundId, cmdLine);
                            }
                        }
                        // Also check text content for command IDs
                        if (typeof payload === 'string') {
                            const textMatch = payload.match(/(?:command[_\s-]*id|CommandId)[:\s"]+([a-f0-9-]{8,})/i);
                            if (textMatch) {
                                index.set(textMatch[1], cmdLine);
                            }
                        }
                    }
                }
                // Also map by tool call ID (the AI may reference it directly)
                index.set(tc.id, cmdLine);
            }
        }
    }
    return index;
}

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
    steps: TrajectoryStep[],
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

    enrichToolCallsWithResults(steps);
    const commandIndex = buildCommandIndex(steps);

    // Render only steps after the anchor (the current turn's assistant response)
    const renderFrom = anchorIndex >= 0 ? anchorIndex + 1 : 0;
    const fragments: string[] = [];

    for (let i = renderFrom; i < steps.length; i++) {
        const step = steps[i];
        const rendered = renderStep(step, opts, commandIndex);
        if (rendered) {
            fragments.push(rendered);
        }
    }

    // Append running indicator with mode | model footer
    const isRunning = runStatus === 'CASCADE_RUN_STATUS_RUNNING'
        || runStatus === 'RUNNING';
    if (isRunning && fragments.length > 0) {
        const metaParts: string[] = [];
        if (opts.modeName) metaParts.push(escapeHtml(opts.modeName));
        if (opts.modelName) metaParts.push(escapeHtml(opts.modelName));
        const metaSuffix = metaParts.length > 0 ? ' ' + metaParts.join(' | ') : '';
        fragments.push(`<i>● Generating…</i>${metaSuffix}`);
    }

    return fragments.join('\n\n').trim();
}

// ---------------------------------------------------------------------------
// Per-step rendering
// ---------------------------------------------------------------------------

function renderStep(step: TrajectoryStep, opts: Required<StepRenderOptions>, commandIndex?: Map<string, string>): string | null {
    const type = step?.type;

    if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || type === 'CORTEX_STEP_TYPE_RESPONSE') {
        return renderAssistantStep(step, opts, commandIndex);
    }

    // Catch error-only steps that aren't planner/response type
    const errorOnly = renderStepError(step, 'telegram');
    if (errorOnly) return errorOnly;

    // Skip user input — already visible in the Telegram chat
    return null;
}

function renderAssistantStep(step: TrajectoryStep, opts: Required<StepRenderOptions>, commandIndex?: Map<string, string>): string | null {
    const parts: string[] = [];
    const planner = step?.plannerResponse;

    // 1. Thinking block
    if (opts.showThinking && planner?.thinking) {
        const thinking = renderThinking(planner.thinking, opts.maxThinkingChars);
        if (thinking) parts.push(thinking);
    }

    // 2. Tool calls
    if (opts.showToolCalls && Array.isArray(planner?.toolCalls) && planner.toolCalls.length > 0) {
        const toolLines = renderToolCalls(planner.toolCalls, opts.showToolArgs, opts.showToolResults, commandIndex);
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
function renderStepError(step: TrajectoryStep, mode: 'telegram' | 'discord'): string | null {
    const errorField = step?.error || step?.plannerResponse?.error || step?.response?.error;
    if (!errorField) return null;

    const errorMessage = typeof errorField === 'string'
        ? errorField
        : (errorField as { message?: string })?.message || JSON.stringify(errorField);

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

    return `💭 <blockquote expandable>\n${markdownToTelegramHtml(text)}\n</blockquote>`;
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
function renderToolCalls(toolCalls: ToolCall[], showArgs: boolean, showResults: boolean, commandIndex?: Map<string, string>): string | null {
    const lines: string[] = [];

    for (const tc of toolCalls) {
        const status = resolveToolStatus(tc);
        const statusIcon = status === 'pending'
            ? '<tg-emoji emoji-id="5465665476971471368">⏳</tg-emoji>'
            : status === 'error'
                ? '<tg-emoji emoji-id="5465465565741634628">✖️</tg-emoji>'
                : '<tg-emoji emoji-id="5465665476971471369">✔️</tg-emoji>';
        const summary = buildCompactToolSummary(tc, commandIndex);

        let line = `${statusIcon} ${summary.icon}`;
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
        // Embed artifact content inline at the point it appears in the trajectory
        if (summary.artifactContent) {
            const ARTIFACT_INLINE_MAX = 3500;
            const truncated = summary.artifactContent.length > ARTIFACT_INLINE_MAX
                ? summary.artifactContent.slice(0, ARTIFACT_INLINE_MAX) + '\n\n…(truncated)'
                : summary.artifactContent;
            const contentHtml = markdownToTelegramHtml(truncated);
            lines.push(`<blockquote expandable>${contentHtml}</blockquote>`);
        }
    }

    return lines.length > 0 ? lines.join('\n') : null;
}

function resolveToolStatus(tc: ToolCall): 'pending' | 'success' | 'error' {
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
    /** Emoji icon for the tool category (e.g. 🔍, 📄, ✏️, ▶️) */
    icon: string;
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
    /** Inline artifact content (markdown) — embedded as expandable blockquote for IsArtifact write_to_file calls */
    artifactContent?: string;
    /** Artifact type for icon selection (implementation_plan, walkthrough, task, other) */
    artifactType?: string;
}

/** Parse tool arguments into a raw object for compact summary extraction. */
function getToolArgsObject(tc: ToolCall): Record<string, unknown> | null {
    const direct = tc?.arguments || tc?.function?.arguments || tc?.input;
    if (direct && typeof direct === 'object') return direct as Record<string, unknown>;
    if (typeof direct === 'string' && direct.trim()) {
        try { return JSON.parse(direct) as Record<string, unknown>; } catch { return null; }
    }
    const json = tc?.argumentsJson;
    if (typeof json === 'string' && json.trim()) {
        try { return JSON.parse(json) as Record<string, unknown>; } catch { return null; }
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
    const hunkPattern = /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/g;
    const hunks: RegExpExecArray[] = [];
    let match: RegExpExecArray | null;
    while ((match = hunkPattern.exec(result)) !== null) {
        hunks.push(match);
    }
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
function buildCompactToolSummary(tc: ToolCall, commandIndex?: Map<string, string>): CompactToolSummary {
    const name = (tc.name || tc.toolName || tc.function?.name || '').toLowerCase();
    const args = getToolArgsObject(tc);
    const result = extractToolResult(tc);
    const argsRecord = args || {} as Record<string, unknown>;

    // ── Complete tool mapping from Antigravity SDK CortexStepType ──
    // Handles both snake_case (gRPC/trajectory) and camelCase (SDK) variants.
    switch (name) {

        // ── Search tools ────────────────────────────────────────────────
        case 'grep_search':
        case 'grepsearch': {
            const query = (argsRecord.Query as string) || '';
            // Show scope if searching a specific path (not project root)
            const searchPath = argsRecord.SearchPath as string | undefined;
            const scope = searchPath && !searchPath.endsWith('/')
                ? ` in ${fileBasename(searchPath)}`
                : '';
            return { icon: '🔍', label: 'Searched', subject: query + scope, resultBrief: extractResultCount(result) };
        }
        case 'find_by_name':
        case 'findbyname': {
            const pattern = (argsRecord.Pattern as string) || '';
            const searchDir = argsRecord.SearchDirectory as string | undefined;
            const dir = searchDir ? ` in ${fileBasename(searchDir)}` : '';
            return { icon: '🔍', label: 'Searched', subject: pattern + dir, resultBrief: extractResultCount(result) };
        }
        case 'codebase_search':
        case 'codebasesearch':
            return { icon: '🔍', label: 'Searched', subject: (argsRecord.query as string) || (argsRecord.Query as string) || '', resultBrief: extractResultCount(result) };
        case 'search_web':
        case 'searchweb':
            return { icon: '🌐', label: 'Web searched', subject: (argsRecord.query as string) || '', resultBrief: '' };

        // ── File viewing tools ──────────────────────────────────────────
        case 'view_file':
        case 'viewfile': {
            const fp = (argsRecord.AbsolutePath as string) || (argsRecord.path as string) || '';
            const s = argsRecord.StartLine;
            const e = argsRecord.EndLine;
            const range = s && e ? `#L${s}-${e}` : s ? `#L${s}` : '';
            // Extract total lines from result if available
            const linesBrief = extractBriefStatus(result, [/Total Lines:\s*(\d+)/i]);
            return {
                icon: '📄',
                label: 'Analyzed',
                subject: `${fileBasename(fp)} ${range}`.trim(),
                resultBrief: linesBrief ? `${linesBrief} lines` : '',
            };
        }
        case 'view_file_outline':
        case 'viewfileoutline':
            return { icon: '📄', label: 'Viewed outline', subject: fileBasename((argsRecord.AbsolutePath as string) || (argsRecord.path as string) || ''), resultBrief: '' };
        case 'view_code_item':
        case 'viewcodeitem': {
            const sym = (argsRecord.node_identifier as string) || (argsRecord.symbol as string) || '';
            const fileArg = argsRecord.file as string | undefined;
            const file = fileArg ? fileBasename(fileArg) : '';
            const subj = file ? `${sym} in ${file}` : sym;
            return { icon: '📄', label: 'Viewed symbol', subject: subj, resultBrief: '' };
        }
        case 'view_content_chunk':
            return { icon: '📄', label: 'Read chunk', subject: `#${(argsRecord.position as number) ?? '?'}`, resultBrief: '' };
        case 'read_url_content':
        case 'readurlcontent':
            return { icon: '🌐', label: 'Read URL', subject: ((argsRecord.Url as string) || '').replace(/^https?:\/\//, '').slice(0, 60), resultBrief: '' };

        // ── File modification tools ─────────────────────────────────────
        case 'write_to_file':
        case 'writetofile': {
            const fn = fileBasename((argsRecord.TargetFile as string) || '');
            const desc = argsRecord.Description;
            const isArtifact = !!(argsRecord.IsArtifact || argsRecord.isArtifact);
            const artifactMeta = (argsRecord.ArtifactMetadata || argsRecord.artifactMetadata || {}) as Record<string, unknown>;
            const artifactType = isArtifact && typeof artifactMeta.ArtifactType === 'string' ? artifactMeta.ArtifactType : undefined;
            const artifactIcon = artifactType === 'implementation_plan' ? '📋'
                : artifactType === 'walkthrough' ? '📝'
                : artifactType === 'task' ? '✅'
                : isArtifact ? '📄' : '📝';
            // For artifacts, embed the CodeContent inline in the trajectory
            const codeContent = isArtifact ? (argsRecord.CodeContent as string | undefined) : undefined;
            return {
                icon: artifactIcon,
                label: isArtifact ? 'Artifact' : 'Created',
                subject: fn,
                resultBrief: typeof desc === 'string' ? desc.slice(0, 60) : '',
                artifactContent: codeContent || undefined,
                artifactType,
            };
        }
        case 'replace_file_content':
        case 'multi_replace_file_content':
        case 'writecascadeedit':
        case 'write_cascade_edit': {
            const fn = fileBasename((argsRecord.TargetFile as string) || (argsRecord.file as string) || '');
            const desc = argsRecord.Description;
            const { diffText, stats } = extractDiffFromResult(result);
            const briefParts: string[] = [];
            if (stats) briefParts.push(stats);
            if (typeof desc === 'string') briefParts.push(desc.slice(0, 60));
            return {
                icon: '✏️',
                label: 'Edited',
                subject: fn,
                resultBrief: briefParts.join(' · '),
                resultPreview: diffText || undefined,
            };
        }
        case 'propose_code':
        case 'proposecode':
            return { icon: '✏️', label: 'Proposed edit', subject: fileBasename((argsRecord.TargetFile as string) || (argsRecord.file as string) || ''), resultBrief: '' };

        // ── Terminal / command tools ─────────────────────────────────────
        case 'run_command':
        case 'runcommand': {
            const cmdLine = String(argsRecord.CommandLine || argsRecord.command || '');
            const isShort = cmdLine.length <= 60 && !cmdLine.includes('\n');
            const exitBrief = extractBriefStatus(result, [
                /exit code[:\s]+(\d+)/i,
                /completed successfully/i,
                /command failed/i,
            ]);
            const resultSummary = extractCommandResultBrief(cmdLine, result, exitBrief);
            return {
                icon: '▶️',
                label: 'Ran command',
                subject: isShort ? cmdLine : '',
                resultBrief: resultSummary,
                codePreview: isShort ? undefined : (cmdLine || undefined),
            };
        }
        case 'shell_exec':
        case 'shellexec':
            return { icon: '▶️', label: 'Ran shell', subject: '', resultBrief: '', codePreview: (argsRecord.command as string) || (argsRecord.CommandLine as string) || undefined };
        case 'command_status': {
            const statusBrief = extractBriefStatus(result, [/status[:\s]+"?(running|done|completed)"?/i]);
            const commandId = argsRecord.CommandId as string | undefined;
            // Resolve actual command line from the index
            const resolvedCmd = commandId && commandIndex?.get(commandId);
            let cmdSubject = '';
            if (resolvedCmd) {
                // Show a short version of the actual command
                const shortCmd = resolvedCmd.length > 50 ? resolvedCmd.slice(0, 47) + '...' : resolvedCmd;
                cmdSubject = shortCmd;
            } else if (commandId) {
                cmdSubject = `#${commandId.slice(0, 8)}`;
            }
            return { icon: '▶️', label: 'Checked command', subject: cmdSubject, resultBrief: statusBrief };
        }
        case 'send_command_input':
        case 'sendcommandinput': {
            const inputVal = argsRecord.Input as string | undefined;
            const inputPreview = inputVal ? inputVal.trim().slice(0, 40) : '';
            return { icon: '▶️', label: 'Sent input', subject: inputPreview, resultBrief: '' };
        }
        case 'read_terminal':
        case 'readterminal':
            return { icon: '▶️', label: 'Read terminal', subject: (argsRecord.Name as string) || '', resultBrief: '' };

        // ── Directory tools ─────────────────────────────────────────────
        case 'list_dir':
        case 'list_directory':
        case 'listdirectory': {
            const dirPath = (argsRecord.DirectoryPath as string) || (argsRecord.path as string) || '';
            const dirSubject = shortenPath(dirPath);
            // Try to extract entry count from result
            const entryCount = extractBriefStatus(result, [/(\d+)\s+(?:children|entries|items|files)/i]);
            return { icon: '📁', label: 'Listed', subject: dirSubject, resultBrief: entryCount ? `${entryCount} entries` : '' };
        }

        // ── Browser tools ───────────────────────────────────────────────
        case 'open_browser_url':
        case 'openbrowserurl':
            return { icon: '🌐', label: 'Opened browser', subject: ((argsRecord.url as string) || '').replace(/^https?:\/\//, '').slice(0, 60), resultBrief: '' };
        case 'read_browser_page':
        case 'readbrowserpage': {
            const url = argsRecord.url as string | undefined;
            return { icon: '🌐', label: 'Read browser page', subject: url ? url.replace(/^https?:\/\//, '').slice(0, 50) : '', resultBrief: '' };
        }
        case 'list_browser_pages':
        case 'listbrowserpages': {
            const pageCt = extractBriefStatus(result, [/(\d+)\s+pages?/i]);
            return { icon: '🌐', label: 'Listed browser pages', subject: '', resultBrief: pageCt ? `${pageCt} pages` : '' };
        }

        // ── Agent / MCP tools ───────────────────────────────────────────
        case 'mcp_tool':
        case 'mcptool': {
            const server = (argsRecord.server as string) || (argsRecord.ServerName as string) || '';
            const tool = (argsRecord.tool as string) || (argsRecord.toolName as string) || (argsRecord.name as string) || '';
            const mcpSubj = server ? `${server}:${tool}` : tool;
            return { icon: '🔌', label: 'MCP tool', subject: mcpSubj, resultBrief: '' };
        }
        case 'invoke_subagent':
        case 'invokesubagent':
            return { icon: '🤖', label: 'Invoked subagent', subject: (argsRecord.agent as string) || (argsRecord.name as string) || '', resultBrief: '' };

        // ── Memory / Knowledge tools ────────────────────────────────────
        case 'memory':
            return { icon: '🧠', label: 'Memory', subject: (argsRecord.action as string) || '', resultBrief: '' };
        case 'knowledge_generation':
        case 'knowledgegeneration':
            return { icon: '🧠', label: 'Generated knowledge', subject: '', resultBrief: '' };

        // ── Miscellaneous ───────────────────────────────────────────────
        case 'generate_image': {
            const prompt = argsRecord.Prompt as string | undefined;
            return { icon: '🖼️', label: 'Generated image', subject: (argsRecord.ImageName as string) || (prompt?.slice(0, 40) || ''), resultBrief: '' };
        }
        case 'read_resource':
            return { icon: '📦', label: 'Read resource', subject: (argsRecord.Uri as string) || '', resultBrief: '' };
        case 'wait': {
            const duration = argsRecord.duration as number | undefined;
            return { icon: '⏱️', label: 'Waiting', subject: duration ? `${duration}ms` : '', resultBrief: '' };
        }
        case 'task_boundary':
        case 'taskboundary':
            return { icon: '📋', label: 'Task', subject: (argsRecord.TaskName as string) || '', resultBrief: (argsRecord.TaskStatus as string) || '' };
        case 'notify_user':
        case 'notifyuser':
            return { icon: '🔔', label: 'Notified user', subject: '', resultBrief: '' };

        default: {
            // Handle MCP server tools: mcp_<server>_<tool> → "MCP: <tool>"
            if (name.startsWith('mcp_')) {
                const parts = name.split('_');
                const serverPart = parts.length > 2 ? parts[1] : '';
                const toolPart = parts.length > 2 ? parts.slice(2).join('_') : parts.slice(1).join('_');
                return { icon: '🔌', label: 'MCP', subject: serverPart ? `${serverPart}:${toolPart}` : toolPart, resultBrief: '' };
            }
            return { icon: '🔧', label: name || 'unknown', subject: '', resultBrief: '' };
        }
    }
}

/**
 * Extract tool call result/output. No truncation — the caller wraps
 * long content in expandable blockquotes.
 */
function extractToolResult(tc: ToolCall): string | null {
    const res = tc?.result ?? tc?.output ?? tc?.toolCallResult;
    if (res == null) return null;
    if (typeof res === 'string') return res;
    if (typeof res === 'object') {
        // Handle common payload keys from the new SDK structure
        const resObj = res as Record<string, unknown>;
        if (typeof resObj.summary === 'string') return resObj.summary;
        if (typeof resObj.output === 'string') return resObj.output;
        if (typeof resObj.result === 'string') return resObj.result;
        return JSON.stringify(res, null, 2);
    }
    return String(res);
}

// ---------------------------------------------------------------------------
// Markdown → Telegram HTML
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CJK-aware display width (monospace terminal column width)
// ---------------------------------------------------------------------------

/**
 * Get the display width of a string in a monospace font.
 * CJK characters, fullwidth forms, and some symbols occupy 2 columns;
 * everything else occupies 1 column.
 */
function displayWidth(str: string): number {
    let width = 0;
    for (const ch of str) {
        const cp = ch.codePointAt(0)!;
        width += isWideChar(cp) ? 2 : 1;
    }
    return width;
}

/** Pad a string to a target *display* width with spaces. */
function padEndDisplay(str: string, targetWidth: number): string {
    const diff = targetWidth - displayWidth(str);
    return diff > 0 ? str + ' '.repeat(diff) : str;
}

/**
 * Check whether a Unicode code point is a "wide" character (occupies 2
 * columns in a monospace / terminal context).
 *
 * Covers: CJK Unified Ideographs, CJK Extension A/B, CJK Compatibility
 * Ideographs, Hangul Syllables, Fullwidth Forms, some CJK symbols, and
 * common emoji ranges.
 */
function isWideChar(cp: number): boolean {
    return (
        // CJK Radicals Supplement .. Ideographic Description Characters
        (cp >= 0x2E80 && cp <= 0x2FFF) ||
        // CJK Symbols and Punctuation, Hiragana, Katakana, Bopomofo, etc.
        (cp >= 0x3000 && cp <= 0x303F) ||
        (cp >= 0x3040 && cp <= 0x309F) ||
        (cp >= 0x30A0 && cp <= 0x30FF) ||
        (cp >= 0x3100 && cp <= 0x312F) ||
        (cp >= 0x3130 && cp <= 0x318F) ||
        (cp >= 0x3190 && cp <= 0x31FF) ||
        (cp >= 0x3200 && cp <= 0x33FF) ||
        // CJK Unified Ideographs Extension A
        (cp >= 0x3400 && cp <= 0x4DBF) ||
        // CJK Unified Ideographs
        (cp >= 0x4E00 && cp <= 0x9FFF) ||
        // Hangul Syllables
        (cp >= 0xAC00 && cp <= 0xD7AF) ||
        // CJK Compatibility Ideographs
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        // Fullwidth Forms
        (cp >= 0xFF01 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||
        // CJK Unified Ideographs Extension B+
        (cp >= 0x20000 && cp <= 0x2FA1F) ||
        // Common emoji ranges (most render as wide in monospace)
        (cp >= 0x1F300 && cp <= 0x1F9FF)
    );
}

// ---------------------------------------------------------------------------
// Markdown table → <pre> conversion (Telegram has no table support)
// ---------------------------------------------------------------------------

/** Detect whether a line looks like a markdown table separator (| --- | --- |). */
function isTableSeparatorLine(line: string): boolean {
    return /^\|?[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)+\|?\s*$/.test(line.trim());
}

/** Detect whether a line looks like a markdown table row (| x | y |). */
function isTableRowLine(line: string): boolean {
    const trimmed = line.trim();
    // Must contain at least one pipe that isn't at the very start/end only
    return trimmed.includes('|') && /\|/.test(trimmed);
}

/** Parse a markdown table row into cells. */
function parseTableRow(line: string): string[] {
    let trimmed = line.trim();
    // Remove leading/trailing pipes
    if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
    if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
    return trimmed.split('|').map(c => c.trim());
}

/**
 * Convert markdown tables in the input to `<pre>` blocks with aligned columns.
 * Uses CJK-aware display width for proper alignment.
 * Non-table content passes through unchanged.
 */
function convertMarkdownTables(text: string): string {
    const lines = text.split('\n');
    const output: string[] = [];
    let i = 0;

    while (i < lines.length) {
        // Look for table start: a row line followed by a separator line
        if (
            i + 1 < lines.length &&
            isTableRowLine(lines[i]) &&
            isTableSeparatorLine(lines[i + 1])
        ) {
            // Collect all table rows
            const tableLines: string[] = [lines[i]]; // header
            let j = i + 2; // skip separator
            while (j < lines.length && isTableRowLine(lines[j]) && !isTableSeparatorLine(lines[j])) {
                tableLines.push(lines[j]);
                j++;
            }

            // Parse into cells
            const parsed = tableLines.map(parseTableRow);

            // Calculate max column *display* widths (CJK-aware)
            const colCount = Math.max(...parsed.map(r => r.length));
            const colWidths: number[] = new Array(colCount).fill(0);
            for (const row of parsed) {
                for (let c = 0; c < colCount; c++) {
                    colWidths[c] = Math.max(colWidths[c], displayWidth(row[c] || ''));
                }
            }

            // Render aligned table using display-width padding
            const renderedRows: string[] = [];
            for (let ri = 0; ri < parsed.length; ri++) {
                const row = parsed[ri];
                const cells = [];
                for (let c = 0; c < colCount; c++) {
                    cells.push(padEndDisplay(row[c] || '', colWidths[c]));
                }
                renderedRows.push(cells.join(' │ '));

                // After header, add a separator
                if (ri === 0) {
                    renderedRows.push(colWidths.map(w => '─'.repeat(w)).join('─┼─'));
                }
            }

            output.push(`<pre>${escapeHtml(renderedRows.join('\n'))}</pre>`);
            i = j;
        } else {
            output.push(lines[i]);
            i++;
        }
    }

    return output.join('\n');
}

// ---------------------------------------------------------------------------
// <details>/<summary> → <blockquote expandable> conversion
// ---------------------------------------------------------------------------

/**
 * Convert HTML `<details>/<summary>` blocks into Telegram `<blockquote expandable>`.
 * The summary text becomes a bold header line above the expandable blockquote.
 */
function convertDetailsBlocks(text: string): string {
    // Match <details> ... <summary>Title</summary> ... content ... </details>
    return text.replace(
        /<details>\s*(?:\n\s*)?<summary>([\s\S]*?)<\/summary>\s*(?:\n)?((?:[\s\S]*?))<\/details>/gi,
        (_m, summary: string, content: string) => {
            const title = summary.trim();
            const body = content.trim();
            if (!body) return `<b>${title}</b>`;
            return `<b>${title}</b>\n<blockquote expandable>${body}</blockquote>`;
        },
    );
}

// ---------------------------------------------------------------------------
// GitHub-style alerts (> [!NOTE], > [!WARNING], etc.)
// ---------------------------------------------------------------------------

/** Alert type → emoji mapping. */
const ALERT_ICONS: Record<string, string> = {
    NOTE: 'ℹ️',
    TIP: '💡',
    IMPORTANT: '❗',
    WARNING: '⚠️',
    CAUTION: '🚨',
};

/**
 * Convert GitHub-style alert blockquotes into Telegram blockquotes with
 * emoji-prefixed headers.
 *
 * Input:
 *   > [!NOTE]
 *   > Some note content here.
 *
 * Output (Telegram HTML after further processing):
 *   <blockquote>ℹ️ <b>NOTE</b>
 *   Some note content here.</blockquote>
 */
function convertGitHubAlerts(text: string): string {
    // Pattern: lines starting with > [!TYPE] followed by subsequent > lines
    return text.replace(
        /^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n((?:>[ \t]?.*(?:\n|$))*)/gim,
        (_m, type: string, body: string) => {
            const icon = ALERT_ICONS[type.toUpperCase()] || 'ℹ️';
            // Strip leading '> ' from each body line
            const bodyText = body
                .split('\n')
                .map(l => l.replace(/^>\s?/, ''))
                .join('\n')
                .trim();
            const header = `> ${icon} **${type}**`;
            if (!bodyText) return header;
            // Re-wrap in blockquote syntax so the normal blockquote processing picks it up
            const rewrapped = bodyText.split('\n').map(l => `> ${l}`).join('\n');
            return `${header}\n${rewrapped}`;
        },
    );
}

/**
 * Lightweight Markdown to Telegram HTML converter.
 *
 * Handles: bold, italic, strikethrough, inline code, code blocks,
 * links, headers, lists (ordered + unordered), blockquotes, tables.
 *
 * No external dependencies. Designed for the subset of Markdown
 * typically found in AI assistant responses.
 */
export function markdownToTelegramHtml(md: string): string {
    if (!md) return '';

    let result = md;

    // Normalize line endings
    result = result.replace(/\r\n/g, '\n');

    // HTML <details>/<summary> → Telegram <blockquote expandable>
    // Must run BEFORE HTML escaping since it processes raw HTML tags
    result = convertDetailsBlocks(result);

    // GitHub-style alerts (> [!NOTE], > [!WARNING], etc.)
    // Must run BEFORE blockquote processing to inject emoji headers
    result = convertGitHubAlerts(result);

    // Fenced code blocks (``` ... ```) — must be processed BEFORE inline escaping
    result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
        return `<pre>${escapeHtml(code.trimEnd())}</pre>`;
    });

    // Markdown tables → <pre> blocks (must be processed BEFORE line-by-line)
    result = convertMarkdownTables(result);

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
    steps: TrajectoryStep[],
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
        const metaParts: string[] = [];
        if (opts.modeName) metaParts.push(opts.modeName);
        if (opts.modelName) metaParts.push(opts.modelName);
        const metaSuffix = metaParts.length > 0 ? ' ' + metaParts.join(' | ') : '';
        fragments.push(`*● Generating…*${metaSuffix}`);
    }

    return fragments.join('\n\n').trim();
}

function renderDiscordStep(step: TrajectoryStep, opts: Required<StepRenderOptions>): string | null {
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

                let card = `${statusIcon}${summary.icon}`;
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
