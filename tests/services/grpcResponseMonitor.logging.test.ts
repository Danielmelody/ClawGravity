import { EventEmitter } from 'events';

jest.mock('../../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        phase: jest.fn(),
        done: jest.fn(),
    },
}));

import { GrpcResponseMonitor } from '../../src/services/grpcResponseMonitor';
import { logger } from '../../src/utils/logger';

class FakeGrpcClient extends EventEmitter {
    rawRPC = jest.fn();
}

describe('GrpcResponseMonitor snapshot logging', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('logs snapshot summaries only when the trajectory state changes', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Done' } },
                    ],
                },
            });

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-log-sampling',
            expectedUserMessage: 'commit',
        });

        await monitor.start();
        await Promise.resolve();
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);

        const snapshotLogs = (logger.info as jest.Mock).mock.calls
            .map((args) => String(args[0]))
            .filter((line) => line.includes('[GrpcMonitor] Snapshot'));

        expect(snapshotLogs).toHaveLength(2);
        expect(snapshotLogs[0]).toContain('runStatus=CASCADE_RUN_STATUS_RUNNING');
        expect(snapshotLogs[0]).toContain('steps=1');
        expect(snapshotLogs[0]).toContain('anchor=matched');
        expect(snapshotLogs[1]).toContain('steps=2');
        expect(snapshotLogs[1]).toContain('latestRole=assistant');
        expect(snapshotLogs[1]).toContain('textLen=4');

        await monitor.stop();
    });
});
