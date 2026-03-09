import { EventEmitter } from 'events';
import { TrajectoryStreamRouter } from '../../src/services/trajectoryStreamRouter';
import { logger } from '../../src/utils/logger';

jest.mock('../../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

class FakeGrpcClient extends EventEmitter {
    streamCascadeUpdates = jest.fn(() => new AbortController());
    rawRPC = jest.fn();
}

describe('TrajectoryStreamRouter', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('retries idly without failure backoff when no active cascade exists', async () => {
        const client = new FakeGrpcClient();
        const cdpService = {
            getGrpcClient: jest.fn().mockResolvedValue(client),
            getActiveCascadeId: jest.fn().mockResolvedValue(null),
        };

        const router = new TrajectoryStreamRouter({
            cdpService: cdpService as any,
            projectName: '__claw__',
        });

        await router.start();

        expect((router as any).reconnectFailures).toBe(0);
        expect(cdpService.getActiveCascadeId).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(3000);

        expect((router as any).reconnectFailures).toBe(0);
        expect(cdpService.getActiveCascadeId).toHaveBeenCalledTimes(2);
        expect(client.streamCascadeUpdates).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith('[StreamRouter:__claw__] No active cascade, retrying in 3000ms');
        expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('Reconnecting in'));

        await router.stop();
    });
});
