const {
    LOCK_FILE,
    SERVICE_PID_FILE,
    getBackgroundStatus,
    removePidFile,
    stopProcess,
} = require('./background-process-utils.cjs');

function cleanupStaleFiles(status) {
    let cleaned = 0;

    if (status.app.stale) {
        if (removePidFile(LOCK_FILE, status.app.pid)) {
            cleaned += 1;
        }
    }

    if (status.service.stale) {
        if (removePidFile(SERVICE_PID_FILE, status.service.pid)) {
            cleaned += 1;
        }
    }

    return cleaned;
}

function main() {
    const initialStatus = getBackgroundStatus();
    const initialCleanupCount = cleanupStaleFiles(initialStatus);

    if (!initialStatus.app.running && !initialStatus.service.running) {
        console.log('ClawGravity background is not running.');
        if (initialCleanupCount > 0) {
            console.log(`Cleaned ${initialCleanupCount} stale PID file(s).`);
        }
        return;
    }

    if (initialStatus.app.running) {
        const result = stopProcess(initialStatus.app.pid);
        if (!result.stopped) {
            console.error(`Failed to stop bot process ${initialStatus.app.pid}.`);
            process.exit(1);
        }
        removePidFile(LOCK_FILE, initialStatus.app.pid);
        console.log(`Stopped bot PID ${initialStatus.app.pid} via ${result.method}.`);
    }

    const serviceStatus = getBackgroundStatus();
    if (serviceStatus.service.running) {
        const result = stopProcess(serviceStatus.service.pid);
        if (!result.stopped) {
            console.error(`Failed to stop background service process ${serviceStatus.service.pid}.`);
            process.exit(1);
        }
        removePidFile(SERVICE_PID_FILE, serviceStatus.service.pid);
        console.log(`Stopped service PID ${serviceStatus.service.pid} via ${result.method}.`);
    }

    const finalStatus = getBackgroundStatus();
    const finalCleanupCount = cleanupStaleFiles(finalStatus);

    if (finalStatus.app.running || finalStatus.service.running) {
        console.error('ClawGravity background is still running after stop attempt.');
        process.exit(1);
    }

    if (finalCleanupCount > 0) {
        console.log(`Cleaned ${finalCleanupCount} stale PID file(s).`);
    }

    console.log('ClawGravity background stopped.');
}

main();
