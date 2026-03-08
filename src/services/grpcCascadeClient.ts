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

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Connection info discovered from the LS process */
export interface LSConnection {
    port: number;
    csrfToken: string;
    useTls: boolean;
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
    type: 'text' | 'tool_call' | 'status' | 'complete' | 'error';
    text?: string;
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

    constructor() {
        super();
        // Self-signed cert on localhost — skip TLS verification
        this.agent = new https.Agent({ rejectUnauthorized: false });
        this.httpAgent = new http.Agent();
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

    /**
     * Create a new headless cascade and optionally send a message.
     *
     * @param text Optional text to send
     * @param model Optional model identifier
     * @returns cascadeId or null
     */
    async createCascade(text?: string, model?: ModelId): Promise<string | null> {
        const startResp = await this.rpc('StartCascade', { source: 0 });
        const cascadeId = startResp?.cascadeId;
        if (!cascadeId) {
            logger.error('[GrpcCascadeClient] StartCascade returned no cascadeId');
            return null;
        }
        logger.info(`[GrpcCascadeClient] Cascade created: ${cascadeId}`);

        if (text) {
            const sendResult = await this.sendMessage(cascadeId, text, model);
            if (!sendResult.ok) {
                logger.warn(`[GrpcCascadeClient] Initial send failed for cascade ${cascadeId}: ${sendResult.error}`);
                return null;
            }
        }

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
            return { ok: true, data: result };
        } catch (err: any) {
            return { ok: false, error: err.message || String(err) };
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
        const url = `${proto}://127.0.0.1:${conn.port}/exa.language_server_pb.LanguageServerService/StreamCascadeReactiveUpdates`;

        // Use the same content-type format as unary RPCs (application/json)
        // to avoid HTTP 415 from newer LS versions that reject connect+json.
        const jsonBody = JSON.stringify({ cascadeId });

        const headers: Record<string, string | number> = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(jsonBody),
            'connect-protocol-version': '1',
        };
        if (conn.csrfToken) {
            headers['x-codeium-csrf-token'] = conn.csrfToken;
        }

        const reqOptions: any = {
            method: 'POST',
            headers,
        };
        if (conn.useTls) {
            reqOptions.rejectUnauthorized = false;
        }

        const req = httpModule.request(url, reqOptions, (res) => {
            // Diagnostic: log HTTP status and cascade ID
            logger.warn(`[GrpcStream] HTTP ${res.statusCode} for cascade=${cascadeId.slice(0, 12)}... url=${url}`);
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

            res.on('data', (chunk: Buffer) => {
                totalBytesReceived += chunk.length;
                // Diagnostic: log first chunk
                if (totalBytesReceived === chunk.length) {
                    logger.warn(`[GrpcStream] First chunk: ${chunk.length} bytes, hex=${chunk.slice(0, 50).toString('hex')}`);
                }

                // Accumulate raw binary buffer for parsing
                rawBuffer = Buffer.concat([rawBuffer, chunk]);

                // Detect format: Connect streaming envelope (binary frames) vs plain JSON
                // Connect envelopes start with flag byte (0x00 data, 0x02 trailer)
                // Plain JSON starts with '{' (0x7B)
                if (rawBuffer.length > 0 && (rawBuffer[0] === 0x00 || rawBuffer[0] === 0x02)) {
                    // Connect streaming envelope format
                    while (rawBuffer.length >= 5) {
                        const flags = rawBuffer[0];
                        const messageLength = rawBuffer.readUInt32BE(1);

                        if (rawBuffer.length < 5 + messageLength) {
                            break; // Need more data
                        }

                        const messageData = rawBuffer.slice(5, 5 + messageLength);
                        rawBuffer = rawBuffer.slice(5 + messageLength);

                        if (flags === 2 || (flags & 0x02)) { // Trailer flag
                            try {
                                const trailer = JSON.parse(messageData.toString('utf8'));
                                if (trailer.error) {
                                    logger.warn(`[GrpcStream] Trailer error: ${JSON.stringify(trailer.error).slice(0, 300)}`);
                                }
                            } catch { /* ignore */ }
                            continue;
                        }

                        try {
                            const text = messageData.toString('utf8');
                            const parsed = JSON.parse(text);
                            this.emit('data', this.parseStreamEvent(parsed));
                        } catch (e) {
                            logger.warn(`[GrpcStream] Parse failure: ${e}`);
                        }
                    }
                } else {
                    // Plain JSON format (newline-delimited or single object)
                    const bufStr = rawBuffer.toString('utf8');
                    const lines = bufStr.split('\n');

                    // Keep the last potentially incomplete line in the buffer
                    const lastLine = lines.pop() ?? '';
                    rawBuffer = Buffer.from(lastLine, 'utf8');

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        try {
                            const parsed = JSON.parse(trimmed);
                            this.emit('data', this.parseStreamEvent(parsed));
                        } catch (e) {
                            logger.warn(`[GrpcStream] JSON line parse failure: ${e}`);
                        }
                    }
                }
            });

            res.on('end', () => {
                // Try parsing any remaining buffer
                if (rawBuffer.length > 0) {
                    const remaining = rawBuffer.toString('utf8').trim();
                    if (remaining) {
                        try {
                            const parsed = JSON.parse(remaining);
                            this.emit('data', this.parseStreamEvent(parsed));
                        } catch { /* ignore partial data */ }
                    }
                }

                logger.warn(`[GrpcStream] Stream ended, total bytes=${totalBytesReceived}`);
                this.emit('complete');
            });

            res.on('error', (err) => this.emit('error', err));
        });

