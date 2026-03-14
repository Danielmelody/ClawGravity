import { exec } from 'child_process';
import { promisify } from 'util';
import { Effect, Schedule } from 'effect';
import { logger } from '../utils/logger';
import { GrpcCascadeClient, LSConnection } from './grpcCascadeClient';

const execAsync = promisify(exec);

/** Execute a shell command, returning stdout or null on failure. */
function execSafe(cmd: string, label: string, timeoutMs = 5000): Effect.Effect<string | null, never> {
    return Effect.tryPromise({
        try: () => execAsync(cmd, { encoding: 'utf8', timeout: timeoutMs }).then(r => r.stdout),
        catch: (err) => err,
    }).pipe(
        Effect.catchAll((err) => {
            logger.warn(`[LsClientManager] ${label} failed: ${err instanceof Error ? (err as Error).message : String(err)}`);
            return Effect.succeed(null);
        }),
    );
}

export class LsClientManager {
    private lsClient: GrpcCascadeClient | null = null;
    private lsClientInitPromise: Promise<GrpcCascadeClient | null> | null = null;
    private sniffedLSCredentials: LSConnection | null = null;
    public lastLSUnavailableReason: string | null = null;

    public reset(): void {
        this.lsClient = null;
        this.lsClientInitPromise = null;
        this.sniffedLSCredentials = null;
        this.lastLSUnavailableReason = null;
    }

    public async getClient(currentWorkspacePath: string | null, evaluateFn: (expression: string) => Promise<unknown>): Promise<GrpcCascadeClient | null> {
        return this.ensureClient(currentWorkspacePath, evaluateFn);
    }

    private async ensureClient(currentWorkspacePath: string | null, evaluateFn: (expression: string) => Promise<unknown>): Promise<GrpcCascadeClient | null> {
        if (this.lsClient?.isReady()) {
            this.lastLSUnavailableReason = null;
            return this.lsClient;
        }

        if (this.lsClientInitPromise) return this.lsClientInitPromise;

        this.lsClientInitPromise = (async () => {
            try {
                // Use Effect.retry with a schedule instead of a manual for-loop
                const discoveryEffect = Effect.tryPromise({
                    try: () => this.attemptDiscovery(currentWorkspacePath, evaluateFn),
                    catch: (e) => e,
                }).pipe(
                    Effect.flatMap(() =>
                        this.sniffedLSCredentials
                            ? Effect.succeed(this.sniffedLSCredentials)
                            : currentWorkspacePath
                                ? Effect.fail(new Error('Discovery failed, retrying...'))
                                : Effect.succeed(null as LSConnection | null),
                    ),
                );

                const retrySchedule = Schedule.recurs(6).pipe(
                    Schedule.addDelay(() => 5000),
                );

                const credentials = await Effect.runPromise(
                    discoveryEffect.pipe(
                        Effect.retry(retrySchedule),
                        Effect.catchAll(() => Effect.succeed(null as LSConnection | null)),
                    ),
                );

                if (!credentials) {
                    this.lastLSUnavailableReason = 'LS client unavailable: Could not discover LS credentials from process or Network sniffing.';
                    logger.debug(`[LsClientManager] ${this.lastLSUnavailableReason}`);
                    return null;
                }

                this.lsClient = new GrpcCascadeClient();
                this.lsClient.setCdpEvaluate(async (expression: string) => evaluateFn(expression));
                this.lsClient.setConnection(credentials);

                this.lastLSUnavailableReason = null;
                logger.info(`[LsClientManager] LS client initialized: port=${credentials.port}, tls=${credentials.useTls}`);
                return this.lsClient;
            } catch (err: unknown) {
                this.lastLSUnavailableReason = `LS client unavailable: ${err instanceof Error ? err.message : String(err)}`;
                logger.error(`[LsClientManager] LS client init failed: ${this.lastLSUnavailableReason}`);
                return null;
            } finally {
                this.lsClientInitPromise = null;
            }
        })();

        return this.lsClientInitPromise;
    }

