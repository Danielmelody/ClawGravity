jest.mock('fs', () => ({
    existsSync: jest.fn(),
}));

jest.mock('child_process', () => ({
    spawn: jest.fn(),
    execSync: jest.fn(),
}));

jest.mock('../../src/utils/lockfile', () => ({
    releaseCurrentLock: jest.fn(),
}));

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import {
    clearShutdownHooks,
    registerShutdownHook,
    resolveRestartLaunchSpec,
    runShutdownHooks,
    spawnReplacementProcess,
} from '../../src/services/processRestartService';

describe('processRestartService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearShutdownHooks();
    });

    it('resolves a JavaScript CLI entrypoint to a start command', () => {
        const spec = resolveRestartLaunchSpec(
            ['node', 'dist/bin/cli.js', 'restart'],
            '/node',
            '/repo',
        );
        const resolvedCli = path.resolve('/repo', 'dist/bin/cli.js');

        expect(spec).toEqual({
            executable: '/node',
            args: [resolvedCli, 'start'],
            displayCommand: `/node ${resolvedCli} start`,
        });
    });

    it('resolves a TypeScript CLI entrypoint through local ts-node', () => {
        (fs.existsSync as jest.Mock).mockImplementation((target: string) =>
            target === 'C:\\repo\\node_modules\\ts-node\\dist\\bin.js',
        );

        const spec = resolveRestartLaunchSpec(
            ['node', 'src/bin/cli.ts', 'restart'],
            'C:\\node.exe',
            'C:\\repo',
        );

        expect(spec).toEqual({
            executable: 'C:\\node.exe',
            args: ['C:\\repo\\node_modules\\ts-node\\dist\\bin.js', 'C:\\repo\\src\\bin\\cli.ts', 'start'],
            displayCommand: 'C:\\node.exe C:\\repo\\node_modules\\ts-node\\dist\\bin.js C:\\repo\\src\\bin\\cli.ts start',
        });
    });

    it('spawns a detached replacement process that waits for the current pid', () => {
        const unref = jest.fn();
        (spawn as jest.Mock).mockReturnValue({ pid: 4321, unref });

        const result = spawnReplacementProcess({ detached: true, stdio: 'ignore', waitForPid: 1234 });

        expect(result.ok).toBe(true);
        expect(spawn).toHaveBeenCalledWith(
            process.execPath,
            expect.arrayContaining(['start']),
            expect.objectContaining({
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                env: expect.objectContaining({
                    CLAW_GRAVITY_WAIT_FOR_PID: '1234',
                }),
            }),
        );
        expect(unref).toHaveBeenCalled();
    });

    it('runs registered shutdown hooks in reverse registration order', async () => {
        const calls: string[] = [];
        registerShutdownHook('first', () => { calls.push('first'); });
        registerShutdownHook('second', () => { calls.push('second'); });

        await runShutdownHooks();

        expect(calls).toEqual(['second', 'first']);
    });
});
