const path = require('path');
const { spawn } = require('child_process');

function main() {
    const cwd = process.cwd();
    const logPath = path.resolve(cwd, 'logs', 'claw-gravity.log');
    const serviceScript = path.resolve(__dirname, 'start-service.cjs');

    const child = spawn(process.execPath, [serviceScript], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
            ...process.env,
            CLAW_GRAVITY_BACKGROUND: '1',
        },
    });

    child.unref();

    console.log(`ClawGravity is starting in background.`);
    console.log(`PID: ${child.pid ?? 'unknown'}`);
    console.log(`Logs: ${logPath}`);
}

main();
