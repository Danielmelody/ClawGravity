/**
 * MessageDeliveryState — CRDT-inspired state for Telegram message delivery.
 *
 * Uses LWW-Registers (Last-Writer-Wins) for concurrent text/HTML updates
 * and a monotonic completion flag. Each writer (onProgress, onRenderedTimeline,
 * onComplete) writes to its own independent register — no coordination needed.
 *
 * The `resolvePreferredFormat()` merge function deterministically picks the
 * best content source based on register clocks.
 *
 * All types are immutable. State transitions are via the pure `deliveryReducer`.
 */

// ---------------------------------------------------------------------------
// LWW-Register
// ---------------------------------------------------------------------------

/** Last-Writer-Wins Register. Clock is a monotonic integer (NOT wall-clock). */
export interface LWWRegister<T> {
    readonly value: T;
    readonly clock: number;
}

function setRegister<T>(reg: LWWRegister<T>, value: T): LWWRegister<T> {
    return { value, clock: reg.clock + 1 };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Raw step data from trajectory for native rendering. */
export interface StepsData {
    readonly steps: any[];
    readonly runStatus: string | null;
}

/** Immutable message delivery state. */
export interface MessageDeliveryState {
    /** Raw streaming text from onProgress. */
    readonly text: LWWRegister<string>;
    /** Rendered HTML from onRenderedTimeline. */
    readonly html: LWWRegister<string>;
    /** Raw step data for native step-based rendering. */
    readonly stepsData: LWWRegister<StepsData | null>;
    /** Monotonic: once true, stays true forever. */
    readonly completed: boolean;
    /** Set once on completion. */
    readonly finalText: string | null;
}

export function initialDeliveryState(): MessageDeliveryState {
    return {
        text: { value: '', clock: 0 },
        html: { value: '', clock: 0 },
        stepsData: { value: null, clock: 0 },
        completed: false,
        finalText: null,
    };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type DeliveryAction =
    | { readonly type: 'TEXT_UPDATE'; readonly text: string }
    | { readonly type: 'HTML_UPDATE'; readonly html: string }
    | { readonly type: 'STEPS_UPDATE'; readonly stepsData: StepsData }
    | { readonly type: 'COMPLETE'; readonly finalText: string };

// ---------------------------------------------------------------------------
// Reducer (pure)
// ---------------------------------------------------------------------------

/**
 * Pure state transition. Returns a new state; never mutates the input.
 *
 * - TEXT_UPDATE: increments text register clock
 * - HTML_UPDATE: increments html register clock
 * - COMPLETE: monotonic flag, sets finalText
 */
export function deliveryReducer(
    state: MessageDeliveryState,
    action: DeliveryAction,
): MessageDeliveryState {
    switch (action.type) {
        case 'TEXT_UPDATE':
            return {
                ...state,
                text: setRegister(state.text, action.text),
            };
        case 'HTML_UPDATE':
            return {
                ...state,
                html: setRegister(state.html, action.html),
            };
        case 'STEPS_UPDATE':
            return {
                ...state,
                stepsData: setRegister(state.stepsData, action.stepsData),
            };
        case 'COMPLETE':
            if (state.completed) return state; // monotonic guard
            return {
                ...state,
                completed: true,
                finalText: action.finalText,
            };
    }
}

// ---------------------------------------------------------------------------
// Merge / Resolution (pure)
// ---------------------------------------------------------------------------

/**
 * Determine the preferred content format based on register clocks.
 *
 * Steps wins when the stepsData register has been written to (native rendering).
 * Falls back to text otherwise.
 *
 * This is the CRDT merge function — commutative and idempotent.
 */
export function resolvePreferredFormat(state: MessageDeliveryState): 'steps' | 'text' {
    if (state.stepsData.clock > 0 && state.stepsData.value !== null
        && Array.isArray(state.stepsData.value.steps) && state.stepsData.value.steps.length > 0) {
        return 'steps';
    }
    return 'text';
}

// ---------------------------------------------------------------------------
// Snapshot (pure)
// ---------------------------------------------------------------------------

/** Frozen, immutable snapshot of delivery state for the pure pipeline. */
export interface DeliverySnapshot {
    readonly text: string;
    readonly html: string;
    readonly stepsData: StepsData | null;
    readonly preferredFormat: 'steps' | 'text';
    readonly finalText: string;
    readonly textClock: number;
    readonly htmlClock: number;
    readonly stepsClock: number;
}

/**
 * Create an immutable snapshot from the current CRDT state.
 *
 * After taking a snapshot, the pipeline can run without any reference
 * to the live state — eliminating race conditions by construction.
 */
export function createDeliverySnapshot(state: MessageDeliveryState): DeliverySnapshot {
    return {
        text: state.text.value,
        html: state.html.value,
        stepsData: state.stepsData.value,
        preferredFormat: resolvePreferredFormat(state),
        finalText: state.finalText ?? '',
        textClock: state.text.clock,
        htmlClock: state.html.clock,
        stepsClock: state.stepsData.clock,
    };
}
