import { logger } from './logger';
import fs from 'fs';
import path from 'path';
import { escapeHtml } from '../platform/telegram/trajectoryRenderer';

const LOCK_FILE = path.resolve(process.cwd(), '.bot.lock');
let currentReleaseLock: (() => void) | null = null;

/**
 * Check if a process with the given PID is running
 */
function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Stop an existing process and wait for it to exit
 */
function killExistingProcess(pid: number): void {
    logger.warn(`🔄 Stopping existing Bot process (PID: ${pid})...`);
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        // Ignore if already terminated
        return;
    }

    // Wait up to 5 seconds for process to exit
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (!isProcessRunning(pid)) {
            logger.info(`✅ Existing process (PID: ${pid}) stopped`);
            return;
        }
        // Wait 50ms (busy wait)
        const waitUntil = Date.now() + 50;
        while (Date.now() < waitUntil) { /* spin */ }
    }

    // Timeout: force kill with SIGKILL
    logger.warn(`⚠️  Process did not exit with SIGTERM, force killing (SIGKILL)`);
    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // ignore
    }
}

/**
 * Acquire a lockfile to prevent duplicate bot instances.
 * If another process is already running, stop it before starting.
 *
 * @returns A function to release the lock
 */
export function acquireLock(): () => void {
    // Check existing lock file
    if (fs.existsSync(LOCK_FILE)) {
        const content = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
        const existingPid = parseInt(content, 10);

        if (!isNaN(existingPid) && existingPid !== process.pid && isProcessRunning(existingPid)) {
            // Stop existing process and restart
            killExistingProcess(existingPid);
        } else if (!isNaN(existingPid) && !isProcessRunning(existingPid)) {
            logger.warn(`⚠️  Stale lock file detected (PID: ${existingPid} has exited). Cleaning up.`);
        }

        // Remove stale lock file
        try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    }

    // Create new lock file
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
    logger.info(`🔒 Lock acquired (PID: ${process.pid})`);

    // Cleanup function
    const releaseLock = () => {
        try {
            if (fs.existsSync(LOCK_FILE)) {
                const content = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
                if (parseInt(content, 10) === process.pid) {
                    fs.unlinkSync(LOCK_FILE);
                    logger.info(`🔓 Lock released (PID: ${process.pid})`);
                }
            }
        } catch {
            // Ignore errors during cleanup
        }
    };

    currentReleaseLock = releaseLock;

    // Auto cleanup on process exit
    process.on('exit', releaseLock);
    process.on('SIGINT', () => {
        releaseLock();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        releaseLock();
        process.exit(0);
    });
    process.on('uncaughtException', async (err) => {
        logger.error('Uncaught exception:', err);
        try {
            const { globalTelegramNotifier } = await import('../bot/index');
            if (globalTelegramNotifier) {
                await globalTelegramNotifier(
                    `🚨 <b>Fatal Error (uncaughtException)</b>\n<pre>${escapeHtml(err instanceof Error ? err.stack || err.message : String(err))}</pre>`,
                );
            }
        } catch {
            // ignore
        }
        releaseLock();
        process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
        logger.error('Unhandled Rejection:', reason);
        try {
            const { globalTelegramNotifier } = await import('../bot/index');
            if (globalTelegramNotifier) {
                await globalTelegramNotifier(
                    `🚨 <b>Unhandled Promise Rejection</b>\n<pre>${escapeHtml(reason instanceof Error ? reason.stack || reason.message : String(reason))}</pre>`,
                );
            }
        } catch {
            // ignore
        }
    });

    return releaseLock;
}

export function releaseCurrentLock(): void {
    currentReleaseLock?.();
    currentReleaseLock = null;
}
