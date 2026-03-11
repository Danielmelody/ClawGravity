/**
 * grpcCascadeClient.ts
 *
 * Direct ConnectRPC client for Antigravity's LanguageServerService.
 * Bypasses DOM injection — sends messages and streams responses
 * via the Connect protocol v1 (JSON) RPC API.
 *
 * COMPLIANCE (following antigravity-sdk patterns):
 *   - Auth uses ephemeral per-session CSRF token ONLY (not OAuth tokens)
 *   - CSRF token is discovered from the LS process CLI args (--csrf_token)
 *   - Port is discovered via process listing + netstat
 *   - No sensitive keys (oauthToken, agentManagerInitState) are accessed
 *   - All communication stays on localhost (127.0.0.1)
 *   - No data leaves the local machine through this channel
 *
 * Key endpoints:
 *   - SendUserCascadeMessage: sends a user message to a specific cascade session
 *   - StartCascade: creates a new cascade session
 *   - StreamCascadeReactiveUpdates: event-driven stream for real-time updates
 *
 * Reference: https://github.com/Kanezal/antigravity-sdk
 */

import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import https from 'https';
import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Connection info discovered from the LS process */
export interface LSConnection {
    port: number;
    csrfToken: string;
    useTls: boolean;
    /** Encoded workspace ID from --workspace_id CLI arg (e.g. 'file_c_3A_Users_Daniel_Projects_foo') */
    workspaceId?: string;
}

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
    raw?: any;
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

// ---------------------------------------------------------------------------
// GrpcCascadeClient
// ---------------------------------------------------------------------------

export class GrpcCascadeClient extends EventEmitter {
    private connection: LSConnection | null = null;
    private agent: https.Agent;
    private httpAgent: http.Agent;
    private lastOperationError: string | null = null;

    constructor() {
        super();
        // Self-signed cert on localhost — skip TLS verification
        this.agent = new https.Agent({ rejectUnauthorized: false });
        this.httpAgent = new http.Agent();
    }

