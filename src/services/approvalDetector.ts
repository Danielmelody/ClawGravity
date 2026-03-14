import { logger } from '../utils/logger';
import { CdpService } from './cdpService';
import { getPendingToolCallsFromPlannerStep } from './trajectoryToolState';
import {
    type NotificationTracker,
    createNotificationTracker,
    resetTrackerDetection,
    processDetection,
} from './detectorStateManager';

/** Approval button information */
export interface ApprovalInfo {
    /** Allow button text (e.g. "Allow") */
    approveText: string;
    /** Per-conversation allow button text (e.g. "Allow This Conversation") */
    alwaysAllowText?: string;
    /** Deny button text (e.g. "Deny") */
    denyText: string;
    /** Action description (e.g. "write to file.ts") */
    description: string;
}

export interface ApprovalDetectorOptions {
    /** CDP service instance (used only for VS Code commands) */
    cdpService: CdpService;
    /** Callback when an approval button is detected */
    onApprovalRequired: (info: ApprovalInfo) => void;
    /** Callback when a previously detected approval is resolved (buttons disappeared) */
    onResolved?: () => void;
}

/**
 * Detects approval-pending state from cascade trajectory data.
 *
 * Zero DOM operations — detection is based on cascade trajectory status:
 * When the cascade has status=IDLE and the latest assistant step contains
 * tool calls, the agent is waiting for user approval.
 *
 * This detector is passive: it does not poll. Call `evaluate()` to feed
 * it trajectory data from the TrajectoryStreamRouter.
 *
 * Actions (approve/deny) are performed via VS Code extension commands.
 */
export class ApprovalDetector {
    private cdpService: CdpService;
    private onApprovalRequired: (info: ApprovalInfo) => void;
    private onResolved?: () => void;

    private isRunning: boolean = false;
    private tracker: NotificationTracker<ApprovalInfo> = createNotificationTracker();
    private static readonly MAX_NOTIFIED_KEYS = 50;

    constructor(options: ApprovalDetectorOptions) {
        this.cdpService = options.cdpService;
        this.onApprovalRequired = options.onApprovalRequired;
        this.onResolved = options.onResolved;
    }

    /**
     * Start monitoring (marks active — must be called before evaluate()).
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        resetTrackerDetection(this.tracker);
        // Note: notifiedKeys is NOT cleared on start — it persists across
        // stop/start cycles to prevent stale cross-session re-notifications.
    }

    /**
     * Stop monitoring.
     */
    async stop(): Promise<void> {
        this.isRunning = false;
    }

    /**
     * Return the last detected approval button info.
     * Returns null if nothing has been detected.
     */
    getLastDetectedInfo(): ApprovalInfo | null {
        return this.tracker.lastDetectedInfo;
    }

    /**
     * Evaluate trajectory data to detect approval-pending state.
     * Called by TrajectoryStreamRouter when stream events arrive.
     *
     * @param cascadeId  The active cascade ID
     * @param steps      Trajectory steps array
     * @param runStatus  Cascade run status string
     */
    evaluate(cascadeId: string, steps: unknown[], runStatus: string | null): void {
        if (!this.isRunning) return;

        try {
            const info = this.extractApprovalFromTrajectory(steps, runStatus);

            processDetection(
                this.tracker,
                info,
                (i) => `${cascadeId}::${i.approveText}::${i.description}`,
                (i) => this.onApprovalRequired(i),
                this.onResolved,
                ApprovalDetector.MAX_NOTIFIED_KEYS,
            );
        } catch (error) {
            logger.error('[ApprovalDetector] Error during evaluation:', error);
        }
    }

    /**
     * Extract approval info from trajectory steps.
     * Returns ApprovalInfo if the cascade is waiting for tool-use approval, null otherwise.
     */
    private extractApprovalFromTrajectory(steps: unknown[], runStatus: string | null): ApprovalInfo | null {
        if (!runStatus || runStatus !== 'CASCADE_RUN_STATUS_IDLE') return null;
        if (steps.length === 0) return null;

        // Walk backwards from the last step to find pending approval
        for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i];

            // Skip user input steps
            if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') break;

            // Check planner response for tool calls
            if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                let pendingToolCalls = getPendingToolCallsFromPlannerStep(steps, i);

                // Exclude terminal commands - they are handled exclusively by RunCommandDetector
                pendingToolCalls = pendingToolCalls.filter((tc: unknown) => {
                    const tcObj = tc as Record<string, unknown>;
                    const tName = tcObj?.name || (tcObj as { toolName?: string })?.toolName || (tcObj as { function?: { name?: string } })?.function?.name;
                    return tName !== 'antigravity.terminalCommand.run' &&
                           tName !== 'run_terminal_command' &&
                           tName !== 'run_command';
                });

                if (pendingToolCalls.length === 0) return null;

                const responseText = typeof step?.plannerResponse?.response === 'string'
                    ? step.plannerResponse.response.trim()
                    : '';

                // Planning mode already surfaces PLANNER_RESPONSE steps that contain
                // a generated plan plus pending tool calls. Ignore those here so the
                // user does not get a duplicate Approval Required card for the same state.
                if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && responseText.length > 0) {
                    return null;
                }

                // Build description from tool call details
                const toolNames = pendingToolCalls.map((tc: unknown) => {
                    const tcObj = tc as Record<string, unknown>;
                    return tcObj?.name || (tcObj as { toolName?: string })?.toolName || (tcObj as { function?: { name?: string } })?.function?.name || 'tool';
                });
                const description = toolNames.length === 1
                    ? `Tool: ${toolNames[0]}`
                    : `Tools: ${toolNames.join(', ')}`;

                return {
                    approveText: 'Allow',
                    alwaysAllowText: 'Allow This Conversation',
                    denyText: 'Deny',
                    description,
                };
            }
        }

        return null;
    }

    /**
     * Approve the current agent step via VS Code command.
     * Uses `antigravity.agent.acceptAgentStep` from the verified SDK.
     */
    async approveButton(): Promise<boolean> {
        try {
            const result = await this.cdpService.executeVscodeCommand('antigravity.agent.acceptAgentStep');
            if (result?.ok) {
                logger.debug('[ApprovalDetector] Approved via VS Code command');
                return true;
            }
            return false;
        } catch (error) {
            logger.error('[ApprovalDetector] Approve command failed:', error);
            return false;
        }
    }

    /**
     * Select "Allow This Conversation / Always Allow".
     * Executes the accept command — this acts as a full-session allow.
     */
    async alwaysAllowButton(): Promise<boolean> {
        // No DOM operations — use the same VS Code command as approve
        return this.approveButton();
    }

    /**
     * Reject the current agent step via VS Code command.
     * Uses `antigravity.agent.rejectAgentStep` from the verified SDK.
     */
    async denyButton(): Promise<boolean> {
        try {
            const result = await this.cdpService.executeVscodeCommand('antigravity.agent.rejectAgentStep');
            if (result?.ok) {
                logger.debug('[ApprovalDetector] Denied via VS Code command');
                return true;
            }
            return false;
        } catch (error) {
            logger.error('[ApprovalDetector] Deny command failed:', error);
            return false;
        }
    }

    /** Returns whether monitoring is currently active */
    isActive(): boolean {
        return this.isRunning;
    }
}
