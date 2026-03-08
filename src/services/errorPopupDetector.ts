import { logger } from '../utils/logger';
import { CdpService } from './cdpService';

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
    /** CDP service instance (used only for gRPC client access and VS Code commands) */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 3000ms) */
    pollIntervalMs?: number;
    /** Callback when an error popup is detected */
    onErrorPopup: (info: ErrorPopupInfo) => void;
    /** Callback when a previously detected error popup is resolved */
    onResolved?: () => void;
}

/**
 * Detects error states via gRPC trajectory polling.
 *
 * Zero DOM operations — detection is based on cascade trajectory:
 * When the cascade has status=IDLE and the latest step contains error
 * information, an error has occurred.
 *
 * Actions are performed via VS Code extension commands.
 */
export class ErrorPopupDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private onErrorPopup: (info: ErrorPopupInfo) => void;
    private onResolved?: () => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** Key of the last detected error popup (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full ErrorPopupInfo from the last detection */
    private lastDetectedInfo: ErrorPopupInfo | null = null;
    /** Timestamp of last notification (for cooldown-based dedup) */
    private lastNotifiedAt: number = 0;
    /** Cooldown period in ms to suppress duplicate notifications (10s for error popups) */
    private static readonly COOLDOWN_MS = 10000;
    /** Set of keys that have already been notified (prevents cross-session re-fires) */
    private notifiedKeys: Set<string> = new Set();
    /** Maximum size of notifiedKeys before pruning oldest entries */
    private static readonly MAX_NOTIFIED_KEYS = 50;

    constructor(options: ErrorPopupDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 3000;
        this.onErrorPopup = options.onErrorPopup;
        this.onResolved = options.onResolved;
    }

    /** Start monitoring. */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        this.lastNotifiedAt = 0;
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

    /** Return the last detected error popup info. Returns null if nothing has been detected. */
    getLastDetectedInfo(): ErrorPopupInfo | null {
        return this.lastDetectedInfo;
    }

    /** Returns whether monitoring is currently active. */
    isActive(): boolean {
        return this.isRunning;
    }

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

    /** Schedule the next poll. */
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
     *   2. Check for error states in the trajectory
     *   3. Notify via callback only on new detection (prevent duplicates)
     *   4. Reset when error state is resolved
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

            const info = this.extractErrorFromTrajectory(steps, runStatus);

            if (info) {
                // Include cascadeId in the key to prevent cross-session re-fires
                const key = `${cascadeId}::${info.title}::${info.body.slice(0, 100)}`;
                const now = Date.now();
                const withinCooldown = (now - this.lastNotifiedAt) < ErrorPopupDetector.COOLDOWN_MS;
                if (key !== this.lastDetectedKey && !withinCooldown && !this.notifiedKeys.has(key)) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    this.lastNotifiedAt = now;
                    this.notifiedKeys.add(key);
                    // Prune oldest entries if set grows too large
                    if (this.notifiedKeys.size > ErrorPopupDetector.MAX_NOTIFIED_KEYS) {
                        const first = this.notifiedKeys.values().next().value;
                        if (first) this.notifiedKeys.delete(first);
                    }
                    this.onErrorPopup(info);
                } else if (key === this.lastDetectedKey) {
                    this.lastDetectedInfo = info;
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
            logger.error('[ErrorPopupDetector] Error during gRPC polling:', error);
        }
    }

    /**
     * Extract error info from trajectory steps.
     * Returns ErrorPopupInfo if the cascade has encountered an error.
     */
    private extractErrorFromTrajectory(steps: any[], runStatus: string | null): ErrorPopupInfo | null {
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
