import type { CdpBridge } from '../services/cdpBridgeManager';
import { MODE_DISPLAY_NAMES } from '../services/modeService';

export interface DiscordStatusField {
    readonly name: string;
    readonly value: string;
    readonly inline: true;
}

interface BuildConnectedProjectsDescriptionOptions {
    readonly bridge: CdpBridge;
    readonly workspaceNames: string[];
    readonly includeMirroring?: boolean;
}

export function buildDiscordStatusFields(
    activeWorkspaceCount: number,
    currentMode: string,
    autoApproveEnabled: boolean,
): DiscordStatusField[] {
    return [
        {
            name: 'CDP Connection',
            value: activeWorkspaceCount > 0
                ? `🟢 ${activeWorkspaceCount} project(s) connected`
                : '⚪ Disconnected',
            inline: true,
        },
        {
            name: 'Mode',
            value: MODE_DISPLAY_NAMES[currentMode] || currentMode,
            inline: true,
        },
        {
            name: 'Auto Approve',
            value: autoApproveEnabled ? '🟢 ON' : '⚪ OFF',
            inline: true,
        },
    ];
}

export function buildConnectedProjectsDescription({
    bridge,
    workspaceNames,
    includeMirroring = false,
}: BuildConnectedProjectsDescriptionOptions): string {
    if (workspaceNames.length === 0) {
        return 'Send a message to auto-connect to a project.';
    }

    const lines = workspaceNames.map((name) => {
        const cdp = bridge.pool.getConnected(name);
        const contexts = cdp ? cdp.getContexts().length : 0;
        const detectorActive = bridge.pool.getApprovalDetector(name)?.isActive() ? ' [Detecting]' : '';
        const mirrorActive = includeMirroring && bridge.pool.getUserMessageDetector(name)?.isActive()
            ? ' [Mirror]'
            : '';

        return `• **${name}** — Contexts: ${contexts}${detectorActive}${mirrorActive}`;
    });

    return `**Connected Projects:**\n${lines.join('\n')}`;
}
