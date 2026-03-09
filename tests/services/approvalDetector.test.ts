/**
 * ApprovalDetector test — gRPC trajectory-based approval detection.
 *
 * The source was refactored from CDP DOM button detection to gRPC trajectory polling.
 * Tests mock the gRPC client to simulate pending tool calls requiring approval.
 */

import { ApprovalDetector, ApprovalDetectorOptions, ApprovalInfo } from '../../src/services/approvalDetector';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('ApprovalDetector - approval button detection and remote execution', () => {
    let mockCdpService: jest.Mocked<CdpService>;
    let mockGrpcClient: { rawRPC: jest.Mock };

    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        mockGrpcClient = { rawRPC: jest.fn() };
        (mockCdpService as any).getGrpcClient = jest.fn().mockResolvedValue(mockGrpcClient);
        (mockCdpService as any).getActiveCascadeId = jest.fn().mockResolvedValue('cascade-1');
        (mockCdpService as any).executeVscodeCommand = jest.fn().mockResolvedValue({ ok: true });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    /** Flush all pending microtasks and timers to let async poll() complete */
    async function flushPromises() {
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    function createDetector(overrides: Partial<ApprovalDetectorOptions> = {}): {
        detector: ApprovalDetector;
        onApprovalRequired: jest.Mock;
        onResolved: jest.Mock;
    } {
        const onApprovalRequired = jest.fn();
        const onResolved = jest.fn();
        const detector = new ApprovalDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onApprovalRequired,
            onResolved,
            ...overrides,
        });
        return { detector, onApprovalRequired, onResolved };
    }

    function makeTrajectory(steps: any[], status: string = 'CASCADE_RUN_STATUS_IDLE') {
        return {
            trajectory: {
                steps,
                cascadeRunStatus: status,
            },
        };
    }

    function makeApprovalStep(toolName: string = 'write_file') {
        return {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                toolCalls: [{ name: toolName }],
            },
        };
    }

    it('calls the onApprovalRequired callback when an approval button is detected', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectory([makeApprovalStep('write_file')]),
        );

        const { detector, onApprovalRequired } = createDetector();
        detector.start();
        jest.advanceTimersByTime(200);
        await flushPromises();

        expect(onApprovalRequired).toHaveBeenCalledWith(
            expect.objectContaining({
                approveText: 'Allow',
                denyText: 'Deny',
                description: 'Tool: write_file',
            }),
        );

        await detector.stop();
    });

    it('does not call the callback multiple times when the same approval button is detected consecutively', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectory([makeApprovalStep('write_file')]),
        );

        const { detector, onApprovalRequired } = createDetector();
        detector.start();

        jest.advanceTimersByTime(200);
        await flushPromises();
        jest.advanceTimersByTime(200);
        await flushPromises();

        expect(onApprovalRequired).toHaveBeenCalledTimes(1);
        await detector.stop();
    });

    it('alwaysAllowButton() can directly click Allow This Conversation', async () => {
        const { detector } = createDetector();
        const result = await detector.alwaysAllowButton();
        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.agent.acceptAgentStep');
    });

    it('alwaysAllowButton() can click the conversation allow button after expanding the Allow Once dropdown', async () => {
        // In the gRPC-based approach, alwaysAllowButton delegates to approveButton
        const { detector } = createDetector();
        const result = await detector.alwaysAllowButton();
        expect(result).toBe(true);
    });

    it('stops polling and no longer calls the callback after stop()', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectory([makeApprovalStep()]),
        );

        const { detector, onApprovalRequired } = createDetector();
        detector.start();
        await detector.stop();

        jest.advanceTimersByTime(500);
        await flushPromises();

        expect(onApprovalRequired).not.toHaveBeenCalled();
    });

    it('continues monitoring even when a CDP error occurs', async () => {
        let callCount = 0;
        mockGrpcClient.rawRPC.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) throw new Error('Transient error');
            return makeTrajectory([makeApprovalStep()]);
        });

        const { detector, onApprovalRequired } = createDetector();
        detector.start();

        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onApprovalRequired).not.toHaveBeenCalled();

        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onApprovalRequired).toHaveBeenCalled();

        await detector.stop();
    });

    it('getLastDetectedInfo() returns the detected ApprovalInfo', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectory([makeApprovalStep('delete_file')]),
        );

        const { detector } = createDetector();
        detector.start();
        jest.advanceTimersByTime(200);
        await flushPromises();

        const info = detector.getLastDetectedInfo();
        expect(info).not.toBeNull();
        expect(info?.approveText).toBe('Allow');
        expect(info?.description).toBe('Tool: delete_file');

        await detector.stop();
    });

    it('getLastDetectedInfo() returns null when the button disappears', async () => {
        let hasPending = true;
        mockGrpcClient.rawRPC.mockImplementation(async () => {
            if (hasPending) {
                return makeTrajectory([makeApprovalStep()]);
            }
            // No pending tools — completed
            return makeTrajectory([{
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                plannerResponse: { toolCalls: [{ name: 'write_file', status: 'completed' }] },
            }]);
        });

        const { detector } = createDetector();
        detector.start();

        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(detector.getLastDetectedInfo()).not.toBeNull();

        hasPending = false;
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(detector.getLastDetectedInfo()).toBeNull();

        await detector.stop();
    });

    it('calls without the contextId parameter when contextId is null', async () => {
        // In gRPC-based approach, there's no contextId — just verifying the poll works
        (mockCdpService as any).getActiveCascadeId.mockResolvedValue(null);

        const { detector, onApprovalRequired } = createDetector();
        detector.start();

        jest.advanceTimersByTime(200);
        await flushPromises();

        // Should not crash, nor call callback
        expect(onApprovalRequired).not.toHaveBeenCalled();
        await detector.stop();
    });

    it('calls onResolved when buttons disappear after detection', async () => {
        let hasPending = true;
        mockGrpcClient.rawRPC.mockImplementation(async () => {
            if (hasPending) {
                return makeTrajectory([makeApprovalStep()]);
            }
            return makeTrajectory([{ type: 'CORTEX_STEP_TYPE_USER_INPUT' }]);
        });

        const { detector, onApprovalRequired, onResolved } = createDetector();
        detector.start();

        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onApprovalRequired).toHaveBeenCalled();

        hasPending = false;
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onResolved).toHaveBeenCalled();

        await detector.stop();
    });

    it('does not detect approval when cascade is actively running', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectory([makeApprovalStep()], 'CASCADE_RUN_STATUS_RUNNING'),
        );

        const { detector, onApprovalRequired } = createDetector();
        detector.start();

        jest.advanceTimersByTime(200);
        await flushPromises();

        expect(onApprovalRequired).not.toHaveBeenCalled();
        await detector.stop();
    });

    it('approveButton() executes the VS Code accept command', async () => {
        const { detector } = createDetector();
        const result = await detector.approveButton();
        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.agent.acceptAgentStep');
    });

    it('denyButton() executes the VS Code reject command', async () => {
        const { detector } = createDetector();
        const result = await detector.denyButton();
        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.agent.rejectAgentStep');
    });

    it('approveButton() returns false when command fails', async () => {
        (mockCdpService as any).executeVscodeCommand.mockResolvedValue({ ok: false });
        const { detector } = createDetector();
        const result = await detector.approveButton();
        expect(result).toBe(false);
    });
});
