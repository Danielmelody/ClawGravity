/**
 * ErrorPopupDetector test — gRPC trajectory-based detection.
 *
 * The detector is now passive: evaluate() is called by TrajectoryStreamRouter
 * with trajectory data. Tests feed data directly via evaluate().
 */

import { ErrorPopupDetector, ErrorPopupDetectorOptions, ErrorPopupInfo } from '../../src/services/errorPopupDetector';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('ErrorPopupDetector', () => {
    let mockCdpService: jest.Mocked<CdpService>;

    beforeEach(() => {
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        (mockCdpService as any).executeVscodeCommand = jest.fn().mockResolvedValue({ ok: true });
    });

    function createDetector(overrides: Partial<ErrorPopupDetectorOptions> = {}): {
        detector: ErrorPopupDetector;
        onErrorPopup: jest.Mock;
        onResolved: jest.Mock;
    } {
        const onErrorPopup = jest.fn();
        const onResolved = jest.fn();
        const detector = new ErrorPopupDetector({
            cdpService: mockCdpService,
            onErrorPopup,
            onResolved,
            ...overrides,
        });
        return { detector, onErrorPopup, onResolved };
    }

    const IDLE = 'CASCADE_RUN_STATUS_IDLE';

    it('calls the onErrorPopup callback when an error step is detected', () => {
        const { detector, onErrorPopup } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [{ error: 'Something went wrong badly' }], IDLE);

        expect(onErrorPopup).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Agent Error',
                body: expect.stringContaining('Something went wrong badly'),
            }),
        );
    });

    it('does not call the callback multiple times when the same error is detected consecutively', () => {
        const { detector, onErrorPopup } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [{ error: 'Repeated error message' }], IDLE);
        detector.evaluate('cascade-1', [{ error: 'Repeated error message' }], IDLE);

        expect(onErrorPopup).toHaveBeenCalledTimes(1);
    });

    it('does not invoke callback after stop()', async () => {
        const { detector, onErrorPopup } = createDetector();
        detector.start();
        await detector.stop();

        detector.evaluate('cascade-1', [{ error: 'Error after stop' }], IDLE);

        expect(onErrorPopup).not.toHaveBeenCalled();
    });

    it('continues working even when evaluate data varies', () => {
        const { detector, onErrorPopup } = createDetector();
        detector.start();

        // First call with no error
        detector.evaluate('cascade-1', [], IDLE);
        expect(onErrorPopup).not.toHaveBeenCalled();

        // Second call with error
        detector.evaluate('cascade-1', [{ error: 'Real error after recovery' }], IDLE);
        expect(onErrorPopup).toHaveBeenCalled();
    });

    it('getLastDetectedInfo() returns the detected ErrorPopupInfo', () => {
        const { detector } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [{ plannerResponse: { error: 'Test error' } }], IDLE);

        const info = detector.getLastDetectedInfo();
        expect(info).not.toBeNull();
        expect(info?.title).toBe('Agent Error');
    });

    it('getLastDetectedInfo() returns null when error disappears', () => {
        const { detector } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [{ error: 'Transient' }], IDLE);
        expect(detector.getLastDetectedInfo()).not.toBeNull();

        // Error resolved
        detector.evaluate('cascade-1', [{ type: 'CORTEX_STEP_TYPE_USER_INPUT' }], IDLE);
        expect(detector.getLastDetectedInfo()).toBeNull();
    });

    it('calls onResolved when error state disappears', () => {
        const { detector, onResolved } = createDetector();
        detector.start();

        detector.evaluate('cascade-1', [{ error: 'Will resolve' }], IDLE);

        // Error resolved
        detector.evaluate('cascade-1', [], IDLE);

        expect(onResolved).toHaveBeenCalled();
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

    it('detects error patterns in response text when IDLE', () => {
        const { detector, onErrorPopup } = createDetector();
        detector.start();

        detector.evaluate(
            'cascade-1',
            [{ plannerResponse: { response: 'Agent terminated due to an error.' } }],
            IDLE,
        );

        expect(onErrorPopup).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Agent Error',
            }),
        );
    });

    it('detects network error patterns in response text when IDLE', () => {
        const { detector, onErrorPopup } = createDetector();
        detector.start();

        detector.evaluate(
            'cascade-2',
            [{ plannerResponse: { response: 'There was a network issue connecting to the server.' } }],
            IDLE,
        );

        expect(onErrorPopup).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Agent Error',
                body: expect.stringContaining('network issue'),
            }),
        );
    });
});
