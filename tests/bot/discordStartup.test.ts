jest.mock('../../src/commands/registerSlashCommands', () => ({
    registerSlashCommands: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/cdpBridgeManager', () => ({
    ensureWorkspaceRuntime: jest.fn(),
    registerApprovalSessionChannel: jest.fn(),
    registerApprovalWorkspaceChannel: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    },
}));

import { runDiscordStartupTasks } from '../../src/bot/discordStartup';
import { registerSlashCommands } from '../../src/commands/registerSlashCommands';
import { ensureWorkspaceRuntime } from '../../src/services/cdpBridgeManager';

describe('discordStartup', () => {
    it('registers slash commands and sends the startup dashboard', async () => {
        const send = jest.fn().mockResolvedValue(undefined);
        const textChannel = {
            isTextBased: () => true,
            isVoiceBased: () => false,
            permissionsFor: () => ({ has: () => true }),
            send,
        };

        (ensureWorkspaceRuntime as jest.Mock).mockResolvedValue({
            cdp: {
                getCurrentModel: jest.fn().mockResolvedValue('gpt-5'),
                getCurrentMode: jest.fn().mockResolvedValue('planning'),
            },
        });

        await runDiscordStartupTasks({
            client: {
                user: { id: 'bot-user' },
                guilds: {
                    cache: {
                        first: () => ({
                            channels: {
                                cache: {
                                    find: () => textChannel,
                                },
                            },
                        }),
                    },
                },
                channels: {
                    fetch: jest.fn(),
                },
            } as any,
            discordToken: 'discord-token',
            discordClientId: 'client-id',
            guildId: 'guild-id',
            bridge: {
                pool: {
                    getActiveWorkspaceNames: () => ['proj-a'],
                },
            } as any,
            workspaceBindingRepo: {
                findAll: () => [],
            } as any,
            chatSessionRepo: {} as any,
            workspaceService: {
                scanWorkspaces: () => ['proj-a'],
            } as any,
            chatSessionService: {} as any,
            modeService: {
                getCurrentMode: () => 'default',
                setMode: jest.fn(),
            } as any,
            modelService: {
                getDefaultModel: () => 'default-model',
            } as any,
        });

        expect(registerSlashCommands).toHaveBeenCalledWith(
            'discord-token',
            'client-id',
            'guild-id',
        );
        expect(send).toHaveBeenCalledTimes(1);
    });
});
