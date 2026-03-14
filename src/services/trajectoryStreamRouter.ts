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
 *
 * Effect migration: internal polling uses Effect.repeat with Schedule,
 * replacing manual setInterval / isFetching / isRunning flags.
 */

import { Effect, Fiber, Schedule, Ref, Option } from 'effect';
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

/** Connection-ignorable error messages (transient network issues). */
const TRANSIENT_ERRORS = ['WebSocket is not connected', 'Not connected', 'ECONNREFUSED'];

function isTransientError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return TRANSIENT_ERRORS.some((t) => msg.includes(t));
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

    // Effect-managed polling state
    private pollingFiber: Fiber.RuntimeFiber<void, never> | null = null;
    private _isRunning = false;
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

    start(): void {
        this._isRunning = true;
    }

    async stop(): Promise<void> {
        this._isRunning = false;
        await this.stopPolling();
    }

    isActive(): boolean {
        return this._isRunning;
    }

    connectToCascade(cascadeId: string): void {
        if (!this._isRunning) {
            this._isRunning = true;
        }
        if (this.currentCascadeId === cascadeId && this.pollingFiber) {
            return;
        }
        if (this.currentCascadeId && this.currentCascadeId !== cascadeId) {
            logger.info(`[StreamRouter:${this.projectName}] Cascade changed from ${this.currentCascadeId.slice(0, 12)} to ${cascadeId.slice(0, 12)}, restarting poll`);
            void this.stopPolling();
        }
        this.startPolling(cascadeId);
    }

    // ─── Effect-based Polling ───────────────────────────────────────

    private startPolling(cascadeId: string): void {
        this.currentCascadeId = cascadeId;
        logger.info(`[StreamRouter:${this.projectName}] Polling started for cascade=${cascadeId.slice(0, 12)}...`);

        // Build the polling effect: fetch-and-dispatch, then repeat
        const tick = Effect.tryPromise({
            try: () => this.fetchAndDispatch(),
            catch: () => undefined,   // errors handled inside fetchAndDispatch
        }).pipe(
            Effect.catchAll(() => Effect.void),   // never propagate
        );

        const pollingEffect = tick.pipe(
            Effect.repeat(Schedule.spaced(POLLING_INTERVAL_MS)),
            Effect.interruptible,                 // allows Fiber.interrupt to stop it
        );

        // Fork the polling fiber
        this.pollingFiber = Effect.runFork(pollingEffect as Effect.Effect<void, never, never>);
    }

    private async stopPolling(): Promise<void> {
        if (this.pollingFiber) {
            await Effect.runPromise(Fiber.interrupt(this.pollingFiber).pipe(Effect.catchAll(() => Effect.void)));
            this.pollingFiber = null;
        }
        this.currentCascadeId = null;
    }

    // ─── Trajectory Fetch & Dispatch ────────────────────────────────

    /**
     * Fetch current trajectory and summaries, then dispatch to all
     * registered detectors.
     */
    private async fetchAndDispatch(): Promise<void> {
        if (!this._isRunning) return;

        try {
            const client = await this.cdpService.getLSClient();
            if (!client) return;

            const cascadeId = this.currentCascadeId
                ?? await this.cdpService.getActiveCascadeId();
            if (!cascadeId) return;

            if (this.currentCascadeId && cascadeId !== this.currentCascadeId) {
                this.connectToCascade(cascadeId);
                return;
            }

            const trajectoryResp = await client.rawRPC('GetCascadeTrajectory', { cascadeId }) as Record<string, unknown>;
            const trajectory = (trajectoryResp?.trajectory as Record<string, unknown> | undefined) ?? trajectoryResp;
            const steps = Array.isArray(trajectory?.steps) ? trajectory.steps as unknown[] : [];
            const runStatus = extractCascadeRunStatus(trajectoryResp);

            this.approvalDetector?.evaluate(cascadeId, steps, runStatus);
            this.errorPopupDetector?.evaluate(cascadeId, steps, runStatus);
            this.planningDetector?.evaluate(cascadeId, steps, runStatus);
            this.runCommandDetector?.evaluate(cascadeId, steps, runStatus);

            if (this.userMessageDetector?.isActive()) {
                const summResp = await client.rawRPC('GetAllCascadeTrajectories', {}) as Record<string, unknown>;
                const summaries = (summResp?.trajectorySummaries as Record<string, unknown>) || {};
                await this.userMessageDetector.evaluateSummaries(summaries);
            }
        } catch (error) {
            if (isTransientError(error)) return;
            logger.error(`[StreamRouter:${this.projectName}] Error in fetchAndDispatch:`, error);
        }
    }
}