    /**
     * Build standard Connect-protocol headers and request options.
     */
    private buildRequestOptions(
        conn: LSConnection,
        contentType: string,
        contentLength: number,
    ): { headers: Record<string, string | number>; reqOptions: any } {
        const headers: Record<string, string | number> = {
            'Content-Type': contentType,
            'Content-Length': contentLength,
            'connect-protocol-version': '1',
        };
        if (conn.csrfToken) {
            headers['x-codeium-csrf-token'] = conn.csrfToken;
        }
        const reqOptions: any = { method: 'POST', headers };
        if (conn.useTls) {
            reqOptions.rejectUnauthorized = false;
        }
        return { headers, reqOptions };
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
        return this.connection !== null;
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

        let startResp: any;
        try {
            startResp = await this.rpc('StartCascade', { source: 0 });
        } catch (err: any) {
            this.lastOperationError = err?.message || String(err);
            logger.error(`[GrpcCascadeClient] StartCascade failed: ${this.lastOperationError}`);
            return null;
        }

        const cascadeId = startResp?.cascadeId;
        if (!cascadeId) {
            this.lastOperationError = 'StartCascade returned no cascadeId';
            logger.error('[GrpcCascadeClient] StartCascade returned no cascadeId');
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
     */
    async sendMessage(
        cascadeId: string,
        text: string,
        model?: ModelId,
    ): Promise<{ ok: boolean; data?: any; error?: string }> {
        // Verified payload format via E2E testing:
        //   items: [{text}]  (NOT chunk/case)
        //   planModel: model identifier string or legacy numeric ID
        //   conversational: {} (NOT plannerTypeConfig.case)
        //
        // When model is NOT specified, omit planModel entirely so the
        // server uses the user's UI-selected model (not a hardcoded default).
        const plannerConfig: any = {
            conversational: {},
        };
        if (model != null) {
            plannerConfig.planModel = model;
        }

        const payload: any = {
            cascadeId,
            items: [{ text }],
            cascadeConfig: { plannerConfig },
        };

        try {
            const result = await this.rpc('SendUserCascadeMessage', payload);
            this.lastOperationError = null;
            return { ok: true, data: result };
        } catch (err: any) {
            this.lastOperationError = err.message || String(err);
            return { ok: false, error: this.lastOperationError || undefined };
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
    async listCascades(): Promise<any> {
        const resp = await this.rpc('GetAllCascadeTrajectories', {});
        return resp?.trajectorySummaries ?? {};
    }

    /**
     * Get user status (tier, models, etc.)
     */
    async getUserStatus(): Promise<any> {
        return this.rpc('GetUserStatus', {});
    }

    /**
     * Open a streaming connection to receive real-time cascade updates.
     * Used by GrpcResponseMonitor for event-driven listening.
     *
     * Uses the StreamAgentStateUpdates RPC (the same endpoint the IDE
     * workbench uses). This endpoint is NOT gated by the experiment flag
     * that disables StreamCascadeReactiveUpdates ("reactive state is
     * disabled"). It returns full state updates including trajectory
     * steps, status changes, and planner responses.
     *
     * Emits events:
     *   - 'data' (CascadeStreamEvent): each response chunk
     *   - 'complete': when the stream ends
     *   - 'error' (error: Error): on connection or parse errors
     *
     * @param cascadeId The conversation/session ID to stream updates for
     * @returns AbortController to cancel the stream
     */
    streamCascadeUpdates(cascadeId: string): AbortController {
        if (!this.connection) {
            throw new Error('Not connected — call setConnection() first');
        }

        const controller = new AbortController();
        const conn = this.connection;
        const httpModule = conn.useTls ? https : http;
        const proto = conn.useTls ? 'https' : 'http';
        const url = `${proto}://127.0.0.1:${conn.port}/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates`;

        // StreamAgentStateUpdates is a server-streaming RPC using ConnectRPC.
        // Proto: StreamAgentStateUpdatesRequest { conversationId (string), subscriberId (string) }
        // Must use:
        //   - Content-Type: application/connect+json (NOT application/json)
        //   - Body: Connect streaming envelope (5-byte header: 0x00 flag + 4-byte BE length + JSON)
        const subscriberId = randomUUID();
        const payload = {
            conversationId: cascadeId,
            subscriberId,
        };
        const jsonStr = JSON.stringify(payload);
        const msgBuf = Buffer.from(jsonStr, 'utf8');

        // Connect streaming envelope: flag byte (0x00=uncompressed) + uint32 BE length + message
        const envelopedBody = Buffer.alloc(5 + msgBuf.length);
        envelopedBody[0] = 0x00; // flags: uncompressed data frame
        envelopedBody.writeUInt32BE(msgBuf.length, 1);
        msgBuf.copy(envelopedBody, 5);

        const { reqOptions } = this.buildRequestOptions(
            conn,
            'application/connect+json',
            envelopedBody.length,
        );

        const req = httpModule.request(url, reqOptions, (res) => {
            logger.info(`[GrpcStream] HTTP ${res.statusCode} for cascade=${cascadeId.slice(0, 12)}... (agent state stream)`);
            if (res.statusCode && res.statusCode !== 200) {
                let errBody = '';
                res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
                res.on('end', () => {
                    logger.warn(`[GrpcStream] Non-200 response body: ${errBody.slice(0, 500)}`);
                    this.emit('error', new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`));
                });
                return;
            }

            let totalBytesReceived = 0;
            let rawBuffer = Buffer.alloc(0);
            let frameCount = 0;

            res.on('data', (chunk: Buffer) => {
                // Skip processing if stream was aborted
                if (controller.signal.aborted) return;
                totalBytesReceived += chunk.length;

                if (totalBytesReceived === chunk.length) {
                    logger.info(`[GrpcStream] First chunk: ${chunk.length} bytes (agent state stream connected)`);
                }

                // Accumulate raw binary buffer for parsing Connect streaming envelopes
                rawBuffer = Buffer.concat([rawBuffer, chunk]);

                // Parse Connect streaming envelope frames
                // Each frame: 1-byte flags + 4-byte BE length + message body
                while (rawBuffer.length >= 5) {
                    const flags = rawBuffer[0];
                    const messageLength = rawBuffer.readUInt32BE(1);

                    if (rawBuffer.length < 5 + messageLength) {
                        break; // Need more data
                    }

                    const messageData = rawBuffer.slice(5, 5 + messageLength);
                    rawBuffer = rawBuffer.slice(5 + messageLength);
                    frameCount++;

                    // Trailer frame (flags & 0x02)
                    if (flags & 0x02) {
                        try {
                            const trailer = JSON.parse(messageData.toString('utf8'));
                            if (trailer.error) {
                                logger.warn(`[GrpcStream] Trailer error: ${JSON.stringify(trailer.error).slice(0, 300)}`);
                                this.emit('error', new Error(trailer.error.message || 'Stream trailer error'));
                            }
                        } catch { /* ignore */ }
                        continue;
                    }

                    // Data frame — agent state update
                    // Format: { update: { conversationId, status, mainTrajectoryUpdate, ... } }
                    try {
                        const text = messageData.toString('utf8');
                        const parsed = JSON.parse(text);

                        // Parse the agent state update into CascadeStreamEvents
                        const events = this.parseAgentStateUpdate(parsed);
                        for (const event of events) {
                            this.emit('data', event);
                        }
                    } catch (e) {
                        logger.warn(`[GrpcStream] Parse failure: ${e}`);
                    }
                }
            });

            res.on('end', () => {
                if (controller.signal.aborted) return;
                logger.info(`[GrpcStream] Agent state stream ended, total bytes=${totalBytesReceived}, frames=${frameCount}`);
                this.emit('complete');
            });

            res.on('error', (err) => {
                if (controller.signal.aborted) return;
                this.emit('error', err);
            });
        });

        req.on('error', (err) => {
            if (!controller.signal.aborted) {
                this.emit('error', err);
            }
        });

        controller.signal.addEventListener('abort', () => req.destroy());
        req.write(envelopedBody);
        req.end();

        return controller;
    }

    /**
     * Parse a StreamAgentStateUpdates response into CascadeStreamEvents.
     *
     * The agent state stream returns full state updates:
     * { update: { conversationId, status, mainTrajectoryUpdate: { stepsUpdate: { ... } }, ... } }
     *
     * We extract:
     *   - Status transitions (IDLE, RUNNING) from update.status
     *   - A generic 'status' event so GrpcResponseMonitor knows something changed
     *     and can schedule a trajectory fetch for the rendered content.
     */
    parseAgentStateUpdate(raw: any): CascadeStreamEvent[] {
        const update = raw?.update;
        if (!update) return [];

        const events: CascadeStreamEvent[] = [];
        const status = update.status || '';

        if (status === 'CASCADE_RUN_STATUS_IDLE') {
            events.push({ type: 'status', text: 'CASCADE_RUN_STATUS_IDLE', raw });
        } else if (status === 'CASCADE_RUN_STATUS_RUNNING') {
            events.push({ type: 'status', text: 'CASCADE_RUN_STATUS_RUNNING', raw });
        } else if (status.includes('QUOTA')) {
            events.push({ type: 'error', text: 'Quota reached', raw });
        }

        // Only emit a generic "something changed" notification when the frame
        // carries actual trajectory step updates. The agent state stream is
        // very chatty — many frames are pure status heartbeats without new
        // content. Avoiding redundant notifications prevents excessive
        // GetCascadeTrajectory RPCs that hammer the LS.
        const hasStepUpdates = update.mainTrajectoryUpdate?.stepsUpdate?.indices?.length > 0
            || update.mainTrajectoryUpdate?.stepsUpdate?.steps?.length > 0
            || update.artifactSnapshotsUpdate
            || update.executorMetadata?.terminationReason;

        if (hasStepUpdates) {
            events.push({ type: 'status', raw });
        }

        return events;
    }

    /**
     * Make a raw RPC call to any LS method.
     */
    async rawRPC(method: string, payload: any): Promise<any> {
        return this.rpc(method, payload);
    }

    // ---------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------

    /**
     * Make an authenticated RPC call to the Language Server.
     * Uses x-codeium-csrf-token header (NOT OAuth tokens).
     */
    private rpc(method: string, payload: any): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.connection) {
                return reject(new Error('Not connected'));
            }

            const conn = this.connection;
            const httpModule = conn.useTls ? https : http;
            const proto = conn.useTls ? 'https' : 'http';
            const url = `${proto}://127.0.0.1:${conn.port}/exa.language_server_pb.LanguageServerService/${method}`;
            const body = JSON.stringify(payload);

            const { reqOptions } = this.buildRequestOptions(
                conn,
                'application/json',
                Buffer.byteLength(body),
            );

            const req = httpModule.request(url, reqOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { resolve(data ? JSON.parse(data) : {}); }
                        catch { resolve(data); }
                    } else {
                        const hint = res.statusCode === 401
                            ? ' (CSRF token may be invalid or missing)'
                            : '';
                        reject(new Error(`LS ${method}: ${res.statusCode} — ${data.slice(0, 200)}${hint}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    private parseStreamEvent(raw: any): CascadeStreamEvent {
        const result = raw?.result ?? raw ?? {};
        const text = this.extractStreamText(result);
        if (text) {
            return { type: 'text', text, raw };
        }

        if (result.toolCall || result.mcpTool || result.step?.toolCall || result.step?.mcpTool) {
            return { type: 'tool_call', raw };
        }

        const status =
            result.status
            || result.cascadeRunStatus
            || result.step?.status
            || result.step?.cascadeRunStatus;
        if (typeof status === 'string' && status.length > 0) {
            return { type: 'status', text: status, raw };
        }

        const errorPayload = raw?.error || result.error || result.step?.error;
        if (errorPayload) {
            return {
                type: 'error',
                text: errorPayload.message || JSON.stringify(errorPayload),
                raw,
            };
        }

        return { type: 'status', raw };
    }

    private extractStreamText(result: any): string | null {
        const candidates = [
            result?.response?.text,
            result?.assistantResponse?.text,
            result?.plannerResponse?.response,
            result?.step?.response?.text,
            result?.step?.assistantResponse?.text,
            result?.step?.plannerResponse?.response,
        ];

        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.length > 0) {
                return candidate;
            }
        }

        return null;
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
 * Discover ALL LS connections when multiple Antigravity instances are running.
 *
 * When multiple LS processes exist (multi-workspace), the caller should probe
 * each connection to determine which one belongs to the desired workspace.
 * This avoids the fallback-to-first-process problem in `discoverLSConnection`.
 *
 * @returns Array of candidate connections (may be empty)
 */
export async function discoverAllLSConnections(): Promise<LSConnection[]> {
    try {
        const platform = process.platform;
        const allProcesses = await findAllLSProcesses(platform);
        if (allProcesses.length === 0) {
            logger.debug('[GrpcDiscovery] No LS processes found');
            return [];
        }

        logger.debug(`[GrpcDiscovery] Found ${allProcesses.length} LS processes`);

        const connections: LSConnection[] = [];
        for (const proc of allProcesses) {
            const connectPort = await findConnectPort(platform, proc.pid, proc.extPort);
            if (connectPort) {
                connections.push({
                    port: connectPort.port,
                    csrfToken: proc.csrfToken,
                    useTls: connectPort.tls,
                    workspaceId: proc.workspaceId || undefined,
                });
            }
        }

        logger.debug(`[GrpcDiscovery] Resolved ${connections.length} candidate connections from ${allProcesses.length} processes`);
        return connections;
    } catch (err: any) {
        logger.debug(`[GrpcDiscovery] Multi-discovery failed: ${err.message}`);
        return [];
    }
}

/**
 * Shared parser: extract {pid, csrfToken, extPort, workspaceId} from a process command line.
 */
function parseLSProcessLine(
    platform: string,
    line: string,
): { pid: number; csrfToken: string; extPort: number; workspaceId: string | null } | null {
    let pid: number;
    if (platform === 'win32') {
        pid = parseInt(line.split('|')[0].trim(), 10);
    } else {
        pid = parseInt(line.trim().split(/\s+/)[0], 10);
    }

    const csrfToken = extractArg(line, 'csrf_token');
    const extPortStr = extractArg(line, 'extension_server_port');
    const extPort = extPortStr ? parseInt(extPortStr, 10) : 0;
    const workspaceId = extractArg(line, 'workspace_id');

    if (!csrfToken || isNaN(pid)) return null;
    return { pid, csrfToken, extPort, workspaceId };
}

/**
 * Get raw output lines from LS process enumeration.
 */
async function getLSProcessLines(platform: string): Promise<string[]> {
    let output: string;
    try {
        if (platform === 'win32') {
            const psScript = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'language_server' -and $_.CommandLine -match 'csrf_token' } | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }";
            const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
            const result = await execAsync(
                `powershell.exe -NoProfile -EncodedCommand ${encoded}`,
                { encoding: 'utf8', timeout: 10000, windowsHide: true },
            );
            output = result.stdout;
        } else {
            const result = await execAsync(
                'ps -eo pid,args 2>/dev/null | grep language_server | grep csrf_token | grep -v grep',
                { encoding: 'utf8', timeout: 5000 },
            );
            output = result.stdout;
        }
    } catch {
        return [];
    }
    return output.split('\n').filter(l => l.trim().length > 0);
}

/**
 * Find ALL Language Server processes (for multi-workspace support).
 */
async function findAllLSProcesses(
    platform: string,
): Promise<{ pid: number; csrfToken: string; extPort: number; workspaceId: string | null }[]> {
    const lines = await getLSProcessLines(platform);
    const results: { pid: number; csrfToken: string; extPort: number; workspaceId: string | null }[] = [];
    for (const line of lines) {
        const parsed = parseLSProcessLine(platform, line);
        if (parsed) results.push(parsed);
    }
    return results;
}

/**
 * Phase 2: Find the ConnectRPC port via netstat.
 */
async function findConnectPort(
    platform: string,
    pid: number,
    extPort: number,
): Promise<{ port: number; tls: boolean } | null> {
    try {
        let output: string;

        if (platform === 'win32') {
            const result = await execAsync(
                `netstat -aon | findstr "LISTENING" | findstr "${pid}"`,
                { encoding: 'utf8', timeout: 5000, windowsHide: true },
            );
            output = result.stdout;
        } else {
            const result = await execAsync(
                `ss -tlnp 2>/dev/null | grep "pid=${pid}" || netstat -tlnp 2>/dev/null | grep "${pid}"`,
                { encoding: 'utf8', timeout: 5000 },
            );
            output = result.stdout;
        }

        const portMatches = output.matchAll(/127\.0\.0\.1:(\d+)/g);
        const ports: number[] = [];
        for (const m of portMatches) {
            const p = parseInt(m[1], 10);
            if (p !== extPort && !ports.includes(p)) {
                ports.push(p);
            }
        }

        if (ports.length === 0) return null;

        logger.debug(`[GrpcDiscovery] LS ports (excl ext ${extPort}): ${ports.join(', ')}`);

        // Try HTTPS first (preferred)
        for (const port of ports) {
            if (await probePort(port, true)) return { port, tls: true };
        }
        // Fallback: HTTP
        for (const port of ports) {
            if (await probePort(port, false)) return { port, tls: false };
        }
    } catch {
        // netstat failed
    }
    return null;
}

/**
 * Probe a port to check if it accepts ConnectRPC requests.
 */
function probePort(port: number, useTls: boolean): Promise<boolean> {
    const httpModule = useTls ? https : http;
    const proto = useTls ? 'https' : 'http';
    return new Promise((resolve) => {
        const req = httpModule.request(
            `${proto}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': 2, 'connect-protocol-version': '1' },
                rejectUnauthorized: false,
                timeout: 2000,
            } as any,
            (res: any) => {
                // 401 = correct endpoint (CSRF missing), 200 = also correct
                resolve(res.statusCode === 401 || res.statusCode === 200);
            },
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write('{}');
        req.end();
    });
}

/**
 * Extract a CLI argument value from a command-line string.
 */
function extractArg(cmdLine: string, argName: string): string | null {
    const eqMatch = cmdLine.match(new RegExp(`--${argName}=([^\\s"]+)`));
    if (eqMatch) return eqMatch[1];

    const spaceMatch = cmdLine.match(new RegExp(`--${argName}\\s+([^\\s"]+)`));
    if (spaceMatch) return spaceMatch[1];

    return null;
}
