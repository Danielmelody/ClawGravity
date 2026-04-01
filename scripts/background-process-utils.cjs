const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const cwd = path.resolve(__dirname, '..');
const LOCK_FILE = path.resolve(cwd, '.bot.lock');
const SERVICE_PID_FILE = path.resolve(cwd, '.claw-gravity-service.pid');
const LOG_PATH = path.resolve(cwd, 'logs', 'claw-gravity.log');

function readPidFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function writePidFile(filePath, pid) {
    fs.writeFileSync(filePath, `${pid}\n`, 'utf8');
}

function removePidFile(filePath, expectedPid) {
    if (!fs.existsSync(filePath)) {
        return false;
    }

    if (expectedPid == null) {
        fs.unlinkSync(filePath);
        return true;
    }

    const currentPid = readPidFile(filePath);
    if (currentPid !== expectedPid) {
        return false;
    }

    fs.unlinkSync(filePath);
    return true;
}

function isProcessRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function sleep(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        // Busy wait. Fine here because these scripts are short-lived.
    }
}

function stopProcess(pid) {
    if (!isProcessRunning(pid)) {
        return {
            pid,
            stopped: true,
            method: 'not-running',
        };
    }

    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        return {
            pid,
            stopped: !isProcessRunning(pid),
            method: 'sigterm',
        };
    }

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (!isProcessRunning(pid)) {
            return {
                pid,
                stopped: true,
                method: 'sigterm',
            };
        }

        sleep(100);
    }

    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
        });

        return {
            pid,
            stopped: !isProcessRunning(pid),
            method: 'taskkill',
        };
    }

    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // Ignore if the process exited between checks.
    }

    return {
        pid,
        stopped: !isProcessRunning(pid),
        method: 'sigkill',
    };
}

function readTrackedProcess(filePath) {
    const pid = readPidFile(filePath);
    if (pid == null) {
        return {
            pid: null,
            running: false,
            stale: false,
        };
    }

    const running = isProcessRunning(pid);
    return {
        pid,
        running,
        stale: !running,
    };
}

function getBackgroundStatus() {
    const app = readTrackedProcess(LOCK_FILE);
    const service = readTrackedProcess(SERVICE_PID_FILE);

    let state = 'stopped';
    if (app.running) {
        state = 'running';
    } else if (service.running) {
        state = 'starting';
    }

    return {
        state,
        app,
        service,
        cwd,
        lockFile: LOCK_FILE,
        servicePidFile: SERVICE_PID_FILE,
        logPath: LOG_PATH,
    };
}

module.exports = {
    LOCK_FILE,
    LOG_PATH,
    SERVICE_PID_FILE,
    getBackgroundStatus,
    isProcessRunning,
    readPidFile,
    removePidFile,
    stopProcess,
    writePidFile,
};
