import { CdpService } from './cdpService';
import { runVscodeCommand } from './baseDetector';
import { getPendingToolCallsFromPlannerStep, type TrajectoryStep } from './trajectoryToolState';
import {
    NotificationDetector,
} from './detectorStateManager';

/** Approval button information */
export interface ApprovalInfo {
    approveText: string;
    alwaysAllowText?: string;
    denyText: string;
    description: string;
}

export interface ApprovalDetectorOptions {
    cdpService: CdpService;
    onApprovalRequired: (info: ApprovalInfo) => void;
    onResolved?: () => void;
}

/** Tool names handled exclusively by RunCommandDetector */
const TERMINAL_TOOL_NAMES = [
    'antigravity.terminalCommand.run',
    'run_terminal_command',
    'run_command',
];

/**
 * Detects approval-pending state from cascade trajectory data.
 *
 * Zero DOM operations — detection is based on cascade trajectory status:
 * When the cascade has status=IDLE and the latest assistant step contains
 * tool calls, the agent is waiting for user approval.
 *
 * Actions (approve/deny) are performed via VS Code extension commands.
 */
export class ApprovalDetector extends NotificationDetector<ApprovalInfo> {
    private cdpService: CdpService;
    private onApprovalRequired: (info: ApprovalInfo) => void;

    constructor(options: ApprovalDetectorOptions) {
        super('ApprovalDetector', options.onResolved);
        this.cdpService = options.cdpService;
        this.onApprovalRequired = options.onApprovalRequired;
    }

    evaluate(cascadeId: string, steps: unknown[], runStatus: string | null): void {
        this.processEvaluation(
            cascadeId,
            steps,
            runStatus,
            (detectorSteps, detectorRunStatus) => this.extractApprovalFromTrajectory(detectorSteps, detectorRunStatus),
            (currentCascadeId, info) => `${currentCascadeId}::${info.approveText}::${info.description}`,
            (info) => this.onApprovalRequired(info),
        );
    }

    private extractApprovalFromTrajectory(steps: unknown[], runStatus: string | null): ApprovalInfo | null {
        if (!runStatus || runStatus !== 'CASCADE_RUN_STATUS_IDLE') return null;
        if (steps.length === 0) return null;

        for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i] as TrajectoryStep | undefined;
            if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') break;

            if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                let pendingToolCalls = getPendingToolCallsFromPlannerStep(steps as TrajectoryStep[], i);

                // Exclude terminal commands — handled by RunCommandDetector
                pendingToolCalls = pendingToolCalls.filter((tc: unknown) => {
                    const tcObj = tc as Record<string, unknown>;
                    const tName = tcObj?.name || (tcObj as { toolName?: string })?.toolName || (tcObj as { function?: { name?: string } })?.function?.name;
                    return !TERMINAL_TOOL_NAMES.includes(tName as string);
                });

                if (pendingToolCalls.length === 0) return null;

                const responseText = typeof step?.plannerResponse?.response === 'string'
                    ? step.plannerResponse.response.trim()
                    : '';

                if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && responseText.length > 0) return null;

                const toolNames = pendingToolCalls.map((tc: unknown) => {
                    const tcObj = tc as Record<string, unknown>;
                    return tcObj?.name || (tcObj as { toolName?: string })?.toolName || (tcObj as { function?: { name?: string } })?.function?.name || 'tool';
                });
                const description = toolNames.length === 1
                    ? `Tool: ${toolNames[0]}`
                    : `Tools: ${toolNames.join(', ')}`;

                return { approveText: 'Allow', alwaysAllowText: 'Allow This Conversation', denyText: 'Deny', description };
            }
        }
        return null;
    }

    // ─── Actions (using shared CDP helper) ───────────────────────────

    approveButton(): Promise<boolean> { return runVscodeCommand(this.cdpService, 'antigravity.agent.acceptAgentStep', 'ApprovalDetector'); }
    alwaysAllowButton(): Promise<boolean> { return this.approveButton(); }
    denyButton(): Promise<boolean> { return runVscodeCommand(this.cdpService, 'antigravity.agent.rejectAgentStep', 'ApprovalDetector'); }
}
