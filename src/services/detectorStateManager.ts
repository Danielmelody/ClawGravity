/**
 * Share detector lifecycle and deduplication state management.
 *
 * Used by PlanningDetector, ErrorPopupDetector, and potentially RunCommandDetector
 * to eliminate duplicated start/stop/isActive/detection logic.
 */

import { logger } from '../utils/logger';


export interface DetectorState<TInfo> {
    isRunning: boolean;
    lastDetectedKey: string | null;
    lastDetectedInfo: TInfo | null;
    lastNotifiedAt: number;
    notifiedKeys: Set<string>;
}

export interface DetectorStateConfig {
    /** Cooldown in ms between notifications for the same detector */
    cooldownMs: number;
    /** Max tracked keys before eldest is pruned */
    maxNotifiedKeys: number;
    /** Label for log messages */
    label: string;
}

/** Create initial detector state. */
export function createDetectorState<TInfo>(): DetectorState<TInfo> {
    return {
        isRunning: false,
        lastDetectedKey: null,
        lastDetectedInfo: null,
        lastNotifiedAt: 0,
        notifiedKeys: new Set(),
    };
}

/** Mark the detector as started. */
export function startDetector<TInfo>(state: DetectorState<TInfo>): void {
    if (state.isRunning) return;
    state.isRunning = true;
    state.lastDetectedKey = null;
    state.lastDetectedInfo = null;
    state.lastNotifiedAt = 0;
}

/** Mark the detector as stopped. */
export function stopDetector<TInfo>(state: DetectorState<TInfo>): void {
    state.isRunning = false;
}

/**
 * Process a detection result, handling deduplication, cooldown, and resolution.
 *
 * @param state     Mutable detector state
 * @param config    Static configuration (cooldown, max keys, label)
 * @param info      Detected info (null = resolved / not detected)
 * @param key       Deduplication key for this detection
 * @param onDetected  Callback when a genuinely new detection is found
 * @param onResolved  Callback when a previous detection is resolved
 */
export function processDetectorResult<TInfo>(
    state: DetectorState<TInfo>,
    config: DetectorStateConfig,
    info: TInfo | null,
    key: string | null,
    onDetected: (info: TInfo) => void,
    onResolved?: () => void,
): void {
    if (info && key) {
        const now = Date.now();
        const withinCooldown = (now - state.lastNotifiedAt) < config.cooldownMs;
        if (key !== state.lastDetectedKey && !withinCooldown && !state.notifiedKeys.has(key)) {
            state.lastDetectedKey = key;
            state.lastDetectedInfo = info;
            state.lastNotifiedAt = now;
            state.notifiedKeys.add(key);
            // Prune oldest entries if set grows too large
            if (state.notifiedKeys.size > config.maxNotifiedKeys) {
                const first = state.notifiedKeys.values().next().value;
                if (first) state.notifiedKeys.delete(first);
            }
            onDetected(info);
        } else if (key === state.lastDetectedKey) {
            state.lastDetectedInfo = info;
        }
    } else {
        const wasDetected = state.lastDetectedKey !== null;
        state.lastDetectedKey = null;
        state.lastDetectedInfo = null;
        if (wasDetected && onResolved) {
            onResolved();
        }
    }
}

/**
 * Walk trajectory steps backwards to find the last planner response step.
 * When `runStatus` is provided, only returns a result when cascade is IDLE.
 * Returns `{ step, index }` or null.
 *
 * Shared between PlanningDetector and RunCommandDetector.
 */
export function findLastPlannerStep(
    steps: unknown[],
    runStatus?: string | null,
): { step: unknown; index: number } | null {
    if (runStatus !== undefined && (!runStatus || runStatus !== 'CASCADE_RUN_STATUS_IDLE')) return null;
    if (steps.length === 0) return null;

    for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i] as Record<string, unknown> | undefined;
        if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') break;

        if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
            return { step, index: i };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Lightweight notification tracker (no lifecycle/cooldown)
