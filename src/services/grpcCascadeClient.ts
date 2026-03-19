/**
 * grpcCascadeClient.ts
 *
 * Direct ConnectRPC client for Antigravity's LanguageServerService.
 * All RPC calls are proxied through CDP Runtime.evaluate + fetch(),
 * executing within the IDE's renderer process.
 *
 * COMPLIANCE (following antigravity-sdk patterns):
 *   - Auth uses ephemeral per-session CSRF token ONLY (not OAuth tokens)
 *   - Credentials are discovered via CDP Network sniffing
 *   - All communication stays on localhost (127.0.0.1)
 *   - No data leaves the local machine through this channel
 *
 * Key endpoints:
 *   - SendUserCascadeMessage: sends a user message to a specific cascade session
 *   - StartCascade: creates a new cascade session
 *   - GetCascadeTrajectory: fetches trajectory state (polling-based monitoring)
 *
 * Reference: https://github.com/Kanezal/antigravity-sdk
 */

import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Connection info discovered from CDP Network sniffing */
export interface LSConnection {
    port: number;
    csrfToken: string;
    useTls: boolean;
    /** Encoded workspace ID from --workspace_id CLI arg (e.g. 'file_c_3A_Users_Daniel_Projects_foo') */
    workspaceId?: string;
}

/**
 * CDP evaluation callback — executes a JavaScript expression in the
 * renderer process via Runtime.evaluate and returns the raw CDP result.
 */
export type CdpEvaluateFn = (expression: string) => Promise<unknown>;

/** Cascade config for SendUserCascadeMessage */
export interface CascadeConfig {
    plannerConfig?: {
        plannerTypeConfig?: {
            case?: string;
            value?: Record<string, unknown>;
        };
        requestedModel?: {
            choice?: {
                case?: string;
                value?: number;
            };
        };
    };
}

/** Events emitted by the streaming response listener */
export interface CascadeStreamEvent {
    type: 'text' | 'tool_call' | 'status' | 'complete' | 'error' | 'thinking';
    text?: string;
    toolName?: string;
    raw?: unknown;
}

/** Known legacy numeric model IDs (from older antigravity-sdk payloads) */
export const Models = {
    GEMINI_FLASH: 1018,
    GEMINI_PRO_LOW: 1164,
    GEMINI_PRO_HIGH: 1165,
    CLAUDE_SONNET: 1163,
    CLAUDE_OPUS: 1154,
    GPT_OSS: 342,
} as const;

export type ModelId = typeof Models[keyof typeof Models] | number | string;

/**
 * A media item (image/video) to include in a SendUserCascadeMessage.
 *
 * Proto definition (exa.codeium_common_pb.Media contains repeated items of this shape):
 *   - mimeType: string (e.g. 'image/png')
 *   - payload: oneof { inlineData: bytes } — base64-encoded in JSON transport
 *   - thumbnail: bytes (optional, base64)
 *   - uri: string (optional, set after SaveMediaAsArtifact)
 *   - durationSeconds: number (optional, for video)
 *
 * The SendUserCascadeMessageRequest has a `media` field of type `repeated Media`.
 * In the JSON-over-Connect transport, bytes fields are base64-encoded strings.
 */
export interface MediaItem {
    mimeType: string;
    /** Base64-encoded inline image data */
    inlineData?: string;
    /** Base64-encoded thumbnail (optional, smaller version) */
    thumbnail?: string;
    /** Artifact URI (populated after saveMediaAsArtifact) */
    uri?: string;
    /** Duration in seconds (for video) */
    durationSeconds?: number;
}

// ---------------------------------------------------------------------------
// GrpcCascadeClient
// ---------------------------------------------------------------------------

export class GrpcCascadeClient extends EventEmitter {
    private connection: LSConnection | null = null;
    private cdpEvaluate: CdpEvaluateFn | null = null;
    private lastOperationError: string | null = null;

    constructor() {
        super();
    }

    /**
     * Set the CDP evaluation callback.
     * This is injected by CdpService so all RPC calls execute
     * within the IDE renderer process via CDP Runtime.evaluate.
     */
    setCdpEvaluate(fn: CdpEvaluateFn): void {
        this.cdpEvaluate = fn;
    }

