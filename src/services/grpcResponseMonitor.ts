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
    /** Max monitoring duration in ms (default: 300000 = 5 min) */
    maxDurationMs?: number;
    /** Optional user message text used to anchor polling fallback to the current turn. */
    expectedUserMessage?: string;

    // Callbacks shared by the response-monitoring call sites
    onProgress?: (text: string) => void;
    onComplete?: (finalText: string) => void;
    onTimeout?: (lastText: string) => void;
    onPhaseChange?: (phase: GrpcResponsePhase, text: string | null) => void;
    /** Callback for raw step data (for native rendering without CDP). */
    onStepsUpdate?: (data: { steps: any[]; runStatus: string | null }) => void;
}

/** Polling interval for trajectory fetches (ms). */
const POLLING_INTERVAL_MS = 500;

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
    private readonly onStepsUpdate?: (data: { steps: any[]; runStatus: string | null }) => void;

    private isRunning = false;
    private currentPhase: GrpcResponsePhase = 'waiting';
    private lastResponseText: string | null = null;
    private lastThinkingText: string | null = null;
    private hasSeenActivity = false;
    private startTime = 0;
    private pendingTerminalAssistantSignature: string | null = null;

    // Diagnostic: poll failure tracking
    private consecutivePollFailures = 0;
    private lastSuccessfulPollMs = 0;
    private anchorEverMatched = false;
    private anchorLossLogged = false;

    // Polling state
    private pollingTimer: NodeJS.Timeout | null = null;
    private activeTrajectoryRPC: Promise<TrajectoryRecoverySnapshot | null> | null = null;

    // Global timers
    private safetyTimer: NodeJS.Timeout | null = null;

    constructor(options: GrpcResponseMonitorOptions) {
        this.client = options.grpcClient;
        this.cascadeId = options.cascadeId;
        this.maxDurationMs = options.maxDurationMs ?? 300_000;
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

                // Apply snapshot (handles text updates + completion detection)
                this.applyTrajectorySnapshot(snapshot);
            } else {
                this.onPollFailure('null snapshot');
            }
        } catch (err: any) {
            if (!this.isRunning) return;
            const msg = err?.message || String(err);
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

    // ─── Trajectory Fetch & Apply ───────────────────────────────────

    private async readTrajectorySnapshot(): Promise<TrajectoryRecoverySnapshot | null> {
        try {
            const trajectoryResp = await this.client.rawRPC('GetCascadeTrajectory', { cascadeId: this.cascadeId });
            const stepCount = Array.isArray(trajectoryResp?.trajectory?.steps) ? trajectoryResp.trajectory.steps.length : '?';
            logger.debug(`[GrpcMonitor] Trajectory fetched: ${stepCount} steps, status=${trajectoryResp?.trajectory?.status ?? trajectoryResp?.status ?? 'unknown'}`);
            const trajectory = trajectoryResp?.trajectory ?? trajectoryResp;
            const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];

            const runStatus = extractCascadeRunStatus(trajectoryResp);

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
                anchorMatched: (() => {
                    const matched = !this.expectedUserMessage || anchorIndex !== -1;
                    if (matched && this.expectedUserMessage) {
                        this.anchorEverMatched = true;
                        this.anchorLossLogged = false; // reset so we log if it's lost again
                    }
                    return matched;
                })(),
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



        // Emit raw step data for native rendering (no CDP required)
        if (this.onStepsUpdate && snapshot.steps && snapshot.steps.length > 0) {
            this.onStepsUpdate({
                steps: snapshot.steps,
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
        logger.info(`[GrpcMonitor] Completed response from trajectory (${this.lastResponseText.length} chars)`);
        this.finishSuccessfully();
        return true;
    }

    private async finishSuccessfully(): Promise<void> {
        if (this.currentPhase === 'complete') return; // guard against double-fire
        this.setPhase('complete', this.lastResponseText);
        const text = this.lastResponseText ?? '';

        this.stop().catch(() => { });
        this.onComplete?.(text);
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
