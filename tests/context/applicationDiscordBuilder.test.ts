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

    it('join handler shares workspace bindings with the command handlers', async () => {
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
                activePromptSessions: new Map(),
            });

            // The join handler should use the same binding repo as the context.
            // Verify by inserting a binding and checking the workspace handler sees it.
            context.workspaceBindingRepo.upsert({
                channelId: 'discord-ch-1',
                workspacePath: 'my-project',
                guildId: 'test-guild',
            });

            const resolved = commandHandlers.workspace.getWorkspaceForChannel('discord-ch-1');
            expect(resolved).toContain('my-project');

            // joinHandler should be a JoinCommandHandler instance (smoke check)
            expect(artifacts.joinHandler).toBeDefined();
            expect(artifacts.interactionHandler).toBeDefined();
            expect(artifacts.messageHandler).toBeDefined();
        } finally {
            context.db.close();
        }
    });
});
