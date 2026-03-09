/**
 * TrajectoryStreamRouter — event-driven trajectory dispatcher.
 *
 * Subscribes to the existing StreamCascadeReactiveUpdates stream
 * and dispatches trajectory data to registered passive detectors.
 *
 * Architecture:
 *   Stream event (diff) arrives
 *     → debounce (300ms)
 *     → fetch trajectory + summaries ONCE
 *     → fan out to all registered detectors via evaluate()
 *
 * Replaces the old model where 5 independent detectors each ran
 * their own polling timers.
 */

import { logger } from '../utils/logger';
import { CdpService } from './cdpService';
import { GrpcCascadeClient, CascadeStreamEvent } from './grpcCascadeClient';
import { ApprovalDetector } from './approvalDetector';
import { ErrorPopupDetector } from './errorPopupDetector';
import { PlanningDetector } from './planningDetector';
import { RunCommandDetector } from './runCommandDetector';
import { UserMessageDetector } from './userMessageDetector';

/** Debounce delay for trajectory fetches triggered by reactive diffs */
const STREAM_DEBOUNCE_MS = 300;

/** Delay before reconnecting the stream after a closed/error */
const RECONNECT_DELAY_MS = 3000;

/** Maximum consecutive reconnect failures before giving up */
const MAX_RECONNECT_FAILURES = 10;

export interface TrajectoryStreamRouterOptions {
    cdpService: CdpService;
    projectName: string;
}

export class TrajectoryStreamRouter {
    private readonly cdpService: CdpService;
    private readonly projectName: string;

    // Registered detectors (set externally)
    private approvalDetector: ApprovalDetector | null = null;
    private errorPopupDetector: ErrorPopupDetector | null = null;
    private planningDetector: PlanningDetector | null = null;
    private runCommandDetector: RunCommandDetector | null = null;
    private userMessageDetector: UserMessageDetector | null = null;

    // Stream state
    private abortController: AbortController | null = null;
    /** Reference to the client we attached listeners to (for cleanup) */
    private boundClient: GrpcCascadeClient | null = null;
    private dataListener: ((evt: CascadeStreamEvent) => void) | null = null;
    private completeListener: (() => void) | null = null;
    private errorListener: ((err: any) => void) | null = null;
    private isRunning: boolean = false;
    private debounceTimer: NodeJS.Timeout | null = null;
    private isFetching: boolean = false;
    private reconnectFailures: number = 0;

    /** The cascade ID currently being streamed (may change when user switches conversations) */
    private currentCascadeId: string | null = null;

    constructor(options: TrajectoryStreamRouterOptions) {
        this.cdpService = options.cdpService;
        this.projectName = options.projectName;
    }

    // ─── Detector Registration ──────────────────────────────────────

    registerApprovalDetector(detector: ApprovalDetector): void {
        this.approvalDetector = detector;
    }

    registerErrorPopupDetector(detector: ErrorPopupDetector): void {
        this.errorPopupDetector = detector;
    }

    registerPlanningDetector(detector: PlanningDetector): void {
        this.planningDetector = detector;
    }

    registerRunCommandDetector(detector: RunCommandDetector): void {
        this.runCommandDetector = detector;
    }

    registerUserMessageDetector(detector: UserMessageDetector): void {
        this.userMessageDetector = detector;
    }

    // ─── Lifecycle ──────────────────────────────────────────────────

