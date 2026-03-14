/**
 * BaseDetector — shared lifecycle, dedup, and CDP command execution
 * for all trajectory-based detectors.
 *
 * Eliminates duplicated start/stop/isActive/evaluate/try-catch boilerplate
 * across ApprovalDetector, ErrorPopupDetector, PlanningDetector,
 * RunCommandDetector, and UserMessageDetector.
 */

import { Effect } from 'effect';
import { logger } from '../utils/logger';
import { CdpService } from './cdpService';

// ─── CDP Command Helper ────────────────────────────────────────────────

/**
 * Execute a VS Code command via CDP and return success/failure.
 * Replaces the repeated try/catch + result?.ok pattern in every detector.
 */
export function executeVscodeCommandSafe(
    cdp: CdpService,
    command: string,
    label: string,
): Effect.Effect<boolean, never> {
    return Effect.tryPromise({
        try: () => cdp.executeVscodeCommand(command),
        catch: (err) => err,
    }).pipe(
        Effect.map((result) => {
            const ok = (result as { ok?: boolean } | undefined)?.ok === true;
            if (ok) logger.debug(`[${label}] ${command} succeeded`);
            return ok;
        }),
        Effect.catchAll((err) => {
            logger.error(`[${label}] ${command} failed:`, err);
            return Effect.succeed(false);
        }),
    );
}

/**
 * Promise-based wrapper of executeVscodeCommandSafe for backward
 * compatibility with existing callers that expect Promise<boolean>.
 */
export function runVscodeCommand(
    cdp: CdpService,
    command: string,
    label: string,
): Promise<boolean> {
    return Effect.runPromise(executeVscodeCommandSafe(cdp, command, label));
}
