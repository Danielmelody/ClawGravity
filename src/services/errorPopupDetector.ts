import { logger } from '../utils/logger';
import { CdpService } from './cdpService';
import { runVscodeCommand } from './baseDetector';
import {
    DetectorState,
    DetectorStateConfig,
    createDetectorState,
    startDetector,
    stopDetector,
    processDetectorResult,
} from './detectorStateManager';

/** Generic trajectory step type */
interface TrajectoryStep {
    type?: string;
    status?: string;
    cascadeRunStatus?: string;
    error?: unknown;
    plannerResponse?: { response?: string; error?: unknown };
    response?: { text?: string; error?: unknown };
    assistantResponse?: { text?: string };
    [key: string]: unknown;
}

/** Error popup information */
export interface ErrorPopupInfo {
    title: string;
    body: string;
    buttons: string[];
}

export interface ErrorPopupDetectorOptions {
    cdpService: CdpService;
    onErrorPopup: (info: ErrorPopupInfo) => void;
    onResolved?: () => void;
}

/** Error patterns in response text */
const ERROR_PATTERNS = [
    'agent terminated', 'execution terminated', 'execution failed',
    'terminated due to error', 'unexpected error', 'something went wrong',
    'an error occurred', 'network issue', 'network error',
    'connecting to the serv', 'connection failed', 'connection timed out',
    'request failed', 'request timed out', 'failed to fetch',
    'service unavailable', 'server error', 'internal server error',
    'rate limit', 'too many requests', 'quota exceeded', 'capacity',
    'model is overloaded', 'model not available', 'temporarily unavailable',
    'high traffic', 'servers are experiencing', 'please try again later',
    'overloaded', 'resource exhausted', 'try again in a few',
];

/**
 * Detects error states from cascade trajectory data.
 * Zero DOM operations — detection is based on cascade trajectory.
 */
export class ErrorPopupDetector {
    private cdpService: CdpService;
    private onErrorPopup: (info: ErrorPopupInfo) => void;
    private onResolved?: () => void;

    private state: DetectorState<ErrorPopupInfo> = createDetectorState();
    private static readonly CONFIG: DetectorStateConfig = {
        cooldownMs: 10000, maxNotifiedKeys: 50, label: 'ErrorPopupDetector',
    };

    constructor(options: ErrorPopupDetectorOptions) {
        this.cdpService = options.cdpService;
        this.onErrorPopup = options.onErrorPopup;
        this.onResolved = options.onResolved;
    }

    start(): void { startDetector(this.state); }
    async stop(): Promise<void> { stopDetector(this.state); }
    getLastDetectedInfo(): ErrorPopupInfo | null { return this.state.lastDetectedInfo; }
    isActive(): boolean { return this.state.isRunning; }

    async clickDismissButton(): Promise<boolean> {
        logger.debug('[ErrorPopupDetector] Dismiss — error state acknowledged');
        return true;
    }

    async clickCopyDebugInfoButton(): Promise<boolean> {
        logger.warn('[ErrorPopupDetector] Copy debug info not available without DOM');
        return false;
    }

    clickRetryButton(): Promise<boolean> {
        return runVscodeCommand(this.cdpService, 'antigravity.command.retry', 'ErrorPopupDetector');
    }

    async readClipboard(): Promise<string | null> {
        logger.warn('[ErrorPopupDetector] Clipboard reading not available without DOM');
        return null;
    }


    evaluate(cascadeId: string, steps: unknown[], runStatus: string | null): void {
        if (!this.state.isRunning) return;
        
        const coreInfo = this.extractErrorFromTrajectory(steps, runStatus);
        if (!coreInfo) {
            processDetectorResult(this.state, ErrorPopupDetector.CONFIG, null, null,
                (detected) => this.onErrorPopup(detected), this.onResolved);
            return;
        }

        coreInfo.buttons = ['Continue'];
        const key = cascadeId + '::' + coreInfo.title + '::' + coreInfo.body.slice(0, 100);
        processDetectorResult(this.state, ErrorPopupDetector.CONFIG, coreInfo, key,
            (detected) => this.onErrorPopup(detected), this.onResolved);
    }

    private extractErrorFromTrajectory(steps: unknown[], runStatus: string | null): ErrorPopupInfo | null {
        if (steps.length === 0) return null;

        const checkCount = Math.min(steps.length, 5);
        for (let i = steps.length - 1; i >= steps.length - checkCount; i--) {
            const step = steps[i] as TrajectoryStep | undefined;
            if (!step) continue;

            // Check explicit error field
            const errorField = step?.error || step?.plannerResponse?.error || step?.response?.error;
            if (errorField) {
                const errorMessage = typeof errorField === 'string'
                    ? errorField
                    : (errorField as { message?: string })?.message || JSON.stringify(errorField);
                return { title: 'Agent Error', body: String(errorMessage).slice(0, 1000), buttons: [] };
            }

            // Check error patterns in response text
            const responseText = step?.plannerResponse?.response || step?.response?.text || step?.assistantResponse?.text || '';
            if (typeof responseText === 'string') {
                const normalized = responseText.toLowerCase();
                // Terminal = anything that is NOT actively running.
                // Whitelist the single non-terminal state so future unknown statuses are caught.
                const isTerminalStatus = runStatus !== 'CASCADE_RUN_STATUS_RUNNING';
                if (ERROR_PATTERNS.some(p => normalized.includes(p)) && isTerminalStatus) {
                    return { title: 'Agent Error', body: responseText.slice(0, 1000), buttons: [] };
                }
            }

            // Check error status
            const stepStatus = step?.status || step?.cascadeRunStatus;
            if (typeof stepStatus === 'string' && stepStatus.toLowerCase().includes('error')) {
                return { title: 'Agent Error', body: `Step status: ${stepStatus}`, buttons: [] };
            }
        }
        return null;
    }
}
