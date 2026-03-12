import { extractProjectNameFromPath } from '../utils/pathUtils';
import { CdpService, CdpServiceOptions } from './cdpService';
import { ApprovalDetector } from './approvalDetector';
import { ErrorPopupDetector } from './errorPopupDetector';
import { PlanningDetector } from './planningDetector';
import { RunCommandDetector } from './runCommandDetector';
import { UserMessageDetector } from './userMessageDetector';
import { TrajectoryStreamRouter } from './trajectoryStreamRouter';
import { WorkspaceRuntime, DetectorType } from './workspaceRuntime';

/**
 * Pool that manages independent workspace runtimes.
 *
 * Each runtime owns the CdpService plus detector / router lifecycle for a
 * single workspace, while the pool is only a registry and lookup layer.
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
        if (existing) {
            return existing;
        }

        const runtime = new WorkspaceRuntime({
            projectName,
            workspacePath,
            cdpOptions: this.cdpOptions,
            onReconnectFailed: () => {
                this.runtimes.delete(projectName);
            },
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

    /**
     * Register a detector by type key on the runtime for the given project.
     */
    registerDetector<T extends { isActive(): boolean; stop(): void | Promise<void> }>(
        type: DetectorType | string,
        projectName: string,
        detector: T,
    ): void {
        this.runtimes.get(projectName)?.registerDetector(type, detector);
    }

    /**
     * Get a detector by type key from the runtime for the given project.
     */
    getDetector<T extends { isActive(): boolean; stop(): void | Promise<void> }>(
        type: DetectorType | string,
        projectName: string,
    ): T | undefined {
        return this.runtimes.get(projectName)?.getDetector<T>(type);
    }

    // ─── Named Detector Accessors (backward-compatible wrappers) ──────

    registerApprovalDetector(projectName: string, detector: ApprovalDetector): void {
        const runtime = this.runtimes.get(projectName);
        if (!runtime) return;
        runtime.registerApprovalDetector(detector);
    }

    getApprovalDetector(projectName: string): ApprovalDetector | undefined {
        return this.runtimes.get(projectName)?.getApprovalDetector();
    }

    registerErrorPopupDetector(projectName: string, detector: ErrorPopupDetector): void {
        const runtime = this.runtimes.get(projectName);
        if (!runtime) return;
        runtime.registerErrorPopupDetector(detector);
    }

    getErrorPopupDetector(projectName: string): ErrorPopupDetector | undefined {
        return this.runtimes.get(projectName)?.getErrorPopupDetector();
    }

    registerPlanningDetector(projectName: string, detector: PlanningDetector): void {
        const runtime = this.runtimes.get(projectName);
        if (!runtime) return;
        runtime.registerPlanningDetector(detector);
    }

    getPlanningDetector(projectName: string): PlanningDetector | undefined {
        return this.runtimes.get(projectName)?.getPlanningDetector();
    }

    registerRunCommandDetector(projectName: string, detector: RunCommandDetector): void {
        const runtime = this.runtimes.get(projectName);
        if (!runtime) return;
        runtime.registerRunCommandDetector(detector);
    }

    getRunCommandDetector(projectName: string): RunCommandDetector | undefined {
        return this.runtimes.get(projectName)?.getRunCommandDetector();
    }

    registerUserMessageDetector(projectName: string, detector: UserMessageDetector): void {
        const runtime = this.runtimes.get(projectName);
        if (!runtime) return;
        runtime.registerUserMessageDetector(detector);
    }

    getUserMessageDetector(projectName: string): UserMessageDetector | undefined {
        return this.runtimes.get(projectName)?.getUserMessageDetector();
    }

    registerStreamRouter(projectName: string, router: TrajectoryStreamRouter): void {
        const runtime = this.runtimes.get(projectName);
        if (!runtime) return;
        runtime.registerStreamRouter(router);
    }

    getStreamRouter(projectName: string): TrajectoryStreamRouter | undefined {
        return this.runtimes.get(projectName)?.getStreamRouter();
    }

    getActiveWorkspaceNames(): string[] {
        const active: string[] = [];
        for (const [name, runtime] of this.runtimes) {
            if (runtime.getConnected()) {
                active.push(name);
            }
        }
        return active;
    }

    extractProjectName(workspacePath: string): string {
        return extractProjectNameFromPath(workspacePath) || workspacePath;
    }
}
