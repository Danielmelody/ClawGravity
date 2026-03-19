import { Effect } from 'effect';
import { logger } from '../utils/logger';
import { ApprovalDetector } from './approvalDetector';
import {
    CdpService,
    CdpServiceOptions,
    InjectResult,
    UiSyncResult,
} from './cdpService';
import {
    ChatSessionService,
    ConversationHistoryEntry,
    SessionListItem,
} from './chatSessionService';
import { ErrorPopupDetector } from './errorPopupDetector';
import { PlanningDetector } from './planningDetector';
import { RunCommandDetector } from './runCommandDetector';
import { TrajectoryStreamRouter } from './trajectoryStreamRouter';
import { UserMessageDetector, UserMessageInfo } from './userMessageDetector';

/** Common interface for stoppable detectors / routers */
interface Stoppable {
    isActive(): boolean;
    stop(): void | Promise<void>;
}

/** Well-known detector type keys */
export type DetectorType =
    | 'approval'
    | 'errorPopup'
    | 'planning'
    | 'runCommand'
    | 'userMessage'
    | 'streamRouter';

export interface WorkspaceRuntimeOptions {
    readonly projectName: string;
    readonly workspacePath: string;
    readonly cdpOptions?: CdpServiceOptions;
    readonly onReconnectFailed?: () => void;
}

type UserMessageSink = (info: UserMessageInfo) => void | Promise<void>;

export interface WorkspaceSendPromptOptions {
    readonly text: string;
    readonly overrideCascadeId?: string;
    readonly imageFilePaths?: readonly string[];
    readonly echoText?: string;
}

export interface WorkspaceMonitoringTarget {
    readonly grpcClient: NonNullable<Awaited<ReturnType<CdpService['getGrpcClient']>>>;
    readonly cascadeId: string;
}

export interface WorkspaceSendPromptResult {
    readonly injectResult: InjectResult;
    readonly monitoringTarget: WorkspaceMonitoringTarget | null;
}

export interface WorkspaceActiveSessionInfo {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
}

export class WorkspaceRuntime {
    private readonly projectName: string;
    private readonly workspacePath: string;
    private readonly cdp: CdpService;
    private readonly onReconnectFailed?: () => void;

    private connectPromise: Promise<CdpService> | null = null;

    /** Effect Semaphore replaces the hand-rolled operationTail chain */
    private readonly mutex = Effect.unsafeMakeSemaphore(1);

    /** Generic detector/router registry */
    private readonly detectors = new Map<string, Stoppable>();
    private selectedCascadeId: string | null = null;
    private activeSessionInfo: WorkspaceActiveSessionInfo | null = null;
    private readonly userMessageSinks = new Map<string, UserMessageSink>();

    constructor(options: WorkspaceRuntimeOptions) {
        this.projectName = options.projectName;
        this.workspacePath = options.workspacePath;
        this.cdp = new CdpService(options.cdpOptions);
        this.onReconnectFailed = options.onReconnectFailed;

        this.cdp.on('disconnected', () => {
            logger.error(`[WorkspaceRuntime:${this.projectName}] disconnected`);
        });
        this.cdp.on('reconnectFailed', () => {
            logger.error(`[WorkspaceRuntime:${this.projectName}] reconnect failed`);
            this.onReconnectFailed?.();
        });
    }

    getProjectName(): string { return this.projectName; }
    getWorkspacePath(): string { return this.workspacePath; }

    getConnected(): CdpService | null {
        return this.cdp.isConnected() ? this.cdp : null;
    }

    getConnectedCdp(): CdpService | null { return this.getConnected(); }
    getCdpUnsafe(): CdpService { return this.cdp; }

    async getOrConnect(): Promise<CdpService> {
        if (this.cdp.isConnected()) {
            await this.cdp.discoverAndConnectForWorkspace(this.workspacePath);
            return this.cdp;
        }
        if (!this.connectPromise) {
            this.connectPromise = (async () => {
                await this.cdp.discoverAndConnectForWorkspace(this.workspacePath);
                return this.cdp;
            })().finally(() => { this.connectPromise = null; });
        }
        return this.connectPromise;
    }

