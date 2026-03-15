import { buildApplicationCommandHandlers } from '../../src/context/applicationCommandBuilder';
import { buildApplicationContext } from '../../src/context/applicationContextBuilder';
import type { AppConfig } from '../../src/utils/config';

describe('applicationCommandBuilder', () => {
    const config: AppConfig = {
        allowedUserIds: ['123'],
        workspaceBaseDir: process.cwd(),
        autoApproveFileEdits: false,
        logLevel: 'info',
        extractionMode: 'structured',
        platforms: ['discord'],
    };

    it('builds the core command handler set from the application context', async () => {
        const context = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        try {
            const handlers = await buildApplicationCommandHandlers(context);

            expect(handlers.workspace).toBeDefined();
            expect(handlers.chat).toBeDefined();
            expect(handlers.cleanup).toBeDefined();
            expect(handlers.slash).toBeDefined();
        } finally {
            context.db.close();
        }
    });
});
