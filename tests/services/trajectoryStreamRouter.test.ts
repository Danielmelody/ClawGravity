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

    it('start() does not poll or log when no cascade exists', async () => {
        const client = new FakeGrpcClient();
        const cdpService = {
            getGrpcClient: jest.fn().mockResolvedValue(client),
            getActiveCascadeId: jest.fn().mockResolvedValue(null),
        };

        const router = new TrajectoryStreamRouter({
            cdpService: cdpService as any,
            projectName: '__claw__',
        });

        router.start();

        // start() is synchronous and does NOT call connectStream
        expect(router.isActive()).toBe(true);
        expect(cdpService.getActiveCascadeId).not.toHaveBeenCalled();
        expect(cdpService.getGrpcClient).not.toHaveBeenCalled();

        // Wait plenty of time — nothing should happen
        await jest.advanceTimersByTimeAsync(30000);
        expect(cdpService.getActiveCascadeId).not.toHaveBeenCalled();
        expect(logger.debug).not.toHaveBeenCalledWith(
            expect.stringContaining('No active cascade'),
        );

        await router.stop();
    });

    it('connectToCascade() activates polling for a specific cascade', async () => {
        const client = new FakeGrpcClient();
        const cdpService = {
            getGrpcClient: jest.fn().mockResolvedValue(client),
            getActiveCascadeId: jest.fn().mockResolvedValue(null),
        };

        const router = new TrajectoryStreamRouter({
            cdpService: cdpService as any,
            projectName: '__claw__',
        });

        router.start();

        const cascadeId = 'test-cascade-id-12345';
        router.connectToCascade(cascadeId);

        // Advance by next tick for the promise to resolve
        await Promise.resolve();
        await Promise.resolve();

        expect(client.rawRPC).toHaveBeenCalledWith('GetCascadeTrajectory', { cascadeId });
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('Polling started for cascade=test-cascad'),
        );

        await router.stop();
    });

    it('connectToCascade() is a no-op if already polling the same cascade', async () => {
        const client = new FakeGrpcClient();
        const cdpService = {
            getGrpcClient: jest.fn().mockResolvedValue(client),
            getActiveCascadeId: jest.fn().mockResolvedValue(null),
        };

        const router = new TrajectoryStreamRouter({
            cdpService: cdpService as any,
            projectName: '__claw__',
        });

        router.start();

        const cascadeId = 'test-cascade-id-12345';
        router.connectToCascade(cascadeId);
        await Promise.resolve();
        await Promise.resolve();

        expect(client.rawRPC).toHaveBeenCalledTimes(1);

        // Calling again with the same ID — should be a no-op (no secondary immediate poll)
        router.connectToCascade(cascadeId);
        await Promise.resolve();
        await Promise.resolve();

        expect(client.rawRPC).toHaveBeenCalledTimes(1);

        await router.stop();
    });
});