    async ready(): Promise<CdpService> { return this.getOrConnect(); }

    async setActiveCascade(cascadeId: string | null): Promise<void> {
        this.rememberActiveCascade(cascadeId);
        await this.runExclusive(async (cdp) => { cdp.setCachedCascadeId(cascadeId); });
    }

    async clearActiveCascade(): Promise<void> { await this.setActiveCascade(null); }

    getSelectedCascadeId(): string | null { return this.selectedCascadeId; }
    hasSelectedCascade(): boolean { return !!this.selectedCascadeId; }

    async sendPrompt(options: WorkspaceSendPromptOptions): Promise<InjectResult> {
        return this.runExclusive(async (cdp) => this.sendPromptLocked(cdp, options));
    }

    async sendPromptWithMonitoringTarget(options: WorkspaceSendPromptOptions): Promise<WorkspaceSendPromptResult> {
        return this.runExclusive(async (cdp) => {
            const injectResult = await this.sendPromptLocked(cdp, options);
            if (!injectResult.ok) return { injectResult, monitoringTarget: null };
            const monitoringTarget = await this.resolveMonitoringTargetLocked(
                cdp, injectResult.cascadeId ?? options.overrideCascadeId ?? this.selectedCascadeId ?? null,
            );
            return { injectResult, monitoringTarget };
        });
    }

    async sendPromptWithImages(
        text: string, imageFilePaths: readonly string[],
        overrideCascadeId?: string, echoText?: string,
    ): Promise<InjectResult> {
        return this.sendPrompt({ text, imageFilePaths, overrideCascadeId, echoText });
    }

    async startNewChat(chatSessionService: ChatSessionService): Promise<{ ok: boolean; error?: string }> {
        return this.runExclusive(async (cdp) => {
            const grpcClient = await cdp.getGrpcClient();
            if (grpcClient?.createCascade) {
                try {
                    const cascadeId = await grpcClient.createCascade();
                    if (!cascadeId) return { ok: false, error: 'Failed to create cascade via gRPC' };
                    cdp.rememberCreatedCascade(cascadeId);
                    this.rememberActiveCascade(cascadeId);
                    return { ok: true };
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    return { ok: false, error: message };
                }
            }
            const result = await chatSessionService.startNewChat(cdp);
            if (result.ok) this.activeSessionInfo = null;
            return result;
        });
    }

    async activateSessionByTitle(chatSessionService: ChatSessionService, title: string): Promise<{ ok: boolean; error?: string }> {
        return this.runExclusive(async (cdp) => {
            const sessions = await chatSessionService.listAllSessions(cdp);
            const selectedSession = sessions.find((s) => s.title === title);
            const result = await chatSessionService.activateSessionByTitle(cdp, title);
            if (!result.ok) return result;

            if (selectedSession?.cascadeId) {
                cdp.setCachedCascadeId(selectedSession.cascadeId);
                this.rememberActiveCascade(selectedSession.cascadeId);
                return result;
            }
            this.activeSessionInfo = null;
            return result;
        });
    }

    async listAllSessions(chatSessionService: ChatSessionService): Promise<SessionListItem[]> {
        const cdp = await this.getOrConnect();
        return chatSessionService.listAllSessions(cdp);
    }

    async getConversationHistory(
        chatSessionService: ChatSessionService,
        options?: { maxMessages?: number; maxScrollSteps?: number; cascadeId?: string },
    ): Promise<{ messages: ConversationHistoryEntry[]; truncated: boolean }> {
        const cdp = await this.getOrConnect();
        return chatSessionService.getConversationHistory(cdp, options);
    }

    async syncUiMode(modeName: string): Promise<UiSyncResult> {
        return this.runExclusive(async (cdp) => cdp.setUiMode(modeName));
    }

    async getUiModels(): Promise<string[]> {
        const cdp = await this.getOrConnect();
        return cdp.getUiModels();
    }

    async setUiModel(modelName: string): Promise<UiSyncResult> {
        return this.runExclusive(async (cdp) => cdp.setUiModel(modelName));
    }

