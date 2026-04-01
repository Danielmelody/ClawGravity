/**
 * GrpcResponseMonitor — LS-based response monitoring with polling.
 *
 * Polls GetCascadeTrajectory at regular intervals to detect status
 * transitions and content updates. All RPC calls go through the
 * CDP proxy (GrpcCascadeClient.rawRPC → Runtime.evaluate + fetch).
 *
 * Completely headless — no DOM, no direct HTTP.
 */

import { logger } from '../utils/logger';
import { GrpcCascadeClient, extractCascadeRunStatus } from './grpcCascadeClient';

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
    /** Max monitoring duration in ms (default: 3600000 = 1 hour) */
    maxDurationMs?: number;
    /** Optional user message text used to anchor polling fallback to the current turn. */
    expectedUserMessage?: string;

    // Callbacks shared by the response-monitoring call sites
    onProgress?: (text: string) => void;
    onComplete?: (finalText: string) => void;
    onTimeout?: (lastText: string) => void;
    onPhaseChange?: (phase: GrpcResponsePhase, text: string | null) => void;
    /** Callback for raw step data (for native rendering without CDP). */
    onStepsUpdate?: (data: { steps: unknown[]; runStatus: string | null }) => void;
}

/** Polling interval for trajectory fetches (ms). */
const POLLING_INTERVAL_MS = 500;

/** Error patterns in response text that indicate a backend/server error, not a real AI response. */
const ERROR_RESPONSE_PATTERNS = [
    'servers are experiencing high traffic',
    'our servers are experiencing',
    'model is overloaded',
    'service unavailable',
    'temporarily unavailable',
    'resource exhausted',
    'please try again later',
    'please try again in a few',
    'internal server error',
    'rate limit exceeded',
    'quota exceeded',
    'too many requests',
    'capacity limit',
];

/** Max response length to consider for error detection — real responses are typically longer. */
const ERROR_RESPONSE_MAX_LENGTH = 500;

interface TrajectoryRecoverySnapshot {
    steps: unknown[];
    renderSteps: unknown[];
    renderTrajectory: unknown | null;
    runStatus: string | null;
    hasExplicitRunStatus: boolean;
    anchorMatched: boolean;
    anchorRecovered: boolean;
    latestRole: 'user' | 'assistant' | null;
    latestResponseText: string | null;
    /** True if the latest assistant step contains PENDING tool calls (no result yet — model is mid-turn) */
    latestAssistantHasToolCalls: boolean;
    latestAssistantSignature: string | null;
}

