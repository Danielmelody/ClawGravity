/**
 * GrpcResponseMonitor — LS-based response monitoring with stream-first fallback polling.
 *
 * Completely headless — no DOM, no CDP.
 */

import path from 'path';
import { logger } from '../utils/logger';
import { GrpcCascadeClient, CascadeStreamEvent } from './grpcCascadeClient';

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

    // Callbacks shared by the response-monitoring call sites
    onProgress?: (text: string) => void;
    onComplete?: (finalText: string) => void;
    onTimeout?: (lastText: string) => void;
    onPhaseChange?: (phase: GrpcResponsePhase, text: string | null) => void;
    onProcessLog?: (text: string) => void;
}

const TRAJECTORY_POLL_INTERVAL_MS = 750;

interface TrajectoryRecoverySnapshot {
    runStatus: string | null;
    latestRole: 'user' | 'assistant' | null;
    latestResponseText: string | null;
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
    private hasSeenActivity = false;
    private startTime = 0;

    // Stream state
    private abortController: AbortController | null = null;
    private streamDataListener: ((evt: CascadeStreamEvent) => void) | null = null;
    private streamCompleteListener: (() => void) | null = null;
    private streamErrorListener: ((err: any) => void) | null = null;

    // Global timers
    private safetyTimer: NodeJS.Timeout | null = null;
    private recoveryPromise: Promise<void> | null = null;

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
        this.hasSeenActivity = false;
        this.recoveryPromise = null;

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

        this.teardownStream();
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
            this.failStream(err?.message || 'Failed to open stream');
        }
    }

    private teardownStream(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        this.removeStreamListeners();
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
        if (!this.isRunning) return;

        this.emitThinkingDetailsFromPayload(evt.raw?.result ?? evt.raw);
        this.emitPlannedToolCalls(evt.raw?.result?.plannerResponse?.toolCalls);

        if (evt.type === 'error') {
            const msg = evt.text || 'Unknown stream payload error';
            if (msg.toLowerCase().includes('quota')) {
                this.setPhase('quotaReached', this.lastResponseText);
                this.stop().catch(() => { });
                this.onTimeout?.(this.lastResponseText ?? '');
                return;
            }
            this.failStream(`Stream payload error: ${msg.slice(0, 100)}`);
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
        if (!this.isRunning) return;

        if (!this.hasSeenActivity) {
            void this.recoverFromSilentStreamClosure('Stream closed before any activity was received');
            return;
        }

        this.finishSuccessfully();
    }

    private handleStreamError(err: any): void {
        if (!this.isRunning) return;

        const msg = err?.message || String(err);
        if (msg.toLowerCase().includes('quota')) {
            this.setPhase('quotaReached', this.lastResponseText);
            this.stop().catch(() => { });
            this.onTimeout?.(this.lastResponseText ?? '');
            return;
        }
        void this.recoverFromSilentStreamClosure(`Stream error: ${msg.slice(0, 100)}`);
    }

    // ─── Common Logic ──────────────────────────────────────────────

    private failStream(message: string): void {
        logger.warn(`[GrpcMonitor] ${message}`);
        this.setPhase('error', this.lastResponseText);
        const text = this.lastResponseText ?? '';
        this.stop().catch(() => { });
        this.onTimeout?.(text);
    }

    private async recoverFromSilentStreamClosure(failureMessage: string): Promise<void> {
        if (!this.isRunning) return;
        if (this.recoveryPromise) {
            await this.recoveryPromise;
            return;
        }

        this.teardownStream();
        this.recoveryPromise = this.tryRecoverCompletedResponse(failureMessage);
        try {
            await this.recoveryPromise;
        } finally {
            this.recoveryPromise = null;
        }
    }

    private async tryRecoverCompletedResponse(failureMessage: string): Promise<void> {
        logger.warn(`[GrpcMonitor] ${failureMessage}; falling back to trajectory polling`);

        while (this.isRunning) {
            const snapshot = await this.readTrajectorySnapshot();
            if (!this.isRunning) return;

            if (this.applyTrajectorySnapshot(snapshot)) {
                return;
            }

            const remainingMs = this.maxDurationMs - (Date.now() - this.startTime);
            if (remainingMs <= 0) {
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, Math.min(TRAJECTORY_POLL_INTERVAL_MS, remainingMs)));
        }
    }

    private async readTrajectorySnapshot(): Promise<TrajectoryRecoverySnapshot | null> {
        try {
            const trajectoryResp = await this.client.rawRPC('GetCascadeTrajectory', { cascadeId: this.cascadeId });
            const trajectory = trajectoryResp?.trajectory ?? trajectoryResp;
            const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];

            let latestRole: 'user' | 'assistant' | null = null;
            let latestResponseText: string | null = null;

            for (const step of steps) {
                if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
                    latestRole = 'user';
                    latestResponseText = null;
                    continue;
                }

                if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                    latestRole = 'assistant';
                    latestResponseText = step?.plannerResponse?.response || step?.assistantResponse?.text || '';
                }
            }

            const runStatus = typeof trajectory?.cascadeRunStatus === 'string'
                ? trajectory.cascadeRunStatus
                : typeof trajectoryResp?.cascadeRunStatus === 'string'
                    ? trajectoryResp.cascadeRunStatus
                    : null;

            return {
                runStatus,
                latestRole,
                latestResponseText,
            };
        } catch (err: any) {
            logger.debug(`[GrpcMonitor] Trajectory recovery failed: ${err?.message || err}`);
            return null;
        }
    }

    private applyTrajectorySnapshot(snapshot: TrajectoryRecoverySnapshot | null): boolean {
        if (!snapshot) return false;

        const latestText = snapshot.latestRole === 'assistant'
            ? (snapshot.latestResponseText ?? '')
            : null;

        if (latestText !== null && latestText !== this.lastResponseText) {
            this.lastResponseText = latestText;
            if (latestText.length > 0) {
                this.hasSeenActivity = true;
                if (this.currentPhase === 'thinking' || this.currentPhase === 'waiting') {
                    this.setPhase('generating', latestText);
                }
                this.onProgress?.(latestText);
            }
        } else if (snapshot.runStatus === 'CASCADE_RUN_STATUS_RUNNING') {
            this.hasSeenActivity = true;
            if (this.currentPhase === 'waiting') {
                this.setPhase('thinking', null);
            }
        }

        if (snapshot.latestRole === 'assistant' && snapshot.runStatus !== 'CASCADE_RUN_STATUS_RUNNING') {
            this.lastResponseText = latestText ?? this.lastResponseText ?? '';
            this.hasSeenActivity = true;
            logger.info(`[GrpcMonitor] Recovered completed response from trajectory (${this.lastResponseText.length} chars)`);
            this.finishSuccessfully();
            return true;
        }

        return false;
    }

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