    async getCurrentModel(): Promise<string | null> {
        const cdp = await this.getOrConnect();
        return cdp.getCurrentModel();
    }

    async getActiveSessionInfo(): Promise<WorkspaceActiveSessionInfo | null> {
        if (this.activeSessionInfo) return this.activeSessionInfo;
        const cdp = await this.getOrConnect();
        const info = await cdp.getActiveSessionInfo();
        this.rememberActiveSessionInfo(info);
        return info;
    }

    async getActiveCascadeId(): Promise<string | null> {
        if (this.selectedCascadeId) return this.selectedCascadeId;
        const info = await this.getActiveSessionInfo();
        return info?.id || null;
    }

    async refreshActiveSessionInfo(): Promise<WorkspaceActiveSessionInfo | null> {
        const cdp = await this.getOrConnect();
        const info = await cdp.getActiveSessionInfo();
        this.rememberActiveSessionInfo(info);
        return info;
    }

    async resolveActiveCascadeId(preferredCascadeId?: string | null): Promise<string | null> {
        return preferredCascadeId || this.getActiveCascadeId();
    }

    async getMonitoringTarget(preferredCascadeId?: string | null): Promise<WorkspaceMonitoringTarget | null> {
        return this.runExclusive(async (cdp) => this.resolveMonitoringTargetLocked(cdp, preferredCascadeId ?? null));
    }

    /**
     * Serialize async operations on the CDP service.
     * Uses Effect.Semaphore(1) — replaces the manual Promise-chain mutex.
     */
    async runExclusive<T>(operation: (cdp: CdpService) => Promise<T>): Promise<T> {
        return Effect.runPromise(
            this.mutex.withPermits(1)(
                Effect.tryPromise({
                    try: async () => {
                        const cdp = await this.getOrConnect();
                        return await operation(cdp);
                    },
                    catch: (e) => e,
                }),
            ),
        ) as Promise<T>;
    }

    async runSerialized<T>(operation: (cdp: CdpService) => Promise<T>): Promise<T> {
        return this.runExclusive(operation);
    }

    // ─── Generic Detector Registry ─────────────────────────────────────

    registerDetector<T extends Stoppable>(type: DetectorType | string, detector: T): void {
        const existing = this.detectors.get(type);
        if (existing?.isActive()) void existing.stop();
        this.detectors.set(type, detector);
    }

    getDetector<T extends Stoppable>(type: DetectorType | string): T | undefined {
        return this.detectors.get(type) as T | undefined;
    }

    // ─── Named Detector Accessors (backward-compatible) ────────────────

    registerApprovalDetector(detector: ApprovalDetector): void { this.registerDetector('approval', detector); }
    getApprovalDetector(): ApprovalDetector | undefined { return this.getDetector<ApprovalDetector>('approval'); }

    registerErrorPopupDetector(detector: ErrorPopupDetector): void { this.registerDetector('errorPopup', detector); }
    getErrorPopupDetector(): ErrorPopupDetector | undefined { return this.getDetector<ErrorPopupDetector>('errorPopup'); }

    registerPlanningDetector(detector: PlanningDetector): void { this.registerDetector('planning', detector); }
    getPlanningDetector(): PlanningDetector | undefined { return this.getDetector<PlanningDetector>('planning'); }

    registerRunCommandDetector(detector: RunCommandDetector): void { this.registerDetector('runCommand', detector); }
    getRunCommandDetector(): RunCommandDetector | undefined { return this.getDetector<RunCommandDetector>('runCommand'); }

    registerUserMessageDetector(detector: UserMessageDetector): void { this.registerDetector('userMessage', detector); }
    getUserMessageDetector(): UserMessageDetector | undefined { return this.getDetector<UserMessageDetector>('userMessage'); }

    registerStreamRouter(router: TrajectoryStreamRouter): void { this.registerDetector('streamRouter', router); }
    getStreamRouter(): TrajectoryStreamRouter | undefined { return this.getDetector<TrajectoryStreamRouter>('streamRouter'); }

