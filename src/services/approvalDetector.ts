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
    /** CDP service instance (used only for gRPC client access and VS Code commands) */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 2000ms) */
    pollIntervalMs?: number;
    /** Callback when an approval button is detected */
    onApprovalRequired: (info: ApprovalInfo) => void;
    /** Callback when a previously detected approval is resolved (buttons disappeared) */
    onResolved?: () => void;
}

/**
 * Class that detects approval-pending state via gRPC trajectory polling.
 *
 * Zero DOM operations — detection is based on cascade trajectory status:
 * When the cascade has status=IDLE and the latest assistant step contains
 * tool calls, the agent is waiting for user approval.
 *
 * Actions (approve/deny) are performed via VS Code extension commands.
 */
export class ApprovalDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private onApprovalRequired: (info: ApprovalInfo) => void;
    private onResolved?: () => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** Key of the last detected approval state (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full ApprovalInfo from the last detection */
    private lastDetectedInfo: ApprovalInfo | null = null;

    constructor(options: ApprovalDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.onApprovalRequired = options.onApprovalRequired;
        this.onResolved = options.onResolved;
    }

    /**
     * Start monitoring.
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        this.schedulePoll();
    }

    /**
     * Stop monitoring.
     */
    async stop(): Promise<void> {
        this.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /**
     * Return the last detected approval button info.
     * Returns null if nothing has been detected.
     */
    getLastDetectedInfo(): ApprovalInfo | null {
        return this.lastDetectedInfo;
    }

    /** Schedule the next poll */
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
     *   2. Check if status=IDLE and latest step has toolCalls (waiting for approval)
     *   3. Notify via callback only on new detection (prevent duplicates)
     *   4. Reset lastDetectedKey when approval is resolved
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

            // Detect approval-pending state:
            // Cascade is IDLE + last assistant step has tool calls = waiting for user approval
            const info = this.extractApprovalFromTrajectory(steps, runStatus);

            if (info) {
                const key = `${info.approveText}::${info.description}`;
                if (key !== this.lastDetectedKey) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
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
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected') || message.includes('Not connected')) {
                return;
            }
            logger.error('[ApprovalDetector] Error during gRPC polling:', error);
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
                if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;

                // Check if any tool call is awaiting acceptance
                const pendingToolCalls = toolCalls.filter((tc: any) => {
                    // If tool call has no result/output yet, it's pending
                    const status = tc?.status || tc?.toolCallStatus;
                    return !status || status === 'pending' || status === 'awaiting_confirmation';
                });

                if (pendingToolCalls.length === 0) continue;

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
