import { logger } from '../utils/logger';
import { CdpService } from './cdpService';
import { getPendingToolCallsFromPlannerStep, getToolCallName } from './trajectoryToolState';

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
    /** CDP service instance (used only for VS Code commands) */
    cdpService: CdpService;
    /** Callback when a run command dialog is detected */
    onRunCommandRequired: (info: RunCommandInfo) => void;
    /** Callback when a previously detected dialog is resolved (disappeared) */
    onResolved?: () => void;
}

/**
 * Detects "Run command?" state from cascade trajectory data.
 *
 * Zero DOM operations — detection is based on cascade trajectory:
 * When the cascade has status=IDLE and the latest step contains a terminal/command
 * tool call pending approval, the agent is waiting for run command confirmation.
 *
 * This detector is passive: it does not poll. Call `evaluate()` to feed
 * it trajectory data from the TrajectoryStreamRouter.
 *
 * Actions (run/reject) are performed via VS Code extension commands.
 */
export class RunCommandDetector {
    private cdpService: CdpService;
    private onRunCommandRequired: (info: RunCommandInfo) => void;
    private onResolved?: () => void;

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
        this.onRunCommandRequired = options.onRunCommandRequired;
        this.onResolved = options.onResolved;
    }

    /** Start monitoring (marks active — must be called before evaluate()). */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        // Note: notifiedKeys is NOT cleared on start — it persists across
        // stop/start cycles to prevent stale cross-session re-notifications.
    }

    /** Stop monitoring. */
    async stop(): Promise<void> {
        this.isRunning = false;
    }

    /** Return the last detected run command info. */
    getLastDetectedInfo(): RunCommandInfo | null {
        return this.lastDetectedInfo;
    }

    /** Returns whether monitoring is currently active */
    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Evaluate trajectory data to detect run command state.
     * Called by TrajectoryStreamRouter when stream events arrive.
     *
     * @param cascadeId  The active cascade ID
     * @param steps      Trajectory steps array
     * @param runStatus  Cascade run status string
     */
    evaluate(cascadeId: string, steps: any[], runStatus: string | null): void {
        if (!this.isRunning) return;

        try {
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
            logger.error('[RunCommandDetector] Error during evaluation:', error);
        }
    }

    /**
     * Extract run command info from trajectory steps.
     * Looks for terminal/command tool calls when cascade is IDLE.
     */
    private extractRunCommandFromTrajectory(steps: any[], runStatus: string | null): RunCommandInfo | null {
        if (!runStatus || runStatus !== 'CASCADE_RUN_STATUS_IDLE') return null;
        if (steps.length === 0) return null;

        for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i];
            if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') break;

            if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                const pendingToolCalls = getPendingToolCallsFromPlannerStep(steps, i);
                if (pendingToolCalls.length === 0) return null;

                // Find terminal command tool calls
                for (const tc of pendingToolCalls) {
                    const toolName = getToolCallName(tc);
                    const isTerminal = [
                        'terminal', 'command', 'shell', 'bash', 'exec',
                        'run_command', 'runcommand', 'execute_command',
                    ].some((pattern) => toolName.includes(pattern));
                    if (!isTerminal) continue;

                    // Extract command text from tool call arguments
                    const args = this.parseToolCallArgs(tc);
                    const commandText = typeof args === 'string'
                        ? args
                        : args?.command || args?.cmd || args?.script || args?.CommandLine || '';
                    const workingDirectory =
                        args?.cwd
                        || args?.workingDirectory
                        || args?.directory
                        || args?.Cwd
                        || '';

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
                return null;
            }
        }

        return null;
    }

    private parseToolCallArgs(toolCall: any): any {
        const direct = toolCall?.arguments || toolCall?.function?.arguments || toolCall?.input;
        if (direct && typeof direct === 'object') {
            return direct;
        }

        const json = toolCall?.argumentsJson;
        if (typeof json !== 'string' || !json.trim()) {
            return {};
        }

        try {
            return JSON.parse(json);
        } catch {
            return {};
        }
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
}
