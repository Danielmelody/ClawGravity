import { logger } from '../utils/logger';
import { CdpService } from './cdpService';
import { runVscodeCommand } from './baseDetector';
import { getPendingToolCallsFromPlannerStep, getToolCallName, type ToolCall } from './trajectoryToolState';
import {
    type DetectorState,
    type DetectorStateConfig,
    createDetectorState,
    startDetector,
    stopDetector,
    processDetectorResult,
    findLastPlannerStep,
} from './detectorStateManager';

/** Generic trajectory step type */
interface TrajectoryStep {
    type?: string;
    status?: string;
    plannerResponse?: { response?: string; toolCalls?: ToolCall[] };
    response?: { text?: string; error?: unknown };
    assistantResponse?: { text?: string };
    error?: unknown;
    [key: string]: unknown;
}

/** Planning mode button information */
export interface PlanningInfo {
    openText: string;
    proceedText: string;
    planTitle: string;
    planSummary: string;
    description: string;
}

export interface PlanningDetectorOptions {
    cdpService: CdpService;
    onPlanningRequired: (info: PlanningInfo) => void;
    onResolved?: () => void;
}

/** Patterns that identify a run-command tool */
const RUN_COMMAND_PATTERNS = [
    'terminal', 'command', 'shell', 'bash', 'exec',
    'run_command', 'runcommand', 'execute_command',
];

/**
 * Detects planning mode state from cascade trajectory data.
 * Zero DOM operations — detection is based on cascade trajectory.
 */
export class PlanningDetector {
    private cdpService: CdpService;
    private onPlanningRequired: (info: PlanningInfo) => void;
    private onResolved?: () => void;

    private state: DetectorState<PlanningInfo> = createDetectorState();
    private static readonly CONFIG: DetectorStateConfig = {
        cooldownMs: 5000, maxNotifiedKeys: 50, label: 'PlanningDetector',
    };

    constructor(options: PlanningDetectorOptions) {
        this.cdpService = options.cdpService;
        this.onPlanningRequired = options.onPlanningRequired;
        this.onResolved = options.onResolved;
    }

    private isRunCommandTool(toolCall: unknown): boolean {
        const toolName = getToolCallName(toolCall as ToolCall);
        return toolName ? RUN_COMMAND_PATTERNS.some((p) => toolName.includes(p)) : false;
    }

    start(): void { startDetector(this.state); }
    async stop(): Promise<void> { stopDetector(this.state); }
    getLastDetectedInfo(): PlanningInfo | null { return this.state.lastDetectedInfo; }
    isActive(): boolean { return this.state.isRunning; }

    clickOpenButton(): Promise<boolean> {
        return runVscodeCommand(this.cdpService, 'antigravity.command.openPlan', 'PlanningDetector');
    }

    clickProceedButton(): Promise<boolean> {
        return runVscodeCommand(this.cdpService, 'antigravity.command.accept', 'PlanningDetector');
    }

    /**
     * Extract plan content from the trajectory.
     */
    async extractPlanContent(): Promise<string | null> {
        try {
            const client = await this.cdpService.getGrpcClient();
            if (!client) return null;
            const cascadeId = await this.cdpService.getActiveCascadeId();
            if (!cascadeId) return null;

            const trajectoryResp = await client.rawRPC('GetCascadeTrajectory', { cascadeId }) as { trajectory?: { steps?: unknown[] } } | undefined;
            const trajectory = trajectoryResp?.trajectory ?? trajectoryResp as { steps?: unknown[] } | undefined;
            const steps = Array.isArray(trajectory?.steps) ? trajectory.steps as TrajectoryStep[] : [];

            const found = findLastPlannerStep(steps);
            if (!found) return null;

            const { step } = found as { step: TrajectoryStep; index: number };
            const responseText = step?.plannerResponse?.response || step?.response?.text || step?.assistantResponse?.text || null;
            return responseText && responseText.length > 50 ? responseText.slice(0, 4000) : null;
        } catch (error) {
            logger.error('[PlanningDetector] Error extracting plan content:', error);
            return null;
        }
    }

    evaluate(cascadeId: string, steps: unknown[], runStatus: string | null): void {
        if (!this.state.isRunning) return;
        try {
            const info = this.extractPlanningFromTrajectory(steps, runStatus);
            const key = info ? `${cascadeId}::${info.planTitle}::${info.planSummary?.slice(0, 50)}` : null;
            processDetectorResult(this.state, PlanningDetector.CONFIG, info, key,
                (detected) => this.onPlanningRequired(detected), this.onResolved);
        } catch (error) {
            logger.error('[PlanningDetector] Error during evaluation:', error);
        }
    }

    private extractPlanningFromTrajectory(steps: unknown[], runStatus: string | null): PlanningInfo | null {
        const found = findLastPlannerStep(steps, runStatus);
        if (!found) return null;

        const { step, index: i } = found as { step: TrajectoryStep; index: number };
        if (!step?.plannerResponse) return null;

        const pendingToolCalls = getPendingToolCallsFromPlannerStep(steps as TrajectoryStep[], i);
        if (pendingToolCalls.length === 0) return null;
        if (pendingToolCalls.some((tc: unknown) => this.isRunCommandTool(tc))) return null;

        const responseText = step.plannerResponse?.response || '';
        const toolNames = pendingToolCalls.map((tc: unknown) =>
            (tc as Record<string, unknown>)?.name || (tc as Record<string, unknown>)?.toolName || 'action',
        ).join(', ');

        return {
            openText: 'Open',
            proceedText: 'Proceed',
            planTitle: 'Implementation Plan',
            planSummary: toolNames ? `Planned actions: ${toolNames}` : responseText.slice(0, 200),
            description: responseText.slice(0, 500),
        };
    }
}
