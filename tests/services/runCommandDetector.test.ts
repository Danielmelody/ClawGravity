/**
 * Run command dialog detection and remote execution TDD test
 *
 * The detector is now passive: evaluate() is called by TrajectoryStreamRouter
 * with trajectory data. Tests feed data directly via evaluate().
 */

import { RunCommandDetector, RunCommandDetectorOptions, RunCommandInfo } from '../../src/services/runCommandDetector';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('RunCommandDetector - run command dialog detection and remote execution', () => {
    let detector: RunCommandDetector;
    let mockCdpService: jest.Mocked<CdpService>;

    beforeEach(() => {
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        mockCdpService.getPrimaryContextId = jest.fn().mockReturnValue(42);
        mockCdpService.executeVscodeCommand = jest.fn();
        jest.clearAllMocks();
    });

    afterEach(async () => {
        if (detector) {
            await detector.stop();
        }
    });

    const IDLE = 'CASCADE_RUN_STATUS_IDLE';
    const RUNNING = 'CASCADE_RUN_STATUS_RUNNING';

    function makeSteps(opts: {
        command?: string;
        cwd?: string;
        toolName?: string;
        status?: string;
    } = {}): any[] {
        const {
            command = 'python3 -m http.server 8000',
            cwd = '~/Code/login',
            toolName = 'run_command',
            status = 'pending',
        } = opts;
        return [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { text: 'start server' } },
            {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                plannerResponse: {
                    toolCalls: [{
                        name: toolName,
                        status,
                        arguments: { command, cwd },
                    }],
                },
            },
        ];
    }

    function makeStepsWithoutStatus(): any[] {
        return [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { text: 'hi' } },
            {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                plannerResponse: {
                    toolCalls: [{
                        name: 'run_command',
                        // No status field!
                        arguments: { command: 'echo hi' },
                    }],
                },
            },
        ];
    }

    function makeStepsWithEmptyCommand(): any[] {
        return [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { text: 'hi' } },
            {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                plannerResponse: {
                    toolCalls: [{
                        name: 'run_command',
                        status: 'pending',
                        arguments: {},
                    }],
                },
            },
        ];
    }

    it('calls the onRunCommandRequired callback when a pending command is detected', () => {
        const onRunCommandRequired = jest.fn();
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired,
        });
        detector.start();

        detector.evaluate('cascade-456', makeSteps(), IDLE);

        expect(onRunCommandRequired).toHaveBeenCalledTimes(1);
        expect(onRunCommandRequired).toHaveBeenCalledWith(
            expect.objectContaining({
                commandText: 'python3 -m http.server 8000',
                workingDirectory: '~/Code/login',
                runText: 'Run',
                rejectText: 'Reject',
            }),
        );
    });

    it('does not call the callback when no pending command exists', () => {
        const onRunCommandRequired = jest.fn();
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired,
        });
        detector.start();

        detector.evaluate('cascade-456', [], IDLE);

        expect(onRunCommandRequired).not.toHaveBeenCalled();
    });

    it('detects pending run_command even when the planner tool call omits an explicit status', () => {
        const onRunCommandRequired = jest.fn();
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired,
        });
        detector.start();

        detector.evaluate('cascade-456', makeStepsWithoutStatus(), IDLE);

        expect(onRunCommandRequired).toHaveBeenCalledTimes(1);
        expect(onRunCommandRequired).toHaveBeenCalledWith(
            expect.objectContaining({
                commandText: 'echo hi',
            }),
        );
    });

    it('does NOT trigger for pending tool calls with empty command text', () => {
        const onRunCommandRequired = jest.fn();
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired,
        });
        detector.start();

        detector.evaluate('cascade-456', makeStepsWithEmptyCommand(), IDLE);

        expect(onRunCommandRequired).not.toHaveBeenCalled();
    });

    it('does not trigger for a historical run_command whose concrete step is already canceled', () => {
        const onRunCommandRequired = jest.fn();
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired,
        });
        detector.start();

        detector.evaluate('cascade-456', [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { text: 'start server' } },
            {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                plannerResponse: {
                    toolCalls: [{
                        id: 'tool-run',
                        name: 'run_command',
                        argumentsJson: JSON.stringify({ CommandLine: 'echo hi', Cwd: '~/Code/login' }),
                    }],
                },
            },
            {
                type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                status: 'CORTEX_STEP_STATUS_CANCELED',
                metadata: {
                    toolCall: { id: 'tool-run', name: 'run_command' },
                },
            },
        ], IDLE);

        expect(onRunCommandRequired).not.toHaveBeenCalled();
        expect(detector.getLastDetectedInfo()).toBeNull();
    });

    it('does not call the callback multiple times for the same command', () => {
        const onRunCommandRequired = jest.fn();
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired,
        });
        detector.start();

        detector.evaluate('cascade-456', makeSteps(), IDLE);
        detector.evaluate('cascade-456', makeSteps(), IDLE);
        detector.evaluate('cascade-456', makeSteps(), IDLE);

        expect(onRunCommandRequired).toHaveBeenCalledTimes(1);
    });

    it('calls callback again when a different command appears', () => {
        const onRunCommandRequired = jest.fn();
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired,
        });
        detector.start();

        detector.evaluate('cascade-456', makeSteps({ command: 'npm install' }), IDLE);
        detector.evaluate('cascade-456', makeSteps({ command: 'npm test' }), IDLE);

        expect(onRunCommandRequired).toHaveBeenCalledTimes(2);
        expect(onRunCommandRequired).toHaveBeenNthCalledWith(1, expect.objectContaining({ commandText: 'npm install' }));
        expect(onRunCommandRequired).toHaveBeenNthCalledWith(2, expect.objectContaining({ commandText: 'npm test' }));
    });

    it('executes the backend command when runButton() is called', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: true } as any);
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired: jest.fn(),
        });

        const result = await detector.runButton('Run');

        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.terminalCommand.run');
    });

    it('executes the backend command when rejectButton() is called', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: true } as any);
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired: jest.fn(),
        });

        const result = await detector.rejectButton('Reject');

        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.terminalCommand.reject');
    });

    it('does not invoke callback after stop()', async () => {
        const onRunCommandRequired = jest.fn();
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired,
        });
        detector.start();

        detector.evaluate('cascade-456', makeSteps(), IDLE);
        expect(onRunCommandRequired).toHaveBeenCalledTimes(1);

        await detector.stop();

        detector.evaluate('cascade-456', makeSteps({ command: 'other cmd' }), IDLE);
        expect(onRunCommandRequired).toHaveBeenCalledTimes(1);
    });

    it('getLastDetectedInfo() returns the detected RunCommandInfo', () => {
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired: jest.fn(),
        });

        expect(detector.getLastDetectedInfo()).toBeNull();

        detector.start();
        detector.evaluate('cascade-456', makeSteps({ command: 'ls -la', cwd: '~/projects' }), IDLE);

        const info = detector.getLastDetectedInfo();
        expect(info).not.toBeNull();
        expect(info?.commandText).toBe('ls -la');
        expect(info?.workingDirectory).toBe('~/projects');
    });

    it('getLastDetectedInfo() returns null when the dialog disappears', () => {
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired: jest.fn(),
        });
        detector.start();

        detector.evaluate('cascade-456', makeSteps(), IDLE);
        expect(detector.getLastDetectedInfo()).not.toBeNull();

        detector.evaluate('cascade-456', [], IDLE);
        expect(detector.getLastDetectedInfo()).toBeNull();
    });

    it('runButton() returns false when the backend command is unavailable', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: false } as any);
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired: jest.fn(),
        });
        const result = await detector.runButton();

        expect(result).toBe(false);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.terminalCommand.run');
    });

    it('rejectButton() returns false when the backend command is unavailable', async () => {
        mockCdpService.executeVscodeCommand.mockRejectedValue(new Error('command failed'));
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired: jest.fn(),
        });
        const result = await detector.rejectButton();

        expect(result).toBe(false);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.terminalCommand.reject');
    });

    it('does not detect command when cascade status is RUNNING', () => {
        const onRunCommandRequired = jest.fn();
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired,
        });
        detector.start();

        detector.evaluate('cascade-456', makeSteps(), RUNNING);

        expect(onRunCommandRequired).not.toHaveBeenCalled();
    });

    it('calls onResolved when dialog disappears after detection', () => {
        const onResolved = jest.fn();
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired: jest.fn(),
            onResolved,
        });
        detector.start();

        detector.evaluate('cascade-456', makeSteps(), IDLE);
        expect(onResolved).not.toHaveBeenCalled();

        detector.evaluate('cascade-456', [], IDLE);
        expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it('does not call onResolved when dialog was never detected', () => {
        const onResolved = jest.fn();
        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            onRunCommandRequired: jest.fn(),
            onResolved,
        });
        detector.start();

        detector.evaluate('cascade-456', [], IDLE);
        detector.evaluate('cascade-456', [], IDLE);

        expect(onResolved).not.toHaveBeenCalled();
    });
});
