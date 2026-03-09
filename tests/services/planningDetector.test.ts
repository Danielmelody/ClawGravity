/**
 * Planning mode button detection and remote execution TDD test
 *
 * The detector is now passive: evaluate() is called by TrajectoryStreamRouter
 * with trajectory data. Tests feed data directly via evaluate().
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

    const IDLE = 'CASCADE_RUN_STATUS_IDLE';
    const RUNNING = 'CASCADE_RUN_STATUS_RUNNING';

    function makePlanSteps(opts: {
        planResponse?: string;
        toolCalls?: any[];
    } = {}): any[] {
        const {
            planResponse = 'This is a detailed implementation plan for the authentication feature that spans multiple steps and requires careful execution.',
            toolCalls = [{ name: 'write_to_file' }, { name: 'replace_file_content' }],
        } = opts;
        return [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { text: 'Add auth' } },
            {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                plannerResponse: {
                    response: planResponse,
                    toolCalls,
                },
            },
        ];
    }

    function makeNoToolCallSteps(responseText: string = 'Hello! How can I help?'): any[] {
        return [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { text: 'hi' } },
            {
                type: 'CORTEX_STEP_TYPE_RESPONSE',
                plannerResponse: {
                    response: responseText,
                },
            },
        ];
    }

    // Test 1: Call onPlanningRequired when tool plan is detected
    it('calls the onPlanningRequired callback when planning tool calls are detected', () => {
        const onPlanningRequired = jest.fn();
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired,
        });
        detector.start();

        detector.evaluate('cascade-123', makePlanSteps(), IDLE);

        expect(onPlanningRequired).toHaveBeenCalledTimes(1);
        expect(onPlanningRequired).toHaveBeenCalledWith(
            expect.objectContaining({
                openText: 'Open',
                proceedText: 'Proceed',
                planTitle: 'Implementation Plan',
            }),
        );
    });

    // Test 2: Do not call the callback when no tool calls exist
    it('does not call the callback when no planning tool calls exist', () => {
        const onPlanningRequired = jest.fn();
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired,
        });
        detector.start();

        detector.evaluate('cascade-123', makeNoToolCallSteps(), IDLE);

        expect(onPlanningRequired).not.toHaveBeenCalled();
    });

    // Test 2b: Long response without tool calls does NOT trigger planning
    it('does NOT trigger planning for a long response with no tool calls', () => {
        const onPlanningRequired = jest.fn();
        const longText = 'A'.repeat(500);
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired,
        });
        detector.start();

        detector.evaluate('cascade-123', makeNoToolCallSteps(longText), IDLE);

        expect(onPlanningRequired).not.toHaveBeenCalled();
    });

    // Test 3: No duplicate calls for the same plan detected consecutively
    it('does not call the callback multiple times when the same plan is detected', () => {
        const onPlanningRequired = jest.fn();
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired,
        });
        detector.start();

        const steps = makePlanSteps();
        detector.evaluate('cascade-123', steps, IDLE);
        detector.evaluate('cascade-123', steps, IDLE);
        detector.evaluate('cascade-123', steps, IDLE);

        expect(onPlanningRequired).toHaveBeenCalledTimes(1);
    });

    // Test 3b: Dedup uses cascadeId + planTitle + planSummary
    it('treats detections in the same cascade with same plan as duplicate', () => {
        const onPlanningRequired = jest.fn();
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired,
        });
        detector.start();

        const steps = makePlanSteps();
        detector.evaluate('cascade-123', steps, IDLE);
        detector.evaluate('cascade-123', steps, IDLE);

        expect(onPlanningRequired).toHaveBeenCalledTimes(1);
    });

    // Test 3c: Cooldown suppresses rapid re-detection after key reset
    it('suppresses re-detection within 5s cooldown even after key reset', () => {
        const onPlanningRequired = jest.fn();
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired,
        });
        detector.start();

        // First detection
        detector.evaluate('cascade-123', makePlanSteps(), IDLE);
        expect(onPlanningRequired).toHaveBeenCalledTimes(1);

        // Plan disappears (key reset)
        detector.evaluate('cascade-123', [], IDLE);

        // Re-detection within cooldown (Date.now() hasn't advanced enough)
        detector.evaluate('cascade-123', makePlanSteps(), IDLE);

        // Still only 1 notification due to cooldown
        expect(onPlanningRequired).toHaveBeenCalledTimes(1);
    });

    // Test 4: clickOpenButton() uses VS Code command
    it('uses VS Code command when clickOpenButton() is called', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: true } as any);
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired: jest.fn(),
        });

        const result = await detector.clickOpenButton('Open');

        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.command.openPlan');
    });

    // Test 5: clickProceedButton() uses the backend command
    it('executes the backend command when clickProceedButton() is called', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: true } as any);
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired: jest.fn(),
        });

        const result = await detector.clickProceedButton('Proceed');

        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.command.accept');
    });

    // Test 6: extractPlanContent() returns plan text from trajectory
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
            onPlanningRequired: jest.fn(),
        });

        const content = await detector.extractPlanContent();
        expect(content).toBe(planText);
    });

    // Test 7: extractPlanContent() returns null when no content
    it('extractPlanContent() returns null when no plan content is found', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue({
            trajectory: {
                cascadeRunStatus: IDLE,
                steps: [],
            },
        });

        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired: jest.fn(),
        });

        const content = await detector.extractPlanContent();
        expect(content).toBeNull();
    });

    // Test 8: Does not invoke callback after stop()
    it('does not invoke callback after stop()', async () => {
        const onPlanningRequired = jest.fn();
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired,
        });
        detector.start();

        detector.evaluate('cascade-123', makePlanSteps(), IDLE);
        expect(onPlanningRequired).toHaveBeenCalledTimes(1);

        await detector.stop();

        // Evaluate after stop should be ignored
        detector.evaluate('cascade-123', makePlanSteps({ toolCalls: [{ name: 'new_action' }] }), IDLE);
        expect(onPlanningRequired).toHaveBeenCalledTimes(1);
    });

    // Test 10: getLastDetectedInfo() returns detected info
    it('getLastDetectedInfo() returns the detected PlanningInfo', () => {
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired: jest.fn(),
        });

        expect(detector.getLastDetectedInfo()).toBeNull();

        detector.start();
        detector.evaluate('cascade-123', makePlanSteps(), IDLE);

        const info = detector.getLastDetectedInfo();
        expect(info).not.toBeNull();
        expect(info?.planTitle).toBe('Implementation Plan');
    });

    // Test 11: lastDetectedInfo resets when plan disappears
    it('getLastDetectedInfo() returns null when plan disappears', () => {
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired: jest.fn(),
        });
        detector.start();

        detector.evaluate('cascade-123', makePlanSteps(), IDLE);
        expect(detector.getLastDetectedInfo()).not.toBeNull();

        detector.evaluate('cascade-123', [], IDLE);
        expect(detector.getLastDetectedInfo()).toBeNull();
    });

    // Test 12: clickOpenButton() without arguments works
    it('clickOpenButton() without arguments uses VS Code command', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: true } as any);
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired: jest.fn(),
        });

        const result = await detector.clickOpenButton();
        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.command.openPlan');
    });

    // Test 13: clickProceedButton() returns false when the backend command is unavailable
    it('clickProceedButton() returns false when the backend command is unavailable', async () => {
        mockCdpService.executeVscodeCommand.mockResolvedValue({ ok: false } as any);
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired: jest.fn(),
        });
        const result = await detector.clickProceedButton();
        expect(result).toBe(false);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.command.accept');
    });

    // Test 14: Does not detect planning when status is RUNNING
    it('does not detect planning when cascade status is RUNNING', () => {
        const onPlanningRequired = jest.fn();
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired,
        });
        detector.start();

        detector.evaluate('cascade-123', makePlanSteps(), RUNNING);

        expect(onPlanningRequired).not.toHaveBeenCalled();
    });

    // Test 15: isActive() returns correct state
    it('isActive() returns true while running and false after stop', async () => {
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired: jest.fn(),
        });

        expect(detector.isActive()).toBe(false);
        detector.start();
        expect(detector.isActive()).toBe(true);
        await detector.stop();
        expect(detector.isActive()).toBe(false);
    });

    // Test 15b: Module loads correctly
    it('PlanningDetector class is exported and defined', () => {
        const planningDetectorModule = require('../../src/services/planningDetector');
        expect(planningDetectorModule.PlanningDetector).toBeDefined();
    });

    // Test 16: extractPlanContent() returns null on gRPC error
    it('extractPlanContent() returns null when a gRPC error occurs', async () => {
        (mockCdpService as any).getGrpcClient = jest.fn().mockResolvedValue(null);
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired: jest.fn(),
        });

        const content = await detector.extractPlanContent();
        expect(content).toBeNull();
    });

    // onResolved callback tests
    it('calls onResolved when plan disappears after detection', () => {
        const onResolved = jest.fn();
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired: jest.fn(),
            onResolved,
        });
        detector.start();

        detector.evaluate('cascade-123', makePlanSteps(), IDLE);
        expect(onResolved).not.toHaveBeenCalled();

        detector.evaluate('cascade-123', [], IDLE);
        expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it('does not call onResolved when plan was never detected', () => {
        const onResolved = jest.fn();
        detector = new PlanningDetector({
            cdpService: mockCdpService,
            onPlanningRequired: jest.fn(),
            onResolved,
        });
        detector.start();

        detector.evaluate('cascade-123', [], IDLE);
        detector.evaluate('cascade-123', [], IDLE);

        expect(onResolved).not.toHaveBeenCalled();
    });
});