    // ─── User Message Sinks ────────────────────────────────────────────

    addUserMessageSink(sink: UserMessageSink): void;
    addUserMessageSink(sinkKey: string, sink: UserMessageSink): void;
    addUserMessageSink(sinkOrKey: string | UserMessageSink, sink?: UserMessageSink): void {
        if (typeof sinkOrKey === 'function') {
            this.userMessageSinks.set(`sink:${this.userMessageSinks.size + 1}`, sinkOrKey);
            return;
        }
        if (!sink) return;
        this.userMessageSinks.set(sinkOrKey, sink);
    }

    removeUserMessageSink(sinkKey: string): void { this.userMessageSinks.delete(sinkKey); }
    clearUserMessageSinks(): void { this.userMessageSinks.clear(); }
    hasUserMessageSinks(): boolean { return this.userMessageSinks.size > 0; }

    async dispatchUserMessage(info: UserMessageInfo): Promise<void> {
        for (const sink of this.userMessageSinks.values()) {
            try { await sink(info); }
            catch (error) { logger.error(`[WorkspaceRuntime:${this.projectName}] User message sink failed:`, error); }
        }
    }

    async disconnect(): Promise<void> {
        this.clearUserMessageSinks();
        for (const detector of this.detectors.values()) {
            try { await Promise.resolve(detector.stop()); } catch { /* cleanup */ }
        }
        this.detectors.clear();
        await this.cdp.disconnect();
    }

    // ─── Internal Helpers ──────────────────────────────────────────────

    private rememberPromptResult(result: InjectResult, requestedCascadeId: string | null): void {
        if (result.ok && result.cascadeId) { this.rememberActiveCascade(result.cascadeId); return; }
        if (result.ok && requestedCascadeId) { this.rememberActiveCascade(requestedCascadeId); }
    }

    private rememberActiveCascade(cascadeId: string | null): void {
        this.selectedCascadeId = cascadeId;
        if (!cascadeId || this.activeSessionInfo?.id !== cascadeId) this.activeSessionInfo = null;
        const streamRouter = this.getDetector<TrajectoryStreamRouter>('streamRouter');
        if (cascadeId && streamRouter?.isActive()) streamRouter.connectToCascade(cascadeId);
    }

    private rememberActiveSessionInfo(info: WorkspaceActiveSessionInfo | null): void {
        this.activeSessionInfo = info;
        this.selectedCascadeId = info?.id || null;
    }

    private async sendPromptLocked(cdp: CdpService, options: WorkspaceSendPromptOptions): Promise<InjectResult> {
        const targetCascadeId = options.overrideCascadeId ?? this.selectedCascadeId ?? null;
        if (targetCascadeId) cdp.setCachedCascadeId(targetCascadeId);

        const echoText = options.echoText ?? options.text;
        if (echoText.trim()) this.getDetector<UserMessageDetector>('userMessage')?.addEchoHash(echoText);

        if (options.imageFilePaths && options.imageFilePaths.length > 0) {
            const result = targetCascadeId
                ? await cdp.injectMessageWithImageFiles(options.text, [...options.imageFilePaths], targetCascadeId)
                : await cdp.injectMessageWithImageFiles(options.text, [...options.imageFilePaths]);
            this.rememberPromptResult(result, targetCascadeId);
            return result;
        }

        const result = targetCascadeId
            ? await cdp.injectMessage(options.text, targetCascadeId)
            : await cdp.injectMessage(options.text);
        this.rememberPromptResult(result, targetCascadeId);
        return result;
    }

    private async resolveMonitoringTargetLocked(cdp: CdpService, preferredCascadeId: string | null): Promise<WorkspaceMonitoringTarget | null> {
        const grpcClient = await cdp.getGrpcClient();
        if (!grpcClient) return null;
        const cascadeId = preferredCascadeId ?? this.selectedCascadeId ?? this.activeSessionInfo?.id ?? await cdp.getActiveCascadeId();
        if (!cascadeId) return null;
        return { grpcClient, cascadeId };
    }
}
