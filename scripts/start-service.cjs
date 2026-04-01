const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
    LOCK_FILE,
    SERVICE_PID_FILE,
    isProcessRunning,
    readPidFile,
    removePidFile,
    writePidFile,
} = require('./background-process-utils.cjs');

const APP_READY_POLL_MS = 200;
const APP_READY_TIMEOUT_MS = 15000;

function resolveNpmLaunch(scriptName) {
    if (process.platform === 'win32') {
        return {
            command: 'cmd.exe',
            args: ['/d', '/s', '/c', `npm run ${scriptName}`],
        };
    }

    return {
        command: 'npm',
        args: ['run', scriptName],
    };
}

function openLogFile(logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    return fs.openSync(logPath, 'a');
}

function writeLog(logFd, chunk) {
    fs.writeSync(logFd, typeof chunk === 'string' ? chunk : chunk.toString());
}

function logLine(logFd, message) {
    writeLog(logFd, `[${new Date().toISOString()}] ${message}\n`);
}

function sendStatus(type, payload = {}) {
    if (typeof process.send !== 'function') {
        return;
    }

    try {
        process.send({ type, ...payload });
    } catch {
        // Ignore IPC failures when the launcher is already gone.
    }
}

function mirrorChunk(target, chunk, enabled) {
    if (!enabled()) {
        return;
    }

    try {
        target.write(chunk);
    } catch {
        // Ignore mirror failures after the launcher disconnects.
    }
}

function mirrorLine(message, enabled) {
    if (!enabled()) {
        return;
    }

    try {
        process.stdout.write(`${message}\n`);
    } catch {
        // Ignore mirror failures after the launcher disconnects.
    }
}

function runCommand(command, args, options, logFd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (chunk) => {
            writeLog(logFd, chunk);
            mirrorChunk(process.stdout, chunk, options.shouldMirrorStartupOutput);
        });
        child.stderr.on('data', (chunk) => {
            writeLog(logFd, chunk);
            mirrorChunk(process.stderr, chunk, options.shouldMirrorStartupOutput);
        });
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 1));
    });
}

function waitForAppReady(app, logFd, logPath, shouldMirrorStartupOutput, onReady) {
    return new Promise((resolve, reject) => {
        let ready = false;
        let finished = false;
        let pollInterval = null;
        let readyTimeout = null;

        const cleanup = () => {
            clearInterval(pollInterval);
            clearTimeout(readyTimeout);
        };

        const markReady = (pid) => {
            if (ready) {
                return;
            }

            ready = true;
            onReady(pid);
            cleanup();
        };

        const failStartup = (message, exitCode = 1) => {
            if (finished) {
                return;
            }

            finished = true;
            cleanup();
            sendStatus('failure', { reason: message, exitCode, logPath });
            const error = new Error(message);
            error.exitCode = exitCode;
            error.statusSent = true;
            reject(error);
        };

        app.stdout.on('data', (chunk) => {
            writeLog(logFd, chunk);
            mirrorChunk(process.stdout, chunk, shouldMirrorStartupOutput);
        });
        app.stderr.on('data', (chunk) => {
            writeLog(logFd, chunk);
            mirrorChunk(process.stderr, chunk, shouldMirrorStartupOutput);
        });
        app.on('error', (err) => {
            failStartup(`Failed to launch app: ${err.message}`);
        });
        app.on('close', (code) => {
            if (!ready) {
                failStartup(`Application exited before startup completed (exit code ${code ?? 1}).`, code ?? 1);
                return;
            }

            if (finished) {
                return;
            }

            finished = true;
            cleanup();
            logLine(logFd, `Application exited with code ${code ?? 1}.`);
            resolve(code ?? 1);
        });

        pollInterval = setInterval(() => {
            const appPid = readPidFile(LOCK_FILE);
            if (appPid != null && appPid === app.pid && isProcessRunning(appPid)) {
                markReady(appPid);
            }
        }, APP_READY_POLL_MS);

        readyTimeout = setTimeout(() => {
            const trackedPid = readPidFile(LOCK_FILE);
            if (trackedPid != null && trackedPid === app.pid && isProcessRunning(trackedPid)) {
                markReady(trackedPid);
                return;
            }

            failStartup(`Application did not report ready within ${APP_READY_TIMEOUT_MS}ms.`);
        }, APP_READY_TIMEOUT_MS);
    });
}

