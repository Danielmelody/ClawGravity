import { logger } from '../utils/logger';
import { CdpService } from './cdpService';

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
    /** Key of the last detected approval state (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full ApprovalInfo from the last detection */
    private lastDetectedInfo: ApprovalInfo | null = null;
    /** Set of keys that have already been notified (prevents cross-session re-fires) */
    private notifiedKeys: Set<string> = new Set();
    /** Maximum size of notifiedKeys before pruning oldest entries */
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
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
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
        return this.lastDetectedInfo;
    }

    /**
     * Evaluate trajectory data to detect approval-pending state.
     * Called by TrajectoryStreamRouter when stream events arrive.
     *
     * @param cascadeId  The active cascade ID
     * @param steps      Trajectory steps array
     * @param runStatus  Cascade run status string
     */
    evaluate(cascadeId: string, steps: any[], runStatus: string | null): void {
        if (!this.isRunning) return;

        try {
            const info = this.extractApprovalFromTrajectory(steps, runStatus);

            if (info) {
                // Include cascadeId in the key to prevent cross-session re-fires:
                // When cascade changes (new conversation), old detections won't match.
                // When the same cascade transiently resolves then re-enters IDLE,
                // notifiedKeys prevents duplicate notifications.
                const key = `${cascadeId}::${info.approveText}::${info.description}`;
                if (key !== this.lastDetectedKey && !this.notifiedKeys.has(key)) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    this.notifiedKeys.add(key);
                    // Prune oldest entries if set grows too large
                    if (this.notifiedKeys.size > ApprovalDetector.MAX_NOTIFIED_KEYS) {
                        const first = this.notifiedKeys.values().next().value;
                        if (first) this.notifiedKeys.delete(first);
                    }
                    this.onApprovalRequired(info);
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
            logger.error('[ApprovalDetector] Error during evaluation:', error);
        }
    }

    /**
     * Extract approval info from trajectory steps.
     * Returns ApprovalInfo if the cascade is waiting for tool-use approval, null otherwise.
     */
    private extractApprovalFromTrajectory(steps: any[], runStatus: string | null): ApprovalInfo | null {
        if (!runStatus || runStatus !== 'CASCADE_RUN_STATUS_IDLE') return null;
        if (steps.length === 0) return null;

        // Walk backwards from the last step to find pending approval
        for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i];

            // Skip user input steps
            if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') break;

            // Check planner response for tool calls
            if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                const toolCalls = step?.plannerResponse?.toolCalls;
                if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;

                // Check if any tool call is awaiting acceptance
                const pendingToolCalls = toolCalls.filter((tc: any) => {
                    // Check if the tool call already has a result
                    const hasResult = tc?.result !== undefined
                        || tc?.output !== undefined
                        || tc?.toolCallResult !== undefined;

                    if (hasResult) return false;

                    const status = tc?.status || tc?.toolCallStatus || '';
                    const isCompleted = status === 'completed'
                        || status === 'done'
                        || status === 'success'
                        || status === 'error';

                    return !isCompleted;
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
                const toolNames = pendingToolCalls.map((tc: any) =>
                    tc?.name || tc?.toolName || tc?.function?.name || 'tool'
                );
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
    async approveButton(_buttonText?: string): Promise<boolean> {
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
    async denyButton(_buttonText?: string): Promise<boolean> {
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
