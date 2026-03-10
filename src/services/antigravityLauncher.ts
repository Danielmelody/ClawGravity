import { logger } from '../utils/logger';
import { CDP_PORTS } from '../utils/cdpPorts';
import { getAntigravityCliPath, getAntigravityCdpHint } from '../utils/pathUtils';
import { checkCdpPort, findFreeCdpPort } from '../utils/portUtils';
import { execFile, spawn } from 'child_process';

/** How long to wait for Antigravity to become responsive after launch (ms) */
const LAUNCH_WAIT_MS = 45_000;

/** Poll interval when waiting for CDP to respond (ms) */
const POLL_INTERVAL_MS = 2_000;



/**
 * Launch Antigravity with --remote-debugging-port using the platform-appropriate method.
 *
 * On Windows, uses execFile (matching the proven `claw-gravity open` command logic).
 * The CLI wrapper (.cmd) only works correctly with execFile + shell:true on Windows.
 *
 * On other platforms, uses spawn with detached:true so Antigravity persists
 * after the bot process exits.
 *
 * @param port CDP port to enable
 * @param workspacePath Optional workspace directory to open on launch
 */
function launchAntigravity(port: number, workspacePath?: string): Promise<void> {
    const antigravityCli = getAntigravityCliPath();
    const args = [`--remote-debugging-port=${port}`];
    if (workspacePath) args.push(workspacePath);

    if (process.platform === 'win32') {
        return new Promise((resolve, reject) => {
            logger.info(`[AntigravityLauncher] execFile: ${antigravityCli} ${args.join(' ')}`);
            execFile(antigravityCli, args, { shell: true }, (err) => {
                if (err) {
                    reject(new Error(`Failed to launch Antigravity: ${err.message}`));
                    return;
                }
                resolve();
            });
        });
    } else if (process.platform === 'darwin') {
        return new Promise((resolve, reject) => {
            const macArgs = ['-a', 'Antigravity', '--args', `--remote-debugging-port=${port}`];
            if (workspacePath) macArgs.push(workspacePath);
            logger.info(`[AntigravityLauncher] open ${macArgs.join(' ')}`);
            execFile('open', macArgs, (err) => {
                if (err) {
                    reject(new Error(`Failed to launch Antigravity: ${err.message}`));
                    return;
                }
                resolve();
            });
        });
    } else {
        // Linux
        return new Promise((resolve, reject) => {
            const linuxArgs = [`--remote-debugging-port=${port}`];
            if (workspacePath) linuxArgs.push(workspacePath);
            logger.info(`[AntigravityLauncher] spawn: antigravity ${linuxArgs.join(' ')}`);
            try {
                const child = spawn('antigravity', linuxArgs, {
                    detached: true,
                    stdio: 'ignore',
                });
                child.unref();
                child.once('error', (err) => {
                    reject(new Error(`Failed to launch Antigravity: ${err.message}`));
                });
                setTimeout(() => resolve(), 500);
            } catch (err: any) {
                reject(new Error(`Failed to launch Antigravity: ${err?.message || err}`));
            }
        });
    }
}

/**
 * Check if Antigravity is running with CDP ports.
 * If not running, auto-launch Antigravity with --remote-debugging-port
 * and wait until CDP becomes responsive.
 *
 * Called during Bot initialization.
 *
 * @param workspacePath Optional workspace directory to open when auto-launching
 */
export async function ensureAntigravityRunning(workspacePath?: string): Promise<void> {
    logger.debug('[AntigravityLauncher] Checking CDP ports...');

    for (const port of CDP_PORTS) {
        if (await checkCdpPort(port)) {
            logger.debug(`[AntigravityLauncher] OK — Port ${port} responding`);
            return;
        }
    }

    // No CDP port is responding — find a free port and auto-launch Antigravity
    const launchPort = await findFreeCdpPort();
    if (!launchPort) {
        logger.warn('[AntigravityLauncher] No free CDP port available. All candidate ports are occupied.');
        logger.warn(`[AntigravityLauncher] Candidate ports: ${CDP_PORTS.join(', ')}`);
        logger.warn('[AntigravityLauncher] Close an application using one of these ports or launch Antigravity manually.');
        return;
    }

    logger.warn(`[AntigravityLauncher] No CDP ports responding. Auto-launching Antigravity on port ${launchPort}...`);

    try {
        await launchAntigravity(launchPort, workspacePath);
        logger.info(`[AntigravityLauncher] Antigravity launch command completed. Waiting for CDP...`);

        // Wait for CDP to become responsive
        const startTime = Date.now();
        while (Date.now() - startTime < LAUNCH_WAIT_MS) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

            if (await checkCdpPort(launchPort)) {
                logger.done(`[AntigravityLauncher] ✓ Antigravity CDP ready on port ${launchPort}`);
                return;
            }

            const elapsed = Math.round((Date.now() - startTime) / 1000);
            logger.debug(`[AntigravityLauncher] Still waiting... (${elapsed}s)`);
        }

        // Timed out — Antigravity was launched but CDP didn't respond in time
        logger.warn('');
        logger.warn('='.repeat(70));
        logger.warn('  Antigravity was launched but CDP is not responding yet.');
        logger.warn('  The bot will continue, but CDP connections may fail initially.');
        logger.warn('');
        logger.warn('  If this persists, try manually:');
        logger.warn(`    ${getAntigravityCdpHint(launchPort)}`);
        logger.warn('='.repeat(70));
        logger.warn('');

    } catch (err: any) {
        logger.error(`[AntigravityLauncher] Auto-launch failed: ${err?.message || err}`);
        logger.warn('');
        logger.warn('='.repeat(70));
        logger.warn('  Failed to auto-launch Antigravity.');
        logger.warn('');
        logger.warn('  Please start it manually:');
        logger.warn(`    ${getAntigravityCdpHint(launchPort)}`);
        logger.warn('='.repeat(70));
        logger.warn('');
    }
}