function normalizeComparableText(text: string | null | undefined): string {
    return (text || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

function extractUserStepText(step: unknown): string {
    const s = step as Record<string, unknown> | null | undefined;
    const userInput = s?.userInput as Record<string, unknown> | undefined;
    const direct = typeof userInput?.userResponse === 'string'
        ? userInput.userResponse
        : '';
    if (direct.trim()) return direct;

    const items = Array.isArray(userInput?.items) ? (userInput.items as unknown[]) : [];
    return items
        .map((item: unknown) => {
            const it = item as Record<string, unknown> | null | undefined;
            return typeof it?.text === 'string' ? it.text : '';
        })
        .filter(Boolean)
        .join('\n');
}

function extractAssistantStepText(step: unknown): string {
    const s = step as Record<string, unknown> | null | undefined;
    const plannerResponse = s?.plannerResponse as Record<string, unknown> | undefined;
    const assistantResponse = s?.assistantResponse as Record<string, unknown> | undefined;
    if (typeof plannerResponse?.response === 'string') {
        return plannerResponse.response;
    }
    if (typeof assistantResponse?.text === 'string') {
        return assistantResponse.text;
    }
    return '';
}

function buildAssistantSignature(step: unknown, stepIndex: number): string {
    const text = normalizeComparableText(extractAssistantStepText(step));
    const s = step as Record<string, unknown> | null | undefined;
    const plannerResponse = s?.plannerResponse as Record<string, unknown> | undefined;
    const toolCalls = Array.isArray(plannerResponse?.toolCalls) ? (plannerResponse.toolCalls as unknown[]).length : 0;
    const stepType = s?.type || 'assistant';
    return `${stepIndex}:${stepType}:${toolCalls}:${text}`;
}

function findLastUserInputIndex(steps: unknown[]): number {
    for (let i = steps.length - 1; i >= 0; i--) {
        const stepRecord = steps[i] as Record<string, unknown> | null | undefined;
        if (stepRecord?.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
            return i;
        }
    }
    return -1;
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
    /** Callback for raw step data (for native rendering without CDP). */
    private readonly onStepsUpdate?: (data: { steps: unknown[]; runStatus: string | null }) => void;

    private isRunning = false;
    private currentPhase: GrpcResponsePhase = 'waiting';
    private lastResponseText: string | null = null;
    private lastThinkingText: string | null = null;
    private hasSeenActivity = false;
    private startTime = 0;
    private pendingTerminalAssistantSignature: string | null = null;
    private lastSnapshotLogKey: string | null = null;

    // Diagnostic: poll failure tracking
    private consecutivePollFailures = 0;
    private lastSuccessfulPollMs = 0;
    private anchorEverMatched = false;
    private anchorLossLogged = false;

    // Stale trajectory heuristic: detect when RUNNING but nothing is changing
    private lastTrajectoryFingerprint: string | null = null;
    private trajectoryStaleStart: number | null = null;
    private static readonly STALE_COMPLETION_MS = 30_000; // 30s without trajectory changes → complete

    // Polling state
    private pollingTimer: NodeJS.Timeout | null = null;
    private activeTrajectoryRPC: Promise<TrajectoryRecoverySnapshot | null> | null = null;

    // Global timers
    private safetyTimer: NodeJS.Timeout | null = null;

    constructor(options: GrpcResponseMonitorOptions) {
        this.client = options.grpcClient;
        this.cascadeId = options.cascadeId;
        this.maxDurationMs = options.maxDurationMs ?? 3600_000;
        this.expectedUserMessage = normalizeComparableText(options.expectedUserMessage);

        this.onProgress = options.onProgress;
        this.onComplete = options.onComplete;
        this.onTimeout = options.onTimeout;
        this.onPhaseChange = options.onPhaseChange;
        this.onStepsUpdate = options.onStepsUpdate;
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
        this.lastSnapshotLogKey = null;

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

        // Start polling
        this.initPolling();
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
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
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

    // ─── Polling Implementation ─────────────────────────────────────

    private initPolling(): void {
        if (!this.isRunning) return;

        logger.info(`[GrpcMonitor] Starting polling | cascade=${this.cascadeId.slice(0, 12)}... interval=${POLLING_INTERVAL_MS}ms`);

        // Immediate first fetch
        void this.pollOnce();

        // Regular polling interval
        this.pollingTimer = setInterval(() => {
            void this.pollOnce();
        }, POLLING_INTERVAL_MS);
    }

    private async pollOnce(): Promise<void> {
        if (!this.isRunning) return;

        // Prevent overlapping/parallel trajectory fetches
        if (this.activeTrajectoryRPC) return;

        try {
            this.activeTrajectoryRPC = this.readTrajectorySnapshot();
            const snapshot = await this.activeTrajectoryRPC;
            if (!this.isRunning) return;

            if (snapshot) {
                this.consecutivePollFailures = 0;
                this.lastSuccessfulPollMs = Date.now();

                // Update activity tracking from run status
                if (snapshot.runStatus === 'CASCADE_RUN_STATUS_RUNNING') {
                    this.hasSeenActivity = true;
                    if (this.currentPhase === 'waiting') {
                        this.setPhase('thinking', null);
                    }
                }

                // Check for quota errors
                if (snapshot.runStatus && snapshot.runStatus.includes('QUOTA')) {
                    this.setPhase('quotaReached', this.lastResponseText);
                    this.stop().catch(() => { });
                    this.onTimeout?.(this.lastResponseText ?? '');
                    return;
                }

                this.logSnapshotState(snapshot);

                // Apply snapshot (handles text updates + completion detection)
                this.applyTrajectorySnapshot(snapshot);
            } else {
                this.onPollFailure('null snapshot');
            }
        } catch (err: unknown) {
            if (!this.isRunning) return;
            const msg = err instanceof Error ? err.message : String(err);
            this.onPollFailure(msg);
        } finally {
            this.activeTrajectoryRPC = null;
        }
    }

    /** Track consecutive poll failures with escalating log levels (not spammy). */
    private onPollFailure(reason: string): void {
        this.consecutivePollFailures++;
        const n = this.consecutivePollFailures;
        const sinceSuccess = this.lastSuccessfulPollMs
            ? `${Math.round((Date.now() - this.lastSuccessfulPollMs) / 1000)}s ago`
            : 'never';
        // Log on 1st, 5th, 20th, then every 50th failure
        if (n === 1 || n === 5 || n === 20 || n % 50 === 0) {
            logger.warn(
                `[GrpcMonitor] Poll failure #${n} (last success: ${sinceSuccess}): ${reason.slice(0, 150)}`,
            );
        }
    }

    private logSnapshotState(snapshot: TrajectoryRecoverySnapshot): void {
        const anchorState = !this.expectedUserMessage
            ? 'none'
            : snapshot.anchorMatched
                ? (snapshot.anchorRecovered ? 'recovered' : 'matched')
                : 'missing';
        const textLen = snapshot.latestResponseText?.length ?? 0;
        const logKey = [
            snapshot.runStatus ?? 'null',
            snapshot.steps.length,
            snapshot.renderSteps.length,
            anchorState,
            snapshot.latestRole ?? 'none',
            snapshot.latestAssistantHasToolCalls ? 'pending' : 'idle',
            snapshot.latestAssistantSignature ?? 'no-sig',
            textLen,
        ].join('|');

        if (logKey === this.lastSnapshotLogKey) {
            return;
        }
        this.lastSnapshotLogKey = logKey;

        const elapsedSec = this.startTime > 0
            ? Math.max(0, Math.round((Date.now() - this.startTime) / 1000))
            : 0;
        logger.info(
            `[GrpcMonitor] Snapshot t=${elapsedSec}s runStatus=${snapshot.runStatus ?? 'null'}`
            + ` steps=${snapshot.steps.length} renderSteps=${snapshot.renderSteps.length}`
            + ` anchor=${anchorState} latestRole=${snapshot.latestRole ?? 'none'}`
            + ` textLen=${textLen} pendingTools=${snapshot.latestAssistantHasToolCalls ? 'yes' : 'no'}`,
        );
    }

    // ─── Trajectory Fetch & Apply ───────────────────────────────────

    private async readTrajectorySnapshot(): Promise<TrajectoryRecoverySnapshot | null> {
        try {
            const trajectoryResp = await this.client.rawRPC('GetCascadeTrajectory', { cascadeId: this.cascadeId });
            const trajectoryRespRecord = trajectoryResp as Record<string, unknown> | null | undefined;
            const trajectoryData = trajectoryRespRecord?.trajectory as Record<string, unknown> | undefined;
            const stepCount = Array.isArray(trajectoryData?.steps) ? trajectoryData.steps.length : '?';
            const status = (trajectoryData as Record<string, unknown> | undefined)?.status ?? trajectoryRespRecord?.status ?? 'unknown';
            logger.debug(`[GrpcMonitor] Trajectory fetched: ${stepCount} steps, status=${status}`);
            const trajectory = trajectoryData ?? trajectoryResp;
            const steps = Array.isArray((trajectory as Record<string, unknown> | null | undefined)?.steps) ? (trajectory as Record<string, unknown>).steps as unknown[] : [];

            const runStatus = extractCascadeRunStatus(trajectoryResp);

            const hasExplicitRunStatus = typeof runStatus === 'string' && runStatus.length > 0;
            let latestRole: 'user' | 'assistant' | null = null;
            let latestResponseText: string | null = null;
            let latestAssistantHasToolCalls = false;
            let latestAssistantSignature: string | null = null;
            let anchorRecovered = false;
            let matchedAnchorDirectly = false;

            let anchorIndex = -1;
            if (this.expectedUserMessage) {
                for (let i = steps.length - 1; i >= 0; i--) {
                    const stepRecord = steps[i] as Record<string, unknown> | null | undefined;
                    if (stepRecord?.type !== 'CORTEX_STEP_TYPE_USER_INPUT') continue;

                    const stepText = normalizeComparableText(extractUserStepText(steps[i]));
                    if (stepText === this.expectedUserMessage ||
                        (stepText && this.expectedUserMessage && (stepText.includes(this.expectedUserMessage) || this.expectedUserMessage.includes(stepText)))) {
                        anchorIndex = i;
                        matchedAnchorDirectly = true;
                        break;
                    }
                }

                if (anchorIndex === -1) {
                    if (this.anchorEverMatched) {
                        anchorRecovered = true;
                        const fallbackUserIndex = findLastUserInputIndex(steps);
                        anchorIndex = fallbackUserIndex >= 0 ? fallbackUserIndex : 0;
                        if (!this.anchorLossLogged) {
                            this.anchorLossLogged = true;
                            logger.warn(
                                `[GrpcMonitor] Anchor dropped after prior match; recovering from truncated trajectory tail (steps=${steps.length}, fallbackIndex=${anchorIndex})`,
                            );
                        }
                    } else {
                        // Only log details on first anchor-miss (avoid flooding)
                        if (!this.anchorLossLogged) {
                            this.anchorLossLogged = true;
                            const prevMatched = this.anchorEverMatched ? ' (was previously matched!)' : '';
                            logger.warn(`[GrpcMonitor] Anchor not matched${prevMatched}. Expected: "${this.expectedUserMessage.slice(0, 80)}...", steps=${steps.length}`);
                        }
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
                            anchorRecovered: false,
                            latestRole: null,
                            latestResponseText: null,
                            latestAssistantHasToolCalls: false,
                            latestAssistantSignature: null,
                        };
                    }
                }
            }

            const renderStartIndex = anchorIndex >= 0 ? anchorIndex : 0;

            for (let i = Math.max(anchorIndex, 0); i < steps.length; i++) {
                const step = steps[i];
                const stepRecord = step as Record<string, unknown> | null | undefined;
                if (stepRecord?.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
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

                const plannerResponse = stepRecord?.plannerResponse as Record<string, unknown> | undefined;
                if (stepRecord?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || stepRecord?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                    latestRole = 'assistant';

                    const thinking = plannerResponse?.thinking;
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
                    // Also scan forward to subsequent concrete tool steps for completion
                    // (LS sometimes records results there, not on plannerResponse.toolCalls).
                    if (Array.isArray(plannerResponse?.toolCalls) && (plannerResponse.toolCalls as unknown[]).length > 0) {
                        const pendingToolCalls = (plannerResponse.toolCalls as unknown[]).filter((tc: unknown) => {
                            const tcRecord = tc as Record<string, unknown> | null | undefined;
                            // A tool call is pending if it has no result/output
                            const hasResult = tcRecord?.result !== undefined
                                || tcRecord?.output !== undefined
                                || tcRecord?.toolCallResult !== undefined;
                            const status = String(tcRecord?.status || tcRecord?.toolCallStatus || '');
                            const isCompleted = status === 'completed'
                                || status === 'done'
                                || status === 'success'
                                || status === 'error';
                            if (hasResult || isCompleted) return false;

                            // Scan forward for a concrete tool execution step with this tool call ID
                            const tcId = typeof tcRecord?.id === 'string' ? tcRecord.id.trim() : '';
                            if (tcId) {
                                for (let j = i + 1; j < steps.length; j++) {
                                    const execStep = steps[j] as Record<string, unknown> | null | undefined;
                                    const meta = execStep?.metadata as Record<string, unknown> | undefined;
                                    const execTc = meta?.toolCall as Record<string, unknown> | undefined;
                                    if (execTc && String(execTc.id || '').trim() === tcId) {
                                        // Found a concrete step — check if it's terminal
                                        const execStatus = String(execStep?.status || '').toLowerCase();
                                        if (['done', 'completed', 'success', 'error', 'canceled', 'cancelled'].some(s => execStatus.includes(s))) {
                                            return false; // not pending
                                        }
                                    }
                                }
                            }
                            return true;
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
                anchorMatched: (() => {
                    const matched = !this.expectedUserMessage || anchorIndex !== -1 || anchorRecovered;
                    if (matched && this.expectedUserMessage) {
                        this.anchorEverMatched = true;
                        if (matchedAnchorDirectly) {
                            this.anchorLossLogged = false; // reset so we log if it's lost again
                        }
                    }
                    return matched;
                })(),
                anchorRecovered,
                latestRole,
                latestResponseText,
                latestAssistantHasToolCalls,
                latestAssistantSignature,
            };
        } catch (err: unknown) {
            logger.debug(`[GrpcMonitor] Trajectory recovery failed: ${err instanceof Error ? err.message : String(err)}`);
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



        // Emit raw step data for native rendering (no CDP required)
        if (this.onStepsUpdate && snapshot.renderSteps && snapshot.renderSteps.length > 0) {
            this.onStepsUpdate({
                steps: snapshot.renderSteps,
                runStatus: snapshot.runStatus ?? null,
            });
        }

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

        // Explicit DONE/IDLE status + no pending tool calls → complete even if text is empty.
        // The AI may have finished with only tool calls (edits, commands) and no prose.
        
    const isExplicitlyDone = snapshot.hasExplicitRunStatus && snapshot.runStatus !== 'CASCADE_RUN_STATUS_RUNNING';

        // Don't complete if latest step has tool calls AND run is still active.
        // If the run has an explicit terminal status (IDLE/DONE), tool calls are already
        // resolved server-side — allow completion even with tool-call-only assistant turns.
        if (snapshot.latestAssistantHasToolCalls && !isExplicitlyDone) {
            this.pendingTerminalAssistantSignature = null;
            this.lastTrajectoryFingerprint = null;
            this.trajectoryStaleStart = null;
            return false;
        }

        // Stale trajectory heuristic: if RUNNING but trajectory unchanged for 30s
        // with no pending tool calls, treat as done. This handles the case where
        // the AI finishes with a tool call (e.g. notify_user) but runStatus
        // never transitions to DONE.
        let staleCompleted = false;
        if (snapshot.runStatus === 'CASCADE_RUN_STATUS_RUNNING') {
            if (!isExplicitlyDone && snapshot.latestRole === 'assistant') {
                const fingerprint = `${snapshot.latestAssistantSignature}|${snapshot.steps?.length ?? 0}`;
                if (fingerprint !== this.lastTrajectoryFingerprint) {
                    this.lastTrajectoryFingerprint = fingerprint;
                    this.trajectoryStaleStart = Date.now();
                    return false;
                } else if (this.trajectoryStaleStart) {
                    const staleDuration = Date.now() - this.trajectoryStaleStart;
                    if (staleDuration >= GrpcResponseMonitor.STALE_COMPLETION_MS) {
                        logger.info(
                            `[GrpcMonitor] Stale trajectory heuristic: RUNNING but unchanged for ${Math.round(staleDuration / 1000)}s — completing`,
                        );
                        staleCompleted = true;
                        // Fall through — bypass downstream guards
                    } else {
                        return false;
                    }
                } else {
                    this.trajectoryStaleStart = Date.now();
                    return false;
                }
            } else {
                this.pendingTerminalAssistantSignature = null;
                return false;
            }
        }

        // When we have no explicit "done" status and no stale-heuristic completion,
        // require assistant role + non-empty text
        if (!isExplicitlyDone && !staleCompleted) {
            if (snapshot.latestRole !== 'assistant' || latestTextIsEmpty) {
                this.pendingTerminalAssistantSignature = null;
                return false;
            }
        }

        if (!snapshot.hasExplicitRunStatus && !staleCompleted) {
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
        logger.info(`[GrpcMonitor] Completed response from trajectory (${this.lastResponseText.length} chars, stale=${staleCompleted})`);
        this.finishSuccessfully(snapshot.runStatus);
        return true;
    }

    private async finishSuccessfully(_runStatus: string | null = null): Promise<void> {
        if (this.currentPhase === 'complete' || this.currentPhase === 'error') return; // guard against double-fire
        const text = this.lastResponseText ?? '';

        // Detect backend error responses (short messages with known error patterns).
        // These should be surfaced as errors, not delivered as normal AI responses.
        if (this.isErrorResponse(text)) {
            logger.warn(`[GrpcMonitor] Response detected as backend error: "${text.slice(0, 150)}"`);
            this.setPhase('error', text);
            this.stop().catch(() => { });
            this.onTimeout?.(text);
            return;
        }

        this.setPhase('complete', this.lastResponseText);

        this.stop().catch(() => { });
        this.onComplete?.(text);
    }

    /**
     * Check if a response text is actually a backend/server error message.
     * Short responses matching known error patterns are treated as errors.
     */
    private isErrorResponse(text: string): boolean {
        if (!text.trim()) return false;
        // Only check short responses — a long response that happens to contain
        // "please try again" in context is a real response, not an error.
        if (text.length > ERROR_RESPONSE_MAX_LENGTH) return false;
        const normalized = text.toLowerCase();
        return ERROR_RESPONSE_PATTERNS.some(p => normalized.includes(p));
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
        if (this.currentPhase === 'thinking') {
            this.onPhaseChange?.('thinking', delta);
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
}
