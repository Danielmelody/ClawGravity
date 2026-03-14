import { extractProjectNameFromPath } from '../utils/pathUtils';
import { CdpService, CdpServiceOptions } from './cdpService';
import { TrajectoryStreamRouter } from './trajectoryStreamRouter';
import { WorkspaceRuntime, DetectorType } from './workspaceRuntime';

/**
 * Pool that manages independent workspace runtimes.
 *
 * Each runtime owns the CdpService plus detector/router lifecycle for a
 * single workspace, while the pool is only a registry and lookup layer.
 *
 * Effect migration: removed boilerplate named-detector wrappers.
 * All detector access goes through the generic registerDetector/getDetector.
 */
export class CdpConnectionPool {
    private readonly runtimes = new Map<string, WorkspaceRuntime>();
    private readonly cdpOptions: CdpServiceOptions;

    constructor(cdpOptions: CdpServiceOptions = {}) {
        this.cdpOptions = cdpOptions;
    }

    async getOrConnect(workspacePath: string): Promise<CdpService> {
        return this.getOrCreateRuntime(workspacePath).getOrConnect();
    }

    getConnected(projectName: string): CdpService | null {
        return this.runtimes.get(projectName)?.getConnected() ?? null;
    }

    getOrCreateRuntime(workspacePath: string): WorkspaceRuntime {
        const projectName = this.extractProjectName(workspacePath);
        const existing = this.runtimes.get(projectName);
        if (existing) return existing;

        const runtime = new WorkspaceRuntime({
            projectName, workspacePath,
            cdpOptions: this.cdpOptions,
            onReconnectFailed: () => { this.runtimes.delete(projectName); },
        });
        this.runtimes.set(projectName, runtime);
        return runtime;
    }

    getRuntime(projectName: string): WorkspaceRuntime | undefined {
        return this.runtimes.get(projectName);
    }

    disconnectWorkspace(projectName: string): void {
        const runtime = this.runtimes.get(projectName);
        if (!runtime) return;
        void runtime.disconnect();
        this.runtimes.delete(projectName);
    }

    disconnectAll(): void {
        for (const projectName of [...this.runtimes.keys()]) {
            this.disconnectWorkspace(projectName);
        }
    }

    // ─── Generic Detector Registry (delegates to WorkspaceRuntime) ────

    registerDetector<T extends { isActive(): boolean; stop(): void | Promise<void> }>(
        type: DetectorType | string, projectName: string, detector: T,
    ): void {
        this.runtimes.get(projectName)?.registerDetector(type, detector);
    }

    getDetector<T extends { isActive(): boolean; stop(): void | Promise<void> }>(
        type: DetectorType | string, projectName: string,
    ): T | undefined {
        return this.runtimes.get(projectName)?.getDetector<T>(type);
    }

    // ─── Named Accessors (backward-compatible one-line delegates) ─────
    //     Each pair delegates to the generic registerDetector/getDetector.

    registerApprovalDetector(projectName: string, detector: import('./approvalDetector').ApprovalDetector): void {
        this.registerDetector('approval', projectName, detector);
    }
    getApprovalDetector(projectName: string): import('./approvalDetector').ApprovalDetector | undefined {
        return this.getDetector('approval', projectName);
    }

    registerErrorPopupDetector(projectName: string, detector: import('./errorPopupDetector').ErrorPopupDetector): void {
        this.registerDetector('errorPopup', projectName, detector);
    }
    getErrorPopupDetector(projectName: string): import('./errorPopupDetector').ErrorPopupDetector | undefined {
        return this.getDetector('errorPopup', projectName);
    }

    registerPlanningDetector(projectName: string, detector: import('./planningDetector').PlanningDetector): void {
        this.registerDetector('planning', projectName, detector);
    }
    getPlanningDetector(projectName: string): import('./planningDetector').PlanningDetector | undefined {
        return this.getDetector('planning', projectName);
    }

    registerRunCommandDetector(projectName: string, detector: import('./runCommandDetector').RunCommandDetector): void {
        this.registerDetector('runCommand', projectName, detector);
    }
    getRunCommandDetector(projectName: string): import('./runCommandDetector').RunCommandDetector | undefined {
        return this.getDetector('runCommand', projectName);
    }

    registerUserMessageDetector(projectName: string, detector: import('./userMessageDetector').UserMessageDetector): void {
        this.registerDetector('userMessage', projectName, detector);
    }
    getUserMessageDetector(projectName: string): import('./userMessageDetector').UserMessageDetector | undefined {
        return this.getDetector('userMessage', projectName);
    }

    registerStreamRouter(projectName: string, router: TrajectoryStreamRouter): void {
        this.registerDetector('streamRouter', projectName, router);
    }
    getStreamRouter(projectName: string): TrajectoryStreamRouter | undefined {
        return this.getDetector('streamRouter', projectName);
    }

    getActiveWorkspaceNames(): string[] {
        const active: string[] = [];
        for (const [name, runtime] of this.runtimes) {
            if (runtime.getConnected()) active.push(name);
        }
        return active;
    }

    extractProjectName(workspacePath: string): string {
        return extractProjectNameFromPath(workspacePath) || workspacePath;
    }
}
