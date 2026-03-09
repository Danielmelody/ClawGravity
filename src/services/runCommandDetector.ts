import { logger } from '../utils/logger';
import { CdpService } from './cdpService';

/** Run command dialog information */
export interface RunCommandInfo {
    /** The command text to be executed (e.g. "python3 -m http.server 8000") */
    commandText: string;
    /** Working directory shown in the dialog (e.g. "~/Code/login") */
    workingDirectory: string;
    /** Run button text (e.g. "Run") */
    runText: string;
    /** Reject button text (e.g. "Reject") */
    rejectText: string;
}

export interface RunCommandDetectorOptions {
    /** CDP service instance (used only for gRPC client access and VS Code commands) */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 2000ms) */
    pollIntervalMs?: number;
    /** Callback when a run command dialog is detected */
    onRunCommandRequired: (info: RunCommandInfo) => void;
    /** Callback when a previously detected dialog is resolved (disappeared) */
    onResolved?: () => void;
}

/**
 * Class that detects "Run command?" state via gRPC trajectory polling.
 *
 * Zero DOM operations — detection is based on cascade trajectory:
 * When the cascade has status=IDLE and the latest step contains a terminal/command
 * tool call pending approval, the agent is waiting for run command confirmation.
 *
 * Actions (run/reject) are performed via VS Code extension commands.
 */
export class RunCommandDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private onRunCommandRequired: (info: RunCommandInfo) => void;
    private onResolved?: () => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** Key of the last detected dialog (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full RunCommandInfo from the last detection */
    private lastDetectedInfo: RunCommandInfo | null = null;
    /** Set of keys that have already been notified (prevents cross-session re-fires) */
    private notifiedKeys: Set<string> = new Set();
    /** Maximum size of notifiedKeys before pruning oldest entries */
    private static readonly MAX_NOTIFIED_KEYS = 50;

    constructor(options: RunCommandDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.onRunCommandRequired = options.onRunCommandRequired;
        this.onResolved = options.onResolved;
    }

    /** Start monitoring. */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        // Note: notifiedKeys is NOT cleared on start — it persists across
        // stop/start cycles to prevent stale cross-session re-notifications.
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

    /** Return the last detected run command info. */
    getLastDetectedInfo(): RunCommandInfo | null {
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
     *   2. Check if status=IDLE and latest step has a terminal command tool call
     *   3. Notify via callback only on new detection (prevent duplicates)
     *   4. Reset when command dialog is resolved
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

            const info = this.extractRunCommandFromTrajectory(steps, runStatus);

            if (info) {
                // Include cascadeId in the key to prevent cross-session re-fires:
                // When cascade changes (new conversation), old detections won't match.
                // When the same cascade transiently resolves then re-enters IDLE,
                // notifiedKeys prevents duplicate notifications.
                const key = `${cascadeId}::${info.commandText}::${info.workingDirectory}`;
                if (key !== this.lastDetectedKey && !this.notifiedKeys.has(key)) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    this.notifiedKeys.add(key);
                    // Prune oldest entries if set grows too large
                    if (this.notifiedKeys.size > RunCommandDetector.MAX_NOTIFIED_KEYS) {
                        const first = this.notifiedKeys.values().next().value;
                        if (first) this.notifiedKeys.delete(first);
                    }
                    this.onRunCommandRequired(info);
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
            logger.error('[RunCommandDetector] Error during gRPC polling:', error);
        }
    }

    /**
     * Extract run command info from trajectory steps.
     * Looks for terminal/command tool calls when cascade is IDLE.
     */
    private extractRunCommandFromTrajectory(steps: any[], runStatus: string | null): RunCommandInfo | null {
        if (!runStatus || runStatus !== 'CASCADE_RUN_STATUS_IDLE') return null;
        if (steps.length === 0) return null;

        // Terminal command tool name patterns
        const TERMINAL_TOOL_PATTERNS = [
            'terminal', 'command', 'shell', 'bash', 'exec',
            'run_command', 'runcommand', 'execute_command',
        ];

        for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i];
            if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') break;

            if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                const toolCalls = step?.plannerResponse?.toolCalls;
                if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;

                // Find terminal command tool calls
                for (const tc of toolCalls) {
                    const toolName = (tc?.name || tc?.toolName || tc?.function?.name || '').toLowerCase();
                    const isTerminal = TERMINAL_TOOL_PATTERNS.some(p => toolName.includes(p));
                    if (!isTerminal) continue;

                    // Check if the tool call already has a result
                    const hasResult = tc?.result !== undefined
                        || tc?.output !== undefined
                        || tc?.toolCallResult !== undefined;

                    if (hasResult) continue;

                    const status = tc?.status || tc?.toolCallStatus || '';
                    const isCompleted = status === 'completed'
                        || status === 'done'
                        || status === 'success'
                        || status === 'error';

                    if (isCompleted) continue;

                    // Require an explicit pending-like status to avoid false positives
                    // on tool calls that are completed but missing a status field.
                    const isPending = status === 'pending'
                        || status === 'waiting'
                        || status === 'needs_approval'
                        || status === 'awaiting_confirmation';

                    if (!isPending) continue;

                    // Extract command text from tool call arguments
                    const args = tc?.arguments || tc?.function?.arguments || tc?.input || {};
                    const commandText = typeof args === 'string'
                        ? args
                        : args?.command || args?.cmd || args?.script || '';
                    const workingDirectory = args?.cwd || args?.workingDirectory || args?.directory || '';

                    // Skip if we couldn't extract a meaningful command
                    const trimmedCommand = String(commandText).trim();
                    if (!trimmedCommand) continue;

                    return {
                        commandText: trimmedCommand,
                        workingDirectory: String(workingDirectory).trim(),
                        runText: 'Run',
                        rejectText: 'Reject',
                    };
                }

                // If we reach the end of the latest planner response and found
                // no pending terminal commands, then there are none awaiting user action.
                // Do not search older responses from this same turn.
                return null;
            }
        }

        return null;
    }

    /**
     * Accept/run the pending terminal command via VS Code command.
     * Uses `antigravity.terminalCommand.run` from the verified SDK.
     */
    async runButton(_buttonText?: string): Promise<boolean> {
        try {
            const result = await this.cdpService.executeVscodeCommand('antigravity.terminalCommand.run');
            if (result?.ok) {
                logger.debug('[RunCommandDetector] Ran via VS Code command');
                return true;
            }
            return false;
        } catch (error) {
            logger.error('[RunCommandDetector] Run command failed:', error);
            return false;
        }
    }

    /**
     * Reject the pending terminal command via VS Code command.
     * Uses `antigravity.terminalCommand.reject` from the verified SDK.
     */
    async rejectButton(_buttonText?: string): Promise<boolean> {
        try {
            const result = await this.cdpService.executeVscodeCommand('antigravity.terminalCommand.reject');
            if (result?.ok) {
                logger.debug('[RunCommandDetector] Rejected via VS Code command');
                return true;
            }
            return false;
        } catch (error) {
            logger.error('[RunCommandDetector] Reject command failed:', error);
            return false;
        }
    }

    /** Returns whether monitoring is currently active */
    isActive(): boolean {
        return this.isRunning;
    }
}
