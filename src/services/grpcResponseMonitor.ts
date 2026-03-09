/**
 * GrpcResponseMonitor — LS-based response monitoring with reactive stream
 * notifications and on-demand trajectory fetches.
 *
 * The reactive diff stream acts as a notification channel: it tells us
 * WHEN something changes (status transitions, generic diffs). Actual
 * content (response text, tool calls) is fetched from GetCascadeTrajectory
 * on-demand with debouncing.
 *
 * Completely headless — no DOM, no CDP.
 */

import { logger } from '../utils/logger';
import { GrpcCascadeClient, CascadeStreamEvent } from './grpcCascadeClient';
import type { AntigravityTrajectoryRenderer } from './antigravityTrajectoryRenderer';
import { createHash } from 'crypto';

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
    /** Optional user message text used to anchor polling fallback to the current turn. */
    expectedUserMessage?: string;

    // Callbacks shared by the response-monitoring call sites
    onProgress?: (text: string) => void;
    onComplete?: (finalText: string) => void;
    onTimeout?: (lastText: string) => void;
    onPhaseChange?: (phase: GrpcResponsePhase, text: string | null) => void;
    onRenderedTimeline?: (timeline: {
        content: string;
        format: 'text' | 'html';
        strategy?: string;
        contextId?: number;
    }) => void;
    trajectoryRenderer?: AntigravityTrajectoryRenderer;
}

/** Debounce delay for trajectory fetches triggered by reactive diffs */
const REACTIVE_SNAPSHOT_DEBOUNCE_MS = 8;
/** Initial retry delay for recovery (doubles each attempt) */
const RECOVERY_INITIAL_DELAY_MS = 500;
/** Max retry delay cap */
const RECOVERY_MAX_DELAY_MS = 4000;
/** Max retries before giving up recovery */
const RECOVERY_MAX_RETRIES = 8;

interface TrajectoryRecoverySnapshot {
    steps: any[];
    renderSteps: any[];
    renderTrajectory: any | null;
    runStatus: string | null;
    hasExplicitRunStatus: boolean;
    anchorMatched: boolean;
    latestRole: 'user' | 'assistant' | null;
    latestResponseText: string | null;
    /** True if the latest assistant step contains PENDING tool calls (no result yet — model is mid-turn) */
    latestAssistantHasToolCalls: boolean;
    latestAssistantSignature: string | null;
}