    /**
     * Set connection parameters (port + CSRF token).
     * No OAuth tokens — only the ephemeral CSRF token.
     */
    setConnection(conn: LSConnection): void {
        this.connection = conn;
        logger.debug(`[GrpcCascadeClient] Connection set: port=${conn.port}, tls=${conn.useTls}`);
    }

    /** Check if connection is configured */
    isReady(): boolean {
        return this.connection !== null && this.cdpEvaluate !== null;
    }

    getLastOperationError(): string | null {
        return this.lastOperationError;
    }

    /**
     * Create a new headless cascade and optionally send a message.
     *
     * @param text Optional text to send
     * @param model Optional model identifier
     * @returns cascadeId or null
     */
    async createCascade(text?: string, model?: ModelId): Promise<string | null> {
        this.lastOperationError = null;

        const plannerConfig: Record<string, unknown> = {
            conversational: {},
        };
        if (model != null) {
            plannerConfig.planModel = model;
        }

        const startPayload: Record<string, unknown> = { source: 0 };
        if (model != null) {
            startPayload.cascadeConfig = { plannerConfig };
        }

        let startResp: unknown;
        try {
            startResp = await this.rpc('StartCascade', startPayload);
        } catch (err: unknown) {
            this.lastOperationError = err instanceof Error ? err.message : String(err);
            logger.error(`[GrpcCascadeClient] StartCascade failed: ${this.lastOperationError}`);
            return null;
        }

        const sr = startResp as Record<string, unknown>;
        const cascadeId =
            (sr.cascadeId as string | undefined)
            || ((sr.cascade as Record<string, unknown> | undefined)?.cascadeId as string | undefined)
            || ((sr.cascade as Record<string, unknown> | undefined)?.id as string | undefined)
            || ((sr.trajectory as Record<string, unknown> | undefined)?.cascadeId as string | undefined)
            || ((sr.session as Record<string, unknown> | undefined)?.cascadeId as string | undefined)
            || null;
        if (!cascadeId) {
            const responsePreview = JSON.stringify(startResp)?.slice(0, 500) || '{}';
            this.lastOperationError = `StartCascade returned no cascadeId: ${responsePreview}`;
            logger.error(`[GrpcCascadeClient] ${this.lastOperationError}`);
            return null;
        }

        logger.info(`[GrpcCascadeClient] Cascade created: ${cascadeId}`);

        if (text) {
            const sendResult = await this.sendMessage(cascadeId, text, model);
            if (!sendResult.ok) {
                this.lastOperationError = sendResult.error || 'Initial send failed';
                logger.warn(`[GrpcCascadeClient] Initial send failed for cascade ${cascadeId}: ${sendResult.error}`);
                return null;
            }
        }

        this.lastOperationError = null;
        return cascadeId;
    }

    /**
     * Send a user message to a specific cascade session.
     * Compliant: uses only CSRF token, no OAuth token in payload.
     *
     * @param cascadeId The conversation/session ID
     * @param text The message text
     * @param model Optional model identifier
     * @param media Optional array of media items (images/videos) to include
     */
    async sendMessage(
        cascadeId: string,
        text: string,
        model?: ModelId,
        media?: MediaItem[],
    ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
        // Verified payload format via E2E testing:
        //   items: [{text}]  (NOT chunk/case)
        //   planModel: model identifier string or legacy numeric ID
        //   conversational: {} (NOT plannerTypeConfig.case)
        //
        // When model is NOT specified, omit planModel entirely so the
        // server uses the user's UI-selected model (not a hardcoded default).
        const plannerConfig: Record<string, unknown> = {
            conversational: {},
        };
        if (model != null) {
            plannerConfig.planModel = model;
        }

        const payload: Record<string, unknown> = {
            cascadeId,
            items: [{ text }],
            cascadeConfig: { plannerConfig },
        };

        // Attach media items (images/videos) if present.
        // Proto field: repeated exa.codeium_common_pb.Media media
        // In JSON transport, bytes fields (inlineData, thumbnail) are base64 strings.
        if (media && media.length > 0) {
            payload.media = media.map(item => {
                const mediaObj: Record<string, unknown> = {
                    mimeType: item.mimeType,
                };
                if (item.inlineData) {
                    mediaObj.inlineData = item.inlineData;
                }
                if (item.thumbnail) {
                    mediaObj.thumbnail = item.thumbnail;
                }
                if (item.uri) {
                    mediaObj.uri = item.uri;
                }
                if (item.durationSeconds != null) {
                    mediaObj.durationSeconds = item.durationSeconds;
                }
                return mediaObj;
            });
        }

        try {
            const result = await this.rpc('SendUserCascadeMessage', payload);
            this.lastOperationError = null;
            return { ok: true, data: result };
        } catch (err: unknown) {
            this.lastOperationError = err instanceof Error ? err.message : String(err);
            return { ok: false, error: this.lastOperationError || undefined };
        }
    }

