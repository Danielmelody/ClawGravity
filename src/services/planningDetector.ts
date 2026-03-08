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
    /** CDP service instance (used only for gRPC client access and VS Code commands) */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 2000ms) */
    pollIntervalMs?: number;
    /** Callback when planning buttons are detected */
    onPlanningRequired: (info: PlanningInfo) => void;
    /** Callback when a previously detected planning state is resolved */
    onResolved?: () => void;
}

/**
 * Detects planning mode state via gRPC trajectory polling.
 *
 * Zero DOM operations — detection is based on cascade trajectory:
 * When the cascade has a planner response with a plan (toolCalls listing
 * planned actions) and status=IDLE, planning mode is active.
 *
 * Actions are performed via VS Code extension commands.
 */
export class PlanningDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private onPlanningRequired: (info: PlanningInfo) => void;
    private onResolved?: () => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** Key of the last detected planning info (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full PlanningInfo from the last detection */
    private lastDetectedInfo: PlanningInfo | null = null;
    /** Timestamp of last notification (for cooldown-based dedup) */
    private lastNotifiedAt: number = 0;
    /** Cooldown period in ms to suppress duplicate notifications */
    private static readonly COOLDOWN_MS = 5000;

    constructor(options: PlanningDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.onPlanningRequired = options.onPlanningRequired;
        this.onResolved = options.onResolved;
    }

    /** Start monitoring. */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        this.lastNotifiedAt = 0;
        this.schedulePoll();
    }

    /** Stop monitoring. */
    async stop(): Promise<void> {
        this.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
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

    /** Schedule the next poll. */
    private schedulePoll(): void {
        if (!this.isRunning) return;
        this.pollTimer = setTimeout(async () => {
            await this.poll();
            if (this.isRunning) {
                this.schedulePoll();
            }
        }, this.pollIntervalMs);
    }

    /**
     * Single poll iteration via gRPC trajectory:
     *   1. Get active cascade trajectory via gRPC
     *   2. Check if the latest step contains a plan (planner response with toolCalls)
     *   3. Notify via callback only on new detection (prevent duplicates)
     *   4. Reset when planning state is resolved
     */
    private async poll(): Promise<void> {
        try {
            const client = await this.cdpService.getGrpcClient();
            if (!client) return;

            const cascadeId = await this.cdpService.getActiveCascadeId();
            if (!cascadeId) return;

            const trajectoryResp = await client.rawRPC('GetCascadeTrajectory', { cascadeId });
            const trajectory = trajectoryResp?.trajectory ?? trajectoryResp;
            const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];

            const runStatus =
                trajectory?.cascadeRunStatus
                || trajectoryResp?.cascadeRunStatus
                || trajectory?.status
                || trajectoryResp?.status
                || null;

            const info = this.extractPlanningFromTrajectory(steps, runStatus);

            if (info) {
                const key = `${info.planTitle}::${info.planSummary?.slice(0, 50)}`;
                const now = Date.now();
                const withinCooldown = (now - this.lastNotifiedAt) < PlanningDetector.COOLDOWN_MS;
                if (key !== this.lastDetectedKey && !withinCooldown) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    this.lastNotifiedAt = now;
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
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected') || message.includes('Not connected')) {
                return;
            }
            logger.error('[PlanningDetector] Error during gRPC polling:', error);
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
                if (!plannerResponse) continue;

                const toolCalls = plannerResponse?.toolCalls;
                const responseText = plannerResponse?.response || '';

                // Planning mode is indicated by a planner response with planned tool calls
                // and/or a substantial plan text in the response
                const hasToolPlan = Array.isArray(toolCalls) && toolCalls.length > 0;
                const hasPlanText = responseText.length > 100;

                if (!hasToolPlan && !hasPlanText) continue;

                // Build plan summary from tool calls
                const toolNames = hasToolPlan
                    ? toolCalls.map((tc: any) => tc?.name || tc?.toolName || 'action').join(', ')
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
