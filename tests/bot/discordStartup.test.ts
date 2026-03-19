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

function createBasicDeps(overrides: Record<string, any> = {}) {
    const send = jest.fn().mockResolvedValue(undefined);
    const textChannel = {
        isTextBased: () => true,
        isVoiceBased: () => false,
        permissionsFor: () => ({ has: () => true }),
        send,
    };

    return {
        deps: {
            client: {
                user: { id: 'bot-user' },
                guilds: {
                    cache: {
                        first: () => ({
                            channels: {
                                cache: {
                                    find: (fn: Function) => fn(textChannel) ? textChannel : null,
                                },
                            },
                        }),
                    },
                },
                channels: { fetch: jest.fn() },
            } as any,
            discordToken: 'discord-token',
            discordClientId: 'client-id',
            guildId: 'guild-id',
            bridge: {
                pool: { getActiveWorkspaceNames: () => ['proj-a'] },
            } as any,
            workspaceBindingRepo: { findAll: () => [] } as any,
            chatSessionRepo: {} as any,
            workspaceService: { scanWorkspaces: () => ['proj-a'] } as any,
            chatSessionService: {} as any,
            modeService: {
                getCurrentMode: () => 'default',
                setMode: jest.fn(),
            } as any,
            modelService: { getDefaultModel: () => 'default-model' } as any,
            ...overrides,
        },
        send,
    };
}

describe('discordStartup', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('sends a startup dashboard embed to the first available text channel', async () => {
        (ensureWorkspaceRuntime as jest.Mock).mockResolvedValue({
            cdp: {
                getCurrentModel: jest.fn().mockResolvedValue('gpt-5'),
                getCurrentMode: jest.fn().mockResolvedValue('planning'),
            },
        });

        const { deps, send } = createBasicDeps();
        await runDiscordStartupTasks(deps);

        // The dashboard embed should have been sent exactly once
        expect(send).toHaveBeenCalledTimes(1);

        // Verify the embed contains meaningful startup information
        const sentPayload = send.mock.calls[0][0];
        expect(sentPayload.embeds).toHaveLength(1);

        const embed = sentPayload.embeds[0];
        expect(embed.data.title).toBe('ClawGravity Online');
    });

    it('completes gracefully when slash command registration fails', async () => {
        (registerSlashCommands as jest.Mock).mockRejectedValue(new Error('network error'));
        (ensureWorkspaceRuntime as jest.Mock).mockResolvedValue({
            cdp: {
                getCurrentModel: jest.fn().mockResolvedValue('gpt-5'),
                getCurrentMode: jest.fn().mockResolvedValue('planning'),
            },
        });

        const { deps, send } = createBasicDeps();

        // Should not throw — startup is fault-tolerant
        await expect(runDiscordStartupTasks(deps)).resolves.toBeUndefined();

        // Dashboard should still be sent despite slash command failure
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('completes gracefully when no guild is available', async () => {
        (ensureWorkspaceRuntime as jest.Mock).mockResolvedValue({
            cdp: {
                getCurrentModel: jest.fn().mockResolvedValue('gpt-5'),
                getCurrentMode: jest.fn().mockResolvedValue('planning'),
            },
        });

        const { deps } = createBasicDeps({
            client: {
                user: { id: 'bot-user' },
                guilds: { cache: { first: () => null } },
                channels: { fetch: jest.fn() },
            } as any,
        });

        // Should not throw even if there's no guild
        await expect(runDiscordStartupTasks(deps)).resolves.toBeUndefined();
    });
});
