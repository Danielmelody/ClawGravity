import { logger } from '../utils/logger';
import { CdpService } from './cdpService';

/** Planning mode button information */
export interface PlanningInfo {
    /** Open button text */
    openText: string;
    /** Proceed button text */
    proceedText: string;
    /** Plan title (file name shown in the card) */
    planTitle: string;
    /** Plan summary text */
    planSummary: string;
    /** Plan description */
    description: string;
}

export interface PlanningDetectorOptions {
    /** CDP service instance (used only for VS Code commands) */
    cdpService: CdpService;
    /** Callback when planning buttons are detected */
    onPlanningRequired: (info: PlanningInfo) => void;
    /** Callback when a previously detected planning state is resolved */
    onResolved?: () => void;
}

/**
 * Detects planning mode state from cascade trajectory data.
 *
 * Zero DOM operations — detection is based on cascade trajectory:
 * When the cascade has a planner response with a plan (toolCalls listing
 * planned actions) and status=IDLE, planning mode is active.
 *
 * This detector is passive: it does not poll. Call `evaluate()` to feed
 * it trajectory data from the TrajectoryStreamRouter.
 *
 * Actions are performed via VS Code extension commands.
 */
export class PlanningDetector {
    private cdpService: CdpService;
    private onPlanningRequired: (info: PlanningInfo) => void;
    private onResolved?: () => void;

    private isRunning: boolean = false;
    /** Key of the last detected planning info (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full PlanningInfo from the last detection */
    private lastDetectedInfo: PlanningInfo | null = null;
    /** Timestamp of last notification (for cooldown-based dedup) */
    private lastNotifiedAt: number = 0;
    /** Cooldown period in ms to suppress duplicate notifications */
    private static readonly COOLDOWN_MS = 5000;
    /** Set of keys that have already been notified (prevents cross-session re-fires) */
    private notifiedKeys: Set<string> = new Set();
    /** Maximum size of notifiedKeys before pruning oldest entries */
    private static readonly MAX_NOTIFIED_KEYS = 50;

    constructor(options: PlanningDetectorOptions) {
        this.cdpService = options.cdpService;
        this.onPlanningRequired = options.onPlanningRequired;
        this.onResolved = options.onResolved;
    }

