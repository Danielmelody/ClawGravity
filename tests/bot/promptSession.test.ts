import { PromptSession } from '../../src/bot/promptSession';

const monitorStart = jest.fn();
const monitorStop = jest.fn();

jest.mock('../../src/services/grpcResponseMonitor', () => ({
    GrpcResponseMonitor: jest.fn().mockImplementation((opts: any) => ({
        start: jest.fn().mockImplementation(() => monitorStart(opts)),
        stop: jest.fn().mockImplementation(() => monitorStop()),
        getPhase: jest.fn().mockReturnValue('complete'),
    })),
}));

function createMockChannel() {
    const sentMessages: any[] = [];
    const channel = {
        sentMessages,
        send: jest.fn().mockImplementation(async (payload: any) => {
            const sent = {
                payload,
                edit: jest.fn().mockImplementation(async (nextPayload: any) => {
                    sent.payload = nextPayload;
                    return sent;
                }),
                delete: jest.fn().mockResolvedValue(undefined),
            };
            sentMessages.push(sent);
            return sent;
        }),
        isTextBased: jest.fn().mockReturnValue(true),
    };
    return channel;
}

function createSession(overrides: Record<string, any> = {}) {
    const channel = createMockChannel();
    const message = {
        author: { id: 'user-1' },
        channel,
        channelId: 'channel-1',
        react: jest.fn().mockResolvedValue(undefined),
        reply: jest.fn().mockResolvedValue(undefined),
        reactions: {
            removeAll: jest.fn().mockResolvedValue(undefined),
        },
    } as any;

    const cdp = {
        injectMessage: jest.fn().mockResolvedValue({ ok: true, cascadeId: 'cascade-1' }),
        injectMessageWithImageFiles: jest.fn().mockResolvedValue({ ok: true, cascadeId: 'cascade-1' }),
        getGrpcClient: jest.fn().mockResolvedValue({}),
        getActiveCascadeId: jest.fn().mockResolvedValue('cascade-1'),
        getCurrentModel: jest.fn().mockResolvedValue('claude-3-5-sonnet'),
    } as any;

    const onFullCompletion = jest.fn();
    const session = new PromptSession({
        message,
        prompt: 'hello',
        cdp,
        modeService: { getCurrentMode: jest.fn().mockReturnValue('fast') } as any,
        modelService: { getCurrentModel: jest.fn().mockReturnValue('model-a') } as any,
        inboundImages: [],
        options: { onFullCompletion },
        enqueueGeneral: async (task: () => Promise<void>) => task(),
        enqueueResponse: async (task: () => Promise<void>) => task(),
        enqueueActivity: async (task: () => Promise<void>) => task(),
        telemetryModeName: 'Fast',
        telemetryModelName: 'Model A',
        logger: {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        },
        config: {
            autoRenameThreshold: 5,
            coalesceMs: 0,
        },
        autoRenameChannel: jest.fn().mockResolvedValue(undefined),
        tryEmergencyExtractText: jest.fn().mockResolvedValue(''),
        userStopRequestedChannels: new Set<string>(),
        telegramNotify: null,
        ...overrides,
    });

    return { session, channel, message, cdp, onFullCompletion };
}

describe('PromptSession', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        monitorStart.mockReset();
        monitorStop.mockReset();
    });

    it('renders the latest full snapshot without duplicating prior progress and signals completion once', async () => {
        monitorStart.mockImplementation(async (opts: any) => {
            await opts.onProgress?.('Alpha');
            await opts.onProgress?.('Alpha\n\nBeta');
            await opts.onComplete?.('Alpha\n\nBeta');
        });

        const { session, channel, cdp, onFullCompletion } = createSession();
        await session.execute();

        expect(cdp.injectMessage).toHaveBeenCalledTimes(1);
        expect(channel.send).toHaveBeenCalled();
        expect(onFullCompletion).toHaveBeenCalledTimes(1);

        const sent = channel.sentMessages[0];
        expect(sent).toBeDefined();

        const finalPayload = sent.edit.mock.calls.at(-1)?.[0] ?? sent.payload;
        const finalEmbed = finalPayload.embeds[0].toJSON();
        const description = finalEmbed.description as string;

        expect(description).toContain('Alpha');
        expect(description).toContain('Beta');
        expect(description).not.toContain('AlphaAlpha');
        expect((description.match(/Beta/g) || []).length).toBe(1);
    });

    it('stops an active session, clears reactions, and signals completion once', async () => {
        monitorStart.mockResolvedValue(undefined);
        monitorStop.mockResolvedValue(undefined);

        const { session, message, onFullCompletion } = createSession();
        await session.execute();

        const stopped = await session.stopByUser();

        expect(stopped).toBe(true);
        expect(monitorStop).toHaveBeenCalledTimes(1);
        expect(message.reactions.removeAll).toHaveBeenCalled();
        expect(message.react).toHaveBeenCalledWith('⏹️');
        expect(onFullCompletion).toHaveBeenCalledTimes(1);
    });

    it('escapes Telegram notification text before sending', async () => {
        monitorStart.mockImplementation(async (opts: any) => {
            await opts.onComplete?.('Use <tag> && keep & data safe');
        });

        const telegramNotify = jest.fn().mockResolvedValue(undefined);
        const { session } = createSession({ telegramNotify });

        await session.execute();

        expect(telegramNotify).toHaveBeenCalledWith(
            '🦞 <b>Antigravity Response</b>\n\nUse &lt;tag&gt; &amp;&amp; keep &amp; data safe',
        );
    });
});
