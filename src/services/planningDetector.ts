import { logger } from '../utils/logger';
import { CdpService } from './cdpService';
import { getPendingToolCallsFromPlannerStep, getToolCallName } from './trajectoryToolState';
import {
    type DetectorState,
    type DetectorStateConfig,
    createDetectorState,
    startDetector,
    stopDetector,
    processDetectorResult,
    findLastPlannerStep,
} from './detectorStateManager';

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

    private state: DetectorState<PlanningInfo> = createDetectorState();
    private static readonly CONFIG: DetectorStateConfig = {
        cooldownMs: 5000,
        maxNotifiedKeys: 50,
        label: 'PlanningDetector',
    };

    constructor(options: PlanningDetectorOptions) {
        this.cdpService = options.cdpService;
        this.onPlanningRequired = options.onPlanningRequired;
        this.onResolved = options.onResolved;
    }

    private getToolName(toolCall: any): string {
        return getToolCallName(toolCall);
    }

    private isRunCommandTool(toolCall: any): boolean {
        const toolName = this.getToolName(toolCall);
        if (!toolName) return false;

        return [
            'terminal',
            'command',
            'shell',
            'bash',
            'exec',
            'run_command',
            'runcommand',
            'execute_command',
        ].some((pattern) => toolName.includes(pattern));
    }

    /** Start monitoring (marks active — must be called before evaluate()). */
    start(): void { startDetector(this.state); }

    /** Stop monitoring. */
    async stop(): Promise<void> { stopDetector(this.state); }

    /** Return the last detected planning info. Returns null if nothing has been detected. */
    getLastDetectedInfo(): PlanningInfo | null { return this.state.lastDetectedInfo; }

    /** Returns whether monitoring is currently active. */
    isActive(): boolean { return this.state.isRunning; }

    /**
     * Click the Open button.
     * Uses VS Code command (no DOM operation).
     */
    async clickOpenButton(): Promise<boolean> {
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
    async clickProceedButton(): Promise<boolean> {
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

            // Reuse shared backward-walk to find the latest planner response
            const found = findLastPlannerStep(steps);
            if (!found) return null;

            const { step } = found;
            const responseText =
                step?.plannerResponse?.response
                || step?.response?.text
                || step?.assistantResponse?.text
                || null;
            if (responseText && responseText.length > 50) {
                return responseText.slice(0, 4000);
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
        if (!this.state.isRunning) return;

        try {
            const info = this.extractPlanningFromTrajectory(steps, runStatus);
            const key = info ? `${cascadeId}::${info.planTitle}::${info.planSummary?.slice(0, 50)}` : null;

            processDetectorResult(
                this.state,
                PlanningDetector.CONFIG,
                info,
                key,
                (detected) => this.onPlanningRequired(detected),
                this.onResolved,
            );
        } catch (error) {
            logger.error('[PlanningDetector] Error during evaluation:', error);
        }
    }

    /**
     * Extract planning info from trajectory steps.
     * Returns PlanningInfo if there's an active plan awaiting user decision.
     */
    private extractPlanningFromTrajectory(steps: any[], runStatus: string | null): PlanningInfo | null {
        const found = findLastPlannerStep(steps, runStatus);
        if (!found) return null;

        const { step, index: i } = found;
        const plannerResponse = step?.plannerResponse;
        if (!plannerResponse) return null;

        const pendingToolCalls = getPendingToolCallsFromPlannerStep(steps, i);

        // Planning mode requires actual planned tool calls
        const hasToolPlan = pendingToolCalls.length > 0;

        if (!hasToolPlan) return null;
        if (pendingToolCalls.some((tc: any) => this.isRunCommandTool(tc))) return null;

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
