/**
 * UserMessageDetector test — gRPC-based user message detection.
 *
 * The source was refactored from CDP DOM polling to gRPC trajectory polling.
 * Tests mock the gRPC client to simulate incoming user messages.
 */

import { UserMessageDetector, UserMessageDetectorOptions } from '../../src/services/userMessageDetector';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('UserMessageDetector', () => {
    let mockCdpService: jest.Mocked<CdpService>;
    let mockGrpcClient: { rawRPC: jest.Mock };

    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        mockGrpcClient = { rawRPC: jest.fn() };
        (mockCdpService as any).getGrpcClient = jest.fn().mockResolvedValue(mockGrpcClient);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    /** Flush all pending microtasks to let async poll() complete */
    async function flushPromises() {
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    function createDetector(overrides: Partial<UserMessageDetectorOptions> = {}): {
        detector: UserMessageDetector;
        onUserMessage: jest.Mock;
    } {
        const onUserMessage = jest.fn();
        const detector = new UserMessageDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 100,
            onUserMessage,
            ...overrides,
        });
        return { detector, onUserMessage };
    }

    function makeTrajectorySummaries(entries: Record<string, { lastUserInputTime: string; lastUserInputStepIndex: number }>) {
        return { trajectorySummaries: entries };
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

        let callIdx = 0;
        mockGrpcClient.rawRPC.mockImplementation(async (method: string) => {
            if (method === 'GetAllCascadeTrajectories') {
                callIdx++;
                if (callIdx === 1) {
                    // Priming call
                    return makeTrajectorySummaries({
                        'c-1': { lastUserInputTime: time1, lastUserInputStepIndex: 0 },
                    });
                }
                // Second call — new message
                return makeTrajectorySummaries({
                    'c-1': { lastUserInputTime: time2, lastUserInputStepIndex: 0 },
                });
            }
            if (method === 'GetCascadeTrajectory') {
                return makeTrajectoryDetail('Hello from user');
            }
            return {};
        });

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // First poll: priming
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onUserMessage).not.toHaveBeenCalled();

        // Second poll: new message detected
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'Hello from user' }),
        );

        detector.stop();
    });

    it('primes with empty DOM and detects first real message', async () => {
        let callIdx = 0;
        mockGrpcClient.rawRPC.mockImplementation(async (method: string) => {
            if (method === 'GetAllCascadeTrajectories') {
                callIdx++;
                if (callIdx === 1) {
                    // Empty summaries during priming
                    return { trajectorySummaries: {} };
                }
                return makeTrajectorySummaries({
                    'c-1': { lastUserInputTime: '2026-01-01T00:01:00Z', lastUserInputStepIndex: 0 },
                });
            }
            return makeTrajectoryDetail('First real message');
        });

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // Priming (empty)
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onUserMessage).not.toHaveBeenCalled();

        // First real message
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'First real message' }),
        );

        detector.stop();
    });

    it('does not call onUserMessage for duplicate messages', async () => {
        const time1 = '2026-01-01T00:00:00Z';
        const time2 = '2026-01-01T00:00:01Z';
        const time3 = '2026-01-01T00:00:02Z';

        let callIdx = 0;
        mockGrpcClient.rawRPC.mockImplementation(async (method: string) => {
            if (method === 'GetAllCascadeTrajectories') {
                callIdx++;
                const times = [time1, time2, time3];
                return makeTrajectorySummaries({
                    'c-1': { lastUserInputTime: times[Math.min(callIdx - 1, 2)], lastUserInputStepIndex: 0 },
                });
            }
            return makeTrajectoryDetail('Same message');
        });

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // Prime
        jest.advanceTimersByTime(200);
        await flushPromises();

        // Second poll - detect
        jest.advanceTimersByTime(200);
        await flushPromises();

        // Third poll - same text hash, different time → should be deduped by seenHashes
        jest.advanceTimersByTime(200);
        await flushPromises();

        expect(onUserMessage).toHaveBeenCalledTimes(1);

        detector.stop();
    });

    it('detects new message after different message', async () => {
        const times = ['2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', '2026-01-01T00:00:02Z'];
        const messages = ['Priming msg', 'First message', 'Second different message'];
        let callIdx = 0;

        mockGrpcClient.rawRPC.mockImplementation(async (method: string) => {
            if (method === 'GetAllCascadeTrajectories') {
                callIdx++;
                const idx = Math.min(callIdx - 1, 2);
                return makeTrajectorySummaries({
                    'c-1': { lastUserInputTime: times[idx], lastUserInputStepIndex: 0 },
                });
            }
            // Return different messages for each GetCascadeTrajectory call
            const msgIdx = Math.min(callIdx - 1, 2);
            return makeTrajectoryDetail(messages[msgIdx]);
        });

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // Prime
        jest.advanceTimersByTime(200);
        await flushPromises();

        // First new message
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onUserMessage).toHaveBeenCalledTimes(1);

        // Second different message
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onUserMessage).toHaveBeenCalledTimes(2);

        detector.stop();
    });

    it('seenHashes prevents re-detection of old messages after a different message appears', async () => {
        const times = [
            '2026-01-01T00:00:00Z',
            '2026-01-01T00:00:01Z',
            '2026-01-01T00:00:02Z',
            '2026-01-01T00:00:03Z',
        ];
        const messages = ['Priming', 'Hello', 'World', 'Hello']; // 'Hello' appears twice
        let callIdx = 0;

        mockGrpcClient.rawRPC.mockImplementation(async (method: string) => {
            if (method === 'GetAllCascadeTrajectories') {
                callIdx++;
                const idx = Math.min(callIdx - 1, 3);
                return makeTrajectorySummaries({
                    'c-1': { lastUserInputTime: times[idx], lastUserInputStepIndex: 0 },
                });
            }
            const msgIdx = Math.min(callIdx - 1, 3);
            return makeTrajectoryDetail(messages[msgIdx]);
        });

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // Prime
        jest.advanceTimersByTime(200);
        await flushPromises();
        // Detect 'Hello'
        jest.advanceTimersByTime(200);
        await flushPromises();
        // Detect 'World'
        jest.advanceTimersByTime(200);
        await flushPromises();
        // 'Hello' again — should be skipped by seenHashes
        jest.advanceTimersByTime(200);
        await flushPromises();

        expect(onUserMessage).toHaveBeenCalledTimes(2);

        detector.stop();
    });

    it('seenHashes are cleared on restart', async () => {
        const times = ['2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', '2026-01-01T00:00:02Z', '2026-01-01T00:00:03Z'];
        let callIdx = 0;

        mockGrpcClient.rawRPC.mockImplementation(async (method: string) => {
            if (method === 'GetAllCascadeTrajectories') {
                callIdx++;
                const idx = Math.min(callIdx - 1, 3);
                return makeTrajectorySummaries({
                    'c-1': { lastUserInputTime: times[idx], lastUserInputStepIndex: 0 },
                });
            }
            return makeTrajectoryDetail('Same message');
        });

        const { detector, onUserMessage } = createDetector();
        detector.start();

        // Prime
        jest.advanceTimersByTime(200);
        await flushPromises();
        // Detect
        jest.advanceTimersByTime(200);
        await flushPromises();
        expect(onUserMessage).toHaveBeenCalledTimes(1);

        // Restart clears seenHashes
        detector.stop();
        detector.start();

        // Prime again
        jest.advanceTimersByTime(200);
        await flushPromises();
        // Should detect 'Same message' again after restart
        jest.advanceTimersByTime(200);
        await flushPromises();

        expect(onUserMessage).toHaveBeenCalledTimes(2);

        detector.stop();
    });
});
