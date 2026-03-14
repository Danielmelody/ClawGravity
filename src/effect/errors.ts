/**
 * Unified Effect error types for ClawGravity.
 *
 * All domain-specific errors are TaggedErrors so they can be
 * matched exhaustively in Effect.catchTags and propagated
 * through the type system without any manual `instanceof` checks.
 */

import { Data } from 'effect';

// ─── CDP / Connection Errors ────────────────────────────────────────────

/** WebSocket connection to Antigravity failed or was lost. */
export class CdpConnectionError extends Data.TaggedError('CdpConnectionError')<{
    readonly message: string;
    readonly cause?: unknown;
}> {}

/** A CDP method call timed out. */
export class CdpTimeoutError extends Data.TaggedError('CdpTimeoutError')<{
    readonly method: string;
    readonly timeoutMs: number;
}> {}

/** A CDP method call returned an error result. */
export class CdpCallError extends Data.TaggedError('CdpCallError')<{
    readonly method: string;
    readonly message: string;
    readonly code?: number;
}> {}

/** Could not discover a workspace page via CDP. */
export class WorkspaceNotFoundError extends Data.TaggedError('WorkspaceNotFoundError')<{
    readonly workspacePath: string;
    readonly message: string;
}> {}

// ─── gRPC / Language Server Errors ──────────────────────────────────────

/** Language Server gRPC call failed. */
export class GrpcError extends Data.TaggedError('GrpcError')<{
    readonly method: string;
    readonly message: string;
    readonly cause?: unknown;
}> {}

/** Language Server client is not yet available (still discovering). */
export class LsClientUnavailableError extends Data.TaggedError('LsClientUnavailableError')<{
    readonly message: string;
}> {}

// ─── Process / Launch Errors ────────────────────────────────────────────

/** Failed to launch the Antigravity process. */
export class ProcessLaunchError extends Data.TaggedError('ProcessLaunchError')<{
    readonly message: string;
    readonly cause?: unknown;
}> {}

// ─── Platform / Bot Errors ──────────────────────────────────────────────

/** A Telegram/Discord API call failed. */
export class PlatformApiError extends Data.TaggedError('PlatformApiError')<{
    readonly platform: 'telegram' | 'discord';
    readonly message: string;
    readonly cause?: unknown;
}> {}

// ─── Domain Logic Errors ────────────────────────────────────────────────

/** A configuration or validation error. */
export class ConfigError extends Data.TaggedError('ConfigError')<{
    readonly message: string;
}> {}

/** Generic unrecoverable defect wrapper. */
export class UnexpectedError extends Data.TaggedError('UnexpectedError')<{
    readonly message: string;
    readonly cause?: unknown;
}> {}
