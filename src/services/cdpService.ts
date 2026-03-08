import { logger } from '../utils/logger';
import { CDP_PORTS } from '../utils/cdpPorts';
import { EventEmitter } from 'events';
import * as http from 'http';
import { spawn } from 'child_process';
import { getAntigravityCliPath, extractProjectNameFromPath } from '../utils/pathUtils';
import WebSocket from 'ws';
import { GrpcCascadeClient, discoverLSConnection } from './grpcCascadeClient';

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

/** Antigravity UI DOM selector constants (kept minimal for CDP probe) */
const SELECTORS = {
    /** Keyword to identify message injection target context */
    CONTEXT_URL_KEYWORD: 'cascade-panel',
};

export class CdpService extends EventEmitter {
    private ports: number[];
    private isConnectedFlag: boolean = false;
    private ws: WebSocket | null = null;
    private contexts: CdpContext[] = [];
    private pendingCalls = new Map<number, { resolve: Function, reject: Function, timeoutId: NodeJS.Timeout }>();

    /** Lazy-initialized gRPC client for direct API communication */
    private grpcClient: GrpcCascadeClient | null = null;
    private grpcAuthAttempted: boolean = false;
    /** Cached cascade ID for gRPC calls */
    private cachedCascadeId: string | null = null;
    private idCounter = 1;
    private cdpCallTimeout = 30000;
    private targetUrl: string | null = null;
    private targetFrameId: string | null = null;
    /** Number of auto-reconnect attempts on disconnect */
    private maxReconnectAttempts: number;
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
        this.reconnectDelayMs = options.reconnectDelayMs ?? 2000;
    }

    private async getJson(url: string): Promise<any[]> {
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

    async discoverTarget(): Promise<string> {
        let allPages: any[] = [];
        for (const port of this.ports) {
            try {
                const list = await this.getJson(`http://127.0.0.1:${port}/json/list`);
                allPages.push(...list);
            } catch (e) {
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

        this.ws = new WebSocket(this.targetUrl);

        await new Promise<void>((resolve, reject) => {
            if (!this.ws) return reject(new Error('WebSocket not initialized'));
            this.ws.on('open', () => {
                this.isConnectedFlag = true;
                resolve();
            });
            this.ws.on('error', reject);
        });

        this.ws.on('message', (msg: WebSocket.Data) => {
            try {
                const data = JSON.parse(msg.toString());
                if (data.id !== undefined && this.pendingCalls.has(data.id)) {
                    const { resolve, reject, timeoutId } = this.pendingCalls.get(data.id)!;
                    clearTimeout(timeoutId);
                    this.pendingCalls.delete(data.id);
                    if (data.error) reject(data.error); else resolve(data.result);
                }

                if (data.method === 'Runtime.executionContextCreated') {
                    this.contexts.push(data.params.context);
                }
                if (data.method === 'Runtime.executionContextDestroyed') {
                    const idx = this.contexts.findIndex(c => c.id === data.params.executionContextId);
                    if (idx !== -1) this.contexts.splice(idx, 1);
                }

                // Forward CDP events via EventEmitter (Network.*, Runtime.*, etc.)
                if (data.method) {
                    this.emit(data.method, data.params);
                }
            } catch (e) { }
        });

        this.ws.on('close', () => {
            this.isConnectedFlag = false;
            // Reject all unresolved pending calls to prevent memory leaks
            this.clearPendingCalls(new Error('WebSocket disconnected'));
            this.ws = null;
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

        // Initialize Runtime to get execution contexts
        await this.call('Runtime.enable', {});

        // Enable Network domain for event-based completion detection
        try {
            await this.call('Network.enable', {});
        } catch {
            // Network.enable failure is non-fatal; polling fallback still works
            logger.warn('[CdpService] Network.enable failed — network event detection disabled');
        }
    }

    async call(method: string, params: any = {}): Promise<any> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not connected');
        }

        return new Promise((resolve, reject) => {
            const id = this.idCounter++;
            const timeoutId = setTimeout(() => {
                if (this.pendingCalls.has(id)) {
                    this.pendingCalls.delete(id);
                    reject(new Error(`Timeout calling CDP method ${method}`));
                }
            }, this.cdpCallTimeout);

            this.pendingCalls.set(id, { resolve, reject, timeoutId });
            this.ws!.send(JSON.stringify({ id, method, params }));
        });
    }

    /**
     * Try call(), and on WebSocket connection error,
     * attempt a single on-demand reconnect then retry once.
     * Non-connection errors (timeout, protocol) are NOT retried.
     */
    async callWithRetry(method: string, params: any = {}, timeoutMs = 10000): Promise<any> {
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
        // Stop reconnection attempts
        this.maxReconnectAttempts = 0;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnectedFlag = false;
        this.contexts = [];
        this.currentWorkspacePath = null;
        this.currentWorkspaceName = null;
        this.targetFrameId = null;
        // Reset gRPC state so next connection re-probes auth
        this.grpcClient = null;
        this.grpcAuthAttempted = false;
        this.cachedCascadeId = null;
        this.clearPendingCalls(new Error('disconnect() was called'));
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
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isConnectedFlag) {
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
        let pages: any[] = [];
        let respondingPort: number | null = null;

        for (const port of this.ports) {
            try {
                const list = await this.getJson(`http://127.0.0.1:${port}/json/list`);
                pages.push(...list);
                // Prioritize recording ports that contain workbench pages
                const hasWorkbench = list.some((t: any) => t.url?.includes('workbench'));
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
            // Launch Antigravity if no port responds
            return this.launchAndConnectWorkspace(workspacePath, projectName);
        }

        // Filter workbench pages only (exclude Launchpad, Manager, iframe, worker)
        const workbenchPages = pages.filter(
            (t: any) =>
                t.type === 'page' &&
                t.webSocketDebuggerUrl &&
                !t.title?.includes('Launchpad') &&
                !t.url?.includes('workbench-jetski-agent') &&
                t.url?.includes('workbench'),
        );

        logger.debug(`[CdpService] Searching for workspace "${projectName}" (port=${respondingPort})... ${workbenchPages.length} workbench pages:`);
        for (const p of workbenchPages) {
            logger.debug(`  - title="${p.title}" url=${p.url}`);
        }

        // 1. Title match (fast path)
        const titleMatch = workbenchPages.find((t: any) => t.title?.includes(projectName));
        if (titleMatch) {
            return this.connectToPage(titleMatch, projectName);
        }

        // 2. Title match failed -> CDP probe (connect to each page and check document.title)
        logger.debug(`[CdpService] Title match failed. Searching via CDP probe...`);
        const probeResult = await this.probeWorkbenchPages(workbenchPages, projectName, workspacePath);
        if (probeResult) {
            return true;
        }

        // 3. If not found by probe either, launch a new window
        return this.launchAndConnectWorkspace(workspacePath, projectName);
    }

    /**
     * Connect to the specified page (skip if already connected).
     */
    private async connectToPage(page: any, projectName: string): Promise<boolean> {
        // No reconnection needed if already connected to the same URL
        if (this.isConnectedFlag && this.targetUrl === page.webSocketDebuggerUrl) {
            this.currentWorkspaceName = projectName;
            return true;
        }

        this.disconnectQuietly();
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
    private async probeWorkbenchPages(
        workbenchPages: any[],
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
            // Instead of DOM/document.title, check folder parameter in page URL or
            // folder name in explorer view
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

            // Additional fallback: check URL params (VS Code-based editors may have folder parameter)
            const urlResult = await this.call('Runtime.evaluate', {
                expression: 'window.location.href',
                returnByValue: true,
            });
            const pageUrl = (urlResult?.result?.value || '').toLowerCase();
            const normalizedWorkspaceUri = encodeURIComponent(workspacePath).toLowerCase();
            if (pageUrl.includes(normalizedWorkspaceUri) || pageUrl.includes(projectName.toLowerCase())) {
                this.currentWorkspaceName = projectName;
                logger.debug(`[CdpService] URL parameter match success: "${projectName}"`);
                return true;
            }

        } catch (e) {
            logger.warn(`[CdpService] Folder path probe failed:`, e);
        }

        return false;
    }

    /**
     * Launch Antigravity and wait for a new workbench page to appear, then connect.
     */
    private async launchAndConnectWorkspace(
        workspacePath: string,
        projectName: string,
    ): Promise<boolean> {
        // Open as folder using Antigravity CLI (not as workspace mode).
        // `open -a Antigravity` may open as workspace, resulting in title "Untitled (Workspace)".
        // CLI --new-window opens as folder, immediately reflecting directory name in title.
        const antigravityCli = getAntigravityCliPath();

        logger.debug(`[CdpService] Launching Antigravity: ${antigravityCli} --new-window ${workspacePath}`);
        try {
            await this.runCommand(antigravityCli, ['--new-window', workspacePath]);
        } catch (error: any) {
            // Fall back to open -a if CLI not found (macOS only)
            logger.warn(`[CdpService] CLI launch failed, falling back to open -a (if macOS): ${error?.message || String(error)}`);
            if (process.platform === 'darwin') {
                await this.runCommand('open', ['-a', 'Antigravity', workspacePath]);
            } else {
                throw error;
            }
        }

        // Poll until a new workbench page appears (max 30 seconds)
        const maxWaitMs = 30000;
        const pollIntervalMs = 1000;
        const startTime = Date.now();
        /** Pre-launch workbench page IDs (for detecting new pages) */
        let knownPageIds: Set<string> = new Set();
        for (const port of this.ports) {
            try {
                const preLaunchPages = await this.getJson(`http://127.0.0.1:${port}/json/list`);
                preLaunchPages.forEach((p: any) => {
                    if (p.id) knownPageIds.add(p.id);
                });
            } catch {
                // No response from this port
            }
        }

        while (Date.now() - startTime < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollIntervalMs));

            let pages: any[] = [];
            for (const port of this.ports) {
                try {
                    const list = await this.getJson(`http://127.0.0.1:${port}/json/list`);
                    pages.push(...list);
                } catch {
                    // Next port
                }
            }

            if (pages.length === 0) continue;

            const workbenchPages = pages.filter(
                (t: any) =>
                    t.type === 'page' &&
                    t.webSocketDebuggerUrl &&
                    !t.title?.includes('Launchpad') &&
                    !t.url?.includes('workbench-jetski-agent') &&
                    t.url?.includes('workbench'),
            );

            // Title match
            const titleMatch = workbenchPages.find((t: any) => t.title?.toLowerCase().includes(projectName.toLowerCase()));
            if (titleMatch) {
                return this.connectToPage(titleMatch, projectName);
            }

            // CDP probe (also check folder path if title is not updated)
            const probeResult = await this.probeWorkbenchPages(workbenchPages, projectName, workspacePath);
            if (probeResult) {
                return true;
            }

            // Fallback: connect to newly appeared "Untitled (Workspace)" page after launch
            // If title update and folder path both fail, treat new page as target
            if (Date.now() - startTime > 10000) {
                const newUntitledPages = workbenchPages.filter(
                    (t: any) =>
                        !knownPageIds.has(t.id) &&
                        (t.title?.includes('Untitled') || t.title === ''),
                );
                if (newUntitledPages.length === 1) {
                    logger.debug(`[CdpService] New Untitled page detected. Connecting as "${projectName}" (page.id=${newUntitledPages[0].id})`);
                    return this.connectToPage(newUntitledPages[0], projectName);
                }
            }
        }

        throw new Error(
            `Workbench page for workspace "${projectName}" not found within ${maxWaitMs / 1000} seconds`,
        );
    }

    private async runCommand(command: string, args: string[]): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(command, args, { stdio: 'ignore' });

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

    /**
     * Quietly disconnect the existing connection (no reconnect attempts).
     * Used during workspace switching.
     *
     * Important: ws.close() fires close event asynchronously, so all listeners
     * must be removed first to prevent targetUrl reset and tryReconnect()
     * from reconnecting to a different workbench.
     */
    private disconnectQuietly(): void {
        if (this.ws) {
            // Remove all listeners including close event handlers to prevent side effects
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
            this.isConnectedFlag = false;
            this.contexts = [];
            this.clearPendingCalls(new Error('Disconnected for workspace switch'));
            this.targetUrl = null;
            this.targetFrameId = null;
        }
    }

    /**
     * Reject all unresolved pending calls to prevent memory leaks.
     * (Step 12: Error handling)
     * @param error Error to pass to reject
     */
    private clearPendingCalls(error: Error): void {
        for (const [, { reject, timeoutId }] of this.pendingCalls.entries()) {
            clearTimeout(timeoutId);
            reject(error);
        }
        this.pendingCalls.clear();
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
                logger.error('[CdpService] Reconnect succeeded.');
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

            const onFailed = (_err: Error) => {
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
     * Wait for gRPC client readiness (replaces DOM cascade-panel wait).
     * @returns true if gRPC client is ready
     */
    async waitForCascadePanelReady(timeoutMs = 10000, _pollIntervalMs = 500): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const client = await this.ensureGrpcClient();
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
    // All injection now goes through gRPC.

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

    // injectViaLexicalApi removed — all injection now goes through gRPC.

    /**
     * Lazy-initialize the gRPC client by discovering the LS process.
     * Uses compliant discovery (process CLI args for CSRF token, NOT OAuth tokens).
     * Only attempts discovery once per connection cycle.
     */
    private async ensureGrpcClient(): Promise<GrpcCascadeClient | null> {
        if (this.grpcClient?.isReady()) {
            return this.grpcClient;
        }

        // Only attempt discovery once to avoid repeated failures
        if (this.grpcAuthAttempted) {
            return this.grpcClient;
        }
        this.grpcAuthAttempted = true;

        try {
            // Derive workspace hint from the current workspace name
            const hint = this.currentWorkspaceName
                ?.replace(/[-. ]/g, '_')
                .toLowerCase();

            const conn = await discoverLSConnection(hint || undefined);
            if (conn) {
                this.grpcClient = new GrpcCascadeClient();
                this.grpcClient.setConnection(conn);
                logger.info(`[CdpService] gRPC client initialized: port=${conn.port}, tls=${conn.useTls}`);
                return this.grpcClient;
            }
            logger.debug('[CdpService] LS process discovery returned null — will use DOM injection');
        } catch (err: any) {
            logger.debug(`[CdpService] LS process discovery failed: ${err.message}`);
        }

        return null;
    }

    /**
     * Get the active gRPC client if available.
     * Attempts discovery if not already attempted.
     */
    async getGrpcClient(): Promise<GrpcCascadeClient | null> {
        return this.ensureGrpcClient();
    }

    /**
     * Try to inject a message via the gRPC direct API.
     * Bypasses the entire DOM — sends directly to the LanguageServer.
     * Uses only CSRF token (no OAuth tokens).
     *
     * @returns InjectResult with method='grpc' on success, or null if unavailable
     */
    private async injectViaGrpc(text: string, overrideCascadeId?: string): Promise<InjectResult | null> {
        const client = await this.ensureGrpcClient();
        if (!client) return null;

        // If we have an explicit cascade ID (e.g. from a previous createCascade), try to reuse it
        let cascadeId = overrideCascadeId || this.cachedCascadeId;

        if (cascadeId) {
            // Send to existing cascade
            logger.warn(`[CdpService] injectViaGrpc: sending to existing cascade=${cascadeId.slice(0, 16)}... text="${text.slice(0, 50)}"`);
            const result = await client.sendMessage(cascadeId, text);
            if (result.ok) {
                logger.warn(`[CdpService] sendMessage OK, response: ${JSON.stringify(result.data)?.slice(0, 200)}`);
                return { ok: true, method: 'grpc' };
            }
            // If existing cascade failed, fall through to create a new one
            logger.warn(`[CdpService] sendMessage to existing cascade failed: ${result.error}, creating new cascade`);
            this.cachedCascadeId = null;
        }

        // Create a new Antigravity cascade and send the message
        logger.warn(`[CdpService] injectViaGrpc: creating new cascade with text="${text.slice(0, 50)}"`);
        const newCascadeId = await client.createCascade(text);
        if (newCascadeId) {
            this.cachedCascadeId = newCascadeId;
            logger.warn(`[CdpService] New cascade created: ${newCascadeId.slice(0, 16)}...`);
            return { ok: true, method: 'grpc' };
        }

        logger.error('[CdpService] createCascade returned null — cannot inject');
        return null;
    }

    /**
     * Inject and send the specified text into Antigravity.
     *
     * Strategy: gRPC direct API only — zero DOM dependency.
     */
    async injectMessage(text: string, overrideCascadeId?: string): Promise<InjectResult> {
        // gRPC direct API (no DOM dependency at all)
        const grpcResult = await this.injectViaGrpc(text, overrideCascadeId);
        if (grpcResult?.ok) {
            return grpcResult;
        }

        return { ok: false, error: grpcResult?.error || 'gRPC injection failed — no DOM fallback available' };
    }

    /**
     * Inject a message with image files.
     * NOTE: gRPC does not support image attachment yet — text is sent via gRPC,
     * images are logged as unsupported.
     */
    async injectMessageWithImageFiles(text: string, imageFilePaths: string[]): Promise<InjectResult> {
        if (imageFilePaths.length > 0) {
            logger.warn(`[CdpService] Image attachment not supported via gRPC (${imageFilePaths.length} images ignored)`);
        }
        // Send text-only via gRPC
        return this.injectMessage(text);
    }

    /**
     * Extract images from the latest AI response.
     * NOTE: No gRPC equivalent — image extraction not available in headless mode.
     * @returns Always returns empty array
     */
    async extractLatestResponseImages(_maxImages: number = 4): Promise<ExtractedResponseImage[]> {
        logger.debug('[CdpService] extractLatestResponseImages: not available via gRPC, returning []');
        return [];
    }

    // ─── Mode / Model (gRPC-based, no DOM) ─────────────────────────────

    /** Cached mode name: 'fast' (conversational) or 'plan' (normal) */
    private cachedModeName: string = 'fast';
    /** Cached model label (human-readable, e.g. 'Claude Sonnet 4.6 (Thinking)') */
    private cachedModelLabel: string | null = null;
    /** Cached model configs from GetUserStatus */
    private cachedModelConfigs: Array<{ label: string; model: string; supportsImages?: boolean }> = [];

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
     * Retrieve available models from gRPC GetUserStatus.
     * Uses cascadeModelConfigData.clientModelConfigs from the LS API.
     */
    async getUiModels(): Promise<string[]> {
        try {
            const client = await this.ensureGrpcClient();
            if (!client) return [];

            const status = await client.getUserStatus();
            const configs = status?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
            this.cachedModelConfigs = configs.map((cfg: any) => ({
                label: cfg.label || 'Unknown',
                model: cfg.modelOrAlias?.model || 'unknown',
                supportsImages: cfg.supportsImages,
            }));
            return this.cachedModelConfigs.map(c => c.label);
        } catch (err: any) {
            logger.error('[CdpService] getUiModels via gRPC failed:', err.message);
            return [];
        }
    }

    /**
     * Get the currently selected model label.
     * If no model has been explicitly set, fetches from gRPC and returns the first recommended model.
     */
    async getCurrentModel(): Promise<string | null> {
        if (this.cachedModelLabel) return this.cachedModelLabel;

        // Try to fetch from gRPC
        try {
            const client = await this.ensureGrpcClient();
            if (!client) return null;

            const status = await client.getUserStatus();
            const configs = status?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
            if (configs.length > 0) {
                // Find first recommended model, or fall back to first
                const recommended = configs.find((c: any) => c.isRecommended);
                this.cachedModelLabel = (recommended || configs[0]).label || null;
                // Cache all configs
                this.cachedModelConfigs = configs.map((cfg: any) => ({
                    label: cfg.label || 'Unknown',
                    model: cfg.modelOrAlias?.model || 'unknown',
                    supportsImages: cfg.supportsImages,
                }));
                return this.cachedModelLabel;
            }
        } catch (err: any) {
            logger.debug(`[CdpService] getCurrentModel via gRPC failed: ${err.message}`);
        }
        return null;
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

        // Find by label (case-insensitive)
        const normalized = modelName.toLowerCase().trim();
        const found = this.cachedModelConfigs.find(
            c => c.label.toLowerCase().trim() === normalized,
        );

        if (found) {
            this.cachedModelLabel = found.label;
            logger.info(`[CdpService] Model set to '${found.label}' (${found.model})`);
            return { ok: true, model: found.label };
        }

        // Try partial match
        const partial = this.cachedModelConfigs.find(
            c => c.label.toLowerCase().includes(normalized) || normalized.includes(c.label.toLowerCase()),
        );
        if (partial) {
            this.cachedModelLabel = partial.label;
            logger.info(`[CdpService] Model set to '${partial.label}' (partial match for '${modelName}')`);
            return { ok: true, model: partial.label };
        }

        const available = this.cachedModelConfigs.map(c => c.label).join(', ');
        return { ok: false, error: `Model "${modelName}" not found. Available: ${available}` };
    }

    /**
     * Get the model enum value for the currently selected model.
     * Used internally when building SendUserCascadeMessage payloads.
     */
    getSelectedModelEnum(): string | null {
        if (!this.cachedModelLabel) return null;
        const found = this.cachedModelConfigs.find(
            c => c.label === this.cachedModelLabel,
        );
        return found?.model || null;
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
    async executeVscodeCommand(command: string, ...args: any[]): Promise<any> {
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

    // ─── Cascade ID (gRPC-based) ───────────────────────────────────────

    /**
     * Get the currently active cascade (conversation) ID.
     * Uses gRPC GetAllCascadeTrajectories to find the most recent cascade.
     *
     * @returns The active cascade ID string, or null if not found
     */
    async getActiveCascadeId(): Promise<string | null> {
        // Return cached if available
        if (this.cachedCascadeId) return this.cachedCascadeId;

        try {
            const client = await this.ensureGrpcClient();
            if (!client) return null;

            const summaries = await client.listCascades();
            if (!summaries || typeof summaries !== 'object') return null;

            // Diagnostic: dump cascade IDs
            const allIds = Object.keys(summaries);
            logger.warn(`[CdpService] listCascades returned ${allIds.length} cascades: ${allIds.map(id => id.slice(0, 12) + '...').join(', ')}`);
            for (const [id, s] of Object.entries(summaries).slice(0, 3)) {
                const ss = s as any;
                logger.warn(`[CdpService]   cascade=${id.slice(0, 16)} title=${ss.title?.slice(0, 40) || 'N/A'} mod=${ss.lastModifiedTimestamp || 'N/A'}`);
            }

            // Find the most recently modified cascade
            let latestId: string | null = null;
            let latestTime = 0;

            for (const [id, summary] of Object.entries(summaries)) {
                const s = summary as any;
                const modTime = s.lastModifiedTimestamp
                    ? new Date(s.lastModifiedTimestamp).getTime()
                    : 0;
                if (modTime > latestTime) {
                    latestTime = modTime;
                    latestId = id;
                }
            }

            if (latestId) {
                this.cachedCascadeId = latestId;
                return latestId;
            }

            // Fallback: just take the first key
            const ids = Object.keys(summaries);
            if (ids.length > 0) {
                this.cachedCascadeId = ids[0];
                return ids[0];
            }
        } catch (err: any) {
            logger.debug(`[CdpService] getActiveCascadeId via gRPC failed: ${err.message}`);
        }

        return null;
    }
}