//
// Used by detectors that manage their own start/stop lifecycle
// (ApprovalDetector, RunCommandDetector) and only need key-based dedup.
// ---------------------------------------------------------------------------

/** Maximum size of notifiedKeys before pruning oldest entries */
const DEFAULT_MAX_NOTIFIED_KEYS = 50;

/** State and methods for tracking notification deduplication. */
export interface NotificationTracker<T> {
    /** Key of the last detected state (for duplicate prevention) */
    lastDetectedKey: string | null;
    /** The info object from the last detection */
    lastDetectedInfo: T | null;
    /** Set of keys that have already been notified */
    notifiedKeys: Set<string>;
}

/**
 * Create a fresh tracker state.
 */
function createNotificationTracker<T>(): NotificationTracker<T> {
    return {
        lastDetectedKey: null,
        lastDetectedInfo: null,
        notifiedKeys: new Set(),
    };
}

/**
 * Reset detection state (but preserve notifiedKeys to prevent cross-session re-fires).
 */
function resetTrackerDetection<T>(tracker: NotificationTracker<T>): void {
    tracker.lastDetectedKey = null;
    tracker.lastDetectedInfo = null;
}

/**
 * Process a detection result through the notification tracker.
 *
 * @param tracker     The tracker state to update.
 * @param info        The detected info, or null if nothing is detected.
 * @param buildKey    Given the info, produce a dedup key string.
 * @param onNew       Called when a genuinely new detection occurs.
 * @param onResolved  Called when a previously detected state disappears.
 * @param maxKeys     Maximum notifiedKeys size before pruning.
 */
function processDetection<T>(
    tracker: NotificationTracker<T>,
    info: T | null,
    buildKey: (info: T) => string,
    onNew: (info: T) => void,
    onResolved?: () => void,
    maxKeys: number = DEFAULT_MAX_NOTIFIED_KEYS,
): void {
    if (info) {
        const key = buildKey(info);
        if (key !== tracker.lastDetectedKey && !tracker.notifiedKeys.has(key)) {
            tracker.lastDetectedKey = key;
            tracker.lastDetectedInfo = info;
            tracker.notifiedKeys.add(key);
            // Prune oldest entries if set grows too large
            if (tracker.notifiedKeys.size > maxKeys) {
                const first = tracker.notifiedKeys.values().next().value;
                if (first) tracker.notifiedKeys.delete(first);
            }
            onNew(info);
        }
    } else {
        const wasDetected = tracker.lastDetectedKey !== null;
        tracker.lastDetectedKey = null;
        tracker.lastDetectedInfo = null;
        if (wasDetected && onResolved) {
            onResolved();
        }
    }
}

/**
 * Shared lifecycle and evaluation flow for lightweight notification detectors.
 */
export abstract class NotificationDetector<T> {
    private isRunning = false;
    protected readonly tracker: NotificationTracker<T> = createNotificationTracker();

    constructor(
        private readonly label: string,
        private readonly onResolved?: () => void,
        private readonly maxNotifiedKeys: number = DEFAULT_MAX_NOTIFIED_KEYS,
    ) {}

    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        resetTrackerDetection(this.tracker);
    }

    async stop(): Promise<void> {
        this.isRunning = false;
    }

    getLastDetectedInfo(): T | null {
        return this.tracker.lastDetectedInfo;
    }

    isActive(): boolean {
        return this.isRunning;
    }

    protected processEvaluation(
        cascadeId: string,
        steps: unknown[],
        runStatus: string | null,
        extractInfo: (steps: unknown[], runStatus: string | null) => T | null,
        buildKey: (cascadeId: string, info: T) => string,
        onDetected: (info: T) => void,
    ): void {
        if (!this.isRunning) return;

        try {
            const info = extractInfo(steps, runStatus);
            processDetection(
                this.tracker,
                info,
                (detected) => buildKey(cascadeId, detected),
                onDetected,
                this.onResolved,
                this.maxNotifiedKeys,
            );
        } catch (error) {
            logger.error(`[${this.label}] Error during evaluation:`, error);
        }
    }
}