async function main() {
    const cwd = path.resolve(__dirname, '..');
    const logPath = path.resolve(cwd, 'logs', 'claw-gravity.log');
    const logFd = openLogFile(logPath);
    const env = {
        ...process.env,
        CLAW_GRAVITY_BACKGROUND: '1',
    };
    let mirrorStartupOutput = true;
    const shouldMirrorStartupOutput = () => mirrorStartupOutput;
    const cleanupPidFile = () => {
        try {
            removePidFile(SERVICE_PID_FILE, process.pid);
        } catch {
            // Ignore cleanup failures.
        }
    };

    writePidFile(SERVICE_PID_FILE, process.pid);
    process.on('exit', cleanupPidFile);
    process.on('SIGINT', () => {
        cleanupPidFile();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        cleanupPidFile();
        process.exit(0);
    });

    try {
        logLine(logFd, 'Background start requested.');
        mirrorLine('[ClawGravity] Background start requested.', shouldMirrorStartupOutput);

        logLine(logFd, 'Running npm run check...');
        mirrorLine('[ClawGravity] Running npm run check...', shouldMirrorStartupOutput);
        const checkLaunch = resolveNpmLaunch('check');
        const checkCode = await runCommand(checkLaunch.command, checkLaunch.args, {
            cwd,
            env,
            shouldMirrorStartupOutput,
        }, logFd);
        if (checkCode !== 0) {
            logLine(logFd, `npm run check failed with exit code ${checkCode}.`);
            sendStatus('failure', {
                reason: `npm run check failed with exit code ${checkCode}.`,
                exitCode: checkCode,
                logPath,
            });
            return checkCode;
        }

        logLine(logFd, 'Running npm run build...');
        mirrorLine('[ClawGravity] Running npm run build...', shouldMirrorStartupOutput);
        const buildLaunch = resolveNpmLaunch('build');
        const buildCode = await runCommand(buildLaunch.command, buildLaunch.args, {
            cwd,
            env,
            shouldMirrorStartupOutput,
        }, logFd);
        if (buildCode !== 0) {
            logLine(logFd, `npm run build failed with exit code ${buildCode}.`);
            sendStatus('failure', {
                reason: `npm run build failed with exit code ${buildCode}.`,
                exitCode: buildCode,
                logPath,
            });
            return buildCode;
        }

        logLine(logFd, 'Launching dist/bin/cli.js...');
        mirrorLine('[ClawGravity] Launching dist/bin/cli.js...', shouldMirrorStartupOutput);
        const app = spawn(process.execPath, [path.resolve(cwd, 'dist', 'bin', 'cli.js')], {
            cwd,
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const exitCode = await waitForAppReady(app, logFd, logPath, shouldMirrorStartupOutput, (pid) => {
            mirrorStartupOutput = false;
            logLine(logFd, `Application reported ready (PID: ${pid}).`);
            sendStatus('ready', { pid, logPath });
        });

        return exitCode;
    } catch (err) {
        const message = err instanceof Error ? err.stack || err.message : String(err);
        logLine(logFd, `Background start failed: ${message}`);
        if (!(err && typeof err === 'object' && err.statusSent)) {
            sendStatus('failure', { reason: message, exitCode: 1, logPath });
        }
        return err && typeof err === 'object' && typeof err.exitCode === 'number' ? err.exitCode : 1;
    } finally {
        cleanupPidFile();
        fs.closeSync(logFd);
    }
}

main().then((code) => {
    process.exit(code);
});
