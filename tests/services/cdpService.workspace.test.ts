import { CdpService } from '../../src/services/cdpService';

describe('CdpService.isCascadeInWorkspace', () => {
    it('correctly decodes URI encoded workspaces', () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        (service as any).currentWorkspacePath = 'c:\\Users\\Daniel\\Projects\\DeepMarket';

        const summary = {
            workspaces: [
                { workspaceFolderAbsoluteUri: 'file:///c%3A/Users/Daniel/Projects/DeepMarket' }
            ]
        };

        expect(service.isCascadeInWorkspace(summary)).toBe(true);
    });

    it('matches unencoded lowercase equivalent', () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        (service as any).currentWorkspacePath = 'c:\\users\\daniel\\projects\\DEEPMARKET\\';

        const summary = {
            workspaces: [
                { workspaceFolderAbsoluteUri: 'file:///c:/Users/Daniel/Projects/DeepMarket' }
            ]
        };

        expect(service.isCascadeInWorkspace(summary)).toBe(true);
    });
});
