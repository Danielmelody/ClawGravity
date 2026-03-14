import { logger } from '../utils/logger';
import { CDP_PORTS } from '../utils/cdpPorts';
import { EventEmitter } from 'events';
import * as http from 'http';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { extractProjectNameFromPath } from '../utils/pathUtils';
import { CdpConnection } from './cdpConnection';
import { WorkspaceLauncher } from './workspaceLauncher';
import { LsClientManager } from './lsClientManager';
import { GrpcCascadeClient, ModelId, extractCascadeRunStatus } from './grpcCascadeClient';


export interface CdpServiceOptions {
    portsToScan?: number[];
    cdpCallTimeout?: number;
    /** Number of auto-reconnect attempts on disconnect. 0 = no reconnect. Default: 3 */
    maxReconnectAttempts?: number;
    /** Delay between reconnect attempts (ms). Default: 2000 */
    reconnectDelayMs?: number;
}

export interface CdpContext {
    id: number;
    name: string;
    url: string;
    auxData?: {
        frameId?: string;
        type?: string;
        isDefault?: boolean;
    };
}

export interface InjectResult {
    ok: boolean;
    method?: string;
    contextId?: number;
    cascadeId?: string;
    error?: string;
}

export interface ExtractedResponseImage {
    name: string;
    mimeType: string;
    base64Data?: string;
    url?: string;
}



/** UI sync operation result type (Step 9) */
export interface UiSyncResult {
    ok: boolean;
    /** Mode name set (on setUiMode success) */
    mode?: string;
    /** Model name set (on setUiModel success) */
    model?: string;
    error?: string;
}

const RECENT_CASCADE_PROPAGATION_GRACE_MS = 15_000;
const _execAsync = promisify(exec);

export class CdpService extends EventEmitter {
    private ports: number[];
    private isConnectedFlag: boolean = false;
    private connection: CdpConnection | null = null;
    private contexts: CdpContext[] = [];

    /** LS client manager */
    private lsClientManager = new LsClientManager();
    /** Cached cascade ID for LS API calls */
    private cachedCascadeId: string | null = null;
    /** Newly created cascade ID awaiting visibility in listCascades() */
    private recentCreatedCascadeId: string | null = null;
    /** When recentCreatedCascadeId was set */
    private recentCreatedCascadeAt = 0;
    private idCounter = 1;
    private cdpCallTimeout = 30000;
    private targetUrl: string | null = null;
    private targetFrameId: string | null = null;
    /** Network sniff handler reference (for cleanup across reconnects) */
    private networkSniffHandler: ((params: Record<string, unknown>) => void) | null = null;
    /** Number of auto-reconnect attempts on disconnect */
    private maxReconnectAttempts: number;
    /** Original maxReconnectAttempts (preserved across disconnect/reconnect) */
    private readonly originalMaxReconnectAttempts: number;
    /** Delay between reconnect attempts (ms) */
    private reconnectDelayMs: number;
    /** Current reconnect attempt count */
    private reconnectAttemptCount: number = 0;
    /** Reconnecting flag (prevents double connections) */
    private isReconnecting: boolean = false;
    /** Currently connected workspace name */
    private currentWorkspaceName: string | null = null;
    /** Last requested workspace path (used for deterministic reconnect) */
    private currentWorkspacePath: string | null = null;
    /** Workspace switching flag (suppresses disconnected event) */
    private isSwitchingWorkspace: boolean = false;

    constructor(options: CdpServiceOptions = {}) {
        super();
        this.ports = options.portsToScan || [...CDP_PORTS];
        if (options.cdpCallTimeout) this.cdpCallTimeout = options.cdpCallTimeout;
        this.maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
        this.originalMaxReconnectAttempts = this.maxReconnectAttempts;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 2000;
    }

    static clearLaunchCooldowns(): void {
        WorkspaceLauncher.clearLaunchCooldowns();
    }

