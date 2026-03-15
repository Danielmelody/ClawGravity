import {
    clearApplicationContext,
    getApplicationContext,
    setApplicationContext,
} from '../../src/context/applicationContext';
import { buildApplicationContext } from '../../src/context/applicationContextBuilder';
import type { AppConfig } from '../../src/utils/config';

describe('applicationContextBuilder', () => {
    const config: AppConfig = {
        allowedUserIds: ['123'],
        workspaceBaseDir: process.cwd(),
        autoApproveFileEdits: false,
        logLevel: 'info',
        extractionMode: 'structured',
        platforms: ['discord'],
    };

    afterEach(() => {
        try {
            getApplicationContext().db.close();
        } catch {
            // Context may not be set in every test.
        }
        clearApplicationContext();
    });

    it('builds the legacy application context shape from an Effect layer', async () => {
        const ctx = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        expect(ctx.db).toBeDefined();
        expect(ctx.promptDispatcher).toBeDefined();
        expect(ctx.scheduleService).toBeDefined();
        expect(ctx.bridge.pool).toBeDefined();

        ctx.db.close();
    });

    it('remains compatible with the existing global context helpers', async () => {
        const ctx = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        setApplicationContext(ctx);

        expect(getApplicationContext()).toBe(ctx);
    });
});