    /**
     * Upload a media item to the LS and get an artifact URI back.
     * This persists the media so the LS can reference it during processing.
     *
     * @param media The media item to upload
     * @returns The artifact URI or null on failure
     */
    async saveMediaAsArtifact(media: MediaItem): Promise<string | null> {
        const mediaObj: Record<string, unknown> = {
            mimeType: media.mimeType,
        };
        if (media.inlineData) {
            mediaObj.inlineData = media.inlineData;
        }
        if (media.thumbnail) {
            mediaObj.thumbnail = media.thumbnail;
        }
        if (media.uri) {
            mediaObj.uri = media.uri;
        }

        try {
            const result = await this.rpc('SaveMediaAsArtifact', { media: mediaObj });
            const resultRecord = result as Record<string, unknown>;
            return (resultRecord.uri as string | undefined) || null;
        } catch (err: unknown) {
            logger.warn(`[GrpcCascadeClient] SaveMediaAsArtifact failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }

    /**
     * Delete a previously saved media artifact.
     */
    async deleteMediaArtifact(uri: string): Promise<boolean> {
        try {
            const result = await this.rpc('DeleteMediaArtifact', { uri });
            const resultRecord = result as Record<string, unknown>;
            return resultRecord.success !== false;
        } catch (err: unknown) {
            logger.warn(`[GrpcCascadeClient] DeleteMediaArtifact failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }

    /**
     * Focus the UI on a specific cascade conversation.
     */
    async focusCascade(cascadeId: string): Promise<void> {
        await this.rpc('SmartFocusConversation', { cascadeId });
    }

    /**
     * Cancel a running cascade invocation.
     */
    async cancelCascade(cascadeId: string): Promise<void> {
        await this.rpc('CancelCascadeInvocation', { cascadeId });
    }

    /**
     * Get all cascade trajectories (conversation list).
     */
    async listCascades(): Promise<unknown> {
        const resp = await this.rpc('GetAllCascadeTrajectories', {});
        const respRecord = resp as Record<string, unknown>;
        return respRecord.trajectorySummaries ?? {};
    }

    /**
     * Get user status (tier, models, etc.)
     */
    async getUserStatus(): Promise<unknown> {
        return this.rpc('GetUserStatus', {});
    }

    /**
     * Make a raw RPC call to any LS method.
     */
    async rawRPC(method: string, payload: unknown): Promise<unknown> {
        return this.rpc(method, payload);
    }

    // ---------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------

    /**
     * Make an authenticated RPC call to the Language Server.
     * Proxied through CDP Runtime.evaluate + fetch() in the renderer process.
     * Uses x-codeium-csrf-token header (NOT OAuth tokens).
     */
    private async rpc(method: string, payload: unknown): Promise<unknown> {
        if (!this.connection) {
            throw new Error('Not connected');
        }
        if (!this.cdpEvaluate) {
            throw new Error('No CDP evaluator — call setCdpEvaluate() first');
        }

        const conn = this.connection;
        const url = `https://127.0.0.1:${conn.port}/exa.language_server_pb.LanguageServerService/${method}`;

        // Build a self-contained async IIFE that runs fetch() inside the renderer.
        // Double-serialize payload: outer JSON.stringify for the JS string literal,
        // inner serialization happens at runtime inside the renderer.
        const expression = `
            (async () => {
                try {
                    const resp = await fetch(${JSON.stringify(url)}, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'connect-protocol-version': '1',
                            'x-codeium-csrf-token': ${JSON.stringify(conn.csrfToken)},
                        },
                        body: ${JSON.stringify(JSON.stringify(payload))},
                    });
                    const text = await resp.text();
                    if (!resp.ok) {
                        const hint = resp.status === 401 ? ' (CSRF token may be invalid or missing)' : '';
                        throw new Error('LS ${method}: ' + resp.status + ' — ' + text.slice(0, 1000) + hint);
                    }
                    return text ? JSON.parse(text) : {};
                } catch (e) {
                    return { __cdpProxyError: true, message: e.message || String(e) };
                }
            })()
        `;

        const result = await this.cdpEvaluate(expression);

        // Handle CDP-level errors (expression syntax errors, context destroyed, etc.)
        const resultRecord = result as Record<string, unknown>;
        const exceptionDetails = resultRecord.exceptionDetails as Record<string, unknown> | undefined;
        if (exceptionDetails) {
            const exception = exceptionDetails.exception as Record<string, unknown> | undefined;
            const errText = (exceptionDetails.text as string | undefined)
                || (exception?.description as string | undefined)
                || 'CDP evaluation error';
            throw new Error(`LS ${method}: CDP error — ${errText}`);
        }

        const resultInner = resultRecord.result as Record<string, unknown> | undefined;
        const value = resultInner?.value;

        // Handle application-level errors (fetch failures, non-200 status, etc.)
        const valueRecord = value as Record<string, unknown> | undefined;
        if (valueRecord?.__cdpProxyError) {
            throw new Error((valueRecord.message as string | undefined) || `LS ${method}: unknown proxy error`);
        }

        return value;
    }
}

/**
 * Decode a workspace_id from LS process args back to an absolute path.
 *
 * Encoding scheme (observed from Antigravity LS):
 *   - Prefix: 'file_' (URI scheme)
 *   - Colons encoded as '_3A_'
 *   - Path separators are underscores
 *
 * Example: 'file_c_3A_Users_Daniel_Projects_foo' → 'c:/Users/Daniel/Projects/foo'
 *
 * @param encodedId The raw --workspace_id value
 * @returns Decoded path with forward slashes (caller should normalize as needed)
 */
export function decodeWorkspaceId(encodedId: string): string {
    // Strip 'file_' prefix
    let decoded = encodedId.startsWith('file_') ? encodedId.slice(5) : encodedId;
    // Restore colons from '_3A_' → ':/' (the trailing _ is the path separator after the colon)
    decoded = decoded.replace(/_3[Aa]_/g, ':/');
    // Replace remaining underscores with path separators
    decoded = decoded.replace(/_/g, '/');
    return decoded;
}

/**
 * Extract the cascade run status from a GetCascadeTrajectory response.
 *
 * The gRPC response nests the status in different places depending on the
 * server version. This helper normalizes the lookup so callers don't need
 * to duplicate the fallback chain.
 *
 * @param trajectoryResp Raw response from GetCascadeTrajectory RPC
 * @returns The run status string (e.g. 'CASCADE_RUN_STATUS_RUNNING') or null
 */
export function extractCascadeRunStatus(trajectoryResp: unknown): string | null {
    const tr = trajectoryResp as Record<string, unknown> | undefined;
    const trajectory = (tr?.trajectory as Record<string, unknown> | undefined) ?? tr;
    return typeof trajectory?.cascadeRunStatus === 'string'
        ? trajectory.cascadeRunStatus
        : typeof tr?.cascadeRunStatus === 'string'
            ? tr.cascadeRunStatus
            : typeof trajectory?.status === 'string'
                ? trajectory.status
                : typeof tr?.status === 'string'
                    ? tr.status
                    : null;
}
