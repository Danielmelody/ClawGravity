import { CdpService } from '../../src/services/cdpService';

describe('CdpService injection preflight', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('surfaces the last LS initialization error instead of the generic injection failure', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });

        (service as any).lsClientManager.lastLSUnavailableReason =
            'LS client unavailable: could not match workspace "antigravity-tunnel" to a Language Server process.';
        jest.spyOn(service, 'getLSClient').mockResolvedValue(null);

        const result = await service.injectMessage('hi');

        expect(result).toMatchObject({
            ok: false,
            error: 'LS client unavailable: could not match workspace "antigravity-tunnel" to a Language Server process.',
        });
    });


    it('surfaces createCascade failure details instead of collapsing them to the generic message', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            rawRPC: jest.fn().mockResolvedValue({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [],
                },
            }),
            createCascade: jest.fn().mockResolvedValue(null),
            getLastOperationError: jest.fn().mockReturnValue('LS SendUserCascadeMessage: 400 - missing required field'),
            getUserStatus: jest.fn().mockResolvedValue({}),
        };

        jest.spyOn(service, 'getLSClient').mockResolvedValue(mockClient as any);
        jest.spyOn(service, 'getActiveCascadeId').mockResolvedValue(null);
        jest.spyOn(service as any, 'resolveSelectedModelId').mockResolvedValue(null);

        const result = await service.injectMessage('hi');

        expect(result).toMatchObject({
            ok: false,
            error: 'LS SendUserCascadeMessage: 400 - missing required field',
        });
        expect(mockClient.createCascade).toHaveBeenCalled();
    });

    it('sends immediately to a running cached cascade and lets Antigravity queue the turn', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        service.setCachedCascadeId('running-cascade');

        const mockClient = {
            rawRPC: jest.fn().mockResolvedValue({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [],
                },
            }),
            sendMessage: jest.fn().mockResolvedValue({ ok: true, data: { accepted: true } }),
            createCascade: jest.fn(),
            getLastOperationError: jest.fn().mockReturnValue(null),
            getUserStatus: jest.fn().mockResolvedValue({}),
        };

        jest.spyOn(service, 'getLSClient').mockResolvedValue(mockClient as any);
        jest.spyOn(service as any, 'resolveSelectedModelId').mockResolvedValue(null);

        const result = await service.injectMessage('hi');

        expect(result).toMatchObject({
            ok: true,
            method: 'ls-api',
            cascadeId: 'running-cascade',
        });
        expect(mockClient.rawRPC).toHaveBeenCalledWith('GetCascadeTrajectory', { cascadeId: 'running-cascade' });
        expect(mockClient.sendMessage).toHaveBeenCalledWith('running-cascade', 'hi', undefined);
        expect(mockClient.createCascade).not.toHaveBeenCalled();
    });

    it('does not create a new cascade when sending to an existing cascade fails', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        service.setCachedCascadeId('existing-cascade');

        const mockClient = {
            rawRPC: jest.fn().mockResolvedValue({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [],
                },
            }),
            sendMessage: jest.fn().mockResolvedValue({ ok: false, error: 'LS SendUserCascadeMessage: 409 - conflict' }),
            createCascade: jest.fn(),
            getLastOperationError: jest.fn().mockReturnValue(null),
            getUserStatus: jest.fn().mockResolvedValue({}),
        };

        jest.spyOn(service, 'getLSClient').mockResolvedValue(mockClient as any);
        jest.spyOn(service as any, 'resolveSelectedModelId').mockResolvedValue(null);

        const result = await service.injectMessage('retry me');

        expect(result).toMatchObject({
            ok: false,
            error: 'LS SendUserCascadeMessage: 409 - conflict',
            cascadeId: 'existing-cascade',
        });
        expect(mockClient.sendMessage).toHaveBeenCalledWith('existing-cascade', 'retry me', undefined);
        expect(mockClient.createCascade).not.toHaveBeenCalled();
    });
});