function normalizeComparableText(text: string | null | undefined): string {
    return (text || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

function extractUserStepText(step: any): string {
    const direct = typeof step?.userInput?.userResponse === 'string'
        ? step.userInput.userResponse
        : '';
    if (direct.trim()) return direct;

    const items = Array.isArray(step?.userInput?.items) ? step.userInput.items : [];
    return items
        .map((item: any) => typeof item?.text === 'string' ? item.text : '')
        .filter(Boolean)
        .join('\n');
}

function extractAssistantStepText(step: any): string {
    if (typeof step?.plannerResponse?.response === 'string') {
        return step.plannerResponse.response;
    }
    if (typeof step?.assistantResponse?.text === 'string') {
        return step.assistantResponse.text;
    }
    return '';
}

function buildAssistantSignature(step: any, stepIndex: number): string {
    const text = normalizeComparableText(extractAssistantStepText(step));
    const toolCalls = Array.isArray(step?.plannerResponse?.toolCalls) ? step.plannerResponse.toolCalls.length : 0;
    return `${stepIndex}:${step?.type || 'assistant'}:${toolCalls}:${text}`;
}

function buildRenderInputSignature(snapshot: TrajectoryRecoverySnapshot): string {
    const payload = snapshot.renderTrajectory ?? snapshot.renderSteps;
    const serialized = JSON.stringify(payload) ?? '';
    return createHash('sha1').update(serialized).digest('hex');
}

// ---------------------------------------------------------------------------
// GrpcResponseMonitor
// ---------------------------------------------------------------------------

export class GrpcResponseMonitor {
    private readonly client: GrpcCascadeClient;
    private readonly cascadeId: string;
    private readonly maxDurationMs: number;
    private readonly expectedUserMessage: string | null;

    private readonly onProgress?: (text: string) => void;
    private readonly onComplete?: (finalText: string) => void;
    private readonly onTimeout?: (lastText: string) => void;
    private readonly onPhaseChange?: (phase: GrpcResponsePhase, text: string | null) => void;
    private readonly onRenderedTimeline?: (timeline: {
        content: string;
        format: 'text' | 'html';
        strategy?: string;
        contextId?: number;
    }) => void;
    private readonly trajectoryRenderer?: AntigravityTrajectoryRenderer;

    private isRunning = false;
    private currentPhase: GrpcResponsePhase = 'waiting';
    private lastResponseText: string | null = null;
    private lastThinkingText: string | null = null;
    private hasSeenActivity = false;
    private startTime = 0;
    private pendingTerminalAssistantSignature: string | null = null;

    // Stream state
    private abortController: AbortController | null = null;
    private streamDataListener: ((evt: CascadeStreamEvent) => void) | null = null;
    private streamCompleteListener: (() => void) | null = null;
    private streamErrorListener: ((err: any) => void) | null = null;

    // Global timers
    private safetyTimer: NodeJS.Timeout | null = null;
    private reactiveSnapshotTimer: NodeJS.Timeout | null = null;
    private activeTrajectoryRPC: Promise<TrajectoryRecoverySnapshot | null> | null = null;
    private recoveryPromise: Promise<void> | null = null;
    private timelineRenderPromise: Promise<void> | null = null;
    private queuedTimelineSnapshot: TrajectoryRecoverySnapshot | null = null;
    private lastRenderedTimelineKey: string | null = null;
    private lastRenderedTimelineContent: string | null = null;

    constructor(options: GrpcResponseMonitorOptions) {
        this.client = options.grpcClient;
        this.cascadeId = options.cascadeId;
        this.maxDurationMs = options.maxDurationMs ?? 300_000;
        this.expectedUserMessage = normalizeComparableText(options.expectedUserMessage);

        this.onProgress = options.onProgress;
        this.onComplete = options.onComplete;
        this.onTimeout = options.onTimeout;
        this.onPhaseChange = options.onPhaseChange;
        this.onRenderedTimeline = options.onRenderedTimeline;
        this.trajectoryRenderer = options.trajectoryRenderer;
    }

    /** Start monitoring the cascade for AI response */
    async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.startTime = Date.now();
        this.lastResponseText = null;
        this.lastThinkingText = null;
        this.hasSeenActivity = false;
        this.pendingTerminalAssistantSignature = null;
        this.recoveryPromise = null;
        this.timelineRenderPromise = null;
        this.queuedTimelineSnapshot = null;
        this.lastRenderedTimelineKey = null;
        this.lastRenderedTimelineContent = null;

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
        if (this.reactiveSnapshotTimer) {
            clearTimeout(this.reactiveSnapshotTimer);
            this.reactiveSnapshotTimer = null;
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

        if (evt.type === 'error') {
            const msg = evt.text || 'Unknown stream payload error';
            if (this.handleQuotaReached(msg)) return;
            this.failStream(`Stream payload error: ${msg.slice(0, 100)}`);
            return;
        }

        if (evt.type === 'status') {
            const status = evt.text || '';
            if (status === 'CASCADE_RUN_STATUS_IDLE') {
                if (this.hasSeenActivity) {
                    // Cascade finished — fetch trajectory for final text.
                    void this.verifyIdleAndComplete();
                }
            } else if (status === 'CASCADE_RUN_STATUS_RUNNING') {
                this.hasSeenActivity = true;
                if (this.currentPhase === 'waiting') {
                    this.setPhase('thinking', null);
                }
            } else {
                // Generic diff notification — something changed in the cascade.
                // Schedule a debounced trajectory fetch to get the actual content.
                // The reactive stream only tells us WHEN things change;
                // GetCascadeTrajectory tells us WHAT changed.
                this.hasSeenActivity = true;
                this.scheduleReactiveSnapshotFetch();
            }
        }
    }

    /**
     * Schedule a debounced trajectory snapshot fetch.
     * Called when the reactive stream signals a change (non-status diff).
     * Coalesces rapid diff notifications into a single trajectory fetch.
     */
    private scheduleReactiveSnapshotFetch(): void {
        if (this.reactiveSnapshotTimer) return; // Already scheduled
        this.reactiveSnapshotTimer = setTimeout(async () => {
            this.reactiveSnapshotTimer = null;
            if (!this.isRunning) return;

            // Prevent overlapping/parallel trajectory fetches which can exhaust HTTP/2 stream limits
            // and cause severe streaming latency (stuck in thinking or multi-second delays).
            if (this.activeTrajectoryRPC) {
                // We're already fetching, so re-schedule for after another debounce tick
                this.scheduleReactiveSnapshotFetch();
                return;
            }

            try {
                this.activeTrajectoryRPC = this.readTrajectorySnapshot();
                const snapshot = await this.activeTrajectoryRPC;
                if (!this.isRunning) return;
                this.applyTrajectorySnapshot(snapshot);
            } finally {
                this.activeTrajectoryRPC = null;
            }
        }, REACTIVE_SNAPSHOT_DEBOUNCE_MS);
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
        if (this.handleQuotaReached(msg)) return;
        void this.recoverFromSilentStreamClosure(`Stream error: ${msg.slice(0, 100)}`);
    }

    /** Check if msg indicates a quota error; if so, handle it and return true. */
    private handleQuotaReached(msg: string): boolean {
        if (!msg.toLowerCase().includes('quota')) return false;
        this.setPhase('quotaReached', this.lastResponseText);
        this.stop().catch(() => { });
        this.onTimeout?.(this.lastResponseText ?? '');
        return true;
    }


    // ─── Common Logic ──────────────────────────────────────────────

    private failStream(message: string): void {
        logger.warn(`[GrpcMonitor] ${message}`);
        this.setPhase('error', message);
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
        logger.warn(`[GrpcMonitor] ${failureMessage}; attempting trajectory recovery with exponential backoff`);

        let delay = RECOVERY_INITIAL_DELAY_MS;
        let retries = 0;

        while (this.isRunning && retries < RECOVERY_MAX_RETRIES) {
            const snapshot = await this.readTrajectorySnapshot();
            if (!this.isRunning) return;

            if (this.applyTrajectorySnapshot(snapshot)) {
                return;
            }

            const remainingMs = this.maxDurationMs - (Date.now() - this.startTime);
            if (remainingMs <= 0) {
                return;
            }

            retries++;
            const waitMs = Math.min(delay, remainingMs, RECOVERY_MAX_DELAY_MS);
            logger.debug(`[GrpcMonitor] Recovery attempt ${retries}/${RECOVERY_MAX_RETRIES}, next in ${waitMs}ms`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            delay = Math.min(delay * 2, RECOVERY_MAX_DELAY_MS);
        }

        if (this.isRunning) {
            logger.warn(`[GrpcMonitor] Recovery exhausted after ${retries} attempts`);
        }
    }

    private async readTrajectorySnapshot(): Promise<TrajectoryRecoverySnapshot | null> {
        try {
            const trajectoryResp = await this.client.rawRPC('GetCascadeTrajectory', { cascadeId: this.cascadeId });
            const trajectory = trajectoryResp?.trajectory ?? trajectoryResp;
            const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];

            const runStatus = typeof trajectory?.cascadeRunStatus === 'string'
                ? trajectory.cascadeRunStatus
                : typeof trajectoryResp?.cascadeRunStatus === 'string'
                    ? trajectoryResp.cascadeRunStatus
                    : typeof trajectory?.status === 'string'
                        ? trajectory.status
                        : typeof trajectoryResp?.status === 'string'
                            ? trajectoryResp.status
                            : null;

            const hasExplicitRunStatus = typeof runStatus === 'string' && runStatus.length > 0;
            let latestRole: 'user' | 'assistant' | null = null;
            let latestResponseText: string | null = null;
            let latestAssistantHasToolCalls = false;
            let latestAssistantSignature: string | null = null;

            let anchorIndex = -1;
            if (this.expectedUserMessage) {
                for (let i = steps.length - 1; i >= 0; i--) {
                    if (steps[i]?.type !== 'CORTEX_STEP_TYPE_USER_INPUT') continue;

                    const stepText = normalizeComparableText(extractUserStepText(steps[i]));
                    if (stepText === this.expectedUserMessage ||
                        (stepText && this.expectedUserMessage && (stepText.includes(this.expectedUserMessage) || this.expectedUserMessage.includes(stepText)))) {
                        anchorIndex = i;
                        break;
                    }
                }

                if (anchorIndex === -1) {
                    logger.warn(`[GrpcMonitor] Anchor not matched and no user input steps found. Expected: "${this.expectedUserMessage.slice(0, 50)}..."`);
                    return {
                        steps,
                        renderSteps: steps.slice(0),
                        renderTrajectory: {
                            ...(trajectory || {}),
                            steps: steps.slice(0),
                        },
                        runStatus,
                        hasExplicitRunStatus,
                        anchorMatched: false,
                        latestRole: null,
                        latestResponseText: null,
                        latestAssistantHasToolCalls: false,
                        latestAssistantSignature: null,
                    };
                }
            }

            const renderStartIndex = anchorIndex >= 0 ? anchorIndex : 0;

            for (let i = Math.max(anchorIndex, 0); i < steps.length; i++) {
                const step = steps[i];
                if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
                    if (this.expectedUserMessage && i === anchorIndex) {
                        latestRole = 'user';
                        latestResponseText = null;
                        latestAssistantHasToolCalls = false;
                        latestAssistantSignature = null;
                        continue;
                    }

                    latestRole = 'user';
                    latestResponseText = null;
                    latestAssistantHasToolCalls = false;
                    latestAssistantSignature = null;
                    continue;
                }

                if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                    latestRole = 'assistant';

                    const thinking = step?.plannerResponse?.thinking;
                    if (typeof thinking === 'string' && thinking.trim().length > 0) {
                        this.emitThinkingDetails(thinking);
                    }

                    const stepText = extractAssistantStepText(step);
                    if (stepText) {
                        latestResponseText = latestResponseText
                            ? latestResponseText + '\n\n' + stepText
                            : stepText;
                    }

                    // Only count PENDING tool calls (no result yet) as "still working".
                    // Resolved tool calls (with results/output) should not block completion.
                    if (Array.isArray(step?.plannerResponse?.toolCalls) && step.plannerResponse.toolCalls.length > 0) {
                        const pendingToolCalls = step.plannerResponse.toolCalls.filter((tc: any) => {
                            // A tool call is pending if it has no result/output
                            const hasResult = tc?.result !== undefined
                                || tc?.output !== undefined
                                || tc?.toolCallResult !== undefined;
                            const status = tc?.status || tc?.toolCallStatus || '';
                            const isCompleted = status === 'completed'
                                || status === 'done'
                                || status === 'success'
                                || status === 'error';
                            return !hasResult && !isCompleted;
                        });
                        latestAssistantHasToolCalls = pendingToolCalls.length > 0;
                    } else {
                        latestAssistantHasToolCalls = false;
                    }
                    latestAssistantSignature = buildAssistantSignature(step, i);
                }
            }

            return {
                steps,
                renderSteps: steps.slice(renderStartIndex),
                renderTrajectory: {
                    ...(trajectory || {}),
                    steps: steps.slice(renderStartIndex),
                },
                runStatus,
                hasExplicitRunStatus,
                anchorMatched: !this.expectedUserMessage || anchorIndex !== -1,
                latestRole,
                latestResponseText,
                latestAssistantHasToolCalls,
                latestAssistantSignature,
            };
        } catch (err: any) {
            logger.debug(`[GrpcMonitor] Trajectory recovery failed: ${err?.message || err}`);
            return null;
        }
    }

    private applyTrajectorySnapshot(snapshot: TrajectoryRecoverySnapshot | null): boolean {
        if (!snapshot) return false;

        if (!snapshot.anchorMatched) {
            if (snapshot.runStatus === 'CASCADE_RUN_STATUS_RUNNING') {
                this.hasSeenActivity = true;
                if (this.currentPhase === 'waiting') {
                    this.setPhase('thinking', null);
                }
            }
            this.pendingTerminalAssistantSignature = null;
            return false;
        }

        this.scheduleTimelineRender(snapshot);

        const latestText = snapshot.latestRole === 'assistant'
            ? (snapshot.latestResponseText ?? '')
            : null;

        // Transition to 'generating' phase when response text is present.
        let textUpdated = false;
        if (latestText !== null && latestText !== this.lastResponseText) {
            this.lastResponseText = latestText;
            if (latestText.length > 0) {
                this.hasSeenActivity = true;
                textUpdated = true;
                if (this.currentPhase === 'thinking' || this.currentPhase === 'waiting') {
                    this.setPhase('generating', latestText);
                }
            }
        } else if (snapshot.runStatus === 'CASCADE_RUN_STATUS_RUNNING') {
            this.hasSeenActivity = true;
            if (this.currentPhase === 'waiting') {
                this.setPhase('thinking', null);
            }
        }

        if (textUpdated && latestText) {
            this.onProgress?.(latestText);
        }

        const latestTextIsEmpty = latestText !== null && latestText.trim().length === 0;

        // Don't complete if:
        //  - Still RUNNING
        //  - Latest step has tool calls (model is mid-turn, waiting for tool results)
        //  - Latest role isn't assistant
        if (
            snapshot.runStatus === 'CASCADE_RUN_STATUS_RUNNING'
            || snapshot.latestAssistantHasToolCalls
            || snapshot.latestRole !== 'assistant'
            || latestTextIsEmpty
        ) {
            this.pendingTerminalAssistantSignature = null;
            return false;
        }

        if (!snapshot.hasExplicitRunStatus) {
            if (!snapshot.latestAssistantSignature) return false;
            if (this.pendingTerminalAssistantSignature !== snapshot.latestAssistantSignature) {
                this.pendingTerminalAssistantSignature = snapshot.latestAssistantSignature;
                return false;
            }
        } else {
            this.pendingTerminalAssistantSignature = null;
        }

        this.lastResponseText = latestText ?? this.lastResponseText ?? '';
        this.hasSeenActivity = true;
        logger.info(`[GrpcMonitor] Recovered completed response from trajectory (${this.lastResponseText.length} chars)`);
        this.finishSuccessfully();
        return true;
    }

    private finishSuccessfully(): void {
        if (this.currentPhase === 'complete') return; // guard against double-fire
        this.setPhase('complete', this.lastResponseText);
        const text = this.lastResponseText ?? '';
        this.stop().catch(() => { });
        this.onComplete?.(text);
    }

    /**
     * When IDLE arrives during a session with tool calls, verify via trajectory
     * that the model isn't mid-turn before completing. LS often transitions
     * RUNNING→IDLE→RUNNING between tool-call rounds within a single agentic turn.
     * Direct completion on IDLE truncates the response.
     */
    private async verifyIdleAndComplete(): Promise<void> {
        if (!this.isRunning) return;

        const snapshot = await this.readTrajectorySnapshot();
        if (!this.isRunning) return;

        if (!snapshot) {
            // Can't verify — finish optimistically to avoid hanging
            logger.warn('[GrpcMonitor] IDLE verification failed (no trajectory) — completing anyway');
            this.finishSuccessfully();
            return;
        }

        if (snapshot.latestAssistantHasToolCalls || snapshot.runStatus === 'CASCADE_RUN_STATUS_RUNNING') {
            logger.debug(
                `[GrpcMonitor] IDLE received but model still working ` +
                `(toolCalls=${snapshot.latestAssistantHasToolCalls}, status=${snapshot.runStatus}) — continuing to monitor`,
            );
            // Update response text from trajectory in case stream missed some
            if (snapshot.latestResponseText && snapshot.latestResponseText !== this.lastResponseText) {
                this.lastResponseText = snapshot.latestResponseText;
                this.onProgress?.(snapshot.latestResponseText);
            }
            return;
        }

        if (!snapshot.anchorMatched) {
            logger.debug('[GrpcMonitor] IDLE verification waiting for anchored user turn');
            return;
        }

        const verifiedText = snapshot.latestRole === 'assistant'
            ? (snapshot.latestResponseText ?? '')
            : '';
        if (!verifiedText.trim()) {
            logger.debug('[GrpcMonitor] IDLE verification saw empty assistant placeholder — continuing to monitor');
            return;
        }

        // Truly idle — update with latest text from trajectory and finish
        if (verifiedText.length > (this.lastResponseText?.length ?? 0)) {
            this.lastResponseText = verifiedText;
        }
        logger.info(`[GrpcMonitor] IDLE verified via trajectory — completing (${this.lastResponseText?.length ?? 0} chars)`);
        this.finishSuccessfully();
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

    private scheduleTimelineRender(snapshot: TrajectoryRecoverySnapshot): void {
        if (!this.trajectoryRenderer || !this.onRenderedTimeline) return;
        if (!Array.isArray(snapshot.renderSteps) || snapshot.renderSteps.length === 0) return;

        const renderKey = this.buildRenderedTimelineKey(snapshot);
        if (renderKey === this.lastRenderedTimelineKey) {
            return;
        }

        if (this.timelineRenderPromise) {
            this.queuedTimelineSnapshot = snapshot;
            return;
        }

        this.timelineRenderPromise = this.runTimelineRender(snapshot, renderKey)
            .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                logger.debug(`[GrpcMonitor] Timeline render failed: ${message}`);
            })
            .finally(async () => {
                this.timelineRenderPromise = null;
                if (!this.queuedTimelineSnapshot || !this.isRunning) {
                    this.queuedTimelineSnapshot = null;
                    return;
                }

                const queued = this.queuedTimelineSnapshot;
                this.queuedTimelineSnapshot = null;
                this.scheduleTimelineRender(queued);
            });
    }

    private buildRenderedTimelineKey(snapshot: TrajectoryRecoverySnapshot): string {
        return [
            snapshot.runStatus ?? '',
            buildRenderInputSignature(snapshot),
        ].join('|');
    }

    private async runTimelineRender(
        snapshot: TrajectoryRecoverySnapshot,
        renderKey: string,
    ): Promise<void> {
        if (!this.trajectoryRenderer || !this.onRenderedTimeline || !this.isRunning) return;

        const result = await this.trajectoryRenderer.renderTrajectory({
            steps: snapshot.renderSteps,
            runStatus: snapshot.runStatus,
            trajectory: snapshot.renderTrajectory,
            format: 'html',
        });

        if (!this.isRunning || !result.ok || !result.content || result.format !== 'html') {
            return;
        }

        const content = result.content.trim();
        if (!content || content === this.lastRenderedTimelineContent) {
            this.lastRenderedTimelineKey = renderKey;
            return;
        }

        this.lastRenderedTimelineKey = renderKey;
        this.lastRenderedTimelineContent = content;
        this.onRenderedTimeline({
            content,
            format: result.format ?? 'text',
            strategy: result.strategy,
            contextId: result.contextId,
        });
    }
}
