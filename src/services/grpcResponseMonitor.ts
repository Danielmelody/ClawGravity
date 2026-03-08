/**
 * GrpcResponseMonitor — LS-based response monitoring with logic for both
 * streaming (ideal) and polling (fallback).
 *
 * Replaces polling-only monitor with a hybrid approach that tries streaming
 * first, but reverts to polling if the server returns protocol errors or
 * fails to emit activity.
 *
 * Completely headless — no DOM, no CDP, no UI dependency.
 */

import path from 'path';
import { logger } from '../utils/logger';
import { GrpcCascadeClient, CascadeStreamEvent } from './grpcCascadeClient';

const RESERVED_STEP_KEYS = new Set([
    'type',
    'status',
    'metadata',
    'plannerResponse',
    'assistantResponse',
    'userInput',
    'conversationHistory',
    'ephemeralMessage',
    'checkpoint',
    'error',
]);

const PAYLOAD_DETAIL_KEYS = [
    'query',
    'pattern',
    'searchType',
    'searchDirectory',
    'searchPathUri',
    'absolutePathUri',
    'relativePath',
    'absolutePath',
    'userErrorMessage',
];

function tryParseJsonObject(json: string | undefined): Record<string, unknown> | null {
    if (!json) return null;
    try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function trimDisplayValue(value: string, maxLength: number = 120): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatScalar(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^file:\/\//i.test(trimmed)) {
        return trimDisplayValue(path.basename(trimmed.replace(/^file:\/\/\/?/i, '')));
    }

    if (/^[a-z]:[\\/]/i.test(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
        return trimDisplayValue(path.basename(trimmed));
    }

    return trimDisplayValue(trimmed);
}

function formatKeyValue(key: string, value: unknown): string | null {
    const formatted = formatScalar(value);
    if (!formatted) return null;

    switch (key) {
        case 'query':
            return `query=${formatted}`;
        case 'pattern':
            return `pattern=${formatted}`;
        case 'searchType':
            return `type=${formatted}`;
        case 'searchDirectory':
            return `dir=${formatted}`;
        case 'searchPathUri':
        case 'absolutePathUri':
        case 'absolutePath':
        case 'relativePath':
            return `path=${formatted}`;
        case 'userErrorMessage':
            return formatted;
        default:
            return `${key}=${formatted}`;
    }
}

function getObjectValue(source: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
    if (!source) return null;

    for (const key of keys) {
        if (key in source) return source[key];
        const found = Object.keys(source).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
        if (found) return source[found];
    }

    return null;
}

function getResultCount(payload: Record<string, unknown> | null): number | null {
    if (!payload) return null;
    const direct = getObjectValue(payload, 'totalResults', 'truncatedTotalResults');
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    const results = getObjectValue(payload, 'results');
    return Array.isArray(results) ? results.length : null;
}

function getLineRangeLabel(source: Record<string, unknown> | null): string | null {
    if (!source) return null;

    const start = getObjectValue(source, 'startLine', 'StartLine');
    const end = getObjectValue(source, 'endLine', 'EndLine');
    if (typeof start === 'number' && typeof end === 'number') {
        return start === end ? `line ${start}` : `lines ${start}-${end}`;
    }
    return null;
}

function quoteValue(value: unknown): string | null {
    const formatted = formatScalar(value);
    return formatted ? `"${formatted}"` : null;
}

function joinSummaryParts(parts: Array<string | null | undefined>): string {
    return parts.filter((part): part is string => Boolean(part && part.trim())).join(' ');
}

function extractPayloadObject(step: any): Record<string, unknown> | null {
    for (const key of Object.keys(step || {})) {
        if (RESERVED_STEP_KEYS.has(key)) continue;
        const value = step?.[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GrpcResponsePhase =
    | 'waiting'
    | 'thinking'
    | 'generating'
    | 'complete'
    | 'timeout'
    | 'quotaReached'
    | 'error';

export interface GrpcResponseMonitorOptions {
    /** The gRPC client to use */
    grpcClient: GrpcCascadeClient;
    /** The cascade ID to monitor */
    cascadeId: string;
    /** Max monitoring duration in ms (default: 300000 = 5 min) */
    maxDurationMs?: number;

    // Callbacks (matching ResponseMonitor interface)
    onProgress?: (text: string) => void;
    onComplete?: (finalText: string) => void;
    onTimeout?: (lastText: string) => void;
    onPhaseChange?: (phase: GrpcResponsePhase, text: string | null) => void;
    onProcessLog?: (text: string) => void;
}

// ---------------------------------------------------------------------------
// GrpcResponseMonitor
// ---------------------------------------------------------------------------

export class GrpcResponseMonitor {
    private readonly client: GrpcCascadeClient;
    private readonly cascadeId: string;
    private readonly maxDurationMs: number;

    private readonly onProgress?: (text: string) => void;
    private readonly onComplete?: (finalText: string) => void;
    private readonly onTimeout?: (lastText: string) => void;
    private readonly onPhaseChange?: (phase: GrpcResponsePhase, text: string | null) => void;
    private readonly onProcessLog?: (text: string) => void;

    private isRunning = false;
    private currentPhase: GrpcResponsePhase = 'waiting';
    private lastResponseText: string | null = null;
    private lastThinkingText: string | null = null;
    private readonly emittedPlannedToolIds = new Set<string>();
    private readonly emittedStepActivityKeys = new Set<string>();
    private hasSeenActivity = false;
    private startTime = 0;
    private mode: 'stream' | 'poll' = 'stream';

    // Stream state
    private abortController: AbortController | null = null;
    private streamDataListener: ((evt: CascadeStreamEvent) => void) | null = null;
    private streamCompleteListener: (() => void) | null = null;
    private streamErrorListener: ((err: any) => void) | null = null;

    // Poll state
    private pollTimer: NodeJS.Timeout | null = null;
    private lastKnownStepCount = 0;

    // Global timers
    private safetyTimer: NodeJS.Timeout | null = null;

    constructor(options: GrpcResponseMonitorOptions) {
        this.client = options.grpcClient;
        this.cascadeId = options.cascadeId;
        this.maxDurationMs = options.maxDurationMs ?? 300_000;

        this.onProgress = options.onProgress;
        this.onComplete = options.onComplete;
        this.onTimeout = options.onTimeout;
        this.onPhaseChange = options.onPhaseChange;
        this.onProcessLog = options.onProcessLog;
    }

    /** Start monitoring the cascade for AI response */
    async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.startTime = Date.now();
        this.lastResponseText = null;
        this.lastThinkingText = null;
        this.emittedPlannedToolIds.clear();
        this.emittedStepActivityKeys.clear();
        this.hasSeenActivity = false;
        this.lastKnownStepCount = 0;

        this.setPhase('waiting', null);

        // Safety timeout
        this.safetyTimer = setTimeout(() => {
            if (this.isRunning) {
                logger.warn(`[GrpcMonitor] Timeout after ${Math.round((Date.now() - this.startTime) / 1000)}s`);
                this.setPhase('timeout', this.lastResponseText);
                this.stop().catch(() => { });
                this.onTimeout?.(this.lastResponseText ?? '');
            }
        }, this.maxDurationMs);

        // Try streaming first
        this.initStream();
    }

    /** Start in passive mode (same logic as start) */
    async startPassive(): Promise<void> {
        this.start();
    }

    /** Stop monitoring */
    async stop(): Promise<void> {
        this.isRunning = false;

        if (this.safetyTimer) {
            clearTimeout(this.safetyTimer);
            this.safetyTimer = null;
        }

        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        this.removeStreamListeners();
    }

    /** Whether monitoring is active */
    isActive(): boolean {
        return this.isRunning;
    }

    /** Get current phase */
    getPhase(): GrpcResponsePhase {
        return this.currentPhase;
    }

    /** Get last extracted response text */
    getLastText(): string | null {
        return this.lastResponseText;
    }

    // ─── Stream Implementation ──────────────────────────────────────

    private initStream(): void {
        this.mode = 'stream';

        // Bind listeners
        this.streamDataListener = (evt) => this.handleStreamData(evt);
        this.streamCompleteListener = () => this.handleStreamComplete();
        this.streamErrorListener = (err) => this.handleStreamError(err);

        this.client.on('data', this.streamDataListener);
        this.client.on('complete', this.streamCompleteListener);
        this.client.on('error', this.streamErrorListener);

        logger.info(`[GrpcMonitor] Attempting stream | cascade=${this.cascadeId.slice(0, 12)}...`);

        try {
            this.abortController = this.client.streamCascadeUpdates(this.cascadeId);
        } catch (err: any) {
            logger.warn(`[GrpcMonitor] Failed to open stream: ${err.message}. Switching to poll.`);
            this.switchToPolling();
        }
    }

    private removeStreamListeners(): void {
        if (this.streamDataListener) {
            this.client.off('data', this.streamDataListener);
            this.streamDataListener = null;
        }
        if (this.streamCompleteListener) {
            this.client.off('complete', this.streamCompleteListener);
            this.streamCompleteListener = null;
        }
        if (this.streamErrorListener) {
            this.client.off('error', this.streamErrorListener);
            this.streamErrorListener = null;
        }
    }

    private handleStreamData(evt: CascadeStreamEvent): void {
        if (!this.isRunning || this.mode !== 'stream') return;

        this.emitThinkingDetailsFromPayload(evt.raw?.result ?? evt.raw);
        this.emitPlannedToolCalls(evt.raw?.result?.plannerResponse?.toolCalls);

        if (evt.type === 'error') {
            const msg = evt.text || 'Unknown stream payload error';
            logger.warn(`[GrpcMonitor] Stream payload error: ${msg.slice(0, 100)}. Switching to poll.`);
            this.switchToPolling();
            return;
        }

        if (evt.type === 'text') {
            const text = evt.text || '';
            const trimmed = text.trim();
            if (/^thought for\s+\d+/i.test(trimmed)) {
                this.hasSeenActivity = true;
                this.onProcessLog?.(`🧠 ${trimmed}`);
                return;
            }

            if (text !== this.lastResponseText) {
                this.lastResponseText = text;
                this.hasSeenActivity = true;
                if (this.currentPhase === 'thinking' || this.currentPhase === 'waiting') {
                    this.setPhase('generating', text);
                }
                this.onProgress?.(text);
            }
        } else if (evt.type === 'tool_call') {
            const toolName = evt.raw?.result?.toolCall?.name || 'tool';
            this.hasSeenActivity = true;
            this.onProcessLog?.(`🔧 ${toolName}`);
        } else if (evt.type === 'status') {
            const status = evt.text || '';
            if (status === 'CASCADE_RUN_STATUS_IDLE') {
                if (this.hasSeenActivity) {
                    this.finishSuccessfully();
                }
            } else if (status === 'CASCADE_RUN_STATUS_RUNNING') {
                this.hasSeenActivity = true;
                if (this.currentPhase === 'waiting') {
                    this.setPhase('thinking', null);
                }
            }
        }
    }

    private handleStreamComplete(): void {
        if (!this.isRunning || this.mode !== 'stream') return;

        // If the stream ended without activity, it might be the protocol error
        if (!this.hasSeenActivity) {
            logger.warn(`[GrpcMonitor] Stream closed early with no activity. Switching to poll.`);
            this.switchToPolling();
            return;
        }

        this.finishSuccessfully();
    }

    private handleStreamError(err: any): void {
        if (!this.isRunning || this.mode !== 'stream') return;

        const msg = err?.message || String(err);
        logger.warn(`[GrpcMonitor] Stream error: ${msg.slice(0, 100)}. Switching to poll.`);
        this.switchToPolling();
    }

    // ─── Polling Implementation ──────────────────────────────────────

    private switchToPolling(): void {
        if (this.mode === 'poll') return;
        this.mode = 'poll';

        // Clean up stream
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.removeStreamListeners();

        logger.info(`[GrpcMonitor] Polling fallback active | cascade=${this.cascadeId.slice(0, 12)}...`);

        // Immediate first poll, then interval
        this.pollOnce();
        this.pollTimer = setInterval(() => this.pollOnce(), 1500);
    }

    private async pollOnce(): Promise<void> {
        if (!this.isRunning || this.mode !== 'poll') return;

        try {
            const traj = await this.client.rawRPC('GetCascadeTrajectory', { cascadeId: this.cascadeId });
            if (!traj || !this.isRunning) return;

            const steps = traj?.trajectory?.steps || [];
            const cascadeStatus = traj?.trajectory?.cascadeRunStatus || traj?.status || '';

            // Update activity state
            if (cascadeStatus === 'CASCADE_RUN_STATUS_RUNNING' && !this.hasSeenActivity) {
                this.hasSeenActivity = true;
                this.setPhase('thinking', null);
            }

            // Extract assistant text
            let lastAssistantText: string | null = null;
            let lastUserIdx = -1;
            for (let i = steps.length - 1; i >= 0; i--) {
                if (steps[i].type === 'CORTEX_STEP_TYPE_USER_INPUT') {
                    lastUserIdx = i;
                    break;
                }
            }

            if (lastUserIdx >= 0) {
                for (let i = lastUserIdx + 1; i < steps.length; i++) {
                    const step = steps[i];
                    this.emitThinkingDetails(step?.plannerResponse?.thinking);
                    this.emitPlannedToolCalls(step?.plannerResponse?.toolCalls);
                    this.emitStepActivity(step, i);

                    if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                        const text =
                            step.plannerResponse?.modifiedResponse
                            || step.plannerResponse?.response
                            || step.assistantResponse?.text
                            || '';
                        if (text) lastAssistantText = text;
                    } else if (step.type === 'CORTEX_STEP_TYPE_TOOL_CALL' || step.type === 'CORTEX_STEP_TYPE_MCP_TOOL') {
                        this.hasSeenActivity = true;
                        if (steps.length > this.lastKnownStepCount) {
                            const name = step.toolCall?.name || step.mcpTool?.name || 'tool';
                            this.onProcessLog?.(`🔧 ${name}`);
                        }
                    }
                }
            }

            this.lastKnownStepCount = steps.length;

            if (lastAssistantText && lastAssistantText !== this.lastResponseText) {
                this.lastResponseText = lastAssistantText;
                this.hasSeenActivity = true;
                if (this.currentPhase === 'thinking' || this.currentPhase === 'waiting') {
                    this.setPhase('generating', lastAssistantText);
                }
                this.onProgress?.(lastAssistantText);
            }

            // Finish if IDLE and we have activity
            if (cascadeStatus === 'CASCADE_RUN_STATUS_IDLE' && this.hasSeenActivity) {
                this.finishSuccessfully();
            }
        } catch (err: any) {
            const msg = err?.message || String(err);
            if (msg.includes('quota')) {
                this.setPhase('quotaReached', this.lastResponseText);
                this.stop().catch(() => { });
                this.onTimeout?.(this.lastResponseText ?? '');
                return;
            }
            logger.debug(`[GrpcMonitor] Poll error: ${msg.slice(0, 100)}`);
        }
    }

    // ─── Common Logic ──────────────────────────────────────────────

    private finishSuccessfully(): void {
        this.setPhase('complete', this.lastResponseText);
        const text = this.lastResponseText ?? '';
        this.stop().catch(() => { });
        this.onComplete?.(text);
    }

    private emitThinkingDetailsFromPayload(payload: any): void {
        this.emitThinkingDetails(
            payload?.plannerResponse?.thinking
            || payload?.step?.plannerResponse?.thinking
            || null,
        );
    }

    private emitThinkingDetails(thinking: unknown): void {
        if (typeof thinking !== 'string') return;

        const normalized = thinking.replace(/\r/g, '').trim();
        if (!normalized) return;

        let delta = normalized;
        if (this.lastThinkingText) {
            if (normalized === this.lastThinkingText) {
                return;
            }
            if (normalized.startsWith(this.lastThinkingText)) {
                delta = normalized.slice(this.lastThinkingText.length).trim();
            }
        }

        this.lastThinkingText = normalized;
        if (!delta) return;

        this.hasSeenActivity = true;
        if (this.currentPhase === 'waiting') {
            this.setPhase('thinking', null);
        }
        this.onProcessLog?.(delta);
    }

    private emitPlannedToolCalls(toolCalls: unknown): void {
        if (!Array.isArray(toolCalls)) return;

        for (const toolCall of toolCalls) {
            const id = typeof toolCall?.id === 'string'
                ? toolCall.id
                : JSON.stringify(toolCall);
            if (this.emittedPlannedToolIds.has(id)) continue;

            this.emittedPlannedToolIds.add(id);
            const summary = this.buildPlannedToolSummary(toolCall);
            if (!summary) continue;

            this.hasSeenActivity = true;
            if (this.currentPhase === 'waiting') {
                this.setPhase('thinking', null);
            }
            this.onProcessLog?.(summary);
        }
    }

    private emitStepActivity(step: any, stepIndex: number): void {
        if (!step?.metadata?.toolCall) return;

        const summary = this.buildStepActivitySummary(step);
        if (!summary) return;

        const key = `${stepIndex}:${step.status || 'unknown'}:${summary}`;
        if (this.emittedStepActivityKeys.has(key)) return;

        this.emittedStepActivityKeys.add(key);
        this.hasSeenActivity = true;
        if (this.currentPhase === 'waiting') {
            this.setPhase('thinking', null);
        }
        this.onProcessLog?.(summary);
    }

    private buildPlannedToolSummary(toolCall: any): string | null {
        const toolName = typeof toolCall?.name === 'string' ? toolCall.name : 'tool';
        const args = tryParseJsonObject(toolCall?.argumentsJson);
        const known = this.buildKnownToolSummary(toolName, args, null, 'planned');
        if (known) return known;

        const parts = this.collectArgumentParts(args);
        return parts.length > 0
            ? `🛠️ Tool ${toolName}: ${parts.join(' | ')}`
            : `🛠️ Tool ${toolName}`;
    }

    private buildStepActivitySummary(step: any): string | null {
        const toolName = step?.metadata?.toolCall?.name || step?.type || 'tool';
        const status = typeof step?.status === 'string' ? step.status : '';
        const payload = extractPayloadObject(step);
        const args = tryParseJsonObject(step?.metadata?.toolCall?.argumentsJson);

        if (status.includes('ERROR')) {
            const message = formatScalar(step?.error?.userErrorMessage)
                || formatScalar(step?.error?.shortError)
                || 'execution failed';
            const knownError = this.buildKnownToolSummary(toolName, args, payload, 'error', message);
            if (knownError) return knownError;
            return `❌ Tool ${toolName} failed: ${message}`;
        }

        const known = this.buildKnownToolSummary(toolName, args, payload, 'done');
        if (known) return known;

        const parts: string[] = [];
        parts.push(...this.collectArgumentParts(args));
        parts.push(...this.collectPayloadParts(payload));

        const dedupedParts = Array.from(new Set(parts.filter(Boolean)));
        return dedupedParts.length > 0
            ? `🛠️ Tool ${toolName}: ${dedupedParts.join(' | ')}`
            : `🛠️ Tool ${toolName}`;
    }

    private buildKnownToolSummary(
        toolName: string,
        args: Record<string, unknown> | null,
        payload: Record<string, unknown> | null,
        phase: 'planned' | 'done' | 'error',
        errorMessage?: string,
    ): string | null {
        const normalized = toolName.toLowerCase();
        const pathLabel = formatScalar(
            getObjectValue(payload, 'absolutePathUri', 'searchPathUri', 'absolutePath', 'relativePath')
            ?? getObjectValue(args, 'AbsolutePath', 'SearchPath', 'SearchDirectory'),
        );
        const queryLabel = quoteValue(getObjectValue(payload, 'query') ?? getObjectValue(args, 'Query'));
        const patternLabel = quoteValue(getObjectValue(payload, 'pattern') ?? getObjectValue(args, 'Pattern'));
        const lineLabel = getLineRangeLabel(payload) || getLineRangeLabel(args);
        const resultCount = getResultCount(payload);

        switch (normalized) {
            case 'grep_search':
                if (phase === 'error') {
                    return joinSummaryParts([
                        '❌ Search failed',
                        queryLabel ? `for ${queryLabel}` : '',
                        pathLabel ? `in ${pathLabel}` : '',
                        errorMessage ? `- ${errorMessage}` : '',
                    ]);
                }
                if (phase === 'planned') {
                    return joinSummaryParts([
                        '🔎 Searching',
                        queryLabel ? `for ${queryLabel}` : '',
                        pathLabel ? `in ${pathLabel}` : '',
                    ]);
                }
                return joinSummaryParts([
                    resultCount !== null ? `🔎 Found ${resultCount} matches` : '🔎 Search complete',
                    queryLabel ? `for ${queryLabel}` : '',
                    pathLabel ? `in ${pathLabel}` : '',
                ]);

            case 'find_by_name':
                if (phase === 'error') {
                    return joinSummaryParts([
                        '❌ File search failed',
                        patternLabel ? `for ${patternLabel}` : '',
                        pathLabel ? `in ${pathLabel}` : '',
                        errorMessage ? `- ${errorMessage}` : '',
                    ]);
                }
                if (phase === 'planned') {
                    return joinSummaryParts([
                        '📂 Finding files',
                        patternLabel ? `matching ${patternLabel}` : '',
                        pathLabel ? `in ${pathLabel}` : '',
                    ]);
                }
                return joinSummaryParts([
                    resultCount !== null ? `📂 Found ${resultCount} files` : '📂 File search complete',
                    patternLabel ? `matching ${patternLabel}` : '',
                    pathLabel ? `in ${pathLabel}` : '',
                ]);

            case 'view_file':
            case 'read_file':
                if (phase === 'error') {
                    return joinSummaryParts([
                        '❌ File read failed',
                        pathLabel || '',
                        lineLabel || '',
                        errorMessage ? `- ${errorMessage}` : '',
                    ]);
                }
                if (phase === 'planned') {
                    return joinSummaryParts([
                        '📄 Opening',
                        pathLabel || 'file',
                        lineLabel || '',
                    ]);
                }
                return joinSummaryParts([
                    '📄 Read',
                    pathLabel || 'file',
                    lineLabel || '',
                ]);

            case 'search_web':
                if (phase === 'error') {
                    return joinSummaryParts([
                        '❌ Web search failed',
                        queryLabel ? `for ${queryLabel}` : '',
                        errorMessage ? `- ${errorMessage}` : '',
                    ]);
                }
                if (phase === 'planned') {
                    return joinSummaryParts([
                        '🌐 Searching the web',
                        queryLabel ? `for ${queryLabel}` : '',
                    ]);
                }
                return joinSummaryParts([
                    resultCount !== null ? `🌐 Web search returned ${resultCount} results` : '🌐 Web search complete',
                    queryLabel ? `for ${queryLabel}` : '',
                ]);

            default:
                return null;
        }
    }

    private collectArgumentParts(args: Record<string, unknown> | null): string[] {
        if (!args) return [];

        return Object.entries(args)
            .map(([key, value]) => formatKeyValue(key, value))
            .filter((value): value is string => Boolean(value));
    }

    private collectPayloadParts(payload: Record<string, unknown> | null): string[] {
        if (!payload) return [];

        const parts: string[] = [];
        for (const key of PAYLOAD_DETAIL_KEYS) {
            if (!(key in payload)) continue;
            const formatted = formatKeyValue(key, payload[key]);
            if (formatted) {
                parts.push(formatted);
            }
        }

        const startLine = typeof payload.startLine === 'number' ? payload.startLine : null;
        const endLine = typeof payload.endLine === 'number' ? payload.endLine : null;
        if (startLine !== null && endLine !== null) {
            parts.push(`lines=${startLine}-${endLine}`);
        }

        const resultCount = typeof payload.totalResults === 'number'
            ? payload.totalResults
            : typeof payload.truncatedTotalResults === 'number'
                ? payload.truncatedTotalResults
                : Array.isArray(payload.results)
                    ? payload.results.length
                    : null;
        if (resultCount !== null) {
            parts.push(`results=${resultCount}`);
        }

        return parts;
    }

    private setPhase(phase: GrpcResponsePhase, text: string | null): void {
        if (this.currentPhase !== phase) {
            this.currentPhase = phase;
            const len = text?.length ?? 0;
            switch (phase) {
                case 'thinking': logger.phase('[GrpcMonitor] Thinking'); break;
                case 'generating': logger.phase(`[GrpcMonitor] Generating (${len} chars)`); break;
                case 'complete': logger.done(`[GrpcMonitor] Complete (${len} chars)`); break;
                case 'timeout': logger.warn(`[GrpcMonitor] Timeout (${len} chars captured)`); break;
                case 'quotaReached': logger.warn('[GrpcMonitor] Quota Reached'); break;
                default: logger.phase(`[GrpcMonitor] ${phase}`);
            }
            this.onPhaseChange?.(phase, text);
        }
    }
}
