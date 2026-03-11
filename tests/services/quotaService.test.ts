import { QuotaService } from '../../src/services/quotaService';

describe('QuotaService', () => {
    let consoleSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        consoleSpy.mockRestore();
    });

    it('returns an empty array when no RPC resolver is configured', async () => {
        const service = new QuotaService();
        const result = await service.fetchQuota();
        expect(result).toEqual([]);
    });

    it('returns an empty array when RPC resolver returns null', async () => {
        const service = new QuotaService();
        service.setRPCResolver(async () => null);
        const result = await service.fetchQuota();
        expect(result).toEqual([]);
    });

    it('fetches quota info via rawRPC callback', async () => {
        const mockRawRPC = jest.fn().mockResolvedValue({
            userStatus: {
                cascadeModelConfigData: {
                    clientModelConfigs: [
                        {
                            label: 'Gemini',
                            model: 'gemini-pro',
                            quotaInfo: {
                                remainingFraction: 0.6,
                                resetTime: '2026-02-23T12:00:00.000Z',
                            },
                        },
                    ],
                },
            },
        });

        const service = new QuotaService();
        service.setRPCResolver(async () => mockRawRPC);

        const result = await service.fetchQuota();

        expect(result).toHaveLength(1);
        expect(result[0].label).toBe('Gemini');
        expect(result[0].model).toBe('gemini-pro');
        expect(result[0].quotaInfo?.remainingFraction).toBe(0.6);
        expect(mockRawRPC).toHaveBeenCalledWith('GetUserStatus', {
            metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
        });
    });

    it('returns empty array on RPC failure', async () => {
        const mockRawRPC = jest.fn().mockRejectedValue(new Error('Network error'));

        const service = new QuotaService();
        service.setRPCResolver(async () => mockRawRPC);

        const result = await service.fetchQuota();
        expect(result).toEqual([]);
    });

    it('resolves RPC lazily on each call', async () => {
        let callCount = 0;
        const mockRawRPC = jest.fn().mockResolvedValue({
            userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } },
        });

        const service = new QuotaService();
        service.setRPCResolver(async () => {
            callCount++;
            return mockRawRPC;
        });

        await service.fetchQuota();
        await service.fetchQuota();

        // Resolver is called on every fetchQuota (lazy resolution)
        expect(callCount).toBe(2);
        expect(mockRawRPC).toHaveBeenCalledTimes(2);
    });
});
