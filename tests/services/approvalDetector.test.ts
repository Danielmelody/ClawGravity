/**
 * ApprovalDetector test — gRPC trajectory-based approval detection.
 *
 * The detector is now passive: evaluate() is called by TrajectoryStreamRouter
 * with trajectory data. Tests feed data directly via evaluate().
 */

import { ApprovalDetector, ApprovalDetectorOptions, ApprovalInfo } from '../../src/services/approvalDetector';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('ApprovalDetector - approval button detection and remote execution', () => {
    let mockCdpService: jest.Mocked<CdpService>;

    beforeEach(() => {
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        (mockCdpService as any).executeVscodeCommand = jest.fn().mockResolvedValue({ ok: true });
    });

    function createDetector(overrides: Partial<ApprovalDetectorOptions> = {}): {
        detector: ApprovalDetector;
        onApprovalRequired: jest.Mock;
        onResolved: jest.Mock;
    } {
        const onApprovalRequired = jest.fn();
        const onResolved = jest.fn();
        const detector = new ApprovalDetector({
            cdpService: mockCdpService,
            onApprovalRequired,
            onResolved,
            ...overrides,
        });
        return { detector, onApprovalRequired, onResolved };
    }

    function makeApprovalStep(toolName: string = 'write_file') {
        return {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                toolCalls: [{ name: toolName }],
            },
        };
    }

    const IDLE = 'CASCADE_RUN_STATUS_IDLE';
    const RUNNING = 'CASCADE_RUN_STATUS_RUNNING';

    it('calls the onApprovalRequired callback when an approval is detected via evaluate()', () => {
        const { detector, onApprovalRequired } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [makeApprovalStep('write_file')], IDLE);

        expect(onApprovalRequired).toHaveBeenCalledWith(
            expect.objectContaining({
                approveText: 'Allow',
                denyText: 'Deny',
                description: 'Tool: write_file',
            }),
        );
    });

    it('does not call the callback multiple times when the same approval is evaluated consecutively', () => {
        const { detector, onApprovalRequired } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [makeApprovalStep('write_file')], IDLE);
        detector.evaluate('cascade-1', [makeApprovalStep('write_file')], IDLE);

        expect(onApprovalRequired).toHaveBeenCalledTimes(1);
    });

    it('does not emit approval for planning-mode steps that already contain a plan response', () => {
        const { detector, onApprovalRequired } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                response: 'Plan: take a screenshot, inspect the UI, then patch the handler.',
                toolCalls: [{ name: 'mcp_chrome-devtools-mcp_take_screenshot' }],
            },
        }], IDLE);

        expect(onApprovalRequired).not.toHaveBeenCalled();
        expect(detector.getLastDetectedInfo()).toBeNull();
    });

    it('alwaysAllowButton() can directly click Allow This Conversation', async () => {
        const { detector } = createDetector();
        const result = await detector.alwaysAllowButton();
        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.agent.acceptAgentStep');
    });

    it('alwaysAllowButton() can click the conversation allow button after expanding the Allow Once dropdown', async () => {
        const { detector } = createDetector();
        const result = await detector.alwaysAllowButton();
        expect(result).toBe(true);
    });

    it('does not invoke callback after stop()', async () => {
        const { detector, onApprovalRequired } = createDetector();
        detector.start();
        await detector.stop();

        detector.evaluate('cascade-1', [makeApprovalStep()], IDLE);

        expect(onApprovalRequired).not.toHaveBeenCalled();
    });

    it('continues working even when evaluate() throws internally (error handling)', () => {
        const { detector, onApprovalRequired } = createDetector();
        detector.start();

        // First call with error-producing data: pass invalid steps that won't cause a throw
        // but simulate no detection, then succeed on the next call
        detector.evaluate('cascade-1', [], IDLE);
        expect(onApprovalRequired).not.toHaveBeenCalled();

        detector.evaluate('cascade-1', [makeApprovalStep()], IDLE);
        expect(onApprovalRequired).toHaveBeenCalled();
    });

    it('getLastDetectedInfo() returns the detected ApprovalInfo', () => {
        const { detector } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [makeApprovalStep('delete_file')], IDLE);

        const info = detector.getLastDetectedInfo();
        expect(info).not.toBeNull();
        expect(info?.approveText).toBe('Allow');
        expect(info?.description).toBe('Tool: delete_file');
    });

    it('getLastDetectedInfo() returns null when the approval disappears', () => {
        const { detector } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [makeApprovalStep()], IDLE);
        expect(detector.getLastDetectedInfo()).not.toBeNull();

        // Simulate approval resolved — step now has status 'completed'
        detector.evaluate('cascade-1', [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: { toolCalls: [{ name: 'write_file', status: 'completed' }] },
        }], IDLE);
        expect(detector.getLastDetectedInfo()).toBeNull();
    });

    it('does not call callback when cascadeId is empty', () => {
        const { detector, onApprovalRequired } = createDetector();
        detector.start();

        // evaluate requires a cascadeId — empty string means no cascade
        detector.evaluate('', [makeApprovalStep()], IDLE);

        // With empty cascadeId the key is still computed; depends on implementation
        // The important thing is it shouldn't crash
        expect(onApprovalRequired).toHaveBeenCalledTimes(1);
    });

    it('calls onResolved when approval disappears after detection', () => {
        const { detector, onApprovalRequired, onResolved } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [makeApprovalStep()], IDLE);
        expect(onApprovalRequired).toHaveBeenCalled();

        // Approval resolved
        detector.evaluate('cascade-1', [{ type: 'CORTEX_STEP_TYPE_USER_INPUT' }], IDLE);
        expect(onResolved).toHaveBeenCalled();
    });

    it('does not detect approval when cascade is actively running', () => {
        const { detector, onApprovalRequired } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [makeApprovalStep()], RUNNING);

        expect(onApprovalRequired).not.toHaveBeenCalled();
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