    /** Start monitoring (marks active — must be called before evaluate()). */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        this.lastNotifiedAt = 0;
    }

    /** Stop monitoring. */
    async stop(): Promise<void> {
        this.isRunning = false;
    }

    /** Return the last detected planning info. Returns null if nothing has been detected. */
    getLastDetectedInfo(): PlanningInfo | null {
        return this.lastDetectedInfo;
    }

    /** Returns whether monitoring is currently active. */
    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Click the Open button.
     * Uses VS Code command (no DOM operation).
     */
    async clickOpenButton(_buttonText?: string): Promise<boolean> {
        // Open plan — try using VS Code command
        try {
            const result = await this.cdpService.executeVscodeCommand('antigravity.command.openPlan');
            if (result?.ok) {
                logger.debug('[PlanningDetector] Opened via VS Code command');
                return true;
            }
            return false;
        } catch (error) {
            logger.error('[PlanningDetector] Open command failed:', error);
            return false;
        }
    }

    /**
     * Click the Proceed button via VS Code command.
     * Uses `antigravity.command.accept` from the verified SDK.
     */
    async clickProceedButton(_buttonText?: string): Promise<boolean> {
        try {
            const result = await this.cdpService.executeVscodeCommand('antigravity.command.accept');
            if (result?.ok) {
                logger.debug('[PlanningDetector] Proceeded via VS Code command');
                return true;
            }
            return false;
        } catch (error) {
            logger.error('[PlanningDetector] Proceed command failed:', error);
            return false;
        }
    }

    /**
     * Extract plan content from the trajectory.
     * @returns Plan content text or null if not found
     */
    async extractPlanContent(): Promise<string | null> {
        try {
            const client = await this.cdpService.getGrpcClient();
            if (!client) return null;

            const cascadeId = await this.cdpService.getActiveCascadeId();
            if (!cascadeId) return null;

            const trajectoryResp = await client.rawRPC('GetCascadeTrajectory', { cascadeId });
            const trajectory = trajectoryResp?.trajectory ?? trajectoryResp;
            const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];

            // Walk backwards to find the latest planner response with plan content
            for (let i = steps.length - 1; i >= 0; i--) {
                const step = steps[i];
                if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') break;

                if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                    const responseText =
                        step?.plannerResponse?.response
                        || step?.response?.text
                        || step?.assistantResponse?.text
                        || null;
                    if (responseText && responseText.length > 50) {
                        return responseText.slice(0, 4000);
                    }
                }
            }
            return null;
        } catch (error) {
            logger.error('[PlanningDetector] Error extracting plan content:', error);
            return null;
        }
    }

    /**
     * Evaluate trajectory data to detect planning state.
     * Called by TrajectoryStreamRouter when stream events arrive.
     *
     * @param cascadeId  The active cascade ID
     * @param steps      Trajectory steps array
     * @param runStatus  Cascade run status string
     */
    evaluate(cascadeId: string, steps: any[], runStatus: string | null): void {
        if (!this.isRunning) return;

        try {
            const info = this.extractPlanningFromTrajectory(steps, runStatus);

            if (info) {
                // Include cascadeId in the key to prevent cross-session re-fires
                const key = `${cascadeId}::${info.planTitle}::${info.planSummary?.slice(0, 50)}`;
                const now = Date.now();
                const withinCooldown = (now - this.lastNotifiedAt) < PlanningDetector.COOLDOWN_MS;
                if (key !== this.lastDetectedKey && !withinCooldown && !this.notifiedKeys.has(key)) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    this.lastNotifiedAt = now;
                    this.notifiedKeys.add(key);
                    // Prune oldest entries if set grows too large
                    if (this.notifiedKeys.size > PlanningDetector.MAX_NOTIFIED_KEYS) {
                        const first = this.notifiedKeys.values().next().value;
                        if (first) this.notifiedKeys.delete(first);
                    }
                    this.onPlanningRequired(info);
                } else if (key === this.lastDetectedKey) {
                    this.lastDetectedInfo = info;
                }
            } else {
                const wasDetected = this.lastDetectedKey !== null;
                this.lastDetectedKey = null;
                this.lastDetectedInfo = null;
                if (wasDetected && this.onResolved) {
                    this.onResolved();
                }
            }
        } catch (error) {
            logger.error('[PlanningDetector] Error during evaluation:', error);
        }
    }

    /**
     * Extract planning info from trajectory steps.
     * Returns PlanningInfo if there's an active plan awaiting user decision.
     */
    private extractPlanningFromTrajectory(steps: any[], runStatus: string | null): PlanningInfo | null {
        if (!runStatus || runStatus !== 'CASCADE_RUN_STATUS_IDLE') return null;
        if (steps.length === 0) return null;

        for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i];
            if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') break;

            if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                const plannerResponse = step?.plannerResponse;
                if (!plannerResponse) return null;

                const toolCalls = plannerResponse?.toolCalls;

                // Filter to only include tool calls that are actually pending.
                const pendingToolCalls = Array.isArray(toolCalls)
                    ? toolCalls.filter((tc: any) => {
                        const hasResult = tc?.result !== undefined
                            || tc?.output !== undefined
                            || tc?.toolCallResult !== undefined;

                        if (hasResult) return false;

                        const s = tc?.status || tc?.toolCallStatus || '';
                        const isCompleted = s === 'completed'
                            || s === 'done'
                            || s === 'success'
                            || s === 'error';

                        return !isCompleted;
                    })
                    : [];

                // Planning mode requires actual planned tool calls
                const hasToolPlan = pendingToolCalls.length > 0;

                if (!hasToolPlan) return null;

                const responseText = plannerResponse?.response || '';

                // Build plan summary from pending tool calls
                const toolNames = hasToolPlan
                    ? pendingToolCalls.map((tc: any) => tc?.name || tc?.toolName || 'action').join(', ')
                    : '';

                const planTitle = 'Implementation Plan';
                const planSummary = toolNames
                    ? `Planned actions: ${toolNames}`
                    : responseText.slice(0, 200);
                const description = responseText.slice(0, 500);

                return {
                    openText: 'Open',
                    proceedText: 'Proceed',
                    planTitle,
                    planSummary,
                    description,
                };
            }
        }

        return null;
    }
}