    async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.reconnectFailures = 0;
        await this.connectStream();
    }

    async stop(): Promise<void> {
        this.isRunning = false;
        this.teardownStream();
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    isActive(): boolean {
        return this.isRunning;
    }

    // ─── Stream Connection ──────────────────────────────────────────

    private async connectStream(): Promise<void> {
        if (!this.isRunning) return;

        try {
            const client = await this.cdpService.getGrpcClient();
            if (!client) {
                logger.warn(`[StreamRouter:${this.projectName}] gRPC client not ready, retrying in ${RECONNECT_DELAY_MS}ms`);
                this.scheduleReconnect();
                return;
            }

            // Discover the active cascade to stream
            const cascadeId = await this.cdpService.getActiveCascadeId();
            if (!cascadeId) {
                logger.debug(`[StreamRouter:${this.projectName}] No active cascade, retrying in ${RECONNECT_DELAY_MS}ms`);
                this.scheduleReconnect();
                return;
            }

            this.currentCascadeId = cascadeId;
            this.boundClient = client;

            // Wire up event listeners
            this.dataListener = (evt) => this.handleStreamData(evt);
            this.completeListener = () => this.handleStreamClose();
            this.errorListener = (err) => this.handleStreamError(err);

            client.on('data', this.dataListener);
            client.on('complete', this.completeListener);
            client.on('error', this.errorListener);

            // Open the reactive stream
            this.abortController = client.streamCascadeUpdates(cascadeId);
            this.reconnectFailures = 0;

            logger.info(`[StreamRouter:${this.projectName}] Stream connected for cascade=${cascadeId.slice(0, 12)}...`);

            // Do an initial evaluation immediately so we don't miss already-pending states
            void this.fetchAndDispatch();
        } catch (error) {
            logger.error(`[StreamRouter:${this.projectName}] Failed to connect stream:`, error);
            this.scheduleReconnect();
        }
    }

    private teardownStream(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.removeStreamListeners();
        this.currentCascadeId = null;
        this.boundClient = null;
    }

    private removeStreamListeners(): void {
        const client = this.boundClient;
        if (!client) return;

        if (this.dataListener) {
            client.off('data', this.dataListener);
            this.dataListener = null;
        }
        if (this.completeListener) {
            client.off('complete', this.completeListener);
            this.completeListener = null;
        }
        if (this.errorListener) {
            client.off('error', this.errorListener);
            this.errorListener = null;
        }
    }

    private scheduleReconnect(): void {
        if (!this.isRunning) return;

        this.reconnectFailures++;
        if (this.reconnectFailures > MAX_RECONNECT_FAILURES) {
            logger.error(`[StreamRouter:${this.projectName}] Max reconnect failures reached (${MAX_RECONNECT_FAILURES}), giving up`);
            this.isRunning = false;
            return;
        }

        const delay = RECONNECT_DELAY_MS * Math.min(this.reconnectFailures, 3);
        logger.debug(`[StreamRouter:${this.projectName}] Reconnecting in ${delay}ms (attempt ${this.reconnectFailures})`);
        setTimeout(() => {
            this.teardownStream();
            void this.connectStream();
        }, delay);
    }

    // ─── Stream Event Handlers ──────────────────────────────────────

    private handleStreamData(_evt: CascadeStreamEvent): void {
        // The stream fires on every diff. Debounce to avoid hammering
        // the trajectory API when changes arrive in bursts.
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.fetchAndDispatch();
        }, STREAM_DEBOUNCE_MS);
    }

    private handleStreamClose(): void {
        logger.info(`[StreamRouter:${this.projectName}] Stream closed`);
        this.teardownStream();
        this.scheduleReconnect();
    }

    private handleStreamError(err: any): void {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[StreamRouter:${this.projectName}] Stream error: ${msg.slice(0, 200)}`);
        this.teardownStream();
        this.scheduleReconnect();
    }

    // ─── Trajectory Fetch & Dispatch ────────────────────────────────

    /**
     * Fetch current trajectory and summaries, then dispatch to all
     * registered detectors. Prevents concurrent fetches.
     */
    private async fetchAndDispatch(): Promise<void> {
        if (!this.isRunning) return;
        if (this.isFetching) return; // Already in-flight
        this.isFetching = true;

        try {
            const client = await this.cdpService.getGrpcClient();
            if (!client) return;

            const cascadeId = this.currentCascadeId
                ?? await this.cdpService.getActiveCascadeId();
            if (!cascadeId) return;

            // If the cascade changed (user switched conversations), reconnect the stream
            if (this.currentCascadeId && cascadeId !== this.currentCascadeId) {
                logger.info(`[StreamRouter:${this.projectName}] Cascade changed from ${this.currentCascadeId.slice(0, 12)} to ${cascadeId.slice(0, 12)}, reconnecting`);
                this.teardownStream();
                void this.connectStream();
                return;
            }

            // Fetch trajectory for detection (approval, error, planning, run command)
            const trajectoryResp = await client.rawRPC('GetCascadeTrajectory', { cascadeId });
            const trajectory = trajectoryResp?.trajectory ?? trajectoryResp;
            const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
            const runStatus =
                trajectory?.cascadeRunStatus
                || trajectoryResp?.cascadeRunStatus
                || trajectory?.status
                || trajectoryResp?.status
                || null;

            // Dispatch to trajectory-based detectors
            this.approvalDetector?.evaluate(cascadeId, steps, runStatus);
            this.errorPopupDetector?.evaluate(cascadeId, steps, runStatus);
            this.planningDetector?.evaluate(cascadeId, steps, runStatus);
            this.runCommandDetector?.evaluate(cascadeId, steps, runStatus);

            // Fetch summaries for user message detection
            if (this.userMessageDetector?.isActive()) {
                const summResp = await client.rawRPC('GetAllCascadeTrajectories', {});
                const summaries = summResp?.trajectorySummaries || {};
                await this.userMessageDetector.evaluateSummaries(summaries);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected')
                || message.includes('Not connected')
                || message.includes('ECONNREFUSED')) {
                return;
            }
            logger.error(`[StreamRouter:${this.projectName}] Error in fetchAndDispatch:`, error);
        } finally {
            this.isFetching = false;
        }
    }
}
