/**
 * Shared notification tracking logic for detectors.
 *
 * Both ApprovalDetector and RunCommandDetector follow the same pattern
 * for deduplicating notifications via a key-based state machine.
 * This module extracts that pattern.
 */

import { logger } from '../utils/logger';

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
export function createNotificationTracker<T>(): NotificationTracker<T> {
    return {
        lastDetectedKey: null,
        lastDetectedInfo: null,
        notifiedKeys: new Set(),
    };
}

/**
 * Reset detection state (but preserve notifiedKeys to prevent cross-session re-fires).
 */
export function resetTrackerDetection<T>(tracker: NotificationTracker<T>): void {
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
export function processDetection<T>(
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
