import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
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
            } catch (err: any) {
                logger.warn(`[ProcessRestart] Shutdown hook "${name}" failed: ${err?.message || err}`);
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
    } catch (err: any) {
        return {
            ok: false,
            error: err?.message || String(err),
        };
    }
}

export async function restartCurrentProcess(): Promise<RestartResult> {
    const result = spawnReplacementProcess({ detached: true, stdio: 'ignore' });
    if (!result.ok) {
        return result;
    }

    await runShutdownHooks();
    releaseCurrentLock();

    setTimeout(() => process.exit(0), 100);
    return result;
}
