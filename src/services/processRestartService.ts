import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { logger } from '../utils/logger';
import { releaseCurrentLock } from '../utils/lockfile';

type ShutdownHook = () => Promise<void> | void;

export interface RestartLaunchSpec {
    executable: string;
    args: string[];
    displayCommand: string;
}

export interface RestartResult {
    ok: boolean;
    pid?: number;
    launchSpec?: RestartLaunchSpec;
    error?: string;
}

const shutdownHooks = new Map<string, ShutdownHook>();
let shutdownPromise: Promise<void> | null = null;

function resolvePathArg(arg: string | undefined, cwd: string): string | null {
    if (!arg) return null;
    return path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
}

function quoteArg(arg: string): string {
    return /\s/.test(arg) ? `"${arg}"` : arg;
}

function findLocalTsNodeBin(cwd: string): string | null {
    const tsNodeBin = path.resolve(cwd, 'node_modules', 'ts-node', 'dist', 'bin.js');
    return fs.existsSync(tsNodeBin) ? tsNodeBin : null;
}

export function clearShutdownHooks(): void {
    shutdownHooks.clear();
    shutdownPromise = null;
}

export function registerShutdownHook(name: string, hook: ShutdownHook): void {
    shutdownHooks.set(name, hook);
}

export async function runShutdownHooks(): Promise<void> {
    if (shutdownPromise) {
        await shutdownPromise;
        return;
    }

    shutdownPromise = (async () => {
        for (const [name, hook] of Array.from(shutdownHooks.entries()).reverse()) {
            try {
                await hook();
            } catch (err: unknown) {
                logger.warn(`[ProcessRestart] Shutdown hook "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    })();

    await shutdownPromise;
}

export function resolveRestartLaunchSpec(
    argv: string[] = process.argv,
    execPath: string = process.execPath,
    cwd: string = process.cwd(),
): RestartLaunchSpec {
    const entry = resolvePathArg(argv[1], cwd);
    const secondary = resolvePathArg(argv[2], cwd);

    if (entry && /[\\/]ts-node(?:[\\/].*)?$/i.test(entry) && secondary) {
        return {
            executable: execPath,
            args: [entry, secondary, 'start'],
            displayCommand: [execPath, entry, secondary, 'start'].map(quoteArg).join(' '),
        };
    }

    if (entry && /\.js$/i.test(entry)) {
        return {
            executable: execPath,
            args: [entry, 'start'],
            displayCommand: [execPath, entry, 'start'].map(quoteArg).join(' '),
        };
    }

    if (entry && /\.ts$/i.test(entry)) {
        const tsNodeBin = findLocalTsNodeBin(cwd);
        if (!tsNodeBin) {
            throw new Error('Unable to restart from TypeScript entrypoint: local ts-node is missing.');
        }
        return {
            executable: execPath,
            args: [tsNodeBin, entry, 'start'],
            displayCommand: [execPath, tsNodeBin, entry, 'start'].map(quoteArg).join(' '),
        };
    }

    const distCli = path.resolve(cwd, 'dist', 'bin', 'cli.js');
    if (fs.existsSync(distCli)) {
        return {
            executable: execPath,
            args: [distCli, 'start'],
            displayCommand: [execPath, distCli, 'start'].map(quoteArg).join(' '),
        };
    }

    const srcCli = path.resolve(cwd, 'src', 'bin', 'cli.ts');
    const tsNodeBin = findLocalTsNodeBin(cwd);
    if (tsNodeBin && fs.existsSync(srcCli)) {
        return {
            executable: execPath,
            args: [tsNodeBin, srcCli, 'start'],
            displayCommand: [execPath, tsNodeBin, srcCli, 'start'].map(quoteArg).join(' '),
        };
    }

    throw new Error('Unable to resolve a restart launch command for this runtime.');
}

export async function waitForRestartParentExit(): Promise<void> {
    const parentPid = Number(process.env.CLAW_GRAVITY_WAIT_FOR_PID || '');
    if (!Number.isFinite(parentPid) || parentPid <= 0) {
        return;
    }

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        try {
            process.kill(parentPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 100));
        } catch {
            break;
        }
    }

    delete process.env.CLAW_GRAVITY_WAIT_FOR_PID;
}

export function spawnReplacementProcess(options?: {
    detached?: boolean;
    stdio?: 'ignore' | 'inherit';
    waitForPid?: number;
}): RestartResult {
    try {
        const launchSpec = resolveRestartLaunchSpec();
        const detached = options?.detached ?? true;
        const stdio = options?.stdio ?? 'ignore';
        const env = {
            ...process.env,
            CLAW_GRAVITY_WAIT_FOR_PID: String(options?.waitForPid ?? process.pid),
        };

        const child = spawn(launchSpec.executable, launchSpec.args, {
            cwd: process.cwd(),
            env,
            detached,
            stdio,
            windowsHide: true,
        });

        if (detached) {
            child.unref();
        }

        return {
            ok: true,
            pid: child.pid ?? undefined,
            launchSpec,
        };
    } catch (err: unknown) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/**
 * Run `tsc` to compile the TypeScript project before restart.
 * Returns null on success or an error message on failure.
 */
function buildProject(): string | null {
    const cwd = process.cwd();
    const tsconfigPath = path.resolve(cwd, 'tsconfig.json');

    if (!fs.existsSync(tsconfigPath)) {
        logger.warn('[ProcessRestart] No tsconfig.json found, skipping build step.');
        return null;
    }

    logger.info('[ProcessRestart] Compiling TypeScript (tsc)...');
    try {
        execSync('npx tsc', {
            cwd,
            stdio: 'pipe',
            timeout: 60_000,
        });
        logger.done('[ProcessRestart] Build completed successfully.');
        return null;
    } catch (err: unknown) {
        const output = (err as Record<string, unknown>)?.stdout?.toString() || '' + (err as Record<string, unknown>)?.stderr?.toString() || '';
        const trimmed = output.trim().slice(0, 2000);
        logger.error('[ProcessRestart] Build failed:\n' + trimmed);
        return trimmed || (err instanceof Error ? err.message : 'Unknown build error');
    }
}

export async function restartCurrentProcess(): Promise<RestartResult> {
    // Build before restart so code changes take effect
    const buildError = buildProject();
    if (buildError) {
        return {
            ok: false,
            error: `Build failed:\n${buildError}`,
        };
    }

    const result = spawnReplacementProcess({ detached: true, stdio: 'ignore' });
    if (!result.ok) {
        return result;
    }

    await runShutdownHooks();
    releaseCurrentLock();

    setTimeout(() => process.exit(0), 100);
    return result;
}
