/**
 * UserMessageDetector test — gRPC-based user message detection.
 *
 * The detector is now passive: evaluateSummaries() is called by
 * TrajectoryStreamRouter with cascade summaries. Tests feed data directly.
 */

import { UserMessageDetector, UserMessageDetectorOptions } from '../../src/services/userMessageDetector';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('UserMessageDetector', () => {
    let mockCdpService: jest.Mocked<CdpService>;
    let mockGrpcClient: { rawRPC: jest.Mock };

    beforeEach(() => {
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        mockGrpcClient = { rawRPC: jest.fn() };
        (mockCdpService as any).getGrpcClient = jest.fn().mockResolvedValue(mockGrpcClient);
    });

    function createDetector(overrides: Partial<UserMessageDetectorOptions> = {}): {
        detector: UserMessageDetector;
        onUserMessage: jest.Mock;
    } {
        const onUserMessage = jest.fn();
        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            onUserMessage,
            ...overrides,
        });
        return { detector, onUserMessage };
    }

    function makeSummaries(entries: Record<string, { lastUserInputTime: string; lastUserInputStepIndex: number }>) {
        return entries;
    }

    function makeTrajectoryDetail(userText: string) {
        return {
            trajectory: {
                steps: [{
                    userInput: {
                        items: [{ text: userText }],
                    },
                }],
            },
        };
    }

    it('detects a new user message after priming', async () => {
        const time1 = '2026-01-01T00:00:00Z';
        const time2 = '2026-01-01T00:00:05Z';

        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryDetail('Hello from user'));

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // First call: priming
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: time1, lastUserInputStepIndex: 0 },
        }));
        expect(onUserMessage).not.toHaveBeenCalled();

        // Second call: new message detected
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: time2, lastUserInputStepIndex: 0 },
        }));
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'Hello from user' }),
        );

        detector.stop();
    });

    it('primes with empty summaries and detects first real message', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryDetail('First real message'));

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // Priming (empty)
        await detector.evaluateSummaries({});
        expect(onUserMessage).not.toHaveBeenCalled();

        // First real message
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:01:00Z', lastUserInputStepIndex: 0 },
        }));
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'First real message' }),
        );

        detector.stop();
    });

    it('does not call onUserMessage for duplicate messages', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryDetail('Same message'));

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // Prime
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:00Z', lastUserInputStepIndex: 0 },
        }));

        // Second — detect
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:01Z', lastUserInputStepIndex: 0 },
        }));

        // Third — same text hash, should be deduped by seenHashes
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:02Z', lastUserInputStepIndex: 0 },
        }));

        expect(onUserMessage).toHaveBeenCalledTimes(1);

        detector.stop();
    });

    it('detects new message after different message', async () => {
        let getCallIdx = 0;
        const messages = ['First message', 'Second different message'];
        mockGrpcClient.rawRPC.mockImplementation(async () => {
            return makeTrajectoryDetail(messages[Math.min(getCallIdx++, messages.length - 1)]);
        });

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // Prime
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:00Z', lastUserInputStepIndex: 0 },
        }));

        // First new message
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:01Z', lastUserInputStepIndex: 0 },
        }));
        expect(onUserMessage).toHaveBeenCalledTimes(1);

        // Second different message
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:02Z', lastUserInputStepIndex: 0 },
        }));
        expect(onUserMessage).toHaveBeenCalledTimes(2);

        detector.stop();
    });

    it('seenHashes prevents re-detection of old messages after a different message appears', async () => {
        let getCallIdx = 0;
        const messages = ['Hello', 'World', 'Hello']; // 'Hello' appears twice
        mockGrpcClient.rawRPC.mockImplementation(async () => {
            return makeTrajectoryDetail(messages[Math.min(getCallIdx++, messages.length - 1)]);
        });

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // Prime
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:00Z', lastUserInputStepIndex: 0 },
        }));
        // Detect 'Hello'
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:01Z', lastUserInputStepIndex: 0 },
        }));
        // Detect 'World'
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:02Z', lastUserInputStepIndex: 0 },
        }));
        // 'Hello' again — should be skipped by seenHashes
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:03Z', lastUserInputStepIndex: 0 },
        }));

        expect(onUserMessage).toHaveBeenCalledTimes(2);

        detector.stop();
    });

    it('seenHashes are cleared on restart', async () => {
        mockGrpcClient.rawRPC.mockResolvedValue(makeTrajectoryDetail('Same message'));

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // Prime
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:00Z', lastUserInputStepIndex: 0 },
        }));
        // Detect
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:01Z', lastUserInputStepIndex: 0 },
        }));
        expect(onUserMessage).toHaveBeenCalledTimes(1);

        // Restart clears seenHashes
        detector.stop();
        detector.start();

        // Prime again
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:02Z', lastUserInputStepIndex: 0 },
        }));
        // Should detect 'Same message' again after restart
        await detector.evaluateSummaries(makeSummaries({
            'c-1': { lastUserInputTime: '2026-01-01T00:00:03Z', lastUserInputStepIndex: 0 },
        }));

        expect(onUserMessage).toHaveBeenCalledTimes(2);

        detector.stop();
    });
});
