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

    it('workspace handler resolves channel-to-workspace bindings created through the shared repo', async () => {
        const context = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        try {
            const handlers = await buildApplicationCommandHandlers(context);

            // Bind a channel to a workspace through the shared repository
            context.workspaceBindingRepo.upsert({
                channelId: 'ch-100',
                workspacePath: 'proj-alpha',
                guildId: 'test-guild',
            });

            // The workspace handler should resolve it because it shares
            // the same repository instance — this tests real wiring, not just
            // "does the property exist".
            const resolved = handlers.workspace.getWorkspaceForChannel('ch-100');
            expect(resolved).toBeDefined();
            expect(resolved).toContain('proj-alpha');
        } finally {
            context.db.close();
        }
    });

    it('workspace handler returns undefined for unbound channels', async () => {
        const context = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        try {
            const handlers = await buildApplicationCommandHandlers(context);
            expect(handlers.workspace.getWorkspaceForChannel('unknown-ch')).toBeUndefined();
        } finally {
            context.db.close();
        }
    });
});
