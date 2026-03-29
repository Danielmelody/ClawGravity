import { CdpService } from '../src/services/cdpService';
import { LsClientManager } from '../src/services/lsClientManager';

async function main() {
    const lsManager = new LsClientManager();
    const cdp = new CdpService({ lsClientManager: lsManager } as any);
    await cdp.discoverAndConnectForWorkspace("c:\Users\Daniel\Projects\ClawGravity");
    const client = await cdp.getLSClient();
    if (!client) { console.log('No client'); process.exit(1); }
    const resp = await client.rawRPC('GetAllCascadeTrajectories', {}) as Record<string, unknown>;
    const summaries = (resp?.trajectorySummaries as Record<string, unknown>) || {};
    for (const [id, s] of Object.entries(summaries)) {
        if (!s) continue;
        const sum = s as Record<string, any>;
        console.log("ID:", id.slice(0, 8), "- Title:", (sum.title || sum.summary?.slice(0, 20) || 'None').padEnd(20), "- WorkspacePath:", sum.workspacePath, "- ExtraWS:", JSON.stringify(sum.extraConfig?.workspaces));
    }
    process.exit(0);
}
main().catch(console.error);
