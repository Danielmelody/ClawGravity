/**
 * Effect runtime utilities for ClawGravity.
 *
 * Provides helpers for running Effect programs, logging integration,
 * and common combinators used across the codebase.
 */

import { Effect, Logger, LogLevel, Runtime, Layer, ManagedRuntime } from 'effect';
import { logger as appLogger } from '../utils/logger';

// ─── Logger Integration ─────────────────────────────────────────────────

/**
 * Custom Effect logger that routes all Effect log output to the
 * existing application logger, preserving the existing log format.
 */
const appLoggerLayer = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ logLevel, message }) => {
        const text = typeof message === 'string' ? message : String(message);
        switch (logLevel._tag) {
            case 'Error':
            case 'Fatal':
                appLogger.error(text);
                break;
            case 'Warning':
                appLogger.warn(text);
                break;
            case 'Debug':
            case 'Trace':
                appLogger.debug(text);
                break;
            default:
                appLogger.info(text);
                break;
        }
    }),
);

/**
 * Base layer that all Effect programs in the app use.
 * Includes our custom logger and sets minimum log level.
 */
export const BaseLayer = Layer.mergeAll(
    appLoggerLayer,
    Logger.minimumLogLevel(LogLevel.Debug),
);

// ─── Run Helpers ────────────────────────────────────────────────────────

/**
 * Run an Effect program with the base layer, returning a Promise.
 * Use this at the boundary between Effect code and legacy imperative code.
 */
export function runEffect<A, E>(
    effect: Effect.Effect<A, E>,
): Promise<A> {
    return Effect.runPromise(
        effect.pipe(Effect.provide(BaseLayer)),
    );
}

/**
 * Run an Effect program, discarding the result but logging errors.
 */
export function runEffectFork<E>(
    effect: Effect.Effect<void, E>,
): void {
    Effect.runFork(
        effect.pipe(
            Effect.catchAllCause((cause) =>
                Effect.sync(() => {
                    appLogger.error('[Effect] Unhandled cause:', cause);
                }),
            ),
            Effect.provide(BaseLayer),
        ),
    );
}

/**
 * Convert an Effect to a Promise-returning function, suitable for
 * use as a callback in legacy code.
 */
export function effectToCallback<A, E>(
    effect: Effect.Effect<A, E>,
): () => Promise<A> {
    return () => runEffect(effect);
}

// ─── Common Combinators ─────────────────────────────────────────────────

/**
 * Wrap a legacy async function into an Effect, capturing errors
 * into the typed error channel.
 */
export function fromPromiseCaught<A, E>(
    fn: () => Promise<A>,
    onError: (err: unknown) => E,
): Effect.Effect<A, E> {
    return Effect.tryPromise({ try: fn, catch: onError });
}
