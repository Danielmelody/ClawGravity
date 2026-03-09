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
    steps: any[],
    runStatus?: string | null,
): { step: any; index: number } | null {
    if (runStatus !== undefined && (!runStatus || runStatus !== 'CASCADE_RUN_STATUS_IDLE')) return null;
    if (steps.length === 0) return null;

    for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') break;

        if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step?.type === 'CORTEX_STEP_TYPE_RESPONSE') {
            return { step, index: i };
        }
    }
    return null;
}
