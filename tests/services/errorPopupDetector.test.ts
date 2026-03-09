/**
 * ErrorPopupDetector test — gRPC trajectory-based detection.
 *
 * The source was refactored from CDP DOM detection to gRPC trajectory polling.
 * Tests mock the gRPC client to simulate error trajectories.
 */

import { ErrorPopupDetector, ErrorPopupDetectorOptions, ErrorPopupInfo } from '../../src/services/errorPopupDetector';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('ErrorPopupDetector', () => {
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
        // Use real setImmediate to let the promise chain fully drain
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    function createDetector(overrides: Partial<ErrorPopupDetectorOptions> = {}): {
        detector: ErrorPopupDetector;
        onErrorPopup: jest.Mock;
        onResolved: jest.Mock;
    } {
        const onErrorPopup = jest.fn();
        const onResolved = jest.fn();
        const detector = new ErrorPopupDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onErrorPopup,
            onResolved,
            ...overrides,
        });
        return { detector, onErrorPopup, onResolved };
    }

    function makeTrajectory(steps: any[], status?: string) {
        return {
            trajectory: {
                steps,
                cascadeRunStatus: status || 'CASCADE_RUN_STATUS_IDLE',
            },
        };
    }

    it('calls the onErrorPopup callback when an error step is detected', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectory([{ error: 'Something went wrong badly' }]),
        );

        const { detector, onErrorPopup } = createDetector();
        detector.start();
        jest.advanceTimersByTime(200);
        await flushPromises();

        expect(onErrorPopup).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Agent Error',
                body: expect.stringContaining('Something went wrong badly'),
            }),
        );

        await detector.stop();
    });

    it('does not call the callback multiple times when the same error is detected consecutively', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectory([{ error: 'Repeated error message' }]),
        );

        const { detector, onErrorPopup } = createDetector();
        detector.start();

        // First poll
        jest.advanceTimersByTime(200);
        await flushPromises();
        // Second poll with same error
        jest.advanceTimersByTime(200);
        await flushPromises();

        expect(onErrorPopup).toHaveBeenCalledTimes(1);
        await detector.stop();
    });

    it('stops polling and no longer calls the callback after stop()', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectory([{ error: 'Error after stop' }]),
        );

        const { detector, onErrorPopup } = createDetector();
        detector.start();
        await detector.stop();

        jest.advanceTimersByTime(500);
        await flushPromises();

        expect(onErrorPopup).not.toHaveBeenCalled();
    });

    it('continues monitoring even when a gRPC error occurs', async () => {
        let callCount = 0;
        mockGrpcClient.rawRPC.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) throw new Error('Transient gRPC error');
            return makeTrajectory([{ error: 'Real error after recovery' }]);
        });

        const { detector, onErrorPopup } = createDetector();
        detector.start();

        // First poll — throws
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onErrorPopup).not.toHaveBeenCalled();

        // Second poll — succeeds with error
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onErrorPopup).toHaveBeenCalled();

        await detector.stop();
    });

    it('getLastDetectedInfo() returns the detected ErrorPopupInfo', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectory([{ plannerResponse: { error: 'Test error' } }]),
        );

        const { detector } = createDetector();
        detector.start();
        jest.advanceTimersByTime(200);
        await flushPromises();

        const info = detector.getLastDetectedInfo();
        expect(info).not.toBeNull();
        expect(info?.title).toBe('Agent Error');

        await detector.stop();
    });

    it('getLastDetectedInfo() returns null when error disappears', async () => {
        let hasError = true;
        mockGrpcClient.rawRPC.mockImplementation(async () => {
            if (hasError) {
                return makeTrajectory([{ error: 'Transient' }]);
            }
            return makeTrajectory([{ type: 'CORTEX_STEP_TYPE_USER_INPUT' }]);
        });

        const { detector } = createDetector();
        detector.start();

        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(detector.getLastDetectedInfo()).not.toBeNull();

        hasError = false;
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(detector.getLastDetectedInfo()).toBeNull();

        await detector.stop();
    });

    it('calls onResolved when error state disappears', async () => {
        let hasError = true;
        mockGrpcClient.rawRPC.mockImplementation(async () => {
            if (hasError) {
                return makeTrajectory([{ error: 'Will resolve' }]);
            }
            return makeTrajectory([]);
        });

        const { detector, onResolved } = createDetector();
        detector.start();

        jest.advanceTimersByTime(200);
        await flushPromises();

        hasError = false;
        jest.advanceTimersByTime(200);
        await flushPromises();

        expect(onResolved).toHaveBeenCalled();
        await detector.stop();
    });

    it('clickRetryButton() executes VS Code command', async () => {
        const { detector } = createDetector();
        const result = await detector.clickRetryButton();
        expect(result).toBe(true);
        expect(mockCdpService.executeVscodeCommand).toHaveBeenCalledWith('antigravity.command.retry');
    });

    it('clickDismissButton() returns true (no-op)', async () => {
        const { detector } = createDetector();
        const result = await detector.clickDismissButton();
        expect(result).toBe(true);
    });

    it('clickCopyDebugInfoButton() returns false (not supported)', async () => {
        const { detector } = createDetector();
        const result = await detector.clickCopyDebugInfoButton();
        expect(result).toBe(false);
    });

    it('readClipboard() returns null (not supported)', async () => {
        const { detector } = createDetector();
        const result = await detector.readClipboard();
        expect(result).toBeNull();
    });

    it('detects error patterns in response text when IDLE', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(
            makeTrajectory(
                [{ plannerResponse: { response: 'Agent terminated due to an error.' } }],
                'CASCADE_RUN_STATUS_IDLE',
            ),
        );

        const { detector, onErrorPopup } = createDetector();
        detector.start();
        jest.advanceTimersByTime(200);
        await flushPromises();

        expect(onErrorPopup).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Agent Error',
            }),
        );
        await detector.stop();
    });
});
