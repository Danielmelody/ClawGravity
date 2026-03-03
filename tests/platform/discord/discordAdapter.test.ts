import { DiscordAdapter } from '../../../src/platform/discord/discordAdapter';
import type { PlatformAdapterEvents } from '../../../src/platform/adapter';

// ---------------------------------------------------------------------------
// Minimal discord.js Client mock
// ---------------------------------------------------------------------------

function createMockClient() {
    const listeners: Record<string, Function[]> = {};

    return {
        once: jest.fn((event: string, handler: Function) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(handler);
        }),
        on: jest.fn((event: string, handler: Function) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(handler);
        }),
        destroy: jest.fn(),
        channels: {
            fetch: jest.fn(),
        },
        /** Test helper: emit a registered event. */
        __emit(event: string, ...args: unknown[]) {
            for (const handler of listeners[event] ?? []) {
                handler(...args);
            }
        },
        /** Test helper: access stored listeners. */
        __listeners: listeners,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscordAdapter', () => {
    it('has platform set to "discord"', () => {
        const client = createMockClient();
        const adapter = new DiscordAdapter(client as any);

        expect(adapter.platform).toBe('discord');
    });

    it('getBotUserId() returns empty string before start()', () => {
        const client = createMockClient();
        const adapter = new DiscordAdapter(client as any);

        expect(adapter.getBotUserId()).toBe('');
    });

    it('getRawClient() returns the injected client', () => {
        const client = createMockClient();
        const adapter = new DiscordAdapter(client as any);

        expect(adapter.getRawClient()).toBe(client);
    });

    describe('start()', () => {
        it('registers a ClientReady listener that sets botUserId and calls onReady', async () => {
            const client = createMockClient();
            const adapter = new DiscordAdapter(client as any);
            const onReady = jest.fn();

            await adapter.start({ onReady });

            // Simulate the ready event (Events.ClientReady = 'clientReady' in discord.js v14)
            client.__emit('clientReady', { user: { id: 'bot-123' } });

            expect(adapter.getBotUserId()).toBe('bot-123');
            expect(onReady).toHaveBeenCalledTimes(1);
        });

        it('registers MessageCreate listener when onMessage is provided', async () => {
            const client = createMockClient();
            const adapter = new DiscordAdapter(client as any);
            const onMessage = jest.fn().mockResolvedValue(undefined);

            await adapter.start({ onMessage });

            // Verify that 'messageCreate' listener was registered
            expect(client.__listeners['messageCreate']).toBeDefined();
            expect(client.__listeners['messageCreate']).toHaveLength(1);
        });

        it('does not register MessageCreate listener when onMessage is not provided', async () => {
            const client = createMockClient();
            const adapter = new DiscordAdapter(client as any);

            await adapter.start({});

            expect(client.__listeners['messageCreate']).toBeUndefined();
        });

        it('registers InteractionCreate listener when interaction handlers provided', async () => {
            const client = createMockClient();
            const adapter = new DiscordAdapter(client as any);

            await adapter.start({
                onButtonInteraction: jest.fn(),
            });

            expect(client.__listeners['interactionCreate']).toBeDefined();
            expect(client.__listeners['interactionCreate']).toHaveLength(1);
        });

        it('forwards client errors to onError', async () => {
            const client = createMockClient();
            const adapter = new DiscordAdapter(client as any);
            const onError = jest.fn();

            await adapter.start({ onError });

            const error = new Error('connection lost');
            client.__emit('error', error);

            expect(onError).toHaveBeenCalledWith(error);
        });

        it('wraps non-Error thrown in onMessage into Error and forwards to onError', async () => {
            const client = createMockClient();
            const adapter = new DiscordAdapter(client as any);
            const onError = jest.fn();
            const onMessage = jest.fn().mockRejectedValue('string error');

            await adapter.start({ onMessage, onError });

            // Simulate a message event with a minimal mock
            const mockMsg = {
                id: 'm1',
                content: 'hi',
                channelId: 'ch1',
                createdAt: new Date(),
                author: { id: 'u1', username: 'user', displayName: 'User', bot: false },
                channel: { id: 'ch1', name: 'general', send: jest.fn() },
                attachments: new Map(),
                react: jest.fn(),
                reply: jest.fn(),
            };

            await client.__emit('messageCreate', mockMsg);
            // Give the async handler time to settle
            await new Promise((r) => setTimeout(r, 10));

            expect(onError).toHaveBeenCalledTimes(1);
            const errorArg = onError.mock.calls[0][0];
            expect(errorArg).toBeInstanceOf(Error);
            expect(errorArg.message).toBe('string error');
        });
    });

    describe('stop()', () => {
        it('calls client.destroy()', async () => {
            const client = createMockClient();
            const adapter = new DiscordAdapter(client as any);

            await adapter.stop();

            expect(client.destroy).toHaveBeenCalledTimes(1);
        });
    });

    describe('getChannel()', () => {
        it('delegates to client.channels.fetch() and wraps the result', async () => {
            const mockChannel = {
                id: 'ch-42',
                name: 'test-channel',
                isTextBased: () => true,
                send: jest.fn(),
            };
            const client = createMockClient();
            client.channels.fetch.mockResolvedValue(mockChannel);
            const adapter = new DiscordAdapter(client as any);

            const result = await adapter.getChannel('ch-42');

            expect(client.channels.fetch).toHaveBeenCalledWith('ch-42');
            expect(result).not.toBeNull();
            expect(result!.id).toBe('ch-42');
            expect(result!.platform).toBe('discord');
            expect(result!.name).toBe('test-channel');
        });

        it('returns null when client.channels.fetch() returns null', async () => {
            const client = createMockClient();
            client.channels.fetch.mockResolvedValue(null);
            const adapter = new DiscordAdapter(client as any);

            const result = await adapter.getChannel('nonexistent');

            expect(result).toBeNull();
        });

        it('returns null when the channel is not text-based', async () => {
            const voiceChannel = {
                id: 'vc-1',
                name: 'voice-channel',
                isTextBased: () => false,
                send: jest.fn(),
            };
            const client = createMockClient();
            client.channels.fetch.mockResolvedValue(voiceChannel);
            const adapter = new DiscordAdapter(client as any);

            const result = await adapter.getChannel('vc-1');

            expect(result).toBeNull();
        });

        it('wraps text-based channels successfully', async () => {
            const textChannel = {
                id: 'tc-1',
                name: 'text-channel',
                isTextBased: () => true,
                send: jest.fn(),
            };
            const client = createMockClient();
            client.channels.fetch.mockResolvedValue(textChannel);
            const adapter = new DiscordAdapter(client as any);

            const result = await adapter.getChannel('tc-1');

            expect(result).not.toBeNull();
            expect(result!.id).toBe('tc-1');
            expect(result!.platform).toBe('discord');
        });

        it('returns null when client.channels.fetch() throws', async () => {
            const client = createMockClient();
            client.channels.fetch.mockRejectedValue(new Error('Unknown Channel'));
            const adapter = new DiscordAdapter(client as any);

            const result = await adapter.getChannel('bad-id');

            expect(result).toBeNull();
        });
    });
});
