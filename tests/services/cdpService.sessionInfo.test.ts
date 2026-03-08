import { CdpService } from '../../src/services/cdpService';

describe('CdpService session info', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('prefers the cached cascade when resolving the active session', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            listCascades: jest.fn().mockResolvedValue({
                'cascade-old': {
                    title: 'Older Selected Session',
                    summary: 'Older Selected Session',
                    lastModifiedTimestamp: '2026-03-08T09:00:00.000Z',
                },
                'cascade-new': {
                    title: 'Newest Session',
                    summary: 'Newest Session',
                    lastModifiedTimestamp: '2026-03-08T10:00:00.000Z',
                },
            }),
        };

        jest.spyOn(service as any, 'ensureGrpcClient').mockResolvedValue(mockClient);
        service.setCachedCascadeId('cascade-old');

        await expect(service.getActiveSessionInfo()).resolves.toEqual({
            id: 'cascade-old',
            title: 'Older Selected Session',
            summary: 'Older Selected Session',
        });
    });

    it('falls back to the newest cascade when the cached cascade is missing', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            listCascades: jest.fn().mockResolvedValue({
                'cascade-a': {
                    title: 'Session A',
                    summary: 'Session A',
                    lastModifiedTime: '2026-03-08T09:00:00.000Z',
                },
                'cascade-b': {
                    title: 'Session B',
                    summary: 'Session B',
                    lastModifiedTime: '2026-03-08T10:00:00.000Z',
                },
            }),
        };

        jest.spyOn(service as any, 'ensureGrpcClient').mockResolvedValue(mockClient);
        service.setCachedCascadeId('missing-cascade');

        await expect(service.getActiveSessionInfo()).resolves.toEqual({
            id: 'cascade-b',
            title: 'Session B',
            summary: 'Session B',
        });
        await expect(service.getActiveCascadeId()).resolves.toBe('cascade-b');
    });
});
