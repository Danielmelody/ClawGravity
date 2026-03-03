import {
    createPlatformSelectHandler,
    type SelectAction,
} from '../../src/handlers/selectHandler';
import type {
    PlatformSelectInteraction,
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

function makeSelectInteraction(
    overrides: Partial<PlatformSelectInteraction> = {},
): PlatformSelectInteraction {
    return {
        id: 'int-1',
        platform: 'discord',
        customId: 'select_model',
        user: makeUser(),
        channel: makeChannel(),
        values: ['gpt-4'],
        messageId: 'msg-1',
        deferUpdate: jest.fn().mockResolvedValue(undefined),
        reply: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
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

describe('createPlatformSelectHandler', () => {
    it('executes the matching action with selected values', async () => {
        const executeFn = jest.fn().mockResolvedValue(undefined);
        const action: SelectAction = {
            match: (id) => id === 'select_model',
            execute: executeFn,
        };
        const handler = createPlatformSelectHandler({ actions: [action] });
        const interaction = makeSelectInteraction({
            values: ['claude-3', 'gpt-4'],
        });

        await handler(interaction);

        expect(executeFn).toHaveBeenCalledWith(interaction, [
            'claude-3',
            'gpt-4',
        ]);
    });

    it('logs a warning when no action matches', async () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
        const handler = createPlatformSelectHandler({ actions: [] });
        const interaction = makeSelectInteraction({
            customId: 'unknown_select',
        });

        await handler(interaction);

        expect(warnSpy).toHaveBeenCalledWith(
            '[SelectHandler] No handler for customId: unknown_select',
        );
        warnSpy.mockRestore();
    });

    it('catches action errors and reports to user', async () => {
        const action: SelectAction = {
            match: () => true,
            execute: jest.fn().mockRejectedValue(new Error('Service down')),
        };
        const handler = createPlatformSelectHandler({ actions: [action] });
        const interaction = makeSelectInteraction();

        await handler(interaction);

        expect(interaction.reply).toHaveBeenCalledWith({
            text: 'An error occurred while processing the selection.',
            ephemeral: true,
        });
    });

    it('does not throw when error reply itself fails', async () => {
        const action: SelectAction = {
            match: () => true,
            execute: jest.fn().mockRejectedValue(new Error('Service down')),
        };
        const handler = createPlatformSelectHandler({ actions: [action] });
        const interaction = makeSelectInteraction({
            reply: jest.fn().mockRejectedValue(new Error('Reply failed')),
        });

        await expect(handler(interaction)).resolves.toBeUndefined();
    });

    it('catches match() errors and reports to user', async () => {
        const action: SelectAction = {
            match: () => {
                throw new Error('Bad regex');
            },
            execute: jest.fn(),
        };
        const handler = createPlatformSelectHandler({ actions: [action] });
        const interaction = makeSelectInteraction();

        await handler(interaction);

        expect(interaction.reply).toHaveBeenCalledWith({
            text: 'An error occurred while processing the selection.',
            ephemeral: true,
        });
        expect(action.execute).not.toHaveBeenCalled();
    });

    it('first matching action wins (order matters)', async () => {
        const firstExecute = jest.fn().mockResolvedValue(undefined);
        const secondExecute = jest.fn().mockResolvedValue(undefined);
        const actions: SelectAction[] = [
            { match: (id) => id === 'select_model', execute: firstExecute },
            { match: (id) => id === 'select_model', execute: secondExecute },
        ];
        const handler = createPlatformSelectHandler({ actions });
        const interaction = makeSelectInteraction();

        await handler(interaction);

        expect(firstExecute).toHaveBeenCalled();
        expect(secondExecute).not.toHaveBeenCalled();
    });
});
