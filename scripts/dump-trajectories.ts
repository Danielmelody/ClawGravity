import { CdpService } from '../src/services/cdpService';
import { LsClientManager } from '../src/services/lsClientManager';

async function main() {
    const lsManager = new LsClientManager();
    const cdp = new CdpService({ lsClientManager: lsManager } as any);
    await cdp.discoverAndConnectForWorkspace(process.cwd());

    const client = await cdp.getLSClient();
    if (!client) {
        console.log('No client');
        process.exit(1);
    }

    const response = await client.rawRPC('GetAllCascadeTrajectories', {}) as Record<string, unknown>;
    const summaries = (response.trajectorySummaries as Record<string, unknown> | undefined) ?? {};

    for (const [id, summaryValue] of Object.entries(summaries)) {
        if (!summaryValue) {
            continue;
        }

        const summary = summaryValue as Record<string, any>;
        const title = String(summary.title || summary.summary?.slice(0, 20) || 'None');
        console.log(
            'ID:',
            id.slice(0, 8),
            '- Title:',
            title.padEnd(20),
            '- WorkspacePath:',
            summary.workspacePath,
            '- ExtraWS:',
            JSON.stringify(summary.extraConfig?.workspaces),
        );
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
