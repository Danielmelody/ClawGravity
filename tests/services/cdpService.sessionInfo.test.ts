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

        jest.spyOn(service as any, 'ensureLSClient').mockResolvedValue(mockClient);
        service.setCachedCascadeId('cascade-old');

        await expect(service.getActiveSessionInfo()).resolves.toEqual({
            id: 'cascade-old',
            title: 'Older Selected Session',
            summary: 'Older Selected Session',
        });
    });

    it('preserves a recently created cached cascade while summaries catch up', async () => {
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

        jest.spyOn(service as any, 'ensureLSClient').mockResolvedValue(mockClient);
        (service as any).cachedCascadeId = 'missing-cascade';
        (service as any).recentCreatedCascadeId = 'missing-cascade';
        (service as any).recentCreatedCascadeAt = Date.now();

        await expect(service.getActiveSessionInfo()).resolves.toEqual({
            id: 'missing-cascade',
            title: 'Current Session',
            summary: '',
        });
    });

    it('falls back to the newest cascade when the cached cascade is stale and missing', async () => {
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

        jest.spyOn(service as any, 'ensureLSClient').mockResolvedValue(mockClient);
        (service as any).cachedCascadeId = 'missing-cascade';
        (service as any).recentCreatedCascadeId = 'missing-cascade';
        (service as any).recentCreatedCascadeAt = Date.now() - 60_000;

        await expect(service.getActiveSessionInfo()).resolves.toEqual({
            id: 'cascade-b',
            title: 'Session B',
            summary: 'Session B',
        });
        await expect(service.getActiveCascadeId()).resolves.toBe('cascade-b');
    });

    it('does not fall back to another workspace cascade when no summaries match the current workspace', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            listCascades: jest.fn().mockResolvedValue({
                'foreign-cascade': {
                    title: 'Foreign Session',
                    summary: 'Foreign Session',
                    lastModifiedTimestamp: '2026-03-08T10:00:00.000Z',
                    workspaces: [
                        { workspaceFolderAbsoluteUri: 'file:///C:/Users/Daniel/Projects/SomeOtherRepo' },
                    ],
                },
            }),
        };

        jest.spyOn(service as any, 'ensureLSClient').mockResolvedValue(mockClient);
        (service as any).currentWorkspacePath = 'C:\\Users\\Daniel\\Projects\\antigravity-tunnel';

        await expect(service.getActiveSessionInfo()).resolves.toBeNull();
        await expect(service.getActiveCascadeId()).resolves.toBeNull();
    });
});
