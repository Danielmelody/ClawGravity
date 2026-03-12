import { spawn } from 'child_process';
import { getAntigravityCliPath } from '../utils/pathUtils';
import { logger } from '../utils/logger';
import { CdpService } from './cdpService';

export class WorkspaceLauncher {
    private static recentLaunchTimestamps = new Map<string, number>();
    private static readonly LAUNCH_COOLDOWN_MS = 60_000;

    static clearLaunchCooldowns(): void {
        WorkspaceLauncher.recentLaunchTimestamps.clear();
    }

    static async launchAndConnectWorkspace(
        cdpService: CdpService,
        workspacePath: string,
        projectName: string,
        ports: number[]
    ): Promise<boolean> {
        // Guard: prevent launching the same workspace multiple times within cooldown period.
        const lastLaunch = WorkspaceLauncher.recentLaunchTimestamps.get(projectName);
        const now = Date.now();
        if (lastLaunch && (now - lastLaunch) < WorkspaceLauncher.LAUNCH_COOLDOWN_MS) {
            const agoSec = Math.round((now - lastLaunch) / 1000);
            logger.warn(`[WorkspaceLauncher] Suppressing duplicate launch for "${projectName}" — last launch was ${agoSec}s ago (cooldown=${WorkspaceLauncher.LAUNCH_COOLDOWN_MS / 1000}s)`);
            throw new Error(
                `Workspace "${projectName}" was launched ${agoSec}s ago. Wait for the previous launch to initialize or connect manually.`,
            );
        }

        // Open as folder using Antigravity CLI (not as workspace mode).
        // CLI --new-window opens as folder, immediately reflecting directory name in title.
        const antigravityCli = getAntigravityCliPath();

        logger.debug(`[WorkspaceLauncher] Launching Antigravity: ${antigravityCli} --new-window ${workspacePath}`);
        WorkspaceLauncher.recentLaunchTimestamps.set(projectName, now);
        await WorkspaceLauncher.runCommand(antigravityCli, ['--new-window', workspacePath]);

        // Poll until a new workbench page appears (max 30 seconds)
        const maxWaitMs = 30000;
        const pollIntervalMs = 1000;
        const startTime = Date.now();
        
        // Pre-launch workbench page IDs (for detecting new pages)
        const knownPageIds: Set<string> = new Set();
        for (const port of ports) {
            try {
                const preLaunchPages = await cdpService.getJson(`http://127.0.0.1:${port}/json/list`);
                preLaunchPages.forEach((p: any) => {
                    if (p.id) knownPageIds.add(p.id);
                });
            } catch {
                // No response from this port
            }
        }

        while (Date.now() - startTime < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollIntervalMs));

            const pages: any[] = [];
            for (const port of ports) {
                try {
                    const list = await cdpService.getJson(`http://127.0.0.1:${port}/json/list`);
                    pages.push(...list);
                } catch {
                    // Next port
                }
            }

            if (pages.length === 0) continue;

            const workbenchPages = pages.filter((t: any) => cdpService.isWorkbenchPage(t));

            // Title match
            const titleMatch = workbenchPages.find((t: any) => t.title?.toLowerCase().includes(projectName.toLowerCase()));
            if (titleMatch) {
                return cdpService.connectToPage(titleMatch, projectName);
            }

            // CDP probe (also check folder path if title is not updated)
            const probeResult = await cdpService.probeWorkbenchPages(workbenchPages, projectName, workspacePath);
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
                    logger.debug(`[WorkspaceLauncher] New Untitled page detected. Connecting as "${projectName}" (page.id=${newUntitledPages[0].id})`);
                    return cdpService.connectToPage(newUntitledPages[0], projectName);
                }
            }
        }

        throw new Error(
            `Workbench page for workspace "${projectName}" not found within ${maxWaitMs / 1000} seconds`,
        );
    }

    private static async runCommand(command: string, args: string[]): Promise<void> {
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
}
