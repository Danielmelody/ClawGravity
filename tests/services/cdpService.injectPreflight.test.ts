import { CdpService } from '../../src/services/cdpService';

describe('CdpService injection preflight', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('surfaces the last LS initialization error instead of the generic injection failure', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });

        (service as any).lastLSUnavailableReason =
            'LS client unavailable: could not match workspace "antigravity-tunnel" to a Language Server process.';
        jest.spyOn(service as any, 'ensureLSClient').mockResolvedValue(null);

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

        jest.spyOn(service as any, 'ensureLSClient').mockResolvedValue(mockClient);
        jest.spyOn(service, 'getActiveCascadeId').mockResolvedValue(null);
        jest.spyOn(service as any, 'resolveSelectedModelId').mockResolvedValue(null);

        const result = await service.injectMessage('hi');

        expect(result).toMatchObject({
            ok: false,
            error: 'LS SendUserCascadeMessage: 400 - missing required field',
        });
        expect(mockClient.createCascade).toHaveBeenCalled();
    });
});
