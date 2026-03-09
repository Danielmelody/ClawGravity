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
 * Detects user messages from cascade trajectory summaries.
 *
 * This detector is passive: it does not poll. Call `evaluateSummaries()` to
 * feed it cascade summaries from the TrajectoryStreamRouter.
 */
export class UserMessageDetector {
    private readonly cdpService: CdpService;
    private readonly onUserMessage: (info: UserMessageInfo) => void;

    private isRunning: boolean = false;

    /** High-water mark for the strictly increasing lastUserInputTime across all cascades */
    private lastMaxUserInputTimeMs: number = 0;

    /** Set of echo hashes — messages sent by ClawGravity that should be ignored */
    private readonly echoHashes = new Set<string>();
    /** Set of all previously detected message hashes (defense-in-depth dedup) */
    private readonly seenHashes = new Set<string>();
    private static readonly MAX_SEEN_HASHES = 50;

    /** True during the first evaluation — seeds existing state without firing callback */
    private isPriming: boolean = false;

    constructor(options: UserMessageDetectorOptions) {
        this.cdpService = options.cdpService;
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

    /** Start monitoring (marks active — must be called before evaluateSummaries()). */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastMaxUserInputTimeMs = 0;
        this.seenHashes.clear();
        this.isPriming = true;
    }

    /** Stop monitoring. */
    stop(): void {
        this.isRunning = false;
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

    /**
     * Evaluate cascade summaries to detect new user messages.
     * Called by TrajectoryStreamRouter when stream events arrive.
     *
     * The router fetches GetAllCascadeTrajectories and passes in the summaries.
     * If a new user message is detected, the detailed trajectory is fetched
     * on-demand to extract the message text.
     *
     * @param summaries  The trajectorySummaries object from GetAllCascadeTrajectories
     */
    async evaluateSummaries(summaries: Record<string, any>): Promise<void> {
        if (!this.isRunning) return;

        try {
            const updates: Array<{ id: string; ms: number; stepIndex: number }> = [];
            let maxPrimingMs = this.lastMaxUserInputTimeMs;

            for (const [id, t] of Object.entries(summaries)) {
                const timeStr = (t as any).lastUserInputTime;
                if (!timeStr) continue;

                const ms = new Date(timeStr).getTime();
                if (this.isPriming) {
                    if (ms > maxPrimingMs) maxPrimingMs = ms;
                } else if (ms > this.lastMaxUserInputTimeMs) {
                    updates.push({ id, ms, stepIndex: (t as any).lastUserInputStepIndex });
                }
            }

            // First run, just seed
            if (this.isPriming) {
                this.isPriming = false;
                this.lastMaxUserInputTimeMs = maxPrimingMs;
                logger.debug(`[UserMessageDetector] Primed with maxTime: ${maxPrimingMs}`);
                return;
            }

            // No new user input globally
            if (updates.length === 0) {
                return;
            }

            // Sort updates chronologically
            updates.sort((a, b) => a.ms - b.ms);

            const client = await this.cdpService.getGrpcClient();
            if (!client) return;

            for (const update of updates) {
                try {
                    const traj = await client.rawRPC('GetCascadeTrajectory', { cascadeId: update.id });
                    const steps = traj?.trajectory?.steps || [];

                    if (!steps[update.stepIndex]) {
                        this.lastMaxUserInputTimeMs = Math.max(this.lastMaxUserInputTimeMs, update.ms);
                        continue;
                    }

                    const items = steps[update.stepIndex].userInput?.items || [];
                    const textParts = items.map((i: any) => i.text).filter(Boolean);
                    const rawText = textParts.join('\n');

                    if (rawText.trim()) {
                        const text = rawText.trim();
                        const hash = computeEchoHash(text);
                        const preview = text.slice(0, 40).replace(/\n/g, ' ');

                        // Dupe checks
                        if (this.seenHashes.has(hash)) {
                            logger.debug(`[UserMessageDetector] seenHash hit, skipping: "${preview}..."`);
                        } else if (this.echoHashes.has(hash)) {
                            logger.debug(`[UserMessageDetector] Echo hash match, skipping: "${preview}..."`);
                            this.addToSeenHashes(hash);
                        } else {
                            this.addToSeenHashes(hash);
                            logger.debug(`[UserMessageDetector] New message detected via gRPC: "${preview}..."`);
                            this.onUserMessage({ text, cascadeId: update.id });
                        }
                    }

                    this.lastMaxUserInputTimeMs = Math.max(this.lastMaxUserInputTimeMs, update.ms);
                } catch (innerError) {
                    logger.error(`[UserMessageDetector] Error evaluating cascade ${update.id}:`, innerError);
                }
            }

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('ECONNREFUSED')) return;
            logger.error('[UserMessageDetector] Error during evaluation:', error);
        }
    }
}
