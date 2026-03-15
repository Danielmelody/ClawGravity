import { buildApplicationCommandHandlers } from '../../src/context/applicationCommandBuilder';
import { buildApplicationContext } from '../../src/context/applicationContextBuilder';
import { buildDiscordRuntimeArtifacts } from '../../src/context/applicationDiscordBuilder';
import type { AppConfig } from '../../src/utils/config';

describe('applicationDiscordBuilder', () => {
    const config: AppConfig = {
        allowedUserIds: ['123'],
        workspaceBaseDir: process.cwd(),
        autoApproveFileEdits: false,
        logLevel: 'info',
        extractionMode: 'structured',
        platforms: ['discord'],
    };

    it('builds discord runtime artifacts from the shared application context', async () => {
        const context = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        try {
            const commandHandlers = await buildApplicationCommandHandlers(context);
            const artifacts = await buildDiscordRuntimeArtifacts(context, {
                config,
                client: {} as any,
                commandHandlers,
                handleScreenshot: jest.fn().mockResolvedValue(undefined),
                autoRenameChannel: jest.fn().mockResolvedValue(undefined),
                handleSlashInteraction: jest.fn().mockResolvedValue(undefined),
            });

            expect(artifacts.joinHandler).toBeDefined();
            expect(typeof artifacts.interactionHandler).toBe('function');
            expect(typeof artifacts.messageHandler).toBe('function');
        } finally {
            context.db.close();
        }
    });
});
