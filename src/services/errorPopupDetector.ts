import { logger } from '../utils/logger';
import { CdpService } from './cdpService';
import {
    DetectorState,
    DetectorStateConfig,
    createDetectorState,
    startDetector,
    stopDetector,
    processDetectorResult,
} from './detectorStateManager';

/** Error popup information */
export interface ErrorPopupInfo {
    /** Error popup title text */
    title: string;
    /** Error popup body/description text */
    body: string;
    /** Button labels found in the popup */
    buttons: string[];
}

export interface ErrorPopupDetectorOptions {
    /** CDP service instance (used only for VS Code commands) */
    cdpService: CdpService;
    /** Callback when an error popup is detected */
    onErrorPopup: (info: ErrorPopupInfo) => void;
    /** Callback when a previously detected error popup is resolved */
    onResolved?: () => void;
}

/**
 * Detects error states from cascade trajectory data.
 *
 * Zero DOM operations — detection is based on cascade trajectory:
 * When the cascade has status=IDLE and the latest step contains error
 * information, an error has occurred.
 *
 * This detector is passive: it does not poll. Call `evaluate()` to feed
 * it trajectory data from the TrajectoryStreamRouter.
 *
 * Actions are performed via VS Code extension commands.
 */
export class ErrorPopupDetector {
    private cdpService: CdpService;
    private onErrorPopup: (info: ErrorPopupInfo) => void;
    private onResolved?: () => void;

    private state: DetectorState<ErrorPopupInfo> = createDetectorState();
    private static readonly CONFIG: DetectorStateConfig = {
        cooldownMs: 10000,
        maxNotifiedKeys: 50,
        label: 'ErrorPopupDetector',
    };

    constructor(options: ErrorPopupDetectorOptions) {
        this.cdpService = options.cdpService;
        this.onErrorPopup = options.onErrorPopup;
        this.onResolved = options.onResolved;
    }

    /** Start monitoring (marks active — must be called before evaluate()). */
    start(): void { startDetector(this.state); }

    /** Stop monitoring. */
    async stop(): Promise<void> { stopDetector(this.state); }

    /** Return the last detected error popup info. Returns null if nothing has been detected. */
    getLastDetectedInfo(): ErrorPopupInfo | null { return this.state.lastDetectedInfo; }

    /** Returns whether monitoring is currently active. */
    isActive(): boolean { return this.state.isRunning; }

    /**
     * Dismiss the error — no-op; error state resolves on its own.
     * @returns true always (dismissal is implicit)
     */
    async clickDismissButton(): Promise<boolean> {
        logger.debug('[ErrorPopupDetector] Dismiss — error state acknowledged');
        return true;
    }

    /**
     * Copy debug info is not available without DOM.
     * @returns false (not supported)
     */
    async clickCopyDebugInfoButton(): Promise<boolean> {
        logger.warn('[ErrorPopupDetector] Copy debug info not available without DOM');
        return false;
    }

    /**
     * Click the Retry button.
     * Uses VS Code command `antigravity.command.retry`.
     * @returns true if click succeeded
     */
    async clickRetryButton(): Promise<boolean> {
        try {
            const result = await this.cdpService.executeVscodeCommand('antigravity.command.retry');
            if (result?.ok) {
                logger.debug('[ErrorPopupDetector] Retried via VS Code command');
                return true;
            }
            return false;
        } catch (error) {
            logger.error('[ErrorPopupDetector] Retry command failed:', error);
            return false;
        }
    }

    /**
     * Read clipboard content is not available without DOM.
     * @returns null (not supported)
     */
    async readClipboard(): Promise<string | null> {
        logger.warn('[ErrorPopupDetector] Clipboard reading not available without DOM');
        return null;
    }

    /**
     * Evaluate trajectory data to detect error states.
     * Called by TrajectoryStreamRouter when stream events arrive.
     *
     * @param cascadeId  The active cascade ID
     * @param steps      Trajectory steps array
     * @param runStatus  Cascade run status string
     */
    evaluate(cascadeId: string, steps: unknown[], runStatus: string | null): void {
        if (!this.state.isRunning) return;

        try {
            const info = this.extractErrorFromTrajectory(steps, runStatus);
            const key = info ? `${cascadeId}::${info.title}::${info.body.slice(0, 100)}` : null;

            processDetectorResult(
                this.state,
                ErrorPopupDetector.CONFIG,
                info,
                key,
                (detected) => this.onErrorPopup(detected),
                this.onResolved,
            );
        } catch (error) {
            logger.error('[ErrorPopupDetector] Error during evaluation:', error);
        }
    }

    /**
     * Extract error info from trajectory steps.
     * Returns ErrorPopupInfo if the cascade has encountered an error.
     */
    private extractErrorFromTrajectory(steps: unknown[], runStatus: string | null): ErrorPopupInfo | null {
        if (steps.length === 0) return null;

        // Error patterns in step content
        const ERROR_PATTERNS = [
            'agent terminated',
            'execution terminated',
            'execution failed',
            'terminated due to error',
            'unexpected error',
            'something went wrong',
            'an error occurred',
            // Network / connectivity errors
            'network issue',
            'network error',
            'connecting to the serv',
            'connection failed',
            'connection timed out',
            'request failed',
            'request timed out',
            'failed to fetch',
            'service unavailable',
            'server error',
            'internal server error',
            // Rate limit / quota errors
            'rate limit',
            'too many requests',
            'quota exceeded',
            'capacity',
            // Model / API errors
            'model is overloaded',
            'model not available',
            'temporarily unavailable',
        ];

        // Check the last few steps for error information
        const checkCount = Math.min(steps.length, 5);
        for (let i = steps.length - 1; i >= steps.length - checkCount; i--) {
            const step = steps[i];
            if (!step) continue;

            // Check for explicit error field
            const errorField = step?.error || step?.plannerResponse?.error || step?.response?.error;
            if (errorField) {
                const errorMessage = typeof errorField === 'string'
                    ? errorField
                    : errorField?.message || JSON.stringify(errorField);

                return {
                    title: 'Agent Error',
                    body: String(errorMessage).slice(0, 1000),
                    buttons: ['Retry'],
                };
            }

            // Check for error patterns in response text
            const responseText =
                step?.plannerResponse?.response
                || step?.response?.text
                || step?.assistantResponse?.text
                || '';

            if (typeof responseText === 'string') {
                const normalized = responseText.toLowerCase();
                const hasError = ERROR_PATTERNS.some(p => normalized.includes(p));
                if (hasError && runStatus === 'CASCADE_RUN_STATUS_IDLE') {
                    return {
                        title: 'Agent Error',
                        body: responseText.slice(0, 1000),
                        buttons: ['Retry'],
                    };
                }
            }

            // Check for error status in step
            const stepStatus = step?.status || step?.cascadeRunStatus;
            if (typeof stepStatus === 'string' && stepStatus.toLowerCase().includes('error')) {
                return {
                    title: 'Agent Error',
                    body: `Step status: ${stepStatus}`,
                    buttons: ['Retry'],
                };
            }
        }

        return null;
    }
}
