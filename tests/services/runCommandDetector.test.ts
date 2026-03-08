/**
 * Run command dialog detection and remote execution TDD test
 *
 * Test strategy:
 *   - RunCommandDetector class is the test target
 *   - Mock CdpService with gRPC client to simulate trajectory polling
 *   - Verify that onRunCommandRequired callback is called upon detection
 *   - Verify duplicate prevention, stop behavior, and button clicks
 */

import { RunCommandDetector, RunCommandDetectorOptions, RunCommandInfo } from '../../src/services/runCommandDetector';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('RunCommandDetector - run command dialog detection and remote execution', () => {
    let detector: RunCommandDetector;
    let mockCdpService: jest.Mocked<CdpService>;
    let mockGrpcClient: { rawRPC: jest.Mock };

    beforeEach(() => {
        jest.useFakeTimers();
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        mockCdpService.getPrimaryContextId = jest.fn().mockReturnValue(42);
        mockCdpService.executeVscodeCommand = jest.fn();

        mockGrpcClient = { rawRPC: jest.fn() };
        (mockCdpService as any).getGrpcClient = jest.fn().mockResolvedValue(mockGrpcClient);
        (mockCdpService as any).getActiveCascadeId = jest.fn().mockResolvedValue('cascade-456');

        jest.clearAllMocks();
    });

    afterEach(async () => {
        if (detector) {
            await detector.stop();
        }
        jest.useRealTimers();
    });

    function makeRunCommandInfo(overrides: Partial<RunCommandInfo> = {}): RunCommandInfo {
        return {
            commandText: 'python3 -m http.server 8000',
            workingDirectory: '~/Code/login',
            runText: 'Run',
            rejectText: 'Reject',
            ...overrides,
        };
    }

    /**
     * Helper to build a gRPC trajectory with a pending terminal command.
     * Requires explicit pending status (matching the fix).
     */
    function makeTrajectoryWithCommand(opts: {
        command?: string;
        cwd?: string;
        toolName?: string;
        status?: string;
        cascadeStatus?: string;
    } = {}): any {
        const {
            command = 'python3 -m http.server 8000',
            cwd = '~/Code/login',
            toolName = 'run_command',
            status = 'pending',
            cascadeStatus = 'CASCADE_RUN_STATUS_IDLE',
        } = opts;
        return {
            trajectory: {
                cascadeRunStatus: cascadeStatus,
                steps: [
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
                ],
            },
        };
    }

    /** Helper for empty trajectory (no pending commands). */
    function makeEmptyTrajectory(): any {
        return {
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                steps: [],
            },
        };
    }

    /** Helper for trajectory with tool call without status (should NOT trigger). */
    function makeTrajectoryWithoutStatus(): any {
        return {
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                steps: [
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
                ],
            },
        };
    }

    /** Helper for trajectory with empty command text (should NOT trigger). */
    function makeTrajectoryWithEmptyCommand(): any {
        return {
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                steps: [
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
                ],
            },
        };
    }

    it('calls the onRunCommandRequired callback when a pending command is detected', async () => {
        const onRunCommandRequired = jest.fn();

        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryWithCommand());

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

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

    it('does not call the callback when no pending command exists', async () => {
        const onRunCommandRequired = jest.fn();
        mockGrpcClient.rawRPC.mockResolvedValue(makeEmptyTrajectory());

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(onRunCommandRequired).not.toHaveBeenCalled();
    });

    it('does NOT trigger for tool calls without explicit pending status', async () => {
        const onRunCommandRequired = jest.fn();
        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryWithoutStatus());

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(onRunCommandRequired).not.toHaveBeenCalled();
    });

    it('does NOT trigger for pending tool calls with empty command text', async () => {
        const onRunCommandRequired = jest.fn();
        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryWithEmptyCommand());

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(onRunCommandRequired).not.toHaveBeenCalled();
    });

    it('does not call the callback multiple times for the same command', async () => {
        const onRunCommandRequired = jest.fn();

        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryWithCommand());

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);

        expect(onRunCommandRequired).toHaveBeenCalledTimes(1);
    });

    it('calls callback again when a different command appears', async () => {
        const onRunCommandRequired = jest.fn();

        mockGrpcClient.rawRPC
            .mockResolvedValueOnce(makeTrajectoryWithCommand({ command: 'npm install' }))
            .mockResolvedValueOnce(makeTrajectoryWithCommand({ command: 'npm test' }));

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);

        expect(onRunCommandRequired).toHaveBeenCalledTimes(2);
        expect(onRunCommandRequired).toHaveBeenNthCalledWith(1, expect.objectContaining({ commandText: 'npm install' }));
        expect(onRunCommandRequired).toHaveBeenNthCalledWith(2, expect.objectContaining({ commandText: 'npm test' }));
    });

    it('executes the backend command when runButton() is called', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: true } as any);

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
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
            pollIntervalMs: 500,
            onRunCommandRequired: jest.fn(),
        });

        const result = await detector.rejectButton('Reject');

        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.terminalCommand.reject');
    });

    it('stops polling and no longer calls the callback after stop()', async () => {
        const onRunCommandRequired = jest.fn();

        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryWithCommand());

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        expect(onRunCommandRequired).toHaveBeenCalledTimes(1);

        await detector.stop();

        await jest.advanceTimersByTimeAsync(1000);
        expect(onRunCommandRequired).toHaveBeenCalledTimes(1);
    });

    it('continues monitoring even when a gRPC error occurs', async () => {
        const onRunCommandRequired = jest.fn();

        mockGrpcClient.rawRPC
            .mockRejectedValueOnce(new Error('gRPC error'))
            .mockResolvedValueOnce(makeTrajectoryWithCommand());

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500); // error
        await jest.advanceTimersByTimeAsync(500); // success

        expect(onRunCommandRequired).toHaveBeenCalledWith(
            expect.objectContaining({ commandText: 'python3 -m http.server 8000' }),
        );
    });

    it('getLastDetectedInfo() returns the detected RunCommandInfo', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectoryWithCommand({ command: 'ls -la', cwd: '~/projects' }),
        );

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired: jest.fn(),
        });

        expect(detector.getLastDetectedInfo()).toBeNull();

        detector.start();
        await jest.advanceTimersByTimeAsync(500);

        const info = detector.getLastDetectedInfo();
        expect(info).not.toBeNull();
        expect(info?.commandText).toBe('ls -la');
        expect(info?.workingDirectory).toBe('~/projects');
    });

    it('getLastDetectedInfo() returns null when the dialog disappears', async () => {
        mockGrpcClient.rawRPC
            .mockResolvedValueOnce(makeTrajectoryWithCommand())
            .mockResolvedValueOnce(makeEmptyTrajectory());

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired: jest.fn(),
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        expect(detector.getLastDetectedInfo()).not.toBeNull();

        await jest.advanceTimersByTimeAsync(500);
        expect(detector.getLastDetectedInfo()).toBeNull();
    });

    it('runButton() returns false when the backend command is unavailable', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: false } as any);

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
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
            pollIntervalMs: 500,
            onRunCommandRequired: jest.fn(),
        });
        const result = await detector.rejectButton();

        expect(result).toBe(false);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.terminalCommand.reject');
    });

    it('does not detect command when cascade status is RUNNING', async () => {
        const onRunCommandRequired = jest.fn();
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectoryWithCommand({ cascadeStatus: 'CASCADE_RUN_STATUS_RUNNING' }),
        );

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(onRunCommandRequired).not.toHaveBeenCalled();
    });

    it('calls onResolved when dialog disappears after detection', async () => {
        const onResolved = jest.fn();

        mockGrpcClient.rawRPC
            .mockResolvedValueOnce(makeTrajectoryWithCommand())
            .mockResolvedValueOnce(makeEmptyTrajectory());

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired: jest.fn(),
            onResolved,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        expect(onResolved).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(500);
        expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it('does not call onResolved when dialog was never detected', async () => {
        const onResolved = jest.fn();

        mockGrpcClient.rawRPC.mockResolvedValue(makeEmptyTrajectory());

        detector = new RunCommandDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onRunCommandRequired: jest.fn(),
            onResolved,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);

        expect(onResolved).not.toHaveBeenCalled();
    });
});
