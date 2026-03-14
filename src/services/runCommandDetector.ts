import { logger } from '../utils/logger';
import { CdpService } from './cdpService';
import { runVscodeCommand } from './baseDetector';
import { getPendingToolCallsFromPlannerStep, getToolCallName } from './trajectoryToolState';
import {
    type NotificationTracker,
    createNotificationTracker,
    resetTrackerDetection,
    processDetection,
    findLastPlannerStep,
} from './detectorStateManager';

/** Run command dialog information */
export interface RunCommandInfo {
    commandText: string;
    workingDirectory: string;
    runText: string;
    rejectText: string;
}

export interface RunCommandDetectorOptions {
    cdpService: CdpService;
    onRunCommandRequired: (info: RunCommandInfo) => void;
    onResolved?: () => void;
}

/** Patterns that identify a terminal command tool */
const TERMINAL_PATTERNS = [
    'terminal', 'command', 'shell', 'bash', 'exec',
    'run_command', 'runcommand', 'execute_command',
];

/**
 * Detects "Run command?" state from cascade trajectory data.
 * Zero DOM operations — detection is based on cascade trajectory.
 */
export class RunCommandDetector {
    private cdpService: CdpService;
    private onRunCommandRequired: (info: RunCommandInfo) => void;
    private onResolved?: () => void;

    private isRunning = false;
    private tracker: NotificationTracker<RunCommandInfo> = createNotificationTracker();
    private static readonly MAX_NOTIFIED_KEYS = 50;

    constructor(options: RunCommandDetectorOptions) {
        this.cdpService = options.cdpService;
        this.onRunCommandRequired = options.onRunCommandRequired;
        this.onResolved = options.onResolved;
    }

    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        resetTrackerDetection(this.tracker);
    }

    async stop(): Promise<void> { this.isRunning = false; }
    getLastDetectedInfo(): RunCommandInfo | null { return this.tracker.lastDetectedInfo; }
    isActive(): boolean { return this.isRunning; }

    evaluate(cascadeId: string, steps: unknown[], runStatus: string | null): void {
        if (!this.isRunning) return;
        try {
            const info = this.extractRunCommandFromTrajectory(steps, runStatus);
            processDetection(
                this.tracker, info,
                (i) => `${cascadeId}::${i.commandText}::${i.workingDirectory}`,
                (i) => this.onRunCommandRequired(i),
                this.onResolved,
                RunCommandDetector.MAX_NOTIFIED_KEYS,
            );
        } catch (error) {
            logger.error('[RunCommandDetector] Error during evaluation:', error);
        }
    }

    private extractRunCommandFromTrajectory(steps: unknown[], runStatus: string | null): RunCommandInfo | null {
        const found = findLastPlannerStep(steps, runStatus);
        if (!found) return null;

        const { index: i } = found;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pendingToolCalls = getPendingToolCallsFromPlannerStep(steps as unknown as any[], i) as unknown[];
        if (pendingToolCalls.length === 0) return null;

        for (const tc of pendingToolCalls) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const toolName = getToolCallName(tc as any);
            if (!TERMINAL_PATTERNS.some((p) => toolName.includes(p))) continue;

            const args = this.parseToolCallArgs(tc) as Record<string, unknown> | string;
            const argsRecord = typeof args === 'object' && args !== null ? args : {};
            const commandText = typeof args === 'string'
                ? args
                : argsRecord.command || argsRecord.cmd || argsRecord.script || argsRecord.CommandLine || '';
            const workingDirectory =
                argsRecord.cwd || argsRecord.workingDirectory || argsRecord.directory || argsRecord.Cwd || '';

            const trimmedCommand = String(commandText).trim();
            if (!trimmedCommand) continue;

            return {
                commandText: trimmedCommand,
                workingDirectory: String(workingDirectory).trim(),
                runText: 'Run',
                rejectText: 'Reject',
            };
        }
        return null;
    }

    private parseToolCallArgs(toolCall: unknown): unknown {
        const tcRecord = toolCall as Record<string, unknown> | null | undefined;
        const tcFunction = tcRecord?.function as Record<string, unknown> | undefined;
        const direct = tcRecord?.arguments || tcFunction?.arguments || tcRecord?.input;
        if (direct && typeof direct === 'object') return direct;

        const json = tcRecord?.argumentsJson;
        if (typeof json !== 'string' || !json.trim()) return {};
        try { return JSON.parse(json); } catch { return {}; }
    }

    // ─── Actions (using shared CDP helper) ───────────────────────────

    runButton(): Promise<boolean> {
        return runVscodeCommand(this.cdpService, 'antigravity.terminalCommand.run', 'RunCommandDetector');
    }

    rejectButton(): Promise<boolean> {
        return runVscodeCommand(this.cdpService, 'antigravity.terminalCommand.reject', 'RunCommandDetector');
    }
}
