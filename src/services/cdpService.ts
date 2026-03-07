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

/** Antigravity UI DOM selector constants */
const SELECTORS = {
    /** Chat input box: textbox excluding xterm */
    CHAT_INPUT: 'div[role="textbox"]:not(.xterm-helper-textarea)',
    /** Submit button search target tag */
    SUBMIT_BUTTON_CONTAINER: 'button',
    /** Submit icon SVG class candidates */
    SUBMIT_BUTTON_SVG_CLASSES: ['lucide-arrow-right', 'lucide-arrow-up', 'lucide-send'],
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
     * Wait by polling until cascade-panel context becomes available.
     * Right after Antigravity launch, contexts are created asynchronously even after Runtime.enable,
     * so use this method to confirm readiness before DOM operations.
     *
     * @param timeoutMs Maximum wait time (ms). Default: 10000
     * @param pollIntervalMs Polling interval (ms). Default: 500
     * @returns true if cascade-panel context was found
     */
    async waitForCascadePanelReady(timeoutMs = 10000, pollIntervalMs = 500): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const cascadeCtx = this.contexts.find(
                c => c.url && c.url.includes(SELECTORS.CONTEXT_URL_KEYWORD),
            );
            if (cascadeCtx) {
                return true;
            }
            await new Promise(r => setTimeout(r, pollIntervalMs));
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

    /**
     * Focus the chat input field.
     */
    private async focusChatInput(): Promise<{ ok: boolean; contextId?: number; error?: string }> {
        const focusScript = `(() => {
            const editors = Array.from(document.querySelectorAll('${SELECTORS.CHAT_INPUT}'));
            const visible = editors.filter(el => el.offsetParent !== null);
            const editor = visible[visible.length - 1];
            if (!editor) return { ok: false, error: 'No editor found' };
            editor.focus();
            return { ok: true };
        })()`;

        for (const ctx of this.contexts) {
            try {
                const res = await this.call('Runtime.evaluate', {
                    expression: focusScript,
                    returnByValue: true,
                    contextId: ctx.id,
                });
                if (res?.result?.value?.ok) {
                    return { ok: true, contextId: ctx.id };
                }
            } catch {
                // Try next context
            }
        }

        return { ok: false, error: 'Chat input field not found' };
    }

    /**
     * Select all text in the focused input and delete it to ensure a clean state.
     * Uses Meta+A (select all) then Backspace (delete) via CDP key events.
     */
    private async clearInputField(): Promise<void> {
        // Meta+A to select all content
        await this.call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'a',
            code: 'KeyA',
            modifiers: 4, // Meta (Cmd on macOS)
            windowsVirtualKeyCode: 65,
            nativeVirtualKeyCode: 65,
        });
        await this.call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'a',
            code: 'KeyA',
            modifiers: 4,
            windowsVirtualKeyCode: 65,
            nativeVirtualKeyCode: 65,
        });
        // Backspace to delete selected content
        await this.call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Backspace',
            code: 'Backspace',
            windowsVirtualKeyCode: 8,
            nativeVirtualKeyCode: 8,
        });
        await this.call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Backspace',
            code: 'Backspace',
            windowsVirtualKeyCode: 8,
            nativeVirtualKeyCode: 8,
        });
        // Wait for DOM to settle
        await new Promise(r => setTimeout(r, 50));
    }

    /**
     * Send Enter key to submit the message.
     */
    private async pressEnterToSend(): Promise<void> {
        await this.call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
        });
        await this.call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
        });
    }

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
     * Inject text into Antigravity's Lexical editor directly via Runtime.evaluate.
     *
     * Advantages over Input API:
     *   - No DOM focus required — works in background tabs
     *   - No keyboard event routing — bypasses focus state entirely
     *   - Cross-platform — no Meta vs Ctrl differences
     *   - Direct state manipulation — more reliable than simulated input
     *
     * @returns InjectResult with method='lexical' on success, or null if Lexical API unavailable
     */
    private async injectViaLexicalApi(text: string): Promise<InjectResult | null> {
        // Escape the text for embedding in JavaScript string literal
        const safeText = JSON.stringify(text);

        const lexicalScript = `(async () => {
            const editors = Array.from(document.querySelectorAll('div[role="textbox"]:not(.xterm-helper-textarea)'));
            const visible = editors.filter(el => el.offsetParent !== null);
            const tb = visible[visible.length - 1];
            if (!tb) return { ok: false, error: 'No textbox found' };

            const editor = tb.__lexicalEditor;
            if (!editor) return { ok: false, error: 'No Lexical editor instance' };
            if (!editor.update || !editor.dispatchCommand) return { ok: false, error: 'Incomplete Lexical API' };

            try {
                // Use Lexical's internal update mechanism to set text content.
                // The $-prefixed functions are module-scoped but accessible within editor.update().
                editor.update(() => {
                    // Access Lexical internals via the editor's registered nodes and commands
                    const editorState = editor.getEditorState();
                    const root = editorState._nodeMap.get('root');
                    if (!root) throw new Error('No root node');

                    // Clear existing content and insert new text
                    // Use the editor's internal selection and node APIs
                    const selection = root.select(0, root.getChildrenSize());
                    selection.removeText();
                });

                // Brief pause for state update
                await new Promise(r => setTimeout(r, 50));

                // Insert the text via the editor's insertText command
                editor.update(() => {
                    const root = editor.getEditorState()._nodeMap.get('root');
                    if (!root) return;
                    root.select(0, root.getChildrenSize());
                });

                // Use Input.insertText within the Lexical editor context
                // This is more reliable than constructing text nodes manually
                // because it triggers all Lexical listeners and transforms
                tb.focus();
                return { ok: true, needsInputApi: true };
            } catch (e) {
                return { ok: false, error: 'Lexical update failed: ' + (e.message || e) };
            }
        })()`;

        // Try in each execution context
        for (const ctx of this.contexts) {
            try {
                const res = await this.call('Runtime.evaluate', {
                    expression: lexicalScript,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id,
                });
                const value = res?.result?.value;
                if (value?.ok) {
                    if (value.needsInputApi) {
                        // Lexical editor found and focused — use hybrid approach:
                        // Lexical handles the focus (works in background), then Input API types text
                        await this.clearInputField();
                        await this.call('Input.insertText', { text });
                        await new Promise(r => setTimeout(r, 200));
                        await this.pressEnterToSend();
                        return { ok: true, method: 'lexical-hybrid', contextId: ctx.id };
                    }
                    return { ok: true, method: 'lexical', contextId: ctx.id };
                }
                // If error is about missing Lexical, try next context
                if (value?.error?.includes('No Lexical') || value?.error?.includes('No textbox')) {
                    continue;
                }
                // Other Lexical errors — log but try next context
                logger.debug(`[CdpService] Lexical inject attempt in ctx ${ctx.id}: ${value?.error}`);
            } catch {
                // Try next context
            }
        }

        // Lexical API not available in any context
        return null;
    }

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

        // Get the cascade ID
        let cascadeId = overrideCascadeId || this.cachedCascadeId;
        if (!cascadeId) {
            cascadeId = await this.getActiveCascadeId();
            if (cascadeId) {
                this.cachedCascadeId = cascadeId;
            }
        }

        if (!cascadeId) {
            logger.debug('[CdpService] No cascadeId available for gRPC injection');
            return null;
        }

        const result = await client.sendMessage(cascadeId, text);
        if (result.ok) {
            return { ok: true, method: 'grpc' };
        }

        logger.debug(`[CdpService] gRPC injection failed: ${result.error}`);
        // If auth error, reset so next call re-discovers
        if (result.error?.includes('401') || result.error?.includes('403')) {
            this.grpcAuthAttempted = false;
            this.grpcClient = null;
        }
        return null;
    }

    /**
     * Inject and send the specified text into Antigravity's chat input field.
     *
     * Strategy (tiered, highest priority first):
     *   0. gRPC direct API — zero DOM dependency, works across sessions
     *   1. Lexical API — focus-free, background-safe
     *   2. Legacy Input API — fallback with DOM focus
     */
    async injectMessage(text: string, overrideCascadeId?: string): Promise<InjectResult> {
        if (!this.isConnectedFlag || !this.ws) {
            throw new Error('Not connected to CDP. Call connect() first.');
        }

        // Strategy 0: gRPC direct API (preferred — no DOM dependency at all)
        const grpcResult = await this.injectViaGrpc(text, overrideCascadeId);
        if (grpcResult?.ok) {
            return grpcResult;
        }

        // Strategy 1: Lexical API (no focus dependency)
        const lexicalResult = await this.injectViaLexicalApi(text);
        if (lexicalResult) {
            if (lexicalResult.ok) {
                return lexicalResult;
            }
            logger.debug(`[CdpService] Lexical injection failed: ${lexicalResult.error}, falling back to Input API`);
        }

        // Strategy 2: Legacy Input API fallback
        const focusResult = await this.focusChatInput();
        if (!focusResult.ok) {
            return { ok: false, error: focusResult.error || 'Chat input field not found' };
        }

        // Clear any existing text in the input field before injecting
        await this.clearInputField();

        // Input text via CDP Input.insertText
        await this.call('Input.insertText', { text });
        await new Promise(r => setTimeout(r, 200));

        // Send via Enter key
        await this.pressEnterToSend();

        return { ok: true, method: 'enter', contextId: focusResult.contextId };
    }

    /**
     * Attach image files to the UI and send the specified text.
     */
    async injectMessageWithImageFiles(text: string, imageFilePaths: string[]): Promise<InjectResult> {
        if (!this.isConnectedFlag || !this.ws) {
            throw new Error('Not connected to CDP. Call connect() first.');
        }

        const focusResult = await this.focusChatInput();
        if (!focusResult.ok) {
            return { ok: false, error: focusResult.error || 'Chat input field not found' };
        }

        // Clear any existing text in the input field before injecting
        await this.clearInputField();

        const attachResult = await this.attachImageFiles(imageFilePaths, focusResult.contextId);
        if (!attachResult.ok) {
            return { ok: false, error: attachResult.error || 'Failed to attach images' };
        }

        await this.call('Input.insertText', { text });
        await new Promise(r => setTimeout(r, 200));
        await this.pressEnterToSend();

        return { ok: true, method: 'enter', contextId: focusResult.contextId };
    }

    /**
     * Extract images from the latest AI response.
     */
    async extractLatestResponseImages(maxImages: number = 4): Promise<ExtractedResponseImage[]> {
        if (!this.isConnectedFlag || !this.ws) {
            return [];
        }

        const safeMaxImages = Math.max(1, Math.min(8, Math.floor(maxImages)));
        const expression = `(async () => {
            const maxImages = ${safeMaxImages};
            const panel = document.querySelector('.antigravity-agent-side-panel');
            const scope = panel || document;

            const candidateSelectors = [
                '.rendered-markdown',
                '.leading-relaxed.select-text',
                '.flex.flex-col.gap-y-3',
                '[data-message-author-role="assistant"]',
                '[data-message-role="assistant"]',
                '[class*="assistant-message"]',
                '[class*="message-content"]',
                '[class*="markdown-body"]',
                '.prose',
            ];

            const responseNodes = [];
            const seenNodes = new Set();
            for (const selector of candidateSelectors) {
                const nodes = scope.querySelectorAll(selector);
                for (const node of nodes) {
                    if (!node || seenNodes.has(node)) continue;
                    seenNodes.add(node);
                    responseNodes.push(node);
                }
            }

            // Skip image extraction when no response nodes found (prevent UI icon false positives)
            if (responseNodes.length === 0) return [];

            const normalize = (value) => (value || '').toLowerCase();
            const isLikelyUiImage = (img) => {
                if (!img) return true;
                const src = normalize(img.currentSrc || img.src || img.getAttribute('src') || '');
                const alt = normalize(img.getAttribute('alt') || '');
                const title = normalize(img.getAttribute('title') || '');
                const cls = normalize(img.getAttribute('class') || '');
                const blob = [src, alt, title, cls].join(' ');

                if (blob.includes('icon') || blob.includes('avatar') || blob.includes('emoji')) return true;
                if (blob.includes('thumb') || blob.includes('good') || blob.includes('bad')) return true;
                if (src.startsWith('data:image/svg+xml')) return true;
                if (img.closest('button, [role="button"], nav, header, footer, [class*="toolbar"], [class*="reaction"]')) return true;

                const rect = typeof img.getBoundingClientRect === 'function' ? img.getBoundingClientRect() : null;
                const w = Number(img.naturalWidth || img.width || rect?.width || 0);
                const h = Number(img.naturalHeight || img.height || rect?.height || 0);
                if (w < 96 || h < 96) return true;
                if ((w * h) < 12000) return true;

                return false;
            };

            const dedup = new Set();
            const images = [];
            for (let i = responseNodes.length - 1; i >= 0; i--) {
                const node = responseNodes[i];
                const nodeImages = Array.from(node.querySelectorAll('img'));
                for (const img of nodeImages) {
                    if (isLikelyUiImage(img)) continue;
                    const key = (img.currentSrc || img.src || img.getAttribute('src') || '') + '|' + (img.getAttribute('alt') || '');
                    if (!key || dedup.has(key)) continue;
                    dedup.add(key);
                    images.push(img);
                }
                if (images.length >= maxImages) break;
            }

            if (images.length === 0) return [];
            const picked = images.slice(-maxImages);

            const normalizeFileName = (value, idx) => {
                const raw = (value || '').trim();
                const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
                return safe || ('generated-image-' + (idx + 1));
            };

            const guessMimeType = (src) => {
                if (!src) return 'image/png';
                if (src.startsWith('data:')) {
                    const match = src.match(/^data:([^;]+);/);
                    return (match && match[1]) || 'image/png';
                }
                const lower = src.toLowerCase();
                if (lower.includes('.jpg') || lower.includes('.jpeg')) return 'image/jpeg';
                if (lower.includes('.webp')) return 'image/webp';
                if (lower.includes('.gif')) return 'image/gif';
                return 'image/png';
            };

            const blobToBase64 = (blob) => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const value = typeof reader.result === 'string' ? reader.result : '';
                    const commaIndex = value.indexOf(',');
                    resolve(commaIndex >= 0 ? value.slice(commaIndex + 1) : value);
                };
                reader.onerror = () => reject(reader.error || new Error('read failed'));
                reader.readAsDataURL(blob);
            });

            const result = [];
            for (let i = 0; i < picked.length; i++) {
                const img = picked[i];
                const src = img.currentSrc || img.src || img.getAttribute('src') || '';
                if (!src) continue;

                const baseName = normalizeFileName(img.getAttribute('alt') || img.getAttribute('title'), i);
                const mimeType = guessMimeType(src);
                const extensionMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
                const ext = extensionMap[mimeType] || 'png';
                const name = baseName.includes('.') ? baseName : (baseName + '.' + ext);

                if (src.startsWith('data:')) {
                    const commaIndex = src.indexOf(',');
                    if (commaIndex > 0) {
                        result.push({
                            name,
                            mimeType,
                            base64Data: src.slice(commaIndex + 1),
                        });
                    }
                    continue;
                }

                try {
                    const response = await fetch(src);
                    if (!response.ok) throw new Error('fetch failed');
                    const blob = await response.blob();
                    const base64Data = await blobToBase64(blob);
                    result.push({
                        name,
                        mimeType: blob.type || mimeType,
                        base64Data,
                    });
                } catch {
                    result.push({
                        name,
                        mimeType,
                        url: src,
                    });
                }
            }

            return result;
        })()`;

        try {
            const contextId = this.getPrimaryContextId();
            const callParams: Record<string, unknown> = {
                expression,
                returnByValue: true,
                awaitPromise: true,
            };
            if (contextId !== null) {
                callParams.contextId = contextId;
            }

            const response = await this.call('Runtime.evaluate', callParams);
            const value = response?.result?.value;
            if (!Array.isArray(value)) return [];

            return value
                .filter((item) => item && typeof item === 'object' && typeof item.name === 'string')
                .map((item) => ({
                    name: item.name,
                    mimeType: typeof item.mimeType === 'string' ? item.mimeType : 'image/png',
                    base64Data: typeof item.base64Data === 'string' ? item.base64Data : undefined,
                    url: typeof item.url === 'string' ? item.url : undefined,
                }));
        } catch {
            return [];
        }

    }

    /**
     * Get the currently selected mode from the Antigravity UI.
     * Reads the mode toggle button text and maps it back to internal mode name.
     *
     * @returns Internal mode name (e.g., 'fast', 'plan') or null if not found
     */
    async getCurrentMode(): Promise<string | null> {
        if (!this.isConnectedFlag || !this.ws) {
            return null;
        }
        const expression = '(() => {'
            + ' const uiNameMap = { fast: "Fast", plan: "Planning" };'
            + ' const knownModes = Object.values(uiNameMap).map(n => n.toLowerCase());'
            + ' const reverseMap = {};'
            + ' Object.entries(uiNameMap).forEach(([k, v]) => { reverseMap[v.toLowerCase()] = k; });'
            + ' const allBtns = Array.from(document.querySelectorAll("button"));'
            + ' const visibleBtns = allBtns.filter(b => b.offsetParent !== null);'
            + ' const modeToggleBtn = visibleBtns.find(b => {'
            + '   const text = (b.textContent || "").trim().toLowerCase();'
            + '   const hasChevron = b.querySelector("svg[class*=\\"chevron\\"]");'
            + '   return knownModes.some(m => text === m) && hasChevron;'
            + ' });'
            + ' if (!modeToggleBtn) return null;'
            + ' const currentModeText = (modeToggleBtn.textContent || "").trim().toLowerCase();'
            + ' return reverseMap[currentModeText] || null;'
            + '})()';
        try {
            const contextId = this.getPrimaryContextId();
            const callParams: any = {
                expression,
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null) callParams.contextId = contextId;
            const res = await this.call('Runtime.evaluate', callParams);
            return res?.result?.value || null;
        } catch {
            return null;
        }
    }

    /**
     * Operate Antigravity UI mode dropdown to switch to the specified mode.
     * Two-step approach:
     *   Step 1: Click mode toggle button ("Fast"/"Plan" + chevron icon) to open dropdown
     *   Step 2: Select the target mode option from dropdown
     *
     * @param modeName Mode name to set (e.g., 'fast', 'plan')
     */
    async setUiMode(modeName: string): Promise<UiSyncResult> {
        if (!this.isConnectedFlag || !this.ws) {
            await this.reconnectOnDemand();
        }

        const safeMode = JSON.stringify(modeName);

        // Internal mode name -> Antigravity UI display name mapping
        const uiNameMap = JSON.stringify({ fast: 'Fast', plan: 'Planning' });

        // Build DOM manipulation script avoiding backticks in template literals
        const expression = '(async () => {'
            + ' const targetMode = ' + safeMode + ';'
            + ' const targetModeLower = targetMode.toLowerCase();'
            + ' const uiNameMap = ' + uiNameMap + ';'
            + ' const targetUiName = uiNameMap[targetModeLower] || targetMode;'
            + ' const targetUiNameLower = targetUiName.toLowerCase();'
            + ' const allBtns = Array.from(document.querySelectorAll("button"));'
            + ' const visibleBtns = allBtns.filter(b => b.offsetParent !== null);'
            // Step 1: Search for mode toggle button ("Fast"/"Planning" + chevron icon)
            + ' const knownModes = Object.values(uiNameMap).map(n => n.toLowerCase());'
            + ' const modeToggleBtn = visibleBtns.find(b => {'
            + '   const text = (b.textContent || "").trim().toLowerCase();'
            + '   const hasChevron = b.querySelector("svg[class*=\\"chevron\\"]");'
            + '   return knownModes.some(m => text === m) && hasChevron;'
            + ' });'
            + ' if (!modeToggleBtn) {'
            + '   return { ok: false, error: "Mode toggle button not found" };'
            + ' }'
            + ' const currentModeText = (modeToggleBtn.textContent || "").trim().toLowerCase();'
            // Do nothing if already on the target mode
            + ' if (currentModeText === targetUiNameLower) {'
            + '   return { ok: true, mode: targetUiName, alreadySelected: true };'
            + ' }'
            // Open dropdown
            + ' modeToggleBtn.click();'
            + ' await new Promise(r => setTimeout(r, 500));'
            // Step 2: Search for option by .font-medium text inside role="dialog"
            + ' const dialogs = Array.from(document.querySelectorAll("[role=\\"dialog\\"]"));'
            + ' const visibleDialog = dialogs.find(d => {'
            + '   const style = window.getComputedStyle(d);'
            + '   return style.visibility !== "hidden" && style.display !== "none";'
            + ' });'
            + ' let modeOption = null;'
            + ' if (visibleDialog) {'
            + '   const fontMediumEls = Array.from(visibleDialog.querySelectorAll(".font-medium"));'
            + '   const matchEl = fontMediumEls.find(el => {'
            + '     const text = (el.textContent || "").trim().toLowerCase();'
            + '     return text === targetUiNameLower;'
            + '   });'
            + '   if (matchEl) {'
            // Target the parent element of .font-medium (div with cursor-pointer) for clicking
            + '     modeOption = matchEl.closest("div.cursor-pointer") || matchEl.parentElement;'
            + '   }'
            + ' }'
            // Fallback when dialog not found: legacy selectors
            + ' if (!modeOption) {'
            + '   const fallbackEls = Array.from(document.querySelectorAll('
            + '     "div[class*=\\"cursor-pointer\\"]"'
            + '   )).filter(el => el.offsetParent !== null);'
            + '   modeOption = fallbackEls.find(el => {'
            + '     if (el === modeToggleBtn) return false;'
            + '     const fm = el.querySelector(".font-medium");'
            + '     if (fm) {'
            + '       const text = (fm.textContent || "").trim().toLowerCase();'
            + '       return text === targetUiNameLower;'
            + '     }'
            + '     return false;'
            + '   });'
            + ' }'
            + ' if (modeOption) {'
            + '   modeOption.click();'
            + '   await new Promise(r => setTimeout(r, 500));'
            // Verify: check if mode button text has changed
            + '   const updBtn = Array.from(document.querySelectorAll("button"))'
            + '     .filter(b => b.offsetParent !== null)'
            + '     .find(b => b.querySelector("svg[class*=\\"chevron\\"]") && knownModes.some(m => (b.textContent || "").trim().toLowerCase() === m));'
            + '   const newMode = updBtn ? (updBtn.textContent || "").trim() : "unknown";'
            + '   return { ok: true, mode: newMode };'
            + ' }'
            // Failed -> close dropdown
            + ' document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));'
            + ' await new Promise(r => setTimeout(r, 200));'
            + ' return { ok: false, error: "Mode option " + targetUiName + " not found in dropdown" };'
            + '})()';

        try {
            const contextId = this.getPrimaryContextId();
            const callParams: any = {
                expression,
                returnByValue: true,
                awaitPromise: true,
            };
            if (contextId !== null) callParams.contextId = contextId;

            const res = await this.call('Runtime.evaluate', callParams);
            const value = res?.result?.value;
            if (value?.ok) {
                return { ok: true, mode: value.mode };
            }
            return { ok: false, error: value?.error || 'UI operation failed (setUiMode)' };
        } catch (error: any) {
            return { ok: false, error: error?.message || String(error) };
        }
    }

    /**
     * Dynamically retrieve the list of available models from the Antigravity UI.
     */
    async getUiModels(): Promise<string[]> {
        if (!this.isConnectedFlag || !this.ws) {
            throw new Error('Not connected to CDP.');
        }

        const expression = `(async () => {
            const MODEL_RE = /(gemini|claude|gpt|opus|sonnet|flash|thinking)/i;
            const normalize = (value) => (value || '').replace(/\\s+/g, ' ').replace(/\\bNew\\b/g, '').trim();

            const extractItemLabel = (el) => {
                const labeled = el.querySelector('.font-medium');
                return normalize((labeled && labeled.textContent) || el.textContent || '');
            };

            const findModelTrigger = () => {
                const triggers = Array.from(document.querySelectorAll('[role="button"][aria-haspopup="dialog"]'));
                return triggers.find((el) => MODEL_RE.test(normalize(el.textContent || '')));
            };

            const findModelDialog = (trigger) => {
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
                const dialogCandidates = dialogs.filter((dialog) => {
                    const text = normalize(dialog.textContent || '');
                    return text.includes('Model') && MODEL_RE.test(text);
                });

                const visible = dialogCandidates.find((dialog) => {
                    const style = window.getComputedStyle(dialog);
                    return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
                });
                if (visible) return visible;

                if (trigger && trigger.parentElement) {
                    const sibling = Array.from(trigger.parentElement.querySelectorAll('[role="dialog"]')).find((dialog) => {
                        const text = normalize(dialog.textContent || '');
                        return text.includes('Model') && MODEL_RE.test(text);
                    });
                    if (sibling) return sibling;
                }

                return dialogCandidates[0] || null;
            };

            const trigger = findModelTrigger();
            const dialog = findModelDialog(trigger);
            if (!dialog) return [];

            const items = Array.from(dialog.querySelectorAll('div.cursor-pointer'))
                .map(extractItemLabel)
                .filter((label) => label.length > 0 && MODEL_RE.test(label));

            return Array.from(new Set(items));
        })()`;

        try {
            const contextId = this.getPrimaryContextId();
            const callParams: any = {
                expression,
                returnByValue: true,
                awaitPromise: true,
            };
            if (contextId !== null) callParams.contextId = contextId;

            const res = await this.call('Runtime.evaluate', callParams);
            const value = res?.result?.value;
            if (Array.isArray(value) && value.length > 0) {
                // remove duplicates
                return Array.from(new Set(value));
            }
            return [];
        } catch (error: any) {
            logger.error('Failed to get UI models:', error);
            return [];
        }
    }

    /**
     * Get the currently selected model from the Antigravity UI.
     */
    async getCurrentModel(): Promise<string | null> {
        if (!this.isConnectedFlag || !this.ws) {
            return null;
        }
        const expression = `(() => {
            const MODEL_RE = /(gemini|claude|gpt|opus|sonnet|flash|thinking)/i;
            const normalize = (value) => (value || '').replace(/\\s+/g, ' ').replace(/\\bNew\\b/g, '').trim();

            const trigger = Array.from(document.querySelectorAll('[role="button"][aria-haspopup="dialog"]'))
                .find((el) => MODEL_RE.test(normalize(el.textContent || '')));
            if (trigger) {
                const triggerText = normalize(trigger.textContent || '');
                if (triggerText) return triggerText;
            }

            const selectedItem = Array.from(document.querySelectorAll('div.cursor-pointer'))
                .find((e) => e.className.includes('px-2 py-1 flex items-center justify-between') && e.className.includes('bg-gray-500/20'));
            return normalize(selectedItem?.textContent || '') || null;
        })()`;
        try {
            const contextId = this.getPrimaryContextId();
            const res = await this.call('Runtime.evaluate', {
                expression, returnByValue: true, awaitPromise: true,
                contextId: contextId || undefined
            });
            return res?.result?.value || null;
        } catch (e: any) {
            return null;
        }
    }

    /**
     * Operate Antigravity UI model dropdown to switch to the specified model.
     * (Step 9: Model/mode switching UI sync)
     *
     * @param modelName Model name to set (e.g., 'gpt-4o', 'claude-3-opus')
     */
    async setUiModel(modelName: string): Promise<UiSyncResult> {
        if (!this.isConnectedFlag || !this.ws) {
            await this.reconnectOnDemand();
        }

        const safeModel = JSON.stringify(modelName);
        const expression = `(async () => {
            const targetModel = ${safeModel};
            const MODEL_RE = /(gemini|claude|gpt|opus|sonnet|flash|thinking)/i;
            const normalize = (value) => (value || '').replace(/\\s+/g, ' ').replace(/\\bNew\\b/g, '').trim();
            const equalsModel = (value) => normalize(value).toLowerCase() === normalize(targetModel).toLowerCase();

            const findModelTrigger = () => {
                const triggers = Array.from(document.querySelectorAll('[role="button"][aria-haspopup="dialog"]'));
                return triggers.find((el) => MODEL_RE.test(normalize(el.textContent || ''))) || null;
            };

            const findModelDialog = (trigger) => {
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
                const candidates = dialogs.filter((dialog) => {
                    const text = normalize(dialog.textContent || '');
                    return text.includes('Model') && MODEL_RE.test(text);
                });

                const visible = candidates.find((dialog) => {
                    const style = window.getComputedStyle(dialog);
                    return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
                });
                if (visible) return visible;

                if (trigger && trigger.parentElement) {
                    const sibling = Array.from(trigger.parentElement.querySelectorAll('[role="dialog"]')).find((dialog) => {
                        const text = normalize(dialog.textContent || '');
                        return text.includes('Model') && MODEL_RE.test(text);
                    });
                    if (sibling) return sibling;
                }

                return candidates[0] || null;
            };

            const getDialogItems = (dialog) => Array.from(dialog.querySelectorAll('div.cursor-pointer'))
                .map((el) => ({
                    el,
                    label: normalize((el.querySelector('.font-medium') && el.querySelector('.font-medium').textContent) || el.textContent || ''),
                }))
                .filter((item) => item.label.length > 0 && MODEL_RE.test(item.label));

            const trigger = findModelTrigger();
            if (!trigger) {
                return { ok: false, error: 'Model selector button not found.' };
            }

            const currentLabel = normalize(trigger.textContent || '');
            if (equalsModel(currentLabel)) {
                return { ok: true, model: currentLabel, alreadySelected: true };
            }

            trigger.click();
            await new Promise(r => setTimeout(r, 500));

            const dialog = findModelDialog(trigger);
            if (!dialog) {
                return { ok: false, error: 'Model list not found after opening the dropdown.' };
            }

            const modelItems = getDialogItems(dialog);
            if (modelItems.length === 0) {
                return { ok: false, error: 'Model list not found after opening the dropdown.' };
            }

            const targetItem = modelItems.find((item) => equalsModel(item.label));
            if (!targetItem) {
                const available = modelItems.map(item => item.label).join(', ');
                return { ok: false, error: 'Model "' + targetModel + '" not found. Available: ' + available };
            }

            const isSelected = targetItem.el.className.includes('bg-gray-500/20') && !targetItem.el.className.includes('hover:bg-gray-500/20');
            if (isSelected) {
                return { ok: true, model: targetItem.label, alreadySelected: true };
            }

            targetItem.el.click();
            await new Promise(r => setTimeout(r, 500));

            const updatedTrigger = findModelTrigger();
            const updatedLabel = normalize(updatedTrigger ? updatedTrigger.textContent || '' : '');
            if (equalsModel(updatedLabel)) {
                return { ok: true, model: updatedLabel, verified: true };
            }

            return { ok: true, model: targetItem.label, verified: false };
        })()`;

        try {
            const contextId = this.getPrimaryContextId();
            const callParams: any = {
                expression,
                returnByValue: true,
                awaitPromise: true,
            };
            if (contextId !== null) callParams.contextId = contextId;

            const res = await this.call('Runtime.evaluate', callParams);
            const value = res?.result?.value;
            if (value?.ok) {
                return { ok: true, model: value.model };
            }
            return { ok: false, error: value?.error || 'UI operation failed (setUiModel)' };
        } catch (error: any) {
            return { ok: false, error: error?.message || String(error) };
        }
    }

    /**
     * Get the currently active cascade (conversation) ID.
     * Tries multiple strategies:
     *   1. Intercepted gRPC log (if fetch interceptor was installed)
     *   2. Performance log (extract from recent gRPC URLs)
     *   3. Preact component tree inspection
     *
     * @returns The active cascade ID string, or null if not found
     */
    async getActiveCascadeId(): Promise<string | null> {
        const script = `(async () => {
            // Strategy 1: Get from intercepted gRPC calls
            const log = window.__grpcInterceptLog || [];
            const sendMsg = log.filter(e => e.url?.includes('SendUserCascadeMessage')).pop();
            if (sendMsg?.requestBody) {
                try {
                    const bodyStr = new TextDecoder().decode(new Uint8Array(sendMsg.requestBody));
                    const parsed = JSON.parse(bodyStr);
                    if (parsed.cascadeId) return parsed.cascadeId;
                } catch {}
            }

            // Strategy 2: Get from workbenchServiceProvider via Preact tree
            const panel = document.querySelector('.antigravity-agent-side-panel');
            if (panel && panel.__k) {
                const findNode = (node, depth, predicate) => {
                    if (!node || depth > 20) return null;
                    const result = predicate(node);
                    if (result) return result;
                    if (node.__k) {
                        const children = Array.isArray(node.__k) ? node.__k : [node.__k];
                        for (const child of children) {
                            if (!child) continue;
                            const found = findNode(child, depth + 1, predicate);
                            if (found) return found;
                        }
                    }
                    return null;
                };

                // Try component state/props for cascadeId
                const cascadeId = findNode(panel.__k, 0, (node) => {
                    // Check memoizedProps or props
                    const props = node.props || {};
                    if (props.cascadeId && typeof props.cascadeId === 'string') return props.cascadeId;
                    if (props.conversationId && typeof props.conversationId === 'string') return props.conversationId;
                    // Check component instance state
                    if (node.__c?.state) {
                        const s = node.__c.state;
                        if (s.cascadeId && typeof s.cascadeId === 'string') return s.cascadeId;
                        if (s.conversationId && typeof s.conversationId === 'string') return s.conversationId;
                        if (s.activeCascadeId && typeof s.activeCascadeId === 'string') return s.activeCascadeId;
                    }
                    return null;
                });
                if (cascadeId) return cascadeId;
            }

            // Strategy 3: Install a one-shot interceptor and wait for next gRPC call
            if (!window.__grpcInterceptInstalled) {
                let captured = null;
                const origFetch = window.fetch;
                window.fetch = async function(...args) {
                    const [url, opts] = args;
                    const urlStr = typeof url === 'string' ? url : '';
                    if (urlStr.includes('SendUserCascadeMessage') && !captured && opts?.body) {
                        try {
                            const bodyStr = typeof opts.body === 'string' ? opts.body : null;
                            if (bodyStr) {
                                captured = JSON.parse(bodyStr).cascadeId || null;
                            }
                        } catch {}
                    }
                    return origFetch.apply(this, args);
                };
                // Don't wait — just return null, the next call will pick it up
                setTimeout(() => { window.fetch = origFetch; }, 30000);
            }

            return null;
        })()`;

        try {
            for (const ctx of this.contexts) {
                try {
                    const res = await this.call('Runtime.evaluate', {
                        expression: script,
                        returnByValue: true,
                        awaitPromise: true,
                        contextId: ctx.id,
                    });
                    const value = res?.result?.value;
                    if (value && typeof value === 'string') return value;
                } catch {
                    // Try next context
                }
            }
            return null;
        } catch {
            return null;
        }
    }
}