    /** Single attempt to discover LS credentials (performance entries + fallback) */
    private async attemptDiscovery(currentWorkspacePath: string | null, evaluateFn: (expression: string) => Promise<unknown>): Promise<void> {
        if (!this.sniffedLSCredentials) {
            await this.discoverFromProcess(evaluateFn);
        }
        if (!this.sniffedLSCredentials && currentWorkspacePath) {
            await this.discoverFromWorkspaceProcess(currentWorkspacePath, evaluateFn);
        }
    }

    private async discoverFromProcess(evaluateFn: (expression: string) => Promise<unknown>): Promise<void> {
        try {
            logger.info('[LsClientManager] Starting port-first credential discovery...');
            const perfScript = `(() => {
                const entries = performance.getEntries();
                for (const e of entries) {
                    if (e.name && e.name.includes('language_server_pb')) return e.name;
                }
                return null;
            })()`;

            const lsUrl = await evaluateFn(perfScript) as string;
            if (!lsUrl) { logger.warn('[LsClientManager] No LS requests found in performance entries'); return; }

            const portMatch = lsUrl.match(/127\.0\.0\.1:(\d+)/);
            if (!portMatch) { logger.warn(`[LsClientManager] Could not extract port from LS URL: ${lsUrl}`); return; }

            const lsPort = parseInt(portMatch[1], 10);
            const useTls = lsUrl.startsWith('https');
            logger.info(`[LsClientManager] Found LS port from performance entries: port=${lsPort}, tls=${useTls}`);

            // Discover PID via netstat
            const netstatOut = await Effect.runPromise(execSafe(`netstat -ano | findstr "LISTENING" | findstr ":${lsPort} "`, 'netstat'));
            if (!netstatOut) return;

            let lsPid: number | null = null;
            for (const line of netstatOut.split('\n')) {
                if (line.includes(`:${lsPort} `) || line.includes(`:${lsPort}\t`)) {
                    const pidMatch = line.trim().match(/(\d+)\s*$/);
                    if (pidMatch) { lsPid = parseInt(pidMatch[1], 10); break; }
                }
            }
            if (!lsPid) { logger.warn(`[LsClientManager] Could not find PID for port ${lsPort}`); return; }
            logger.info(`[LsClientManager] Port ${lsPort} → PID ${lsPid}`);

            // Get CSRF token from process command line
            const wmicOut = await Effect.runPromise(execSafe(
                `wmic process where "ProcessId=${lsPid}" get CommandLine /format:csv`, 'wmic',
            ));
            if (!wmicOut) return;

            const csrfMatch = wmicOut.match(/--csrf_token\s+(\S+)/);
            if (!csrfMatch) { logger.warn(`[LsClientManager] No --csrf_token found in command line of PID ${lsPid}`); return; }

            const csrfToken = csrfMatch[1];
            logger.info(`[LsClientManager] PID ${lsPid} csrf=${csrfToken.slice(0, 8)}...`);

            // Validate connection
            const proto = useTls ? 'https' : 'http';
            const testScript = `fetch("${proto}://127.0.0.1:${lsPort}/exa.language_server_pb.LanguageServerService/GetUserStatus",{method:"POST",headers:{"Content-Type":"application/proto","Connect-Protocol-Version":"1","x-codeium-csrf-token":"${csrfToken}"},body:new Uint8Array([])}).then(r=>r.status).catch(()=>0)`;

            const status = await evaluateFn(testScript);
            if (status === 200) {
                this.sniffedLSCredentials = { port: lsPort, csrfToken, useTls };
                logger.info(`[LsClientManager] ✅ Validated ${proto.toUpperCase()} port ${lsPort} (status=200)`);
            } else {
                logger.warn(`[LsClientManager] ❌ Port ${lsPort} validation returned status=${status}`);
            }
        } catch (err: unknown) {
            logger.error(`[LsClientManager] Port-first discovery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private static encodeWorkspaceId(workspacePath: string): string {
        let p = workspacePath.replace(/[\\/]+$/, '');
        if (/^[A-Z]:/.test(p)) p = p[0].toLowerCase() + p.slice(1);
        return `file_${p.replace(/:/g, '_3A').replace(/[\\/]/g, '_')}`;
    }

    private async discoverFromWorkspaceProcess(currentWorkspacePath: string, evaluateFn: (expression: string) => Promise<unknown>): Promise<void> {
        try {
            const expectedWorkspaceId = LsClientManager.encodeWorkspaceId(currentWorkspacePath);
            logger.info(`[LsClientManager] Workspace-process fallback: looking for workspace_id containing "${expectedWorkspaceId}"`);

            const wmicOutput = await Effect.runPromise(execSafe(
                `wmic process where "name like '%language_server%'" get ProcessId,CommandLine /format:list`,
                'wmic-scan', 10000,
            ));
            if (!wmicOutput) return;

            const blocks = wmicOutput.split(/\r?\n\r?\n/).filter(b => b.includes('CommandLine='));
            let matchedPid: number | null = null;
            let matchedCsrf: string | null = null;

            for (const block of blocks) {
                const wsIdMatch = block.match(/--workspace_id\s+(\S+)/);
                if (!wsIdMatch || wsIdMatch[1] !== expectedWorkspaceId) continue;
                const csrfMatch = block.match(/--csrf_token\s+(\S+)/);
                if (!csrfMatch) continue;
                matchedCsrf = csrfMatch[1];
                const pidMatch = block.match(/ProcessId[=:](\d+)/);
                if (!pidMatch) continue;
                matchedPid = parseInt(pidMatch[1], 10);
                logger.info(`[LsClientManager] Matched LS process: PID=${matchedPid}, csrf=${matchedCsrf.slice(0, 8)}..., workspace_id=${wsIdMatch[1]}`);
                break;
            }

            if (!matchedPid || !matchedCsrf) {
                logger.warn(`[LsClientManager] No language_server process found for workspace_id "${expectedWorkspaceId}"`);
                return;
            }

            const netstatOutput = await Effect.runPromise(execSafe('netstat -ano | findstr "LISTENING"', 'netstat'));
            if (!netstatOutput) return;

            const candidatePorts: number[] = [];
            for (const line of netstatOutput.split('\n')) {
                const trimmed = line.trim();
                const pidSuffix = trimmed.match(/(\d+)\s*$/);
                if (!pidSuffix || parseInt(pidSuffix[1], 10) !== matchedPid) continue;
                const portMatch = trimmed.match(/127\.0\.0\.1:(\d+)/);
                if (portMatch) candidatePorts.push(parseInt(portMatch[1], 10));
            }

            if (candidatePorts.length === 0) {
                logger.warn(`[LsClientManager] No listening ports found for PID ${matchedPid}`);
                return;
            }

            logger.info(`[LsClientManager] PID ${matchedPid} listening on ports: ${candidatePorts.join(', ')}`);

            for (const port of candidatePorts) {
                for (const useTls of [false, true]) {
                    const proto = useTls ? 'https' : 'http';
                    const testScript = `fetch("${proto}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus",{method:"POST",headers:{"Content-Type":"application/proto","Connect-Protocol-Version":"1","x-codeium-csrf-token":"${matchedCsrf}"},body:new Uint8Array([])}).then(r=>r.status).catch(()=>0)`;

                    try {
                        const status = await evaluateFn(testScript);
                        if (status === 200) {
                            this.sniffedLSCredentials = { port, csrfToken: matchedCsrf, useTls };
                            logger.info(`[LsClientManager] ✅ Workspace-process fallback succeeded: ${proto.toUpperCase()} port ${port} (PID ${matchedPid})`);
                            return;
                        }
                        logger.debug(`[LsClientManager] Port ${port} (${proto}) returned status=${status}`);
                    } catch {
                        // Try next port/protocol
                    }
                }
            }
            logger.warn(`[LsClientManager] Workspace-process fallback: no ports validated for PID ${matchedPid}`);
        } catch (err: unknown) {
            logger.error(`[LsClientManager] Workspace-process fallback failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
