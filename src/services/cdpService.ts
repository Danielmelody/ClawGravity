import { logger } from '../utils/logger';
import { CDP_PORTS } from '../utils/cdpPorts';
import { EventEmitter } from 'events';
import * as http from 'http';
import { spawn } from 'child_process';
import { extractProjectNameFromPath } from '../utils/pathUtils';
import { CdpConnection } from './cdpConnection';
import { WorkspaceLauncher } from './workspaceLauncher';
import { LsClientManager } from './lsClientManager';
import { GrpcCascadeClient, ModelId, MediaItem, extractCascadeRunStatus } from './grpcCascadeClient';


export interface CdpServiceOptions {
    portsToScan?: number[];
    cdpCallTimeout?: number;
    maxReconnectAttempts?: number;
    reconnectDelayMs?: number;
}

export interface CdpContext {
    id: number;
    name: string;
    url: string;
    auxData?: { frameId?: string; type?: string; isDefault?: boolean };
}

export interface InjectResult {
    ok: boolean;
    method?: string;
    contextId?: number;
    cascadeId?: string;
    error?: string;
}

export interface UiSyncResult {
    ok: boolean;
    mode?: string;
    model?: string;
    error?: string;
}

interface CdpTargetInfo {
    id?: string;
    type?: string;
    title?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
}

interface WorkbenchTargetInfo extends CdpTargetInfo {
    webSocketDebuggerUrl: string;
}

interface RuntimeExecutionContextCreatedEvent {
    context?: CdpContext;
}

interface RuntimeExecutionContextDestroyedEvent {
    executionContextId?: number;
}

interface RuntimeEvaluateResult<T> {
    result?: {
        value?: T;
    };
}

interface DomDocumentResult {
    root: {
        nodeId: number;
    };
}

interface DomQuerySelectorResult {
    nodeId: number;
}

const RECENT_CASCADE_PROPAGATION_GRACE_MS = 15_000;

export class CdpService extends EventEmitter {
    private ports: number[];
    private isConnectedFlag = false;
    private connection: CdpConnection | null = null;
    private contexts: CdpContext[] = [];
    private lsClientManager = new LsClientManager();
    private cachedCascadeId: string | null = null;
    private recentCreatedCascadeId: string | null = null;
    private recentCreatedCascadeAt = 0;
    private idCounter = 1;
    private cdpCallTimeout = 30000;
    private targetUrl: string | null = null;
    private targetFrameId: string | null = null;
    private networkSniffHandler: ((params: Record<string, unknown>) => void) | null = null;
    private maxReconnectAttempts: number;
    private readonly originalMaxReconnectAttempts: number;
    private reconnectDelayMs: number;
    private reconnectAttemptCount = 0;
    private isReconnecting = false;
    private currentWorkspaceName: string | null = null;
    private currentWorkspacePath: string | null = null;
    private isSwitchingWorkspace = false;

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
    public isWorkbenchPage(t: CdpTargetInfo): t is WorkbenchTargetInfo {
        return (
            t.type === 'page' &&
            !!t.webSocketDebuggerUrl &&
            !(t.title as string | undefined)?.includes('Launchpad') &&
            !(t.url as string | undefined)?.includes('workbench-jetski-agent') &&
            !!(t.url as string | undefined)?.includes('workbench')
        );
    }

    async discoverTarget(): Promise<string> {
        const pages = await this.listPagesAcrossPorts();
        const matches = (t: CdpTargetInfo) =>
            (t.url?.includes('workbench') || t.title?.includes('Antigravity') || t.title?.includes('Cascade'))
            && !t.title?.includes('Launchpad');
        const target = pages.find(t => t.type === 'page' && t.webSocketDebuggerUrl && matches(t))
            ?? pages.find(t => t.webSocketDebuggerUrl && matches(t))
            ?? pages.find(t => t.webSocketDebuggerUrl && (matches(t) || t.title?.includes('Launchpad')));

        if (target?.webSocketDebuggerUrl) {
            this.targetUrl = target.webSocketDebuggerUrl;
            this.targetFrameId = target.id || null;
            if (target.title && !this.currentWorkspaceName) this.currentWorkspaceName = String(target.title).split(/ \s[—–-] \s/)[0].trim();
            return this.targetUrl!;
        }
        throw new Error('CDP target not found.');
    }

