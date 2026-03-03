import {
    createPlatformCommandHandler,
    type CommandDef,
} from '../../src/handlers/commandHandler';
import type {
    PlatformCommandInteraction,
    PlatformUser,
    PlatformChannel,
    PlatformSentMessage,
} from '../../src/platform/types';
import { logger } from '../../src/utils/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(
    overrides: Partial<PlatformChannel> = {},
): PlatformChannel {
    return {
        id: 'ch-1',
        platform: 'discord',
        name: 'test-channel',
        send: jest.fn(),
        ...overrides,
    };
}

function makeUser(overrides: Partial<PlatformUser> = {}): PlatformUser {
    return {
        id: 'user-1',
        platform: 'discord',
        username: 'testuser',
        isBot: false,
        ...overrides,
    };
}

function makeCommandInteraction(
    overrides: Partial<PlatformCommandInteraction> = {},
): PlatformCommandInteraction {
    return {
        id: 'int-1',
        platform: 'discord',
        commandName: 'mode',
        user: makeUser(),
        channel: makeChannel(),
        options: new Map(),
        deferReply: jest.fn().mockResolvedValue(undefined),
        reply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue({
            id: 'sent-1',
            platform: 'discord',
            channelId: 'ch-1',
            edit: jest.fn(),
            delete: jest.fn(),
        } as PlatformSentMessage),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPlatformCommandHandler', () => {
    it('dispatches known commands correctly', async () => {
        const executeFn = jest.fn().mockResolvedValue(undefined);
        const commands: CommandDef[] = [
            { name: 'mode', execute: executeFn },
        ];
        const handler = createPlatformCommandHandler({ commands });
        const interaction = makeCommandInteraction({ commandName: 'mode' });

        await handler(interaction);

        expect(executeFn).toHaveBeenCalledWith(interaction);
    });

    it('replies with error for unknown commands', async () => {
        const handler = createPlatformCommandHandler({ commands: [] });
        const interaction = makeCommandInteraction({
            commandName: 'nonexistent',
        });

        await handler(interaction);

        expect(interaction.editReply).toHaveBeenCalledWith({
            text: 'Unknown command: nonexistent',
        });
    });

    it('logs a warning for unknown commands', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
        const handler = createPlatformCommandHandler({ commands: [] });
        const interaction = makeCommandInteraction({
            commandName: 'nonexistent',
        });

        await handler(interaction);

        expect(warnSpy).toHaveBeenCalledWith(
            '[CommandHandler] Unknown command: nonexistent',
        );
        warnSpy.mockRestore();
    });

    it('catches command errors and reports to user', async () => {
        const commands: CommandDef[] = [
            {
                name: 'mode',
                execute: jest
                    .fn()
                    .mockRejectedValue(new Error('Permission denied')),
            },
        ];
        const handler = createPlatformCommandHandler({ commands });
        const interaction = makeCommandInteraction({ commandName: 'mode' });

        await handler(interaction);

        expect(interaction.editReply).toHaveBeenCalledWith({
            text: 'An error occurred while processing the command.',
        });
    });

    it('does not throw when error reply itself fails', async () => {
        const commands: CommandDef[] = [
            {
                name: 'mode',
                execute: jest
                    .fn()
                    .mockRejectedValue(new Error('Permission denied')),
            },
        ];
        const handler = createPlatformCommandHandler({ commands });
        const interaction = makeCommandInteraction({
            commandName: 'mode',
            editReply: jest
                .fn()
                .mockRejectedValue(new Error('Edit reply failed')),
        });

        await expect(handler(interaction)).resolves.toBeUndefined();
    });

    it('does not throw when unknown-command editReply rejects', async () => {
        const handler = createPlatformCommandHandler({ commands: [] });
        const interaction = makeCommandInteraction({
            commandName: 'nonexistent',
            editReply: jest
                .fn()
                .mockRejectedValue(new Error('Interaction expired')),
        });

        await expect(handler(interaction)).resolves.toBeUndefined();
    });

    it('dispatches to the correct command among multiple registrations', async () => {
        const modeExecute = jest.fn().mockResolvedValue(undefined);
        const projectExecute = jest.fn().mockResolvedValue(undefined);
        const commands: CommandDef[] = [
            { name: 'mode', execute: modeExecute },
            { name: 'project', execute: projectExecute },
        ];
        const handler = createPlatformCommandHandler({ commands });
        const interaction = makeCommandInteraction({
            commandName: 'project',
        });

        await handler(interaction);

        expect(projectExecute).toHaveBeenCalledWith(interaction);
        expect(modeExecute).not.toHaveBeenCalled();
    });
});
