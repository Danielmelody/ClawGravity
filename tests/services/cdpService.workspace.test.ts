import { CdpService } from '../../src/services/cdpService';
import * as child_process from 'child_process';
import { EventEmitter } from 'events';
import * as pathUtils from '../../src/utils/pathUtils';

// Mock logger to avoid printing during tests
jest.mock('../../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        done: jest.fn(),
    }
}));

// Mock child_process for spawn
jest.mock('child_process');

// Mock ws to prevent actual WebSocket connections
jest.mock('ws', () => {
    return jest.fn().mockImplementation(() => {
        const emitter = new (require('events').EventEmitter)();
        Object.assign(emitter, {
            close: jest.fn(),
            send: jest.fn(),
            readyState: 1, // OPEN
            removeAllListeners: jest.fn().mockReturnThis(),
        });
        // Immediately trigger 'open' event
        process.nextTick(() => emitter.emit('open'));
        return emitter;
    });
});

describe('CdpService - Cross-Platform Workspace Launching', () => {
    let service: CdpService;
    let originalPlatform: NodeJS.Platform;
    let originalEnv: NodeJS.ProcessEnv;
    let mockRunCommand: jest.SpyInstance;
    let mockGetJson: jest.SpyInstance;

    beforeEach(() => {
        originalPlatform = process.platform;
        originalEnv = { ...process.env };

        service = new CdpService({ portsToScan: [9999], maxReconnectAttempts: 0 });

        // Mock internal methods — getJson must be mocked to prevent real HTTP calls
        mockGetJson = jest.spyOn(service as any, 'getJson').mockRejectedValue(new Error('Connection refused'));
        mockRunCommand = jest.spyOn(service as any, 'runCommand').mockResolvedValue(undefined);

        // Mock connect to avoid real WebSocket connections
        jest.spyOn(service as any, 'connect').mockResolvedValue(undefined);
        // Mock call for CDP calls
        jest.spyOn(service as any, 'call').mockResolvedValue({ result: { value: '' } });
        // Mock probeWorkbenchPages to return false (no existing pages match)
        jest.spyOn(service as any, 'probeWorkbenchPages').mockResolvedValue(false);

        // Clear static launch cooldown timestamps to prevent cross-test interference
        CdpService.clearLaunchCooldowns();
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        process.env = originalEnv;
        jest.resetAllMocks();
    });

    const setPlatform = (platform: NodeJS.Platform) => {
        Object.defineProperty(process, 'platform', { value: platform });
    };

    /**
     * Helper: first getJson call returns a non-workbench page (so respondingPort is set),
     * then subsequent calls return the new workbench page. This avoids the "ports not responding" error.
     */
    function setupGetJsonForLaunch(page: any) {
        mockGetJson
            // First scan: port responds with a non-workbench page (e.g. extension host)
            .mockResolvedValueOnce([{ id: 'ext-host', type: 'other', url: 'chrome-extension://foo' }])
            // Poll after launch: resolves with the new workbench page
            .mockResolvedValue([page]);
    }

    describe('launchAndConnectWorkspace (Mac)', () => {
        it('should launch Antigravity using the Mac application path', async () => {
            setPlatform('darwin');

            setupGetJsonForLaunch({
                id: 'new-id',
                type: 'page',
                title: 'MyProject',
                webSocketDebuggerUrl: 'ws://debug',
                url: 'file:///workbench'
            });

            const workspacePath = '/Users/test/Documents/MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity',
                ['--new-window', workspacePath]
            );
        });

        it('throws when the CLI launch fails on Mac', async () => {
            setPlatform('darwin');

            setupGetJsonForLaunch({
                id: 'new-id',
                type: 'page',
                title: 'MyProject',
                webSocketDebuggerUrl: 'ws://debug',
                url: 'file:///workbench'
            });

            mockRunCommand.mockRejectedValueOnce(new Error('Command not found'));

            const workspacePath = '/Users/test/Documents/MyProject';
            await expect(service.discoverAndConnectForWorkspace(workspacePath)).rejects.toThrow('Command not found');

            expect(mockRunCommand).toHaveBeenCalledTimes(1);
            expect(mockRunCommand).toHaveBeenCalledWith(
                '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity',
                ['--new-window', workspacePath]
            );
        });
    });

    describe('launchAndConnectWorkspace (Windows)', () => {
        it('should launch Antigravity using LOCALAPPDATA environment variable', async () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = 'C:\\Users\\TestUser\\AppData\\Local';

            setupGetJsonForLaunch({
                id: 'new-id',
                type: 'page',
                title: 'MyProject',
                webSocketDebuggerUrl: 'ws://debug',
                url: 'file:///workbench'
            });

            const workspacePath = 'C:\\Source\\MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                'C:\\Users\\TestUser\\AppData\\Local\\Programs\\Antigravity\\bin\\antigravity.cmd',
                ['--new-window', workspacePath]
            );
        });

        it('should fallback to Antigravity.exe if LOCALAPPDATA is missing on Windows', async () => {
            setPlatform('win32');
            delete process.env.LOCALAPPDATA;

            setupGetJsonForLaunch({
                id: 'new-id',
                type: 'page',
                title: 'MyProject',
                webSocketDebuggerUrl: 'ws://debug',
                url: 'file:///workbench'
            });

            const workspacePath = 'C:\\Source\\MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                'antigravity',
                ['--new-window', workspacePath]
            );
        });
    });

    describe('launchAndConnectWorkspace (Linux / Unknown)', () => {
        it('should default to `antigravity` command if ANTIGRAVITY_PATH is not set', async () => {
            setPlatform('linux');
            delete process.env.ANTIGRAVITY_PATH;

            setupGetJsonForLaunch({
                id: 'new-id',
                type: 'page',
                title: 'MyProject',
                webSocketDebuggerUrl: 'ws://debug',
                url: 'file:///workbench'
            });

            const workspacePath = '/home/user/MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                'antigravity',
                ['--new-window', workspacePath]
            );
        });

        it('should use ANTIGRAVITY_PATH if it is set', async () => {
            setPlatform('linux');
            process.env.ANTIGRAVITY_PATH = '/opt/custom/antigravity.AppImage';

            setupGetJsonForLaunch({
                id: 'new-id',
                type: 'page',
                title: 'MyProject',
                webSocketDebuggerUrl: 'ws://debug',
                url: 'file:///workbench'
            });

            const workspacePath = '/home/user/MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                '/opt/custom/antigravity.AppImage',
                ['--new-window', workspacePath]
            );
        });
    });

    describe('Project Name Extraction', () => {
        it('should extract the project name from a Windows path with backslashes', async () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = 'C:\\Users\\TestUser\\AppData\\Local';

            setupGetJsonForLaunch({
                id: 'new-id',
                type: 'page',
                title: 'LazyGravity',
                webSocketDebuggerUrl: 'ws://debug',
                url: 'file:///workbench'
            });

            const workspacePath = 'C:\\Source\\LazyGravity';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(service.getCurrentWorkspaceName()).toBe('LazyGravity');
        });

        it('should extract the project name from a Mac/Linux path with forward slashes', async () => {
            setPlatform('darwin');

            setupGetJsonForLaunch({
                id: 'new-id',
                type: 'page',
                title: 'my-cool-project',
                webSocketDebuggerUrl: 'ws://debug',
                url: 'file:///workbench'
            });

            const workspacePath = '/Users/test/Documents/my-cool-project';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(service.getCurrentWorkspaceName()).toBe('my-cool-project');
        });

        it('should extract the project name from a path with trailing slashes', async () => {
            setPlatform('linux');

            setupGetJsonForLaunch({
                id: 'new-id',
                type: 'page',
                title: 'trailing-slash-proj',
                webSocketDebuggerUrl: 'ws://debug',
                url: 'file:///workbench'
            });

            const workspacePath = '/home/user/trailing-slash-proj/';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(service.getCurrentWorkspaceName()).toBe('trailing-slash-proj');
        });
    });
});