    async connect(): Promise<void> {
        if (!this.targetUrl) await this.discoverTarget();
        this.connection = new CdpConnection(this.targetUrl!, this.cdpCallTimeout);
        this.connection.on('disconnected', () => {
            this.isConnectedFlag = false; this.connection = null; this.targetUrl = null;
            if (!this.isSwitchingWorkspace) { this.emit('disconnected'); if (this.maxReconnectAttempts > 0 && !this.isReconnecting) this.tryReconnect(); }
        });
        const orig = this.connection.emit.bind(this.connection);
        this.connection.emit = (ev: string | symbol, ...args: unknown[]) => {
            if (ev === 'Runtime.executionContextCreated') {
                const ctx = (args[0] as RuntimeExecutionContextCreatedEvent | undefined)?.context;
                if (ctx) this.contexts.push({ ...ctx, url: ctx.url || '' });
            } else if (ev === 'Runtime.executionContextDestroyed') {
                const id = (args[0] as RuntimeExecutionContextDestroyedEvent | undefined)?.executionContextId;
                const idx = this.contexts.findIndex(c => c.id === id);
                if (idx !== -1) this.contexts.splice(idx, 1);
            } else if (ev !== 'disconnected') this.emit(ev, ...args);
            return orig(ev, ...args);
        };
        await this.connection.connect();
        this.isConnectedFlag = true;
        await this.call('Runtime.enable', {});
    }
    async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
        if (!this.connection?.isConnected()) throw new Error('WebSocket is not connected');
        return this.connection.call(method, params) as Promise<T>;
    }

    async callWithRetry<T = unknown>(method: string, params: unknown = {}, timeoutMs = 15000): Promise<T> {
        try { return await this.call(method, params); }
        catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            if (m !== 'WebSocket is not connected' && m !== 'WebSocket disconnected') throw e;
            await this.reconnectOnDemand(timeoutMs);
            return this.call(method, params);
        }
    }

    async disconnect(): Promise<void> {
        if (this.connection) { this.connection.removeAllListeners(); this.connection.disconnect(); this.connection = null; }
        this.isConnectedFlag = false; this.contexts = []; this.currentWorkspacePath = this.currentWorkspaceName = this.targetFrameId = null;
        this.lsClientManager.reset();
        this.cachedCascadeId = this.recentCreatedCascadeId = null; this.recentCreatedCascadeAt = 0;
        this.maxReconnectAttempts = this.originalMaxReconnectAttempts;
    }

    getCurrentWorkspaceName(): string | null { return this.currentWorkspaceName; }

    async discoverAndConnectForWorkspace(workspacePath: string): Promise<boolean> {
        const projectName = extractProjectNameFromPath(workspacePath);
        this.currentWorkspacePath = workspacePath;
        if (this.isConnectedFlag && this.currentWorkspaceName === projectName) {
            if (await this.verifyCurrentWorkspace(projectName, workspacePath)) return true;
        }
        this.isSwitchingWorkspace = true;
        try { return await this._discoverAndConnectForWorkspaceImpl(workspacePath, projectName); }
        finally { this.isSwitchingWorkspace = false; }
    }

    private async verifyCurrentWorkspace(projectName: string, workspacePath: string): Promise<boolean> {
        if (!this.connection?.isConnected()) return false;
        try {
            const title = await this.evaluateRuntime<string>('document.title');
            if (String(title || '').toLowerCase().includes(projectName.toLowerCase())) { this.currentWorkspaceName = projectName; return true; }
        } catch { /**/ }
        return this.probeWorkspaceFolderPath(projectName, workspacePath);
    }

    private async _discoverAndConnectForWorkspaceImpl(workspacePath: string, projectName: string): Promise<boolean> {
        const pages = await this.listPagesAcrossPorts();
        if (pages.length === 0) throw new Error('CDP ports not responding.');

        const wb = pages.filter(t => this.isWorkbenchPage(t));
        const matched = wb.find(t => t.title?.includes(projectName));
        if (matched) return this.connectToPage(matched, projectName);

        if (await this.probeWorkbenchPages(wb, projectName, workspacePath)) return true;

        if (wb.length === 1) {
            const t = String(wb[0].title || '').trim();
            if (!t || t.includes('Untitled') || t.toLowerCase().includes(projectName.toLowerCase())) return this.connectToPage(wb[0], projectName);
        } else if (wb.length > 1) {
            const untitled = wb.find(t => !t.title || t.title.includes('Untitled'));
            if (untitled) return this.connectToPage(untitled, projectName);
        }
        return WorkspaceLauncher.launchAndConnectWorkspace(this, workspacePath, projectName, this.ports);
    }

    private async listPagesAcrossPorts(): Promise<CdpTargetInfo[]> {
        const pages: CdpTargetInfo[] = [];
        for (const port of this.ports) {
            try {
                pages.push(...await this.getJson(`http://127.0.0.1:${port}/json/list`) as CdpTargetInfo[]);
            } catch {
                /**/
            }
        }
        return pages;
    }

    async connectToPage(page: WorkbenchTargetInfo, projectName: string): Promise<boolean> {
        if (this.isConnectedFlag && this.targetUrl === page.webSocketDebuggerUrl) { this.currentWorkspaceName = projectName; return true; }
        this.disconnectQuietly();
        this.lsClientManager.reset();
        this.targetUrl = page.webSocketDebuggerUrl; this.targetFrameId = page.id ?? null;
        await this.connect();
        this.currentWorkspaceName = projectName;
        return true;
    }

    async probeWorkbenchPages(wb: WorkbenchTargetInfo[], projectName: string, workspacePath?: string): Promise<boolean> {
        for (const p of wb) {
            try {
                this.disconnectQuietly(); this.targetUrl = p.webSocketDebuggerUrl; await this.connect();
                const title = String(await this.evaluateRuntime<string>('document.title') || '').toLowerCase();
                if (title.includes(projectName.toLowerCase()) || (title.includes('untitled') && workspacePath && await this.probeWorkspaceFolderPath(projectName, workspacePath))) {
                    this.currentWorkspaceName = projectName; return true;
                }
            } catch { /**/ }
        }
        this.disconnectQuietly(); return false;
    }

    private async probeWorkspaceFolderPath(projectName: string, workspacePath: string): Promise<boolean> {
        try {
            const script = `(() => {
                const getItems = (s) => Array.from(document.querySelectorAll(s)).map(e => e.textContent?.trim()).filter(Boolean);
                return { val: [document.querySelector('title')?.textContent || "", ...getItems('.breadcrumbs-view .folder-icon, .tabs-breadcrumbs .label-name'), ...getItems('.explorer-item-label, .monaco-icon-label .label-name'), document.body?.getAttribute('data-uri') || ''].join('|') };
            })()`;
            const result = await this.evaluateRuntime<{ val?: string }>(script);
            const val = String(result?.val || '').toLowerCase();
            if (val.includes(projectName.toLowerCase()) || val.includes(workspacePath.toLowerCase())) { this.currentWorkspaceName = projectName; return true; }
        } catch { /**/ }
        return false;
    }

    private disconnectQuietly(): void {
        if (this.connection) { this.connection.disconnectQuietly(); this.connection = null; this.isConnectedFlag = false; this.contexts = []; this.targetUrl = this.targetFrameId = null; }
    }

    private async tryReconnect(): Promise<void> {
        if (this.isReconnecting) return;
        this.isReconnecting = true; this.reconnectAttemptCount = 0;
        while (this.reconnectAttemptCount < this.maxReconnectAttempts) {
            this.reconnectAttemptCount++;
            await new Promise(r => setTimeout(r, this.reconnectDelayMs));
            try {
                this.contexts = [];
                if (this.currentWorkspacePath) await this.discoverAndConnectForWorkspace(this.currentWorkspacePath);
                else { await this.discoverTarget(); await this.connect(); }
                this.isReconnecting = false; this.emit('reconnected'); return;
            } catch { /**/ }
        }
        this.isReconnecting = false;
        this.emit('reconnectFailed', new Error(`CDP retry failed ${this.maxReconnectAttempts} times.`));
    }

    private reconnectOnDemandPromise: Promise<void> | null = null;
    private async reconnectOnDemand(timeoutMs = 15000): Promise<void> {
        if (this.isReconnecting) return new Promise((resolve, reject) => {
            const t = setTimeout(() => { c(); reject(new Error('WebSocket timeout')); }, timeoutMs);
            const ok = () => { c(); resolve(); }, fail = () => { c(); reject(new Error('WebSocket failed')); };
            const c = () => { clearTimeout(t); this.off('reconnected', ok); this.off('reconnectFailed', fail); };
            this.once('reconnected', ok); this.once('reconnectFailed', fail);
        });
        if (!this.currentWorkspacePath) throw new Error('WebSocket is not connected');
        if (!this.reconnectOnDemandPromise) {
            this.reconnectOnDemandPromise = this.discoverAndConnectForWorkspace(this.currentWorkspacePath).then(() => {}).finally(() => { this.reconnectOnDemandPromise = null; });
        }
        await Promise.race([this.reconnectOnDemandPromise, new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), timeoutMs))]);
    }

    isConnected(): boolean { return this.isConnectedFlag; }
    getTargetUrl(): string | null { return this.targetUrl; }
    getContexts(): CdpContext[] { return [...this.contexts]; }

    async waitForCascadePanelReady(timeoutMs = 10000): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if ((await this.getLSClient())?.isReady()) return true;
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    }

    getPrimaryContextId(): number | null {
        const u = (p: string) => this.contexts.find(c => c.url?.includes(p));
        const ctx = u('cascade-panel');
        if (ctx) return ctx.id;
        if (this.targetFrameId) {
            const f = this.contexts.find(c => c.auxData?.frameId === this.targetFrameId && (c.auxData?.isDefault || c.auxData?.type === 'default'))
                ?? this.contexts.find(c => c.auxData?.frameId === this.targetFrameId);
            if (f) return f.id;
        }
        return u('Extension')?.id ?? (this.contexts[0]?.id || null);
    }

    private async attachImageFiles(filePaths: string[], contextId?: number): Promise<{ ok: boolean; error?: string }> {
        if (filePaths.length === 0) return { ok: true };
        await this.call('DOM.enable', {});
        const s = `(async () => {
            const wait = (ms) => new Promise(r => setTimeout(r, ms));
            const has = (i) => { const a = (i.getAttribute('accept') || '').toLowerCase(); return !a || a.includes('image') || a.includes('*/*'); };
            const find = () => Array.from(document.querySelectorAll('input[type="file"]')).find(i => i.offsetParent !== null && has(i));
            let input = find();
            if (!input) {
                const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => b.offsetParent !== null).slice(-8);
                for (const b of btns) { b.click(); await wait(150); input = find(); if (input) break; }
            }
            if (!input) return { ok: false };
            const t = 'ag-' + Math.random().toString(36).slice(2); input.setAttribute('data-ag', t); return { ok: true, token: t };
        })()`;
        const result = await this.evaluateRuntime<{ ok?: boolean; token?: string }>(s, { awaitPromise: true, contextId });
        if (!result?.ok || !result.token) return { ok: false, error: 'Input not found' };
        const { root } = await this.call<DomDocumentResult>('DOM.getDocument', { depth: 1, pierce: true });
        const { nodeId } = await this.call<DomQuerySelectorResult>('DOM.querySelector', { nodeId: root.nodeId, selector: `input[data-ag="${result.token}"]` });
        await this.call('DOM.setFileInputFiles', { nodeId, files: filePaths });
        return { ok: true };
    }

    async getLSClient(): Promise<GrpcCascadeClient | null> {
        const client = await this.lsClientManager.getClient(this.currentWorkspacePath, async (expr: string) => {
            return this.evaluateRuntime(expr, { awaitPromise: true, timeout: 10000 });
        });
        if (client) client.setCdpEvaluate(expr => this.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 10000 }));
        return client;
    }

    private async evaluateRuntime<T>(
        expression: string,
        options: { awaitPromise?: boolean; contextId?: number; timeout?: number } = {},
    ): Promise<T | undefined> {
        const result = await this.call<RuntimeEvaluateResult<T>>('Runtime.evaluate', {
            expression,
            returnByValue: true,
            ...options,
        });
        return result?.result?.value;
    }

    /** Public alias used by higher-level bot/runtime flows. */
    async getGrpcClient(): Promise<GrpcCascadeClient | null> { return this.getLSClient(); }

    /** Unified cascade send: resolves cascade ID, sends text + optional media. */
    private async sendToCascade(text: string, media?: MediaItem[], overrideCascadeId?: string): Promise<InjectResult> {
        const client = await this.getLSClient();
        if (!client) return { ok: false, error: this.lsClientManager.lastLSUnavailableReason || 'LS client unavailable' };

        const cascadeId = overrideCascadeId || this.cachedCascadeId;
        const modelId = await this.resolveSelectedModelId();
        const mediaArg = media && media.length > 0 ? media : undefined;

        if (cascadeId) {
            // Check if cascade is running (informational)
            try {
                const traj = await client.rawRPC('GetCascadeTrajectory', { cascadeId });
                if (extractCascadeRunStatus(traj) === 'CASCADE_RUN_STATUS_RUNNING')
                    logger.info(`[CdpService] cascade ${cascadeId.slice(0, 16)}... running; queueing turn`);
            } catch { /* non-fatal */ }

            logger.info(`[CdpService] sendToCascade: cascade=${cascadeId.slice(0, 16)}... model=${modelId || 'default'}`);
            const result = await client.sendMessage(cascadeId, text, modelId || undefined, mediaArg);
            if (result.ok) return { ok: true, method: 'ls-api', cascadeId };
            logger.warn(`[CdpService] sendMessage failed: ${result.error}`);
            return { ok: false, error: result.error || 'LS send failed', cascadeId };
        }

        // Create new cascade
        logger.info(`[CdpService] sendToCascade: creating new cascade model=${modelId || 'default'}`);
        const newId = mediaArg
            ? await client.createCascade(undefined, modelId || undefined)
            : await client.createCascade(text, modelId || undefined);

        if (newId) {
            this.rememberCreatedCascade(newId);
            if (mediaArg) {
                const sendResult = await client.sendMessage(newId, text, modelId || undefined, mediaArg);
                if (sendResult.ok) return { ok: true, method: 'ls-api', cascadeId: newId };
                return { ok: false, error: sendResult.error || 'LS send failed', cascadeId: newId };
            }
            return { ok: true, method: 'ls-api', cascadeId: newId };
        }

        const err = client.getLastOperationError?.() || 'LS client injection failed';
        logger.error(`[CdpService] createCascade returned null: ${err}`);
        return { ok: false, error: err };
    }

    async injectMessage(text: string, overrideCascadeId?: string): Promise<InjectResult> {
        return this.sendToCascade(text, undefined, overrideCascadeId);
    }

    private static readonly MIME_MAP: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    };

    async injectMessageWithImageFiles(text: string, imageFilePaths: string[], overrideCascadeId?: string): Promise<InjectResult> {
        const [fsP, pathMod] = await Promise.all([import('fs/promises'), import('path')]);
        const mediaItems: MediaItem[] = [];
        for (const fp of imageFilePaths) {
            try {
                const data = await fsP.readFile(fp);
                if (data.length === 0) continue;
                const ext = pathMod.extname(fp).toLowerCase();
                const mimeType = CdpService.MIME_MAP[ext] || 'image/png';
                mediaItems.push({ mimeType, inlineData: data.toString('base64') });
                logger.info(`[CdpService] Prepared media: ${pathMod.basename(fp)} (${mimeType}, ${Math.round(data.length / 1024)}KB)`);
            } catch (e: unknown) {
                logger.warn(`[CdpService] Failed to read image ${fp}: ${e instanceof Error ? e.message : e}`);
            }
        }
        return this.sendToCascade(text, mediaItems, overrideCascadeId);
    }

    // ─── Mode / Model ───────────────────────────────────────────────────

    private cachedModeName: string = 'fast';
    private cachedModelLabel: string | null = null;
    private cachedModelConfigs: Array<{ label: string; model: string; supportsImages?: boolean }> = [];

    private extractModelIdentifier(config: Record<string, unknown>): string {
        const cfg = config || {};
        const modelOrAlias = cfg.modelOrAlias as Record<string, unknown> | undefined;
        const requestedModel = cfg.requestedModel as Record<string, unknown> | undefined;
        const direct =
            (modelOrAlias?.model as string | undefined) ?? (modelOrAlias?.alias as string | undefined)
            ?? (cfg.model as string | undefined) ?? (cfg.modelId as string | undefined)
            ?? ((requestedModel?.choice as Record<string, unknown>)?.value as string | undefined)
            ?? (requestedModel?.value as string | undefined);
        if (direct != null && String(direct).trim()) return String(direct);

        const nestedChoice = (modelOrAlias?.choice as Record<string, unknown> | undefined) ?? modelOrAlias;
        const ncv = nestedChoice?.value as Record<string, unknown> | undefined;
        const nested = (ncv?.model as string | undefined) ?? (ncv?.alias as string | undefined) ?? (nestedChoice as unknown as string | undefined);
        if (nested != null && String(nested).trim()) return String(nested);
        return 'unknown';
    }

    /** Parse raw LS API model configs into our internal format. */
    private parseModelConfigs(rawConfigs: Record<string, unknown>[]): typeof this.cachedModelConfigs {
        return rawConfigs.map(cfg => ({
            label: (cfg.label as string) || (cfg.displayName as string) || (cfg.modelName as string) || (cfg.model as string) || 'Unknown',
            model: String(this.extractModelIdentifier(cfg)),
            supportsImages: !!cfg.supportsImages,
        }));
    }

    /** Fetch and cache model configs from LS API. */
    private async refreshModelConfigs(): Promise<void> {
        try {
            const client = await this.getLSClient();
            if (!client) return;
            const status = await client.getUserStatus() as { userStatus?: { cascadeModelConfigData?: { clientModelConfigs?: Record<string, unknown>[] } } };
            const configs = status?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
            if (configs.length > 0) this.cachedModelConfigs = this.parseModelConfigs(configs);
        } catch (err: unknown) {
            logger.debug(`[CdpService] refreshModelConfigs failed: ${err instanceof Error ? err.message : err}`);
        }
    }

    private async ensureModelConfigs(): Promise<void> {
        if (this.cachedModelConfigs.length === 0) await this.refreshModelConfigs();
    }

    private normalizeModelLabel(label: string): string {
        return label.toLowerCase().replace(/\s+/g, ' ').replace(/[()]/g, '').trim();
    }

    private findModelConfigByLabel(modelName: string | null): { label: string; model: string; supportsImages?: boolean } | null {
        if (!modelName) return null;
        const normalized = this.normalizeModelLabel(modelName);
        return this.cachedModelConfigs.find(c => this.normalizeModelLabel(c.label) === normalized)
            ?? this.cachedModelConfigs.find(c => {
                const candidate = this.normalizeModelLabel(c.label);
                const nParts = normalized.split(' '), cParts = candidate.split(' ');
                return nParts.every(p => candidate.includes(p)) || cParts.every(p => normalized.includes(p))
                    || candidate.includes(normalized) || normalized.includes(candidate);
            }) ?? null;
    }

    private static toModelId(modelStr: string): ModelId { const n = parseInt(modelStr, 10); return isNaN(n) ? modelStr : n; }

    /** Match cached label against config list, updating cachedModelLabel if found. */
    private matchAndUpdateLabel(label: string): void {
        const matched = this.findModelConfigByLabel(label);
        if (matched) this.cachedModelLabel = matched.label;
    }

    async getCurrentMode(): Promise<string | null> { return this.cachedModeName; }

    async setUiMode(modeName: string): Promise<UiSyncResult> {
        const normalized = modeName.toLowerCase();
        if (normalized !== 'fast' && normalized !== 'plan') return { ok: false, error: `Unknown mode: ${modeName}. Use 'fast' or 'plan'.` };
        this.cachedModeName = normalized;
        logger.info(`[CdpService] Mode set to '${normalized}'`);
        return { ok: true, mode: normalized };
    }

    async getUiModels(): Promise<string[]> {
        try {
            const client = await this.getLSClient();
            if (!client) return [];
            const status = await client.getUserStatus() as { userStatus?: { cascadeModelConfigData?: { clientModelConfigs?: Record<string, unknown>[] } } };
            this.cachedModelConfigs = this.parseModelConfigs(status?.userStatus?.cascadeModelConfigData?.clientModelConfigs || []);
            return this.cachedModelConfigs.map(c => c.label);
        } catch (err: unknown) {
            logger.error('[CdpService] getUiModels failed:', err instanceof Error ? err.message : err);
            return [];
        }
    }

    async getCurrentModel(): Promise<string | null> {
        if (this.cachedModelLabel) {
            await this.ensureModelConfigs();
            this.matchAndUpdateLabel(this.cachedModelLabel);
            return this.cachedModelLabel;
        }
        const uiModel = await this.readModelFromUI();
        if (uiModel) {
            this.cachedModelLabel = uiModel;
            await this.ensureModelConfigs();
            this.matchAndUpdateLabel(uiModel);
            return this.cachedModelLabel;
        }
        await this.refreshModelConfigs();
        return this.cachedModelLabel;
    }

    private async readModelFromUI(): Promise<string | null> {
        if (!this.connection?.isConnected()) return null;
        const script = `(() => {
            const kw = ['Claude', 'Gemini', 'GPT', 'Opus', 'Sonnet', 'Flash', 'Pro', 'Thinking'];
            for (const btn of document.querySelectorAll('div[role="button"]')) {
                const t = btn.textContent?.trim();
                if (t && t.length <= 60 && kw.some(k => t.includes(k))) return t;
            }
            return null;
        })()`;
        for (const ctx of this.contexts) {
            try {
                const res = await this.call('Runtime.evaluate', { expression: script, returnByValue: true, contextId: ctx.id }) as { result?: { value?: unknown } };
                if (typeof res?.result?.value === 'string' && res.result.value.length > 0) return res.result.value;
            } catch { /* next context */ }
        }
        return null;
    }

    private async resolveSelectedModelId(): Promise<ModelId | null> {
        await this.ensureModelConfigs();
        let found = this.findModelConfigByLabel(this.cachedModelLabel);
        if (!found) {
            const uiModel = await this.readModelFromUI();
            if (uiModel) { this.cachedModelLabel = uiModel; await this.ensureModelConfigs(); found = this.findModelConfigByLabel(uiModel); }
        }
        if (!found || found.model === 'unknown') {
            const fallback = this.cachedModelConfigs.find(c => c.model !== 'unknown');
            if (fallback) { this.cachedModelLabel = fallback.label; return CdpService.toModelId(fallback.model); }
            return null;
        }
        this.cachedModelLabel = found.label;
        return CdpService.toModelId(found.model);
    }

    async setUiModel(modelName: string): Promise<UiSyncResult> {
        await this.ensureModelConfigs();
        if (this.cachedModelConfigs.length === 0) await this.getUiModels();
        const found = this.findModelConfigByLabel(modelName);
        if (found) { this.cachedModelLabel = found.label; return { ok: true, model: found.label }; }
        return { ok: false, error: `Model "${modelName}" not found. Available: ${this.cachedModelConfigs.map(c => c.label).join(', ')}` };
    }

    getSelectedModelId(): ModelId | null {
        const found = this.findModelConfigByLabel(this.cachedModelLabel);
        if (!found || found.model === 'unknown') return null;
        this.cachedModelLabel = found.label;
        return CdpService.toModelId(found.model);
    }

    getPlannerTypeForCurrentMode(): string {
        return this.cachedModeName === 'plan' ? 'normal' : 'conversational';
    }

    // ─── VS Code Command Execution (via CDP) ───────────────────────────

    async executeVscodeCommand(command: string, ...args: unknown[]): Promise<unknown> {
        const script = `(async () => {
            try {
                if (typeof acquireVsCodeApi !== 'undefined') {
                    const vscode = acquireVsCodeApi();
                    vscode.postMessage({ type: 'executeCommand', command: ${JSON.stringify(command)}, args: ${JSON.stringify(args)} });
                    return { ok: true, method: 'vscodeApi' };
                }
                return { ok: false, error: 'No VS Code API available' };
            } catch (e) { return { ok: false, error: e.message || String(e) }; }
        })()`;
        for (const ctx of this.contexts) {
            try {
                const res = await this.call('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true, contextId: ctx.id }) as { result?: { value?: { ok?: boolean } } };
                if (res?.result?.value?.ok) return res.result.value;
            } catch { /* next context */ }
        }
        return { ok: false, error: 'Command execution failed in all contexts' };
    }

    // ─── Session Info ──────────────────────────────────────────────────

    async getActiveSessionInfo(): Promise<{ id: string; title: string; summary: string } | null> {
        try {
            const client = await this.getLSClient();
            if (!client) return null;
            const summaries = await client.listCascades() as Record<string, unknown>;
            if (!summaries || typeof summaries !== 'object') return null;

            const toInfo = (id: string, s?: Record<string, unknown>) => ({
                id,
                title: (s?.title as string) || (s?.summary as string) || 'Untitled Session',
                summary: (s?.summary as string) || '',
            });

            // Filter by workspace
            const ws: Record<string, Record<string, unknown>> = {};
            for (const [id, s] of Object.entries(summaries as Record<string, unknown>))
                if (this.isCascadeInWorkspace(s as Record<string, unknown>)) ws[id] = s as Record<string, unknown>;

            if (this.cachedCascadeId && ws[this.cachedCascadeId]) return toInfo(this.cachedCascadeId, ws[this.cachedCascadeId]);

            // Grace period for newly created cascades
            if (this.cachedCascadeId && this.cachedCascadeId === this.recentCreatedCascadeId
                && (Date.now() - this.recentCreatedCascadeAt) <= RECENT_CASCADE_PROPAGATION_GRACE_MS) {
                return { id: this.cachedCascadeId, title: 'Current Session', summary: '' };
            }

            // Most recently modified cascade in this workspace
            let latestId: string | null = null, latestTime = 0;
            for (const [id, s] of Object.entries(ws)) {
                const ts = s.lastModifiedTimestamp || s.lastModifiedTime;
                const t = ts ? new Date(String(ts)).getTime() : 0;
                if (t > latestTime) { latestTime = t; latestId = id; }
            }
            if (latestId) { this.cachedCascadeId = latestId; return toInfo(latestId, ws[latestId]); }

            // Workspace-bound: don't fallback to foreign cascades
            if (this.currentWorkspacePath) return null;

            // Global fallback
            const ids = Object.keys(summaries as Record<string, unknown>);
            if (ids.length > 0) { this.cachedCascadeId = ids[0]; return toInfo(ids[0], (summaries as Record<string, unknown>)[ids[0]] as Record<string, unknown> | undefined); }
        } catch (err: unknown) {
            logger.debug(`[CdpService] getActiveSessionInfo failed: ${err instanceof Error ? err.message : err}`);
        }
        return null;
    }

    async getActiveCascadeId(): Promise<string | null> { return (await this.getActiveSessionInfo())?.id || null; }

    setCachedCascadeId(id: string | null): void {
        this.cachedCascadeId = id;
        if (!id) { this.recentCreatedCascadeId = null; this.recentCreatedCascadeAt = 0; }
    }

    rememberCreatedCascade(id: string): void {
        this.cachedCascadeId = id;
        this.recentCreatedCascadeId = id;
        this.recentCreatedCascadeAt = Date.now();
    }

    // ─── Gateway Restart ─────────────────────────────────────────────

    async resetGateway(): Promise<{ ok: boolean; steps: string[]; error?: string }> {
        const steps: string[] = [];
        try {
            const lsClient = await this.getLSClient();
            if (this.cachedCascadeId && lsClient?.isReady()) {
                try { await lsClient.cancelCascade(this.cachedCascadeId); steps.push(`Cancelled cascade ${this.cachedCascadeId.slice(0, 12)}...`); }
                catch (e: unknown) { steps.push(`Cascade cancel skipped: ${e instanceof Error ? e.message : 'already ended'}`); }
            } else { steps.push('No active cascade to cancel'); }

            this.lsClientManager.reset();
            steps.push('LS client reset');

            this.cachedCascadeId = null; this.recentCreatedCascadeId = null; this.recentCreatedCascadeAt = 0;
            this.cachedModelLabel = null; this.cachedModelConfigs = [];
            steps.push('Cached state cleared');

            if (this.currentWorkspacePath) {
                try { this.disconnectQuietly(); await this.discoverAndConnectForWorkspace(this.currentWorkspacePath); steps.push(`CDP reconnected to "${this.currentWorkspaceName || 'unknown'}"`); }
                catch (e: unknown) { steps.push(`CDP reconnect warning: ${e instanceof Error ? e.message : 'failed'}`); }
            } else { steps.push('CDP: no workspace path (skipped reconnect)'); }

            try {
                const client = await this.getLSClient();
                steps.push(client?.isReady() ? 'LS client re-established' : 'LS client null (will retry)');
            } catch (e: unknown) { steps.push(`LS re-discovery warning: ${e instanceof Error ? e.message : 'failed'}`); }

            logger.info(`[CdpService] Gateway restart completed: ${steps.length} steps`);
            return { ok: true, steps };
        } catch (err: unknown) {
            const error = err instanceof Error ? err.message : String(err);
            logger.error(`[CdpService] Gateway restart failed: ${error}`);
            return { ok: false, steps, error };
        }
    }

    public isCascadeInWorkspace(summary: Record<string, unknown>): boolean {
        if (!this.currentWorkspacePath) return true;
        if (!summary?.workspaces || !Array.isArray(summary.workspaces)) return false;
        const target = this.currentWorkspacePath.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
        for (const ws of summary.workspaces) {
            if (!ws.workspaceFolderAbsoluteUri) continue;
            let p = ws.workspaceFolderAbsoluteUri.replace(/^file:\/\//i, '');
            if (p.match(/^\/[a-zA-Z]:/)) p = p.substring(1);
            const local = decodeURIComponent(p).replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
            if (local === target) return true;
        }
        return false;
    }
}