    public async getJson(url: string): Promise<unknown[]> {
        return new Promise((resolve, reject) => {
            http.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                });
            }).on('error', reject);
        });
    }

    /**
     * Backward-compatible launch helper retained for older tests/callers.
     */
    public async runCommand(command: string, args: string[]): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(command, args, { stdio: 'ignore', shell: process.platform === 'win32' });

            child.once('error', (error) => {
                reject(error);
            });

            child.once('close', (code) => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
            });
        });
    }

    /** Check if a CDP target is a workbench page (not Launchpad, not jetski-agent). */
    public isWorkbenchPage(t: Record<string, unknown>): boolean {
        return (
            t.type === 'page' &&
            !!t.webSocketDebuggerUrl &&
            !(t.title as string | undefined)?.includes('Launchpad') &&
            !(t.url as string | undefined)?.includes('workbench-jetski-agent') &&
            !!(t.url as string | undefined)?.includes('workbench')
        );
    }

    async discoverTarget(): Promise<string> {
        const allPages: Record<string, unknown>[] = [];
        for (const port of this.ports) {
            try {
                const list = await this.getJson(`http://127.0.0.1:${port}/json/list`);
                allPages.push(...list);
            } catch {
                // Ignore port not found
            }
        }

        let target = allPages.find(t =>
            t.type === 'page' &&
            t.webSocketDebuggerUrl &&
            !t.title?.includes('Launchpad') &&
            !t.url?.includes('workbench-jetski-agent') &&
            (t.url?.includes('workbench') || t.title?.includes('Antigravity') || t.title?.includes('Cascade'))
        );

        if (!target) {
            target = allPages.find(t =>
                t.webSocketDebuggerUrl &&
                (t.url?.includes('workbench') || t.title?.includes('Antigravity') || t.title?.includes('Cascade')) &&
                !t.title?.includes('Launchpad')
            );
        }

        if (!target) {
            target = allPages.find(t =>
                t.webSocketDebuggerUrl &&
                (t.url?.includes('workbench') || t.title?.includes('Antigravity') || t.title?.includes('Cascade') || t.title?.includes('Launchpad'))
            );
        }

        if (target && target.webSocketDebuggerUrl) {
            this.targetUrl = target.webSocketDebuggerUrl;
            this.targetFrameId = typeof target.id === 'string' ? target.id : null;
            // Extract workspace name from title (e.g., "ProjectName — Antigravity")
            if (target.title && !this.currentWorkspaceName) {
                const titleParts = target.title.split(/\\s[—–-]\\s/);
                if (titleParts.length > 0) {
                    this.currentWorkspaceName = titleParts[0].trim();
                }
            }
            return target.webSocketDebuggerUrl;
        }

        throw new Error('CDP target not found on any port.');
    }

    async connect(): Promise<void> {
        if (!this.targetUrl) {
            await this.discoverTarget();
        }

        if (!this.targetUrl) throw new Error('Target URL not established.');

        this.connection = new CdpConnection(this.targetUrl, this.cdpCallTimeout);

        // Forward events before connecting
        this.connection.on('disconnected', () => {
            this.isConnectedFlag = false;
            this.connection = null;
            this.targetUrl = null;
            this.targetFrameId = null;
            // Suppress disconnected event and auto-reconnect during workspace switching
            if (this.isSwitchingWorkspace) return;
            this.emit('disconnected');
            // Attempt auto-reconnect (when maxReconnectAttempts > 0)
            if (this.maxReconnectAttempts > 0 && !this.isReconnecting) {
                this.tryReconnect();
            }
        });

        // Forward all other CDP events emitted by CdpConnection
        const originalEmit = this.connection.emit.bind(this.connection);
        this.connection.emit = (event: string | symbol, ...args: unknown[]) => {
            if (event !== 'disconnected') {
                this.emit(event, ...args);
                
                // Track contexts here
                if (event === 'Runtime.executionContextCreated') {
                     this.contexts.push(args[0].context);
                } else if (event === 'Runtime.executionContextDestroyed') {
                     const idx = this.contexts.findIndex(c => c.id === args[0].executionContextId);
                     if (idx !== -1) this.contexts.splice(idx, 1);
                }
            }
            return originalEmit(event, ...args);
        };

        await this.connection.connect();
        this.isConnectedFlag = true;

        // Initialize Runtime to get execution contexts
        await this.call('Runtime.enable', {});

    }
    async call(method: string, params: unknown = {}): Promise<unknown> {
        if (!this.connection || !this.connection.isConnected()) {
            throw new Error('WebSocket is not connected');
        }
        return this.connection.call(method, params);
    }

    /**
     * Try call(), and on WebSocket connection error,
     * attempt a single on-demand reconnect then retry once.
     * Non-connection errors (timeout, protocol) are NOT retried.
     */
    async callWithRetry(method: string, params: unknown = {}, timeoutMs = 10000): Promise<unknown> {
        try {
            return await this.call(method, params);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isConnectionError =
                message === 'WebSocket is not connected' ||
                message === 'WebSocket disconnected';
            if (!isConnectionError) {
                throw error;
            }
            await this.reconnectOnDemand(timeoutMs);
            return await this.call(method, params);
        }
    }

    async disconnect(): Promise<void> {
        if (this.connection) {
            this.connection.removeAllListeners();
            this.connection.disconnect();
            this.connection = null;
        }
        this.isConnectedFlag = false;
        this.contexts = [];
        this.currentWorkspacePath = null;
        this.currentWorkspaceName = null;
        this.targetFrameId = null;
        // Reset LS client state so next connection re-probes auth
        this.lsClientManager.reset();
        this.cachedCascadeId = null;
        this.recentCreatedCascadeId = null;
        this.recentCreatedCascadeAt = 0;
        // Restore reconnect capacity for future connections
        this.maxReconnectAttempts = this.originalMaxReconnectAttempts;
    }

    /**
     * Return the currently connected workspace name.
     */
    getCurrentWorkspaceName(): string | null {
        return this.currentWorkspaceName;
    }

    /**
     * Discover and connect to the workbench page for the specified workspace.
     * Does nothing if already connected to the correct page.
     *
     * @param workspacePath Full workspace path (e.g., /home/user/Code/MyProject)
     * @returns true on successful connection
     */
    async discoverAndConnectForWorkspace(workspacePath: string): Promise<boolean> {
        const projectName = extractProjectNameFromPath(workspacePath);
        this.currentWorkspacePath = workspacePath;

        // Re-validate existing connection before skipping reconnect.
        if (this.isConnectedFlag && this.currentWorkspaceName === projectName) {
            const stillMatched = await this.verifyCurrentWorkspace(projectName, workspacePath);
            if (stillMatched) {
                return true;
            }
            logger.warn(
                `[CdpService] Workspace mismatch detected while reusing connection (expected="${projectName}"). Reconnecting...`,
            );
        }

        this.isSwitchingWorkspace = true;
        try {
            return await this._discoverAndConnectForWorkspaceImpl(workspacePath, projectName);
        } finally {
            this.isSwitchingWorkspace = false;
        }
    }

    /**
     * Verify whether the currently attached page still represents the expected workspace.
     */
    private async verifyCurrentWorkspace(projectName: string, workspacePath: string): Promise<boolean> {
        if (!this.connection || !this.connection.isConnected() || !this.isConnectedFlag) {
            return false;
        }

        try {
            const titleResult = await this.call('Runtime.evaluate', {
                expression: 'document.title',
                returnByValue: true,
            });
            const liveTitle = String(titleResult?.result?.value || '');
            if (liveTitle.toLowerCase().includes(projectName.toLowerCase())) {
                this.currentWorkspaceName = projectName;
                return true;
            }
        } catch {
            // Fall through to folder-path probe.
        }

        return this.probeWorkspaceFolderPath(projectName, workspacePath);
    }

    private async _discoverAndConnectForWorkspaceImpl(
        workspacePath: string,
        projectName: string,
    ): Promise<boolean> {
        // Scan all ports to collect workbench pages
        const pages: Record<string, unknown>[] = [];
        let respondingPort: number | null = null;

        for (const port of this.ports) {
            try {
                const list = await this.getJson(`http://127.0.0.1:${port}/json/list`);
                pages.push(...list);
                // Prioritize recording ports that contain workbench pages
                const hasWorkbench = list.some((t: Record<string, unknown>) => (t.url as string | undefined)?.includes('workbench'));
                if (hasWorkbench && respondingPort === null) {
                    respondingPort = port;
                }
            } catch {
                // No response from this port, next
            }
        }

        if (respondingPort === null && pages.length > 0) {
            // No workbench found but ports responded
            respondingPort = this.ports[0]; // logging purposes
        }

        if (respondingPort === null) {
            // No CDP port is responding. Launching Antigravity here will just open an un-debuggable window and timeout.
            // We must fail fast.
            throw new Error('Antigravity CDP ports are not responding. Please manually start Antigravity with --remote-debugging-port=9222 before proceeding.');
        }

        // Filter workbench pages only (exclude Launchpad, Manager, iframe, worker)
        const workbenchPages = pages.filter((t: Record<string, unknown>) => this.isWorkbenchPage(t));

        logger.debug(`[CdpService] Searching for workspace "${projectName}" (port=${respondingPort})... ${workbenchPages.length} workbench pages:`);
        for (const p of workbenchPages) {
            logger.debug(`  - title="${p.title}" url=${p.url}`);
        }

        // 1. Title match (fast path)
        const titleMatch = workbenchPages.find((t: Record<string, unknown>) => (t.title as string | undefined)?.includes(projectName));
        if (titleMatch) {
            return this.connectToPage(titleMatch, projectName);
        }

        // 2. Title match failed -> CDP probe (connect to each page and check document.title)
        logger.debug(`[CdpService] Title match failed. Searching via CDP probe...`);
        const probeResult = await this.probeWorkbenchPages(workbenchPages, projectName, workspacePath);
        if (probeResult) {
            return true;
        }

        // 3. Fallback: if only 1 workbench page exists, only reuse it if it
        //    looks like an untitled/fresh page. If its title clearly indicates
        //    a different workspace, launch a new window instead of hijacking it.
        if (workbenchPages.length === 1) {
            const singlePage = workbenchPages[0];
            const pageTitle = (singlePage.title || '').trim();
            const isFreshOrUntitled = !pageTitle || pageTitle === 'Untitled (Workspace)' || pageTitle.includes('Untitled');
            const belongsToDifferentWorkspace = pageTitle && !isFreshOrUntitled
                && !pageTitle.toLowerCase().includes(projectName.toLowerCase());

            if (belongsToDifferentWorkspace) {
                logger.warn(
                    `[CdpService] Single workbench page belongs to different workspace "${pageTitle}" ` +
                    `(target="${projectName}") — launching new window instead of reusing`,
                );
                // Fall through to launch
            } else {
                logger.warn(`[CdpService] Single workbench page found (title="${pageTitle}") — connecting to it for workspace "${projectName}"`);
                return this.connectToPage(singlePage, projectName);
            }
        }

        // 4. Multiple workbench pages exist but none matched.
        //    Try connecting to the most recently created / untitled page.
        if (workbenchPages.length > 1) {
            const untitledPage = workbenchPages.find(
                (t: Record<string, unknown>) => !t.title || (t.title as string | undefined)?.includes('Untitled') || (t.title as string | undefined)?.trim() === '',
            );
            if (untitledPage) {
                logger.warn(`[CdpService] Found untitled workbench page among ${workbenchPages.length} pages — connecting to prevent window spam`);
                return this.connectToPage(untitledPage, projectName);
            }
        }

        // 5. No workbench pages at all, no suitable fallback, or single page belongs to another workspace.
        //    Launch a new window for this workspace.
        return WorkspaceLauncher.launchAndConnectWorkspace(this, workspacePath, projectName, this.ports);
    }

    /**
     * Connect to the specified page (skip if already connected).
     */
    public async connectToPage(page: Record<string, unknown>, projectName: string): Promise<boolean> {
        // No reconnection needed if already connected to the same URL
        if (this.isConnectedFlag && this.targetUrl === page.webSocketDebuggerUrl) {
            this.currentWorkspaceName = projectName;
            return true;
        }

        this.disconnectQuietly();

        // Reset LS client + sniffed state so getLSClient() re-discovers the correct LS
        // for the NEW workspace page. Without this, the old LS client
        // continues pointing to the previous workspace's LS process (cross-talk bug).
        this.lsClientManager.reset();
        this.cachedCascadeId = null;
        this.recentCreatedCascadeId = null;
        this.recentCreatedCascadeAt = 0;

        this.targetUrl = page.webSocketDebuggerUrl;
        this.targetFrameId = typeof page?.id === 'string' ? page.id : null;
        await this.connect();
        this.currentWorkspaceName = projectName;
        logger.debug(`[CdpService] Connected to workspace "${projectName}"`);

        return true;
    }

    /**
     * Connect to each workbench page via CDP to get document.title and detect workspace name.
     * Fallback when /json/list titles are stale or incomplete.
     *
     * If the title is "Untitled (Workspace)", verify workspace folder path via CDP.
     *
     * @param workbenchPages List of workbench pages
     * @param projectName Workspace directory name
     * @param workspacePath Full workspace path (for folder path matching)
     */
    public async probeWorkbenchPages(
        workbenchPages: Record<string, unknown>[],
        projectName: string,
        workspacePath?: string,
    ): Promise<boolean> {
        for (const page of workbenchPages) {
            try {
                // Temporarily connect to retrieve document.title
                this.disconnectQuietly();
                this.targetUrl = page.webSocketDebuggerUrl;
                await this.connect();

                const result = await this.call('Runtime.evaluate', {
                    expression: 'document.title',
                    returnByValue: true,
                });
                const liveTitle = String(result?.result?.value || '');
                const normalizedLiveTitle = liveTitle.toLowerCase();
                const normalizedProject = projectName.toLowerCase();

                if (normalizedLiveTitle.includes(normalizedProject)) {
                    this.currentWorkspaceName = projectName;
                    logger.debug(`[CdpService] Probe success: detected "${projectName}"`);
                    return true;
                }

                // If title is "Untitled (Workspace)", verify by folder path
                if (normalizedLiveTitle.includes('untitled') && workspacePath) {
                    const folderMatch = await this.probeWorkspaceFolderPath(projectName, workspacePath);
                    if (folderMatch) {
                        return true;
                    }
                }
            } catch (e) {
                logger.warn(`[CdpService] Probe failed (page.id=${page.id}):`, e);
            }
        }

        // Probe complete, not found -> return to disconnected state
        this.disconnectQuietly();
        return false;
    }

    /**
     * Check if the currently connected page has the specified workspace folder open.
     * In Antigravity (VS Code-based), info may be available from explorer views or APIs.
     *
     * Detects folder path via multiple approaches:
     * 1. Check vscode.workspace.workspaceFolders via VS Code API
     * 2. Check folder path display in DOM
     * 3. Get workspace info from window.location.hash, etc.
     */
    private async probeWorkspaceFolderPath(
        projectName: string,
        workspacePath: string,
    ): Promise<boolean> {
        try {
            // Instead of DOM/document.title, inspect folder-related UI state directly.
            const expression = `(() => {
                // Method 1: Check window title data attribute
                const titleEl = document.querySelector('title');
                if (titleEl && titleEl.textContent) {
                    const t = titleEl.textContent;
                    if (t !== document.title) return { found: true, source: 'title-element', value: t };
                }
                
                // Method 2: Check folder name in explorer view
                const explorerItems = document.querySelectorAll('.explorer-item-label, .monaco-icon-label .label-name');
                const folderNames = Array.from(explorerItems).map(e => (e.textContent || '').trim()).filter(Boolean);
                if (folderNames.length > 0) return { found: true, source: 'explorer', value: folderNames.join(',') };
                
                // Method 3: Get path from tab titles or breadcrumbs
                const breadcrumbs = document.querySelectorAll('.breadcrumbs-view .folder-icon, .tabs-breadcrumbs .label-name');
                const crumbs = Array.from(breadcrumbs).map(e => (e.textContent || '').trim()).filter(Boolean);
                if (crumbs.length > 0) return { found: true, source: 'breadcrumbs', value: crumbs.join(',') };
                
                // Method 4: Check body data-uri attribute, etc.
                const bodyUri = document.body?.getAttribute('data-uri') || '';
                if (bodyUri) return { found: true, source: 'data-uri', value: bodyUri };
                
                return { found: false };
            })()`;

            const res = await this.call('Runtime.evaluate', {
                expression,
                returnByValue: true,
            });

            const value = res?.result?.value;
            if (value?.found && value?.value) {
                const detectedValue = value.value as string;

                const normalizedDetected = detectedValue.toLowerCase();
                const normalizedProject = projectName.toLowerCase();
                const normalizedWorkspace = workspacePath.toLowerCase();

                if (
                    normalizedDetected.includes(normalizedProject) ||
                    normalizedDetected.includes(normalizedWorkspace)
                ) {
                    this.currentWorkspaceName = projectName;
                    logger.debug(`[CdpService] Folder path match success: "${projectName}"`);
                    return true;
                }
            }

        } catch (e) {
            logger.warn(`[CdpService] Folder path probe failed:`, e);
        }

        return false;
    }



    /**
     * Quietly disconnect the existing connection (no reconnect attempts).
     * Used during workspace switching.
     */
    private disconnectQuietly(): void {
        if (this.connection) {
            this.connection.disconnectQuietly();
            this.connection = null;
            this.isConnectedFlag = false;
            this.contexts = [];
            this.targetUrl = null;
            this.targetFrameId = null;
        }
    }

    /**
     * Attempt auto-reconnect after CDP disconnection.
     * Fires 'reconnectFailed' event after maxReconnectAttempts failures.
     * (Step 12: Error handling and timeout management)
     */
    private async tryReconnect(): Promise<void> {
        if (this.isReconnecting) return;
        this.isReconnecting = true;
        this.reconnectAttemptCount = 0;

        while (this.reconnectAttemptCount < this.maxReconnectAttempts) {
            this.reconnectAttemptCount++;
            logger.error(
                `[CdpService] Reconnect attempt ${this.reconnectAttemptCount}/${this.maxReconnectAttempts}...`
            );

            // Add delay between attempts
            await new Promise(r => setTimeout(r, this.reconnectDelayMs));

            try {
                this.contexts = [];
                if (this.currentWorkspacePath) {
                    await this.discoverAndConnectForWorkspace(this.currentWorkspacePath);
                } else {
                    await this.discoverTarget();
                    await this.connect();
                }
                logger.info('[CdpService] Reconnect succeeded.');
                this.reconnectAttemptCount = 0;
                this.isReconnecting = false;
                this.emit('reconnected');
                return;
            } catch (err) {
                logger.error('[CdpService] Reconnect failed:', err);
            }
        }

        this.isReconnecting = false;
        const finalError = new Error(
            `CDP reconnection failed ${this.maxReconnectAttempts} times. Manual restart required.`
        );
        logger.error('[CdpService]', finalError.message);
        this.emit('reconnectFailed', finalError);
    }

    /**
     * Wait for an in-progress reconnection to complete.
     * Resolves when 'reconnected' fires, rejects on 'reconnectFailed' or timeout.
     */
    private waitForReconnection(timeoutMs = 15000): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('WebSocket is not connected'));
            }, timeoutMs);

            const onReconnected = () => {
                cleanup();
                resolve();
            };

            const onFailed = () => {
                cleanup();
                reject(new Error('WebSocket is not connected'));
            };

            const cleanup = () => {
                clearTimeout(timer);
                this.removeListener('reconnected', onReconnected);
                this.removeListener('reconnectFailed', onFailed);
            };

            this.on('reconnected', onReconnected);
            this.on('reconnectFailed', onFailed);
        });
    }

    /** Shared promise to coalesce concurrent reconnectOnDemand() calls */
    private reconnectOnDemandPromise: Promise<void> | null = null;

    /**
     * On-demand reconnect: if already reconnecting, wait; otherwise attempt once.
     * Throws 'WebSocket is not connected' when no workspace path or reconnect fails.
     */
    private async reconnectOnDemand(timeoutMs = 15000): Promise<void> {
        if (this.isReconnecting) {
            return this.waitForReconnection(timeoutMs);
        }

        if (!this.currentWorkspacePath) {
            throw new Error('WebSocket is not connected');
        }

        // Coalesce concurrent calls
        if (!this.reconnectOnDemandPromise) {
            this.reconnectOnDemandPromise = (async () => {
                try {
                    await this.discoverAndConnectForWorkspace(this.currentWorkspacePath!);
                } catch {
                    throw new Error('WebSocket is not connected');
                } finally {
                    this.reconnectOnDemandPromise = null;
                }
            })();
        }

        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new Error('WebSocket is not connected')), timeoutMs);
        });

        try {
            await Promise.race([this.reconnectOnDemandPromise, timeoutPromise]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    isConnected(): boolean {
        return this.isConnectedFlag;
    }

    /**
     * Return the WebSocket debugger URL currently connected to.
     * Used to detect when two CdpService instances point to the same Antigravity window.
     */
    getTargetUrl(): string | null {
        return this.targetUrl;
    }

    getContexts(): CdpContext[] {
        return [...this.contexts];
    }

    /**
     * Wait for LS client readiness (replaces DOM cascade-panel wait).
     * @returns true if LS client is ready
     */
    async waitForCascadePanelReady(timeoutMs = 10000,): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const client = await this.getLSClient();
            if (client?.isReady()) return true;
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    }

    getPrimaryContextId(): number | null {
        // Find cascade-panel context
        const context = this.contexts.find(c => c.url && c.url.includes('cascade-panel'));
        if (context) return context.id;

        if (this.targetFrameId) {
            const matchingDefaultContext = this.contexts.find(
                c =>
                    c.auxData?.frameId === this.targetFrameId &&
                    (c.auxData?.isDefault === true || c.auxData?.type === 'default'),
            );
            if (matchingDefaultContext) return matchingDefaultContext.id;

            const matchingFrameContext = this.contexts.find(
                c => c.auxData?.frameId === this.targetFrameId,
            );
            if (matchingFrameContext) return matchingFrameContext.id;
        }

        // Fallback to Extension context or first one
        const extContext = this.contexts.find(c => c.name && c.name.includes('Extension'));
        if (extContext) return extContext.id;

        return this.contexts.length > 0 ? this.contexts[0].id : null;
    }

    // DOM methods removed: focusChatInput, clearInputField, pressEnterToSend
    // All injection now goes through the LS client (CDP-proxied).

    /**
     * Detect file input in the UI and attach the specified files.
     */
    private async attachImageFiles(filePaths: string[], contextId?: number): Promise<{ ok: boolean; error?: string }> {
        if (filePaths.length === 0) return { ok: true };

        await this.call('DOM.enable', {});

        const locateInputScript = `(async () => {
            const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
            const visible = (el) => {
                if (!el) return false;
                if (el.offsetParent !== null) return true;
                const style = window.getComputedStyle(el);
                if (!style) return false;
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
                return !!rect && rect.width > 0 && rect.height > 0;
            };
            const normalize = (v) => (v || '').toLowerCase();
            const hasImageAccept = (input) => {
                const accept = normalize(input.getAttribute('accept'));
                return !accept || accept.includes('image') || accept.includes('*/*');
            };
            const findInput = () => {
                const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
                const visibleInput = inputs.find(i => visible(i) && hasImageAccept(i));
                if (visibleInput) return visibleInput;
                return inputs.find(hasImageAccept) || null;
            };

            let input = findInput();
            if (!input) {
                const triggerKeywords = ['attach', 'upload', 'image', 'file', 'paperclip', 'plus'];
                const triggers = Array.from(document.querySelectorAll('button, [role="button"]'))
                    .filter(visible)
                    .filter((el) => {
                        const text = normalize(el.textContent);
                        const aria = normalize(el.getAttribute('aria-label'));
                        const title = normalize(el.getAttribute('title'));
                        const cls = normalize(el.getAttribute('class'));
                        const all = [text, aria, title, cls].join(' ');
                        return triggerKeywords.some(k => all.includes(k));
                    })
                    .slice(-8);

                for (const trigger of triggers) {
                    if (typeof trigger.click === 'function') {
                        trigger.click();
                        await wait(150);
                        input = findInput();
                        if (input) break;
                    }
                }
            }

            if (!input) {
                return { ok: false, error: 'Image upload input not found' };
            }

            const token = 'agclaw-upload-' + Math.random().toString(36).slice(2, 10);
            input.setAttribute('data-agclaw-upload-token', token);
            return { ok: true, token };
        })()`;

        const callParams: Record<string, unknown> = {
            expression: locateInputScript,
            returnByValue: true,
            awaitPromise: true,
        };
        if (contextId !== undefined) {
            callParams.contextId = contextId;
        }

        const locateResult = await this.call('Runtime.evaluate', callParams);
        const locateValue = locateResult?.result?.value;
        if (!locateValue?.ok || !locateValue?.token) {
            return { ok: false, error: locateValue?.error || 'Failed to locate file input' };
        }

        const token = String(locateValue.token);
        const documentResult = await this.call('DOM.getDocument', { depth: 1, pierce: true });
        const rootNodeId = documentResult?.root?.nodeId;
        if (!rootNodeId) {
            return { ok: false, error: 'Failed to get DOM root' };
        }

        const selector = `input[data-agclaw-upload-token="${token}"]`;
        const nodeResult = await this.call('DOM.querySelector', {
            nodeId: rootNodeId,
            selector,
        });
        const nodeId = nodeResult?.nodeId;
        if (!nodeId) {
            return { ok: false, error: 'Failed to get upload input node' };
        }

        await this.call('DOM.setFileInputFiles', {
            nodeId,
            files: filePaths,
        });

        const notifyScript = `(() => {
            const input = document.querySelector('${selector}');
            if (!input) return { ok: false, error: 'Image input not found' };
            input.removeAttribute('data-agclaw-upload-token');
            return { ok: true };
        })()`;

        await this.call('Runtime.evaluate', {
            expression: notifyScript,
            returnByValue: true,
            awaitPromise: true,
            ...(contextId !== undefined ? { contextId } : {}),
        });

        await new Promise(r => setTimeout(r, 250));
        return { ok: true };
    }

    /**
     * Get the active LS client if available.
     * Attempts discovery if not already attempted.
     */
    async getLSClient(): Promise<GrpcCascadeClient | null> {
        const client = await this.lsClientManager.getClient(this.currentWorkspacePath, async (expression: string) => {
            const res = await this.call('Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true,
                timeout: 10000,
            });
            return res?.result?.value;
        });
        if (!client) {
            return null;
        }

        client.setCdpEvaluate(async (expression: string) => {
            return this.call('Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true,
                timeout: 10000,
            });
        });

        return client;
    }

    /**
     * Public alias used by higher-level bot/runtime flows.
     */
    async getGrpcClient(): Promise<GrpcCascadeClient | null> {
        return this.getLSClient();
    }

    /**
     * Try to inject a message via the LS direct API.
     * Bypasses the entire DOM — sends directly to the LanguageServer.
     * Uses only CSRF token (no OAuth tokens).
     *
     * @returns InjectResult with method='ls-api' on success, or null if unavailable
     */
    private async injectViaLS(text: string, overrideCascadeId?: string): Promise<InjectResult | null> {
        const client = await this.getLSClient();
        if (!client) {
            return { ok: false, error: this.lsClientManager.lastLSUnavailableReason || 'LS client unavailable' };
        }

        // If we have an explicit cascade ID (e.g. from a previous createCascade), try to reuse it
        const cascadeId = overrideCascadeId || this.cachedCascadeId;
        const modelId = await this.resolveSelectedModelId();

        if (cascadeId) {
            try {
                const trajectoryResp = await client.rawRPC('GetCascadeTrajectory', { cascadeId });
                const runStatus = extractCascadeRunStatus(trajectoryResp);
                if (runStatus === 'CASCADE_RUN_STATUS_RUNNING') {
                    logger.info(`[CdpService] injectViaLS: cascade ${cascadeId.slice(0, 16)}... is still running; delegating turn queueing to Antigravity`);
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.debug(`[CdpService] injectViaLS: failed to inspect existing cascade ${cascadeId.slice(0, 16)}...: ${msg}`);
            }

            // Send to existing cascade
            logger.info(`[CdpService] injectViaLS: sending to existing cascade=${cascadeId.slice(0, 16)}... model=${modelId || 'default'} text="${text.slice(0, 50)}"`);
            const result = await client.sendMessage(cascadeId, text, modelId || undefined);
            if (result.ok) {
                logger.debug(`[CdpService] sendMessage OK, response: ${JSON.stringify(result.data)?.slice(0, 200)}`);
                return { ok: true, method: 'ls-api', cascadeId };
            }
            logger.warn(`[CdpService] sendMessage to existing cascade failed: ${result.error}`);
            return { ok: false, error: result.error || 'LS client injection failed', cascadeId };
        }

        // Create a new Antigravity cascade and send the message
        logger.info(`[CdpService] injectViaLS: creating new cascade with model=${modelId || 'default'} text="${text.slice(0, 50)}"`);
        const newCascadeId = await client.createCascade(text, modelId || undefined);
        if (newCascadeId) {
            this.rememberCreatedCascade(newCascadeId);
            logger.info(`[CdpService] New cascade created: ${newCascadeId.slice(0, 16)}...`);
            return { ok: true, method: 'ls-api', cascadeId: newCascadeId };
        }

        const lastLSError = client.getLastOperationError?.() || null;
        logger.error(`[CdpService] createCascade returned null — cannot inject${lastLSError ? `: ${lastLSError}` : ''}`);
        return { ok: false, error: lastLSError || 'LS client injection failed' };
    }

    /**
     * Inject and send the specified text into Antigravity.
     *
     * Strategy: LS direct API only — zero DOM dependency.
     */
    async injectMessage(text: string, overrideCascadeId?: string): Promise<InjectResult> {
        // LS direct API (no DOM dependency at all)
        const lsResult = await this.injectViaLS(text, overrideCascadeId);
        if (lsResult) {
            return lsResult;
        }

        return { ok: false, error: 'LS client injection failed' };
    }

    /**
     * Inject a message with image files.
     *
     * Strategy (Plan A): Read image files from disk, convert to base64 MediaItems,
     * and pass them through the LS API's `media` field in SendUserCascadeMessage.
     * This ensures images + text are sent together in a single prompt within the
     * same cascade, avoiding the previous DOM/LS path mismatch.
     */
    async injectMessageWithImageFiles(text: string, imageFilePaths: string[], overrideCascadeId?: string): Promise<InjectResult> {
        const fsP = await import('fs/promises');
        const pathMod = await import('path');

        // Convert image files to MediaItems for LS API
        const mediaItems: import('./grpcCascadeClient').MediaItem[] = [];

        for (const filePath of imageFilePaths) {
            try {
                const fileData = await fsP.readFile(filePath);
                if (fileData.length === 0) {
                    logger.warn(`[CdpService] Skipping empty image file: ${filePath}`);
                    continue;
                }

                const base64Data = fileData.toString('base64');
                const ext = pathMod.extname(filePath).toLowerCase();

                let mimeType = 'image/png';
                if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                else if (ext === '.gif') mimeType = 'image/gif';
                else if (ext === '.webp') mimeType = 'image/webp';
                else if (ext === '.bmp') mimeType = 'image/bmp';

                mediaItems.push({ mimeType, inlineData: base64Data });
                logger.info(`[CdpService] Prepared media item: ${pathMod.basename(filePath)} (${mimeType}, ${Math.round(fileData.length / 1024)}KB)`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`[CdpService] Failed to read image file ${filePath}: ${msg}`);
            }
        }

        if (mediaItems.length > 0) {
            logger.info(`[CdpService] Sending message with ${mediaItems.length} media item(s) via LS API`);
        }

        // Send text + media via LS API (unified path — no DOM attachment needed)
        return this.injectMessageWithMedia(text, mediaItems, overrideCascadeId);
    }

    /**
     * Extract images from the latest AI response.
     * NOTE: No LS API equivalent — image extraction not available in headless mode.
     * @returns Always returns empty array
     */
    async extractLatestResponseImages(): Promise<ExtractedResponseImage[]> {
        logger.debug('[CdpService] extractLatestResponseImages: not available via LS API, returning []');
        return [];
    }

    /**
     * Inject a message with pre-prepared media items via the LS API.
     * Text and media are sent together in a single SendUserCascadeMessage call.
     */
    private async injectMessageWithMedia(
        text: string,
        media: import('./grpcCascadeClient').MediaItem[],
        overrideCascadeId?: string,
    ): Promise<InjectResult> {
        const client = await this.getLSClient();
        if (!client) {
            return { ok: false, error: this.lsClientManager.lastLSUnavailableReason || 'LS client unavailable' };
        }

        const cascadeId = overrideCascadeId || this.cachedCascadeId;
        const modelId = await this.resolveSelectedModelId();

        if (cascadeId) {
            // Send to existing cascade with media
            logger.info(`[CdpService] injectWithMedia: sending to cascade=${cascadeId.slice(0, 16)}... with ${media.length} media item(s)`);
            const result = await client.sendMessage(cascadeId, text, modelId || undefined, media.length > 0 ? media : undefined);
            if (result.ok) {
                logger.debug(`[CdpService] sendMessage with media OK`);
                return { ok: true, method: 'ls-api', cascadeId };
            }
            logger.warn(`[CdpService] sendMessage with media failed: ${result.error}`);
            return { ok: false, error: result.error || 'LS client injection failed', cascadeId };
        }

        // Create a new cascade, then send the text + media
        logger.info(`[CdpService] injectWithMedia: creating new cascade, then sending with ${media.length} media item(s)`);
        const newCascadeId = await client.createCascade(undefined, modelId || undefined);
        if (newCascadeId) {
            this.rememberCreatedCascade(newCascadeId);
            logger.info(`[CdpService] New cascade created: ${newCascadeId.slice(0, 16)}...`);

            const sendResult = await client.sendMessage(newCascadeId, text, modelId || undefined, media.length > 0 ? media : undefined);
            if (sendResult.ok) {
                logger.debug(`[CdpService] sendMessage with media to new cascade OK`);
                return { ok: true, method: 'ls-api', cascadeId: newCascadeId };
            }
            logger.warn(`[CdpService] sendMessage with media to new cascade failed: ${sendResult.error}`);
            return { ok: false, error: sendResult.error || 'LS send failed', cascadeId: newCascadeId };
        }

        const lastLSError = client.getLastOperationError?.() || null;
        logger.error(`[CdpService] createCascade returned null — cannot inject${lastLSError ? `: ${lastLSError}` : ''}`);
        return { ok: false, error: lastLSError || 'LS client injection failed' };
    }

    // ─── Mode / Model (LS API-based, no DOM) ─────────────────────────────

    /** Cached mode name: 'fast' (conversational) or 'plan' (normal) */
    private cachedModeName: string = 'fast';
    /** Cached model label (human-readable, e.g. 'Claude Sonnet 4.6 (Thinking)') */
    private cachedModelLabel: string | null = null;
    /** Cached model configs from GetUserStatus */
    private cachedModelConfigs: Array<{ label: string; model: string; supportsImages?: boolean }> = [];

    private extractModelIdentifier(config: Record<string, unknown>): string {
        const direct =
            config?.modelOrAlias?.model
            ?? config?.modelOrAlias?.alias
            ?? config?.model
            ?? config?.modelId
            ?? config?.requestedModel?.choice?.value
            ?? config?.requestedModel?.value;
        if (direct !== undefined && direct !== null && String(direct).trim()) {
            return String(direct);
        }

        const nestedChoice =
            config?.modelOrAlias?.choice
            ?? config?.modelOrAlias;
        const nestedValue =
            nestedChoice?.value?.model
            ?? nestedChoice?.value?.alias
            ?? nestedChoice?.value;
        if (nestedValue !== undefined && nestedValue !== null && String(nestedValue).trim()) {
            return String(nestedValue);
        }

        return 'unknown';
    }

    /**
     * Get the current mode name.
     * Returns the cached mode — mode is set per-message via plannerConfig.
     */
    async getCurrentMode(): Promise<string | null> {
        return this.cachedModeName;
    }

    /**
     * Set the mode for subsequent messages.
     * Mode is applied per-message via the plannerConfig field in SendUserCascadeMessage.
     *   - 'fast' → conversational: {}
     *   - 'plan' → normal: {}
     *
     * @param modeName Mode name: 'fast' or 'plan'
     */
    async setUiMode(modeName: string): Promise<UiSyncResult> {
        const normalized = modeName.toLowerCase();
        if (normalized !== 'fast' && normalized !== 'plan') {
            return { ok: false, error: `Unknown mode: ${modeName}. Use 'fast' or 'plan'.` };
        }
        this.cachedModeName = normalized;
        logger.info(`[CdpService] Mode set to '${normalized}' (will apply on next message)`);
        return { ok: true, mode: normalized };
    }

    /**
     * Retrieve available models from LS API GetUserStatus.
     * Uses cascadeModelConfigData.clientModelConfigs from the LS API.
     */
    async getUiModels(): Promise<string[]> {
        try {
            const client = await this.getLSClient();
            if (!client) return [];

            const status = await client.getUserStatus();
            const configs = status?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
            this.cachedModelConfigs = configs.map((cfg: Record<string, unknown>) => {
                const label = (cfg.label as string | undefined) || (cfg.displayName as string | undefined) || (cfg.modelName as string | undefined) || (cfg.model as string | undefined) || 'Unknown';
                const modelId = this.extractModelIdentifier(cfg);
                return {
                    label,
                    model: String(modelId),
                    supportsImages: !!cfg.supportsImages,
                };
            });
            return this.cachedModelConfigs.map(c => c.label);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('[CdpService] getUiModels via LS API failed:', msg);
            return [];
        }
    }

    /**
     * Get the currently selected model label.
     *
     * Priority:
     *   1. Explicitly set model (via setUiModel / /model command)
     *   2. Read from Antigravity UI DOM (the model selector button)
     *   3. null if both fail
     *
     * Also refreshes the cached model config list from LS API as a side effect.
     */
    async getCurrentModel(): Promise<string | null> {
        // 1. If the bot explicitly set a model (via /model command), return it
        if (this.cachedModelLabel) {
            if (this.cachedModelConfigs.length === 0) {
                await this.refreshModelConfigs();
            }
            const matched = this.findModelConfigByLabel(this.cachedModelLabel);
            if (matched) {
                this.cachedModelLabel = matched.label;
            }
            return this.cachedModelLabel;
        }

        // 2. Try reading the model from the Antigravity UI DOM
        const uiModel = await this.readModelFromUI();
        if (uiModel) {
            this.cachedModelLabel = uiModel;
            if (this.cachedModelConfigs.length === 0) {
                await this.refreshModelConfigs();
            }
            const matched = this.findModelConfigByLabel(uiModel);
            if (matched) {
                this.cachedModelLabel = matched.label;
            }
            return this.cachedModelLabel;
        }

        // 3. Refresh model configs from LS API (side effect for /model command)
        await this.refreshModelConfigs();

        return this.cachedModelLabel;
    }

    /**
     * Read the currently selected model name directly from the Antigravity UI DOM.
     * The model selector is a div[role="button"] in the cascade panel toolbar
     * whose text matches a known model name pattern.
     */
    private async readModelFromUI(): Promise<string | null> {
        if (!this.connection || !this.connection.isConnected()) return null;

        // Known model name substrings to identify the model selector element
        const script = `(() => {
            const modelKeywords = ['Claude', 'Gemini', 'GPT', 'Opus', 'Sonnet', 'Flash', 'Pro', 'Thinking'];
            const buttons = document.querySelectorAll('div[role="button"]');
            for (const btn of buttons) {
                const text = btn.textContent?.trim();
                if (!text || text.length > 60) continue;
                if (modelKeywords.some(k => text.includes(k))) {
                    return text;
                }
            }
            return null;
        })()`;

        for (const ctx of this.contexts) {
            try {
                const res = await this.call('Runtime.evaluate', {
                    expression: script,
                    returnByValue: true,
                    contextId: ctx.id,
                });
                const value = res?.result?.value;
                if (typeof value === 'string' && value.length > 0) {
                    logger.debug(`[CdpService] Model from UI: ${value}`);
                    return value;
                }
            } catch {
                // Try next context
            }
        }
        return null;
    }

    /**
     * Refresh the cached model config list from LS API GetUserStatus.
     * Does NOT set cachedModelLabel — only populates cachedModelConfigs
     * for use by setUiModel/getSelectedModelId.
     */
    private async refreshModelConfigs(): Promise<void> {
        try {
            const client = await this.getLSClient();
            if (!client) return;

            const status = await client.getUserStatus();
            const data = status?.userStatus?.cascadeModelConfigData;
            const configs = data?.clientModelConfigs || [];
            if (configs.length > 0) {
                this.cachedModelConfigs = configs.map((cfg: Record<string, unknown>) => {
                    const label = (cfg.label as string | undefined) || (cfg.displayName as string | undefined) || (cfg.modelName as string | undefined) || (cfg.model as string | undefined) || 'Unknown';
                    const modelId = this.extractModelIdentifier(cfg);
                    return {
                        label,
                        model: String(modelId),
                        supportsImages: !!cfg.supportsImages,
                    };
                });
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.debug(`[CdpService] refreshModelConfigs failed: ${msg}`);
        }
    }

    private normalizeModelLabel(label: string): string {
        return label.toLowerCase().replace(/\s+/g, ' ').replace(/[()]/g, '').trim();
    }

    private findModelConfigByLabel(modelName: string | null): { label: string; model: string; supportsImages?: boolean } | null {
        if (!modelName) return null;

        const normalized = this.normalizeModelLabel(modelName);
        const exact = this.cachedModelConfigs.find(
            c => this.normalizeModelLabel(c.label) === normalized,
        );
        if (exact) return exact;

        return this.cachedModelConfigs.find((c) => {
            const candidate = this.normalizeModelLabel(c.label);
            // When user has Opus explicitly selected we might have normalized="claude opus 4.6 thinking"
            // And candidate="claude 3.5 opus" - neither direct inclusion works.
            // A better fuzzy match for these typical models:
            const nParts = normalized.split(' ');
            const cParts = candidate.split(' ');
            if (nParts.every(p => candidate.includes(p)) || cParts.every(p => normalized.includes(p))) {
                return true;
            }
            return candidate.includes(normalized) || normalized.includes(candidate);
        }) ?? null;
    }

    private async resolveSelectedModelId(): Promise<ModelId | null> {
        if (this.cachedModelConfigs.length === 0) {
            await this.refreshModelConfigs();
        }

        let found = this.findModelConfigByLabel(this.cachedModelLabel);
        if (!found) {
            const uiModel = await this.readModelFromUI();
            if (uiModel) {
                this.cachedModelLabel = uiModel;
                if (this.cachedModelConfigs.length === 0) {
                    await this.refreshModelConfigs();
                }
                found = this.findModelConfigByLabel(uiModel);
            }
        }

        if (!found || found.model === 'unknown') {
            // Fallback: use the first available model from GetUserStatus.
            // After a restart, cachedModelLabel is null and readModelFromUI may fail,
            // but the server now requires a model to be specified in the payload.
            const fallback = this.cachedModelConfigs.find(c => c.model !== 'unknown');
            if (fallback) {
                logger.info(`[CdpService] resolveSelectedModelId: no cached/UI model, falling back to '${fallback.label}' (${fallback.model})`);
                this.cachedModelLabel = fallback.label;
                const num = parseInt(fallback.model, 10);
                return isNaN(num) ? fallback.model : num;
            }
            return null;
        }
        this.cachedModelLabel = found.label;

        const num = parseInt(found.model, 10);
        return isNaN(num) ? found.model : num;
    }

    /**
     * Set the model for subsequent messages.
     * Model is applied per-message via the planModel field in SendUserCascadeMessage.
     *
     * @param modelName Model label (e.g. 'Claude Sonnet 4.6 (Thinking)') or model enum string
     */
    async setUiModel(modelName: string): Promise<UiSyncResult> {
        // Ensure we have the model list
        if (this.cachedModelConfigs.length === 0) {
            await this.getUiModels();
        }

        const found = this.findModelConfigByLabel(modelName);
        if (found) {
            this.cachedModelLabel = found.label;
            logger.info(`[CdpService] Model set to '${found.label}' (${found.model})`);
            return { ok: true, model: found.label };
        }

        const available = this.cachedModelConfigs.map(c => c.label).join(', ');
        return { ok: false, error: `Model "${modelName}" not found. Available: ${available}` };
    }

    /**
     * Get the current model identifier for the currently selected model.
     * Used internally when building SendUserCascadeMessage payloads.
     */
    getSelectedModelId(): ModelId | null {
        const found = this.findModelConfigByLabel(this.cachedModelLabel);
        if (!found || found.model === 'unknown') return null;
        this.cachedModelLabel = found.label;
        const num = parseInt(found.model, 10);
        return isNaN(num) ? found.model : num;
    }

    /**
     * Get the planner type config for the current mode.
     * Used internally when building SendUserCascadeMessage payloads.
     */
    getPlannerTypeForCurrentMode(): string {
        return this.cachedModeName === 'plan' ? 'normal' : 'conversational';
    }

    // ─── VS Code Command Execution (via CDP) ───────────────────────────

    /**
     * Execute a VS Code command via CDP Runtime.evaluate.
     * This calls the extension host's command API through the renderer process,
     * enabling step control (accept/reject), panel operations, etc.
     *
     * Based on antigravity-sdk CommandBridge pattern.
     *
     * @param command Full command ID (e.g. 'antigravity.agent.acceptAgentStep')
     * @param args Optional arguments to pass to the command
     */
    async executeVscodeCommand(command: string, ...args: unknown[]): Promise<unknown> {
        const safeCommand = JSON.stringify(command);
        const safeArgs = JSON.stringify(args);

        // acquireVsCodeApi() is available in webview contexts
        // For extension host commands, we use the __vscode API
        const script = `(async () => {
            try {
                // Try the global acquireVsCodeApi bridge
                if (typeof acquireVsCodeApi !== 'undefined') {
                    const vscode = acquireVsCodeApi();
                    vscode.postMessage({ type: 'executeCommand', command: ${safeCommand}, args: ${safeArgs} });
                    return { ok: true, method: 'vscodeApi' };
                }
                return { ok: false, error: 'No VS Code API available' };
            } catch (e) {
                return { ok: false, error: e.message || String(e) };
            }
        })()`;

        for (const ctx of this.contexts) {
            try {
                const res = await this.call('Runtime.evaluate', {
                    expression: script,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id,
                });
                const value = res?.result?.value;
                if (value?.ok) return value;
            } catch {
                // Try next context
            }
        }
        return { ok: false, error: 'Command execution failed in all contexts' };
    }

    // ─── Session Info (LS API-based) ───────────────────────────────────

    /**
     * Get information about the currently active session.
     * @returns { id: string, title: string, summary: string } or null
     */
    async getActiveSessionInfo(): Promise<{ id: string, title: string, summary: string } | null> {
        try {
            const client = await this.getLSClient();
            if (!client) return null;

            const summaries = await client.listCascades();
            if (!summaries || typeof summaries !== 'object') return null;

            const toSessionInfo = (id: string, summary: Record<string, unknown> | undefined) => ({
                id,
                title: (summary?.title as string | undefined) || (summary?.summary as string | undefined) || 'Untitled Session',
                summary: (summary?.summary as string | undefined) || '',
            });

            // Filter out summaries that don't belong to this workspace
            const workspaceSummaries: Record<string, Record<string, unknown>> = {};
            for (const [id, summary] of Object.entries(summaries)) {
                if (this.isCascadeInWorkspace(summary)) {
                    workspaceSummaries[id] = summary;
                }
            }

            if (this.cachedCascadeId && workspaceSummaries[this.cachedCascadeId]) {
                return toSessionInfo(this.cachedCascadeId, workspaceSummaries[this.cachedCascadeId]);
            }

            if (
                this.cachedCascadeId
                && this.cachedCascadeId === this.recentCreatedCascadeId
                && (Date.now() - this.recentCreatedCascadeAt) <= RECENT_CASCADE_PROPAGATION_GRACE_MS
            ) {
                logger.debug(`[CdpService] Preserving recently created cascade ${this.cachedCascadeId.slice(0, 12)}... while summaries catch up`);
                return {
                    id: this.cachedCascadeId,
                    title: 'Current Session',
                    summary: '',
                };
            }

            // Find the most recently modified cascade in THIS workspace
            let latestId: string | null = null;
            let latestTime = 0;

            for (const [id, summary] of Object.entries(workspaceSummaries)) {
                const s = summary as Record<string, unknown>;
                const ts = s.lastModifiedTimestamp || s.lastModifiedTime;
                const modTime = ts
                    ? new Date(String(ts)).getTime()
                    : 0;
                if (modTime > latestTime) {
                    latestTime = modTime;
                    latestId = id;
                }
            }

            if (latestId) {
                this.cachedCascadeId = latestId;
                return toSessionInfo(latestId, workspaceSummaries[latestId]);
            }

            // If this CdpService is workspace-bound, do NOT fall back to a cascade
            // from another workspace. That causes multiple workspace runtimes to
            // subscribe to the same foreign cascade and creates reconnect storms.
            if (this.currentWorkspacePath) {
                // No cascades for this workspace — caller will idle-retry silently
                return null;
            }

            // Global fallback only when we are not bound to a workspace.
            const ids = Object.keys(summaries);
            if (ids.length > 0) {
                const firstId = ids[0];
                this.cachedCascadeId = firstId;
                return toSessionInfo(firstId, summaries[firstId]);
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.debug(`[CdpService] getActiveSessionInfo via LS API failed: ${msg}`);
        }
        return null;
    }

    /**
     * Get the currently active cascade (conversation) ID.
     * Uses LS API GetAllCascadeTrajectories to find the most recent cascade.
     *
     * @returns The active cascade ID string, or null if not found
     */
    async getActiveCascadeId(): Promise<string | null> {
        const info = await this.getActiveSessionInfo();
        return info?.id || null;
    }

    /**
     * Set the currently active cascade ID (manual override).
     */
    setCachedCascadeId(id: string | null): void {
        this.cachedCascadeId = id;
        if (!id) {
            this.recentCreatedCascadeId = null;
            this.recentCreatedCascadeAt = 0;
        }
    }

    rememberCreatedCascade(id: string): void {
        this.cachedCascadeId = id;
        this.recentCreatedCascadeId = id;
        this.recentCreatedCascadeAt = Date.now();
    }

    // ─── Gateway Restart (OpenClaw-style) ────────────────────────────

    /**
     * Perform a full gateway restart — the OpenClaw standard restart sequence.
     *
     * Steps:
     *   1. Cancel any active cascade (stop running generation)
     *   2. Tear down LS client (force re-discovery on next use)
     *   3. Clear cached cascade ID and model configs
     *   4. Reconnect CDP (refresh browser connection)
     *   5. Re-discover the LS process and establish a new LS client
     *
     * @returns Result object with success status and details
     */
    async resetGateway(): Promise<{ ok: boolean; steps: string[]; error?: string }> {
        const steps: string[] = [];

        try {
            // Step 1: Cancel active cascade (if one is running)
            const lsClient = await this.getLSClient();
            if (this.cachedCascadeId && lsClient?.isReady()) {
                try {
                    await lsClient.cancelCascade(this.cachedCascadeId);
                    steps.push(`Cancelled cascade ${this.cachedCascadeId.slice(0, 12)}...`);
                } catch (err: unknown) {
                    // Not fatal — cascade may have already ended
                    const msg = err instanceof Error ? err.message : 'already ended';
                    steps.push(`Cascade cancel skipped: ${msg}`);
                }
            } else {
                steps.push('No active cascade to cancel');
            }

            // Step 2: Tear down LS client
            this.lsClientManager.reset();
            steps.push('LS client reset');

            // Step 3: Clear cached state
            this.cachedCascadeId = null;
            this.recentCreatedCascadeId = null;
            this.recentCreatedCascadeAt = 0;
            this.cachedModelLabel = null;
            this.cachedModelConfigs = [];
            steps.push('Cached state cleared (cascade, model, configs)');

            // Step 4: Reconnect CDP
            if (this.currentWorkspacePath) {
                const projectName = this.currentWorkspaceName || 'unknown';
                try {
                    this.disconnectQuietly();
                    await this.discoverAndConnectForWorkspace(this.currentWorkspacePath);
                    steps.push(`CDP reconnected to "${projectName}"`);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : 'failed';
                    steps.push(`CDP reconnect warning: ${msg}`);
                    // Not fatal — LS client can still work if CDP reconnects on next call
                }
            } else {
                steps.push('CDP: no workspace path cached (skipped reconnect)');
            }

            // Step 5: Re-discover LS client
            try {
                const client = await this.getLSClient();
                if (client?.isReady()) {
                    steps.push('LS client re-established');
                } else {
                    steps.push('LS client discovery returned null (will retry on next message)');
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'failed';
                steps.push(`LS re-discovery warning: ${msg}`);
            }

            logger.info(`[CdpService] Gateway restart completed: ${steps.length} steps`);
            return { ok: true, steps };

        } catch (err: unknown) {
            const error = err instanceof Error ? err.message : String(err);
            logger.error(`[CdpService] Gateway restart failed: ${error}`);
            return { ok: false, steps, error };
        }
    }

    /**
     * Helper to verify if a cascade trajectory summary belongs to the currently active workspace.
     */
    public isCascadeInWorkspace(summary: Record<string, unknown>): boolean {
        if (!this.currentWorkspacePath) return true; // Accept if we don't know our own workspace yet
        if (!summary?.workspaces || !Array.isArray(summary.workspaces)) return false;

        const targetPath = this.currentWorkspacePath.replace(/\\/g, '/').toLowerCase();

        for (const ws of summary.workspaces) {
            if (!ws.workspaceFolderAbsoluteUri) continue;
            let uriPath = ws.workspaceFolderAbsoluteUri.replace(/^file:\/\//i, '');
            // Handle /c:/ to c:/
            if (uriPath.match(/^\/[a-zA-Z]:/)) {
                uriPath = uriPath.substring(1);
            }

            let localPath = decodeURIComponent(uriPath).replace(/\\/g, '/').toLowerCase();
            // Handle trailing slashes uniformly
            if (localPath.endsWith('/')) localPath = localPath.substring(0, localPath.length - 1);
            const targetNoSlash = targetPath.endsWith('/') ? targetPath.substring(0, targetPath.length - 1) : targetPath;

            if (localPath === targetNoSlash) {
                return true;
            }
        }
        return false;
    }
}
