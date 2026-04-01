const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function readLogExcerpt(logPath, startOffset = 0, maxLines = 40) {
    try {
        const content = fs.readFileSync(logPath).toString('utf8', startOffset);
        return content.split(/\r?\n/).slice(-maxLines).join('\n').trim();
    } catch {
        return '';
    }
}

function forwardStream(stream, writer, onChunk) {
    const onData = (chunk) => {
        onChunk(chunk);
        writer(chunk);
    };
    stream.on('data', onData);

    return () => {
        stream.off('data', onData);
    };
}

function summarizeFailure(logPath, reason, options = {}) {
    console.error('ClawGravity failed to start in background.');
    if (reason) {
        console.error(reason);
    }
    console.error(`Logs: ${logPath}`);

    if (options.showLogExcerpt !== false) {
        const excerpt = readLogExcerpt(logPath, options.startOffset);
        if (!excerpt) {
            return;
        }

        console.error('');
        console.error('Recent startup logs:');
        console.error(excerpt);
    }
}

function main() {
    const cwd = path.resolve(__dirname, '..');
    const logPath = path.resolve(cwd, 'logs', 'claw-gravity.log');
    const serviceScript = path.resolve(__dirname, 'start-service.cjs');
    const initialLogSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

    const child = spawn(process.execPath, [serviceScript], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        env: {
            ...process.env,
            CLAW_GRAVITY_BACKGROUND: '1',
        },
    });

    let resolved = false;
    let sawStartupOutput = false;
    const markStartupOutput = () => {
        sawStartupOutput = true;
    };
    const stopForwardingStdout = forwardStream(child.stdout, (chunk) => process.stdout.write(chunk), markStartupOutput);
    const stopForwardingStderr = forwardStream(child.stderr, (chunk) => process.stderr.write(chunk), markStartupOutput);

    const cleanup = () => {
        stopForwardingStdout();
        stopForwardingStderr();

        if (child.stdout && !child.stdout.destroyed) {
            child.stdout.destroy();
        }

        if (child.stderr && !child.stderr.destroyed) {
            child.stderr.destroy();
        }

        if (typeof child.disconnect === 'function' && child.connected) {
            child.disconnect();
        }

        child.unref();
    };

    const finishSuccess = (pid) => {
        if (resolved) {
            return;
        }

        resolved = true;
        cleanup();
        console.log('ClawGravity is running in background.');
        console.log(`PID: ${pid ?? child.pid ?? 'unknown'}`);
        console.log(`Logs: ${logPath}`);
    };

    const finishFailure = (reason, exitCode = 1) => {
        if (resolved) {
            return;
        }

        resolved = true;
        cleanup();
        summarizeFailure(logPath, reason, {
            startOffset: initialLogSize,
            showLogExcerpt: !sawStartupOutput,
        });
        process.exit(exitCode);
    };

    child.on('message', (message) => {
        if (!message || typeof message !== 'object') {
            return;
        }

        if (message.type === 'ready') {
            finishSuccess(message.pid);
            return;
        }

        if (message.type === 'failure') {
            finishFailure(message.reason, typeof message.exitCode === 'number' ? message.exitCode : 1);
        }
    });

    child.on('error', (error) => {
        finishFailure(`Failed to launch background service: ${error.message}`);
    });

    child.on('close', (code) => {
        if (!resolved) {
            finishFailure(`Background service exited before startup completed (exit code ${code ?? 1}).`, code ?? 1);
        }
    });
}

main();
