const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

function runCommand(command, args, options, logFd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (chunk) => writeLog(logFd, chunk));
        child.stderr.on('data', (chunk) => writeLog(logFd, chunk));
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 1));
    });
}

async function main() {
    const cwd = process.cwd();
    const logPath = path.resolve(cwd, 'logs', 'claw-gravity.log');
    const logFd = openLogFile(logPath);
    const env = {
        ...process.env,
        CLAW_GRAVITY_BACKGROUND: '1',
    };

    try {
        logLine(logFd, 'Background start requested.');

        logLine(logFd, 'Running npm run check...');
        const checkLaunch = resolveNpmLaunch('check');
        const checkCode = await runCommand(checkLaunch.command, checkLaunch.args, { cwd, env }, logFd);
        if (checkCode !== 0) {
            logLine(logFd, `npm run check failed with exit code ${checkCode}.`);
            process.exit(checkCode);
        }

        logLine(logFd, 'Running npm run build...');
        const buildLaunch = resolveNpmLaunch('build');
        const buildCode = await runCommand(buildLaunch.command, buildLaunch.args, { cwd, env }, logFd);
        if (buildCode !== 0) {
            logLine(logFd, `npm run build failed with exit code ${buildCode}.`);
            process.exit(buildCode);
        }

        logLine(logFd, 'Launching dist/bin/cli.js...');
        const app = spawn(process.execPath, [path.resolve(cwd, 'dist', 'bin', 'cli.js')], {
            cwd,
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        app.stdout.on('data', (chunk) => writeLog(logFd, chunk));
        app.stderr.on('data', (chunk) => writeLog(logFd, chunk));
        app.on('error', (err) => {
            logLine(logFd, `Failed to launch app: ${err.message}`);
            process.exit(1);
        });
        app.on('close', (code) => {
            logLine(logFd, `Application exited with code ${code ?? 1}.`);
            process.exit(code ?? 1);
        });
    } catch (err) {
        logLine(logFd, `Background start failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
        process.exit(1);
    }
}

main();
