const {
    getBackgroundStatus,
} = require('./background-process-utils.cjs');

function main() {
    const status = getBackgroundStatus();

    console.log(`ClawGravity background status: ${status.state}`);
    console.log(`Logs: ${status.logPath}`);

    if (status.app.running) {
        console.log(`Bot PID: ${status.app.pid}`);
    } else if (status.app.stale) {
        console.log(`Bot PID file is stale: ${status.app.pid} (${status.lockFile})`);
    }

    if (status.service.running) {
        console.log(`Service PID: ${status.service.pid}`);
    } else if (status.service.stale) {
        console.log(`Service PID file is stale: ${status.service.pid} (${status.servicePidFile})`);
    }

    if (status.state === 'starting') {
        console.log('The background service is still running startup checks/build steps.');
    }
}

main();
