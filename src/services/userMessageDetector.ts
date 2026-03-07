import { createHash } from 'node:crypto';
import { logger } from '../utils/logger';
import { CdpService } from './cdpService';

/** User message information detected from the backend */
export interface UserMessageInfo {
    /** Message text content */
    text: string;
    /** cascadeId of the conversation session where the message was detected */
    cascadeId?: string;
}

export interface UserMessageDetectorOptions {
    /** CDP service instance */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 2000ms) */
    pollIntervalMs?: number;
    /** Callback when a new user message is detected */
    onUserMessage: (info: UserMessageInfo) => void;
}

/**
 * Normalize text for echo hash comparison.
 * Trims, collapses whitespace, and takes first 200 chars.
 */
function normalizeForHash(text: string): string {
    return text.trim().replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Compute a short hash for echo prevention.
 */
function computeEchoHash(text: string): string {
    return createHash('sha256').update(normalizeForHash(text)).digest('hex').slice(0, 16);
}

/**
 * Detects user messages by polling the gRPC Language Server backend.
 * Completely bypasses the DOM.
 */
export class UserMessageDetector {
    private readonly cdpService: CdpService;
    private readonly pollIntervalMs: number;
    private readonly onUserMessage: (info: UserMessageInfo) => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;

    /** High-water mark for the strictly increasing lastUserInputTime across all cascades */
    private lastMaxUserInputTimeMs: number = 0;

    /** Set of echo hashes — messages sent by ClawGravity that should be ignored */
    private readonly echoHashes = new Set<string>();
    /** Set of all previously detected message hashes (defense-in-depth dedup) */
    private readonly seenHashes = new Set<string>();
    private static readonly MAX_SEEN_HASHES = 50;

    /** True during the first poll — seeds existing state without firing callback */
    private isPriming: boolean = false;

    constructor(options: UserMessageDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.onUserMessage = options.onUserMessage;
    }

    /**
     * Register a message hash as an echo (sent by ClawGravity).
     */
    addEchoHash(text: string): void {
        const hash = computeEchoHash(text);
        this.echoHashes.add(hash);
        setTimeout(() => {
            this.echoHashes.delete(hash);
        }, 60000);
    }

    /** Start monitoring. */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastMaxUserInputTimeMs = 0;
        this.seenHashes.clear();
        this.isPriming = true;
        this.schedulePoll();
    }

    /** Stop monitoring. */
    stop(): void {
        this.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    isActive(): boolean {
        return this.isRunning;
    }

    private addToSeenHashes(hash: string): void {
        if (this.seenHashes.size >= UserMessageDetector.MAX_SEEN_HASHES) {
            const oldest = this.seenHashes.values().next().value;
            if (oldest !== undefined) {
                this.seenHashes.delete(oldest);
            }
        }
        this.seenHashes.add(hash);
    }

    private schedulePoll(): void {
        if (!this.isRunning) return;
        this.pollTimer = setTimeout(async () => {
            await this.poll();
            if (this.isRunning) {
                this.schedulePoll();
            }
        }, this.pollIntervalMs);
    }

    private async poll(): Promise<void> {
        try {
            const client = await this.cdpService.getGrpcClient();
            if (!client) {
                return; // Not ready
            }

            const resp = await client.rawRPC('GetAllCascadeTrajectories', {});
            const summaries = resp?.trajectorySummaries || {};

            let newestId: string | null = null;
            let currentPollMaxMs = 0;

            for (const [id, t] of Object.entries(summaries)) {
                const timeStr = (t as any).lastUserInputTime;
                if (!timeStr) continue;

                const ms = new Date(timeStr).getTime();
                if (ms > currentPollMaxMs) {
                    currentPollMaxMs = ms;
                    newestId = id;
                }
            }

            // If no data
            if (!newestId) {
                this.isPriming = false;
                return;
            }

            // First run, just seed
            if (this.isPriming) {
                this.isPriming = false;
                this.lastMaxUserInputTimeMs = currentPollMaxMs;
                logger.debug(`[UserMessageDetector] Primed with maxTime: ${currentPollMaxMs}`);
                return;
            }

            // No new user input globally
            if (currentPollMaxMs <= this.lastMaxUserInputTimeMs) {
                return;
            }

            // New User Input detected!
            this.lastMaxUserInputTimeMs = currentPollMaxMs;

            const traj = await client.rawRPC('GetCascadeTrajectory', { cascadeId: newestId });
            const stepIndex = (summaries as any)[newestId].lastUserInputStepIndex;

            const steps = traj?.trajectory?.steps || [];
            if (!steps[stepIndex]) return;

            const items = steps[stepIndex].userInput?.items || [];
            const textParts = items.map((i: any) => i.text).filter(Boolean);
            const rawText = textParts.join('\n');

            if (!rawText.trim()) return;

            const text = rawText.trim();
            const hash = computeEchoHash(text);
            const preview = text.slice(0, 40).replace(/\n/g, ' ');

            // Dupe checks
            if (this.seenHashes.has(hash)) {
                logger.debug(`[UserMessageDetector] seenHash hit, skipping: "${preview}..."`);
                return;
            }

            if (this.echoHashes.has(hash)) {
                logger.debug(`[UserMessageDetector] Echo hash match, skipping: "${preview}..."`);
                this.addToSeenHashes(hash);
                return;
            }

            this.addToSeenHashes(hash);
            logger.debug(`[UserMessageDetector] New message detected via gRPC: "${preview}..."`);
            this.onUserMessage({ text, cascadeId: newestId });

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('ECONNREFUSED')) return;
            logger.error('[UserMessageDetector] Error during gRPC polling:', error);
        }
    }
}
