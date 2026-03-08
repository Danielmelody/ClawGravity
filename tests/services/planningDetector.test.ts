/**
 * Planning mode button detection and remote execution TDD test
 *
 * Test strategy:
 *   - PlanningDetector class is the test target
 *   - Mock CdpService with gRPC client to simulate trajectory polling
 *   - Verify that onPlanningRequired callback is called upon detection
 *   - Verify clickOpenButton / clickProceedButton / extractPlanContent behavior
 *   - Verify duplicate prevention, stop, and error recovery
 */

import { PlanningDetector, PlanningDetectorOptions, PlanningInfo } from '../../src/services/planningDetector';
import { CdpService } from '../../src/services/cdpService';

// Mock CdpService
jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('PlanningDetector - planning button detection and remote execution', () => {
    let detector: PlanningDetector;
    let mockCdpService: jest.Mocked<CdpService>;
    let mockGrpcClient: { rawRPC: jest.Mock };

    beforeEach(() => {
        jest.useFakeTimers();
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        mockCdpService.getPrimaryContextId = jest.fn().mockReturnValue(42);
        mockCdpService.executeVscodeCommand = jest.fn();

        mockGrpcClient = { rawRPC: jest.fn() };
        (mockCdpService as any).getGrpcClient = jest.fn().mockResolvedValue(mockGrpcClient);
        (mockCdpService as any).getActiveCascadeId = jest.fn().mockResolvedValue('cascade-123');

        jest.clearAllMocks();
    });

    afterEach(async () => {
        if (detector) {
            await detector.stop();
        }
        jest.useRealTimers();
    });

    /** Helper to generate PlanningInfo for testing */
    function makePlanningInfo(overrides: Partial<PlanningInfo> = {}): PlanningInfo {
        return {
            openText: 'Open',
            proceedText: 'Proceed',
            planTitle: 'Implementation Plan',
            planSummary: 'Add authentication feature',
            description: 'This plan adds user authentication to the app.',
            ...overrides,
        };
    }

    /**
     * Helper to build a gRPC trajectory response that triggers planning detection.
     * Requires toolCalls to be present — this is the core planning mode signal.
     */
    function makeTrajectoryWithPlan(opts: {
        planResponse?: string;
        toolCalls?: any[];
        status?: string;
    } = {}): any {
        const {
            planResponse = 'This is a detailed implementation plan for the authentication feature that spans multiple steps and requires careful execution.',
            toolCalls = [{ name: 'write_to_file' }, { name: 'replace_file_content' }],
            status = 'CASCADE_RUN_STATUS_IDLE',
        } = opts;
        return {
            trajectory: {
                cascadeRunStatus: status,
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { text: 'Add auth' } },
                    {
                        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                        plannerResponse: {
                            response: planResponse,
                            toolCalls,
                        },
                    },
                ],
            },
        };
    }

    /** Helper for a trajectory with no plan (e.g. a normal response). */
    function makeTrajectoryNoToolCalls(opts: { status?: string; responseText?: string } = {}): any {
        const { status = 'CASCADE_RUN_STATUS_IDLE', responseText = 'Hello! How can I help?' } = opts;
        return {
            trajectory: {
                cascadeRunStatus: status,
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { text: 'hi' } },
                    {
                        type: 'CORTEX_STEP_TYPE_RESPONSE',
                        plannerResponse: {
                            response: responseText,
                        },
                    },
                ],
            },
        };
    }

    /** Helper for an empty trajectory. */
    function makeEmptyTrajectory(): any {
        return {
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                steps: [],
            },
        };
    }

    // ──────────────────────────────────────────────────────
    // Test 1: Call onPlanningRequired when tool plan is detected
    // ──────────────────────────────────────────────────────
    it('calls the onPlanningRequired callback when planning tool calls are detected', async () => {
        const onPlanningRequired = jest.fn();

        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryWithPlan());

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(onPlanningRequired).toHaveBeenCalledTimes(1);
        expect(onPlanningRequired).toHaveBeenCalledWith(
            expect.objectContaining({
                openText: 'Open',
                proceedText: 'Proceed',
                planTitle: 'Implementation Plan',
            }),
        );
    });

    // ──────────────────────────────────────────────────────
    // Test 2: Do not call the callback when no tool calls exist
    // ──────────────────────────────────────────────────────
    it('does not call the callback when no planning tool calls exist', async () => {
        const onPlanningRequired = jest.fn();
        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryNoToolCalls());

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(onPlanningRequired).not.toHaveBeenCalled();
    });

    // ──────────────────────────────────────────────────────
    // Test 2b: Long response without tool calls does NOT trigger planning
    // ──────────────────────────────────────────────────────
    it('does NOT trigger planning for a long response with no tool calls', async () => {
        const onPlanningRequired = jest.fn();
        const longText = 'A'.repeat(500); // Long but no tool calls
        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryNoToolCalls({ responseText: longText }));

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(onPlanningRequired).not.toHaveBeenCalled();
    });

    // ──────────────────────────────────────────────────────
    // Test 3: No duplicate calls for the same plan detected consecutively
    // ──────────────────────────────────────────────────────
    it('does not call the callback multiple times when the same plan is detected', async () => {
        const onPlanningRequired = jest.fn();

        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryWithPlan());

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);

        expect(onPlanningRequired).toHaveBeenCalledTimes(1);
    });

    // ──────────────────────────────────────────────────────
    // Test 3b: Dedup uses cascadeId + planTitle + planSummary
    // ──────────────────────────────────────────────────────
    it('treats detections in the same cascade with same plan as duplicate', async () => {
        const onPlanningRequired = jest.fn();

        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryWithPlan());

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);

        expect(onPlanningRequired).toHaveBeenCalledTimes(1);
    });

    // ──────────────────────────────────────────────────────
    // Test 3c: Cooldown suppresses rapid re-detection after key reset
    // ──────────────────────────────────────────────────────
    it('suppresses re-detection within 5s cooldown even after key reset', async () => {
        const onPlanningRequired = jest.fn();

        mockGrpcClient.rawRPC
            .mockResolvedValueOnce(makeTrajectoryWithPlan())         // detected
            .mockResolvedValueOnce(makeEmptyTrajectory())            // disappear (key reset)
            .mockResolvedValueOnce(makeTrajectoryWithPlan());        // re-detected

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);  // detect
        expect(onPlanningRequired).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(500);  // disappear
        await jest.advanceTimersByTimeAsync(500);  // re-detect within cooldown (1500ms total)

        // Still only 1 notification due to cooldown
        expect(onPlanningRequired).toHaveBeenCalledTimes(1);
    });

    // ──────────────────────────────────────────────────────
    // Test 4: clickOpenButton() uses VS Code command
    // ──────────────────────────────────────────────────────
    it('uses VS Code command when clickOpenButton() is called', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: true } as any);

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
        });

        const result = await detector.clickOpenButton('Open');

        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.command.openPlan');
    });

    // ──────────────────────────────────────────────────────
    // Test 5: clickProceedButton() uses the backend command
    // ──────────────────────────────────────────────────────
    it('executes the backend command when clickProceedButton() is called', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: true } as any);

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
        });

        const result = await detector.clickProceedButton('Proceed');

        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.command.accept');
    });

    // ──────────────────────────────────────────────────────
    // Test 6: extractPlanContent() returns plan text from trajectory
    // ──────────────────────────────────────────────────────
    it('extractPlanContent() returns the plan text from the trajectory', async () => {
        const planText = '# Implementation Plan\n\n## Step 1\nDo something\n\n## Step 2\nDo something else';
        mockGrpcClient.rawRPC.mockResolvedValue({
            trajectory: {
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { text: 'plan this' } },
                    {
                        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                        plannerResponse: { response: planText },
                    },
                ],
            },
        });

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
        });

        const content = await detector.extractPlanContent();

        expect(content).toBe(planText);
    });

    // ──────────────────────────────────────────────────────
    // Test 7: extractPlanContent() returns null when no content
    // ──────────────────────────────────────────────────────
    it('extractPlanContent() returns null when no plan content is found', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(makeEmptyTrajectory());

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
        });

        const content = await detector.extractPlanContent();

        expect(content).toBeNull();
    });

    // ──────────────────────────────────────────────────────
    // Test 8: Polling stops after stop()
    // ──────────────────────────────────────────────────────
    it('stops polling and no longer calls the callback after stop()', async () => {
        const onPlanningRequired = jest.fn();

        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryWithPlan());

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        expect(onPlanningRequired).toHaveBeenCalledTimes(1);

        await detector.stop();

        // Polling after stop is skipped
        await jest.advanceTimersByTimeAsync(1000);
        expect(onPlanningRequired).toHaveBeenCalledTimes(1); // does not increase
    });

    // ──────────────────────────────────────────────────────
    // Test 9: Monitoring continues on gRPC error
    // ──────────────────────────────────────────────────────
    it('continues monitoring even when a gRPC error occurs', async () => {
        const onPlanningRequired = jest.fn();

        mockGrpcClient.rawRPC
            .mockRejectedValueOnce(new Error('gRPC error'))
            .mockResolvedValueOnce(makeTrajectoryWithPlan({
                toolCalls: [{ name: 'recovery_action' }],
            }));

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500); // error
        await jest.advanceTimersByTimeAsync(500); // success

        expect(onPlanningRequired).toHaveBeenCalledTimes(1);
    });

    // ──────────────────────────────────────────────────────
    // Test 10: getLastDetectedInfo() returns detected info
    // ──────────────────────────────────────────────────────
    it('getLastDetectedInfo() returns the detected PlanningInfo', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryWithPlan());

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
        });

        // null before detection
        expect(detector.getLastDetectedInfo()).toBeNull();

        detector.start();
        await jest.advanceTimersByTimeAsync(500);

        const info = detector.getLastDetectedInfo();
        expect(info).not.toBeNull();
        expect(info?.planTitle).toBe('Implementation Plan');
    });

    // ──────────────────────────────────────────────────────
    // Test 11: lastDetectedInfo resets when plan disappears
    // ──────────────────────────────────────────────────────
    it('getLastDetectedInfo() returns null when plan disappears', async () => {
        mockGrpcClient.rawRPC
            .mockResolvedValueOnce(makeTrajectoryWithPlan())  // 1st: detected
            .mockResolvedValueOnce(makeEmptyTrajectory());    // 2nd: disappeared

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500); // detection
        expect(detector.getLastDetectedInfo()).not.toBeNull();

        await jest.advanceTimersByTimeAsync(500); // disappearance
        expect(detector.getLastDetectedInfo()).toBeNull();
    });

    // ──────────────────────────────────────────────────────
    // Test 12: clickOpenButton() without arguments works
    // ──────────────────────────────────────────────────────
    it('clickOpenButton() without arguments uses VS Code command', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: true } as any);

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
        });

        const result = await detector.clickOpenButton();

        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.command.openPlan');
    });

    // ──────────────────────────────────────────────────────
    // Test 13: clickProceedButton() returns false when the backend command is unavailable
    // ──────────────────────────────────────────────────────
    it('clickProceedButton() returns false when the backend command is unavailable', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: false } as any);

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
        });
        const result = await detector.clickProceedButton();

        expect(result).toBe(false);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.command.accept');
    });

    // ──────────────────────────────────────────────────────
    // Test 14: Does not detect planning when status is RUNNING
    // ──────────────────────────────────────────────────────
    it('does not detect planning when cascade status is RUNNING', async () => {
        const onPlanningRequired = jest.fn();
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectoryWithPlan({ status: 'CASCADE_RUN_STATUS_RUNNING' }),
        );

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(onPlanningRequired).not.toHaveBeenCalled();
    });

    // ──────────────────────────────────────────────────────
    // Test 15: isActive() returns correct state
    // ──────────────────────────────────────────────────────
    it('isActive() returns true while running and false after stop', async () => {
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
        });

        expect(detector.isActive()).toBe(false);

        detector.start();
        expect(detector.isActive()).toBe(true);

        await detector.stop();
        expect(detector.isActive()).toBe(false);
    });

    // ──────────────────────────────────────────────────────
    // Test 15b: Module loads correctly
    // ──────────────────────────────────────────────────────
    it('PlanningDetector class is exported and defined', () => {
        const planningDetectorModule = require('../../src/services/planningDetector');
        expect(planningDetectorModule.PlanningDetector).toBeDefined();
    });

    // ──────────────────────────────────────────────────────
    // Test 16: extractPlanContent() returns null on gRPC error
    // ──────────────────────────────────────────────────────
    it('extractPlanContent() returns null when a gRPC error occurs', async () => {
        (mockCdpService as any).getGrpcClient = jest.fn().mockResolvedValue(null);

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
        });

        const content = await detector.extractPlanContent();

        expect(content).toBeNull();
    });

    // ──────────────────────────────────────────────────────
    // onResolved callback tests
    // ──────────────────────────────────────────────────────
    it('calls onResolved when plan disappears after detection', async () => {
        const onResolved = jest.fn();

        mockGrpcClient.rawRPC
            .mockResolvedValueOnce(makeTrajectoryWithPlan())   // detected
            .mockResolvedValueOnce(makeEmptyTrajectory());     // disappeared

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
            onResolved,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500); // detection
        expect(onResolved).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(500); // disappearance
        expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it('does not call onResolved when plan was never detected', async () => {
        const onResolved = jest.fn();

        mockGrpcClient.rawRPC.mockResolvedValue(makeEmptyTrajectory());

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            onPlanningRequired: jest.fn(),
            onResolved,
        });
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);

        expect(onResolved).not.toHaveBeenCalled();
    });
});
