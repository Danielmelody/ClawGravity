/**
 * TrajectoryStreamRouter — event-driven trajectory dispatcher.
 *
 * Polls the trajectory API at regular intervals and dispatches
 * trajectory data to registered passive detectors.
 *
 * Architecture:
 *   Lazy-connect: does NOT poll on startup. The router stays idle until
 *   `connectToCascade(id)` is called (typically after a user sends a
 *   message and a cascade is created or selected).
 *
 *   Polling tick arrives
 *     → fetch trajectory + summaries ONCE
 *     → fan out to all registered detectors via evaluate()
 */

import { logger } from '../utils/logger';
import { CdpService } from './cdpService';
import { ApprovalDetector } from './approvalDetector';
import { ErrorPopupDetector } from './errorPopupDetector';
import { PlanningDetector } from './planningDetector';
import { RunCommandDetector } from './runCommandDetector';
import { UserMessageDetector } from './userMessageDetector';
import { extractCascadeRunStatus } from './grpcCascadeClient';

/** Polling interval for trajectory fetches (ms) */
const POLLING_INTERVAL_MS = 300;

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

    // Polling state
    private pollingTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    private isFetching: boolean = false;

    /** The cascade ID currently being polled (may change when user switches conversations) */
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

    /**
     * Mark the router as ready. Does NOT start polling.
     * Call `connectToCascade(id)` to actually begin polling.
     */
    start(): void {
        this.isRunning = true;
    }

    async stop(): Promise<void> {
        this.isRunning = false;
        this.stopPolling();
    }

    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Connect (or reconnect) polling to a specific cascade.
     * Called on-demand when a cascade is created, selected, or discovered.
     * If already polling the same cascade, this is a no-op.
     */
    connectToCascade(cascadeId: string): void {
        if (!this.isRunning) {
            this.isRunning = true;
        }
        if (this.currentCascadeId === cascadeId && this.pollingTimer) {
            return; // Already polling this cascade
        }
        if (this.currentCascadeId && this.currentCascadeId !== cascadeId) {
            logger.info(`[StreamRouter:${this.projectName}] Cascade changed from ${this.currentCascadeId.slice(0, 12)} to ${cascadeId.slice(0, 12)}, restarting poll`);
            this.stopPolling();
        }
        this.startPolling(cascadeId);
    }

    // ─── Polling ────────────────────────────────────────────────────

    private startPolling(cascadeId: string): void {
        this.currentCascadeId = cascadeId;

        logger.info(`[StreamRouter:${this.projectName}] Polling started for cascade=${cascadeId.slice(0, 12)}...`);

        // Immediate first fetch
        void this.fetchAndDispatch();

        // Regular polling interval
        this.pollingTimer = setInterval(() => {
            if (!this.isRunning) return;
            void this.fetchAndDispatch();
        }, POLLING_INTERVAL_MS);
    }

    private stopPolling(): void {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
        this.currentCascadeId = null;
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
            const client = await this.cdpService.getLSClient();
            if (!client) return;

            const cascadeId = this.currentCascadeId
                ?? await this.cdpService.getActiveCascadeId();
            if (!cascadeId) return;

            // If the cascade changed (user switched conversations), reconnect polling
            if (this.currentCascadeId && cascadeId !== this.currentCascadeId) {
                this.connectToCascade(cascadeId);
                return;
            }

            // Fetch trajectory for detection (approval, error, planning, run command)
            const trajectoryResp = await client.rawRPC('GetCascadeTrajectory', { cascadeId }) as Record<string, unknown>;
            const trajectory = (trajectoryResp?.trajectory as Record<string, unknown> | undefined) ?? trajectoryResp;
            const steps = Array.isArray(trajectory?.steps) ? trajectory.steps as unknown[] : [];
            const runStatus = extractCascadeRunStatus(trajectoryResp);

            // Dispatch to trajectory-based detectors
            this.approvalDetector?.evaluate(cascadeId, steps, runStatus);
            this.errorPopupDetector?.evaluate(cascadeId, steps, runStatus);
            this.planningDetector?.evaluate(cascadeId, steps, runStatus);
            this.runCommandDetector?.evaluate(cascadeId, steps, runStatus);

            // Fetch summaries for user message detection
            if (this.userMessageDetector?.isActive()) {
                const summResp = await client.rawRPC('GetAllCascadeTrajectories', {}) as Record<string, unknown>;
                const summaries = (summResp?.trajectorySummaries as Record<string, unknown>) || {};
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
