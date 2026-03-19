import type { CdpBridge } from './cdpBridgeManager';
import { ModeService } from './modeService';
import { ModelService } from './modelService';

export interface StartupStatusSnapshot {
    readonly cdpStatus: string;
    readonly startupModel: string;
    readonly startupMode: string;
}

interface BuildStartupStatusSnapshotOptions {
    readonly bridge: CdpBridge;
    readonly cdpMode: string | null;
    readonly cdpModel: string | null;
    readonly modeService: ModeService;
    readonly modelService: ModelService;
}

export function buildStartupStatusSnapshot({
    bridge,
    cdpMode,
    cdpModel,
    modeService,
    modelService,
}: BuildStartupStatusSnapshotOptions): StartupStatusSnapshot {
    const activeWorkspaces = bridge.pool.getActiveWorkspaceNames();
    const cdpStatus = activeWorkspaces.length > 0
        ? `Connected (${activeWorkspaces.join(', ')})`
        : 'Not connected';

    const startupModel = cdpModel || modelService.getDefaultModel() || 'Not synced';
    const startupMode = cdpMode || modeService.getCurrentMode();

    if (cdpMode) {
        modeService.setMode(cdpMode);
    }

    return {
        cdpStatus,
        startupModel,
        startupMode,
    };
}