        req.on('error', (err) => {
            if (!controller.signal.aborted) {
                this.emit('error', err);
            }
        });

        controller.signal.addEventListener('abort', () => req.destroy());
        req.write(jsonBody);
        req.end();

        return controller;
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

            const headers: Record<string, string | number> = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'connect-protocol-version': '1',
            };
            if (conn.csrfToken) {
                headers['x-codeium-csrf-token'] = conn.csrfToken;
            }

            const reqOptions: any = {
                method: 'POST',
                headers,
            };
            if (conn.useTls) {
                reqOptions.rejectUnauthorized = false;
            }

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

// ---------------------------------------------------------------------------
// LS Process Discovery (compliant — same as antigravity-sdk)
// ---------------------------------------------------------------------------

/**
 * Discover LS connection by inspecting the Language Server process CLI args.
 *
 * Compliant strategy (same as antigravity-sdk):
 *   1. Find the LS process via ps/Get-CimInstance
 *   2. Extract --csrf_token and --extension_server_port from CLI args
 *   3. Find the ConnectRPC port via netstat (exclude extension_server_port)
 *   4. Probe ports to determine TLS vs plaintext
 *
 * NO OAuth tokens are extracted.
 */
export async function discoverLSConnection(workspaceHint?: string): Promise<LSConnection | null> {
    try {
        const platform = process.platform;

        // Phase 1: Find LS process and extract CLI args
        const processInfo = await findLSProcess(platform, workspaceHint);
        if (!processInfo) {
            logger.debug('[GrpcDiscovery] No LS process found');
            return null;
        }

        logger.debug(`[GrpcDiscovery] LS process: PID=${processInfo.pid}, csrf=present, ext_port=${processInfo.extPort}`);

        // Phase 2: Find ConnectRPC port via netstat
        const connectPort = await findConnectPort(platform, processInfo.pid, processInfo.extPort);
        if (!connectPort) {
            logger.debug('[GrpcDiscovery] Could not find ConnectRPC port');
            return null;
        }

        return {
            port: connectPort.port,
            csrfToken: processInfo.csrfToken,
            useTls: connectPort.tls,
        };
    } catch (err: any) {
        logger.debug(`[GrpcDiscovery] Discovery failed: ${err.message}`);
        return null;
    }
}

/**
 * Phase 1: Find the Language Server process and extract CLI args.
 */
async function findLSProcess(
    platform: string,
    workspaceHint?: string,
): Promise<{ pid: number; csrfToken: string; extPort: number } | null> {
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
        return null;
    }

    const lines = output.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return null;

    // Pick the best line (matching workspace if possible)
    let bestLine: string | null = null;
    if (workspaceHint) {
        for (const line of lines) {
            if (line.toLowerCase().includes(workspaceHint.toLowerCase())) {
                bestLine = line;
                break;
            }
        }
    }
    if (!bestLine) bestLine = lines[0];

    // Extract PID
    let pid: number;
    if (platform === 'win32') {
        pid = parseInt(bestLine.split('|')[0].trim(), 10);
    } else {
        pid = parseInt(bestLine.trim().split(/\s+/)[0], 10);
    }

    const csrfToken = extractArg(bestLine, 'csrf_token');
    const extPortStr = extractArg(bestLine, 'extension_server_port');
    const extPort = extPortStr ? parseInt(extPortStr, 10) : 0;

    if (!csrfToken || isNaN(pid)) return null;

    return { pid, csrfToken, extPort };
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
