import {
    createCoalescedStatusRenderer,
    createTelegramMessageHandler,
    handlePassiveUserMessage,
} from '../../src/bot/telegramMessageHandler';
import { TelegramSessionStateStore } from '../../src/bot/telegramJoinCommand';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        phase: jest.fn(),
        done: jest.fn(),
        prompt: jest.fn(),
        divider: jest.fn(),
    },
}));

jest.mock('../../src/services/cdpBridgeManager', () => ({
    registerApprovalWorkspaceChannel: jest.fn(),
    ensureWorkspaceRuntime: jest.fn(),
    getCurrentCdp: jest.fn().mockReturnValue(null),
}));

jest.mock('../../src/services/grpcResponseMonitor', () => ({
    GrpcResponseMonitor: jest.fn().mockImplementation((opts) => ({
        start: jest.fn().mockImplementation(async () => {
            if (opts.onComplete) await opts.onComplete('Response text');
        }),
        startPassive: jest.fn().mockImplementation(async () => {
            if (opts.onComplete) await opts.onComplete('Response text');
        }),
        stop: jest.fn().mockResolvedValue(undefined),
        isActive: jest.fn().mockReturnValue(true),
    })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain the microtask queue so fire-and-forget monitor.start() completes. */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

function createMockSentMessage(id = '1', channelId = 'chat-123') {
    const msg: any = {
        id,
        platform: 'telegram' as const,
        channelId,
        edit: null as any,
        delete: jest.fn().mockResolvedValue(undefined),
    };
    msg.edit = jest.fn().mockImplementation(async () => msg);
    return msg;
}

function createMockChannel(id = 'chat-123') {
    const statusMsg = createMockSentMessage('status-1', id);
    const sentMessages = [statusMsg];
    let sendCount = 0;
    const send = jest.fn().mockImplementation(async () => {
        sendCount++;
        if (sendCount === 1) {
            return statusMsg;
        }
        const next = createMockSentMessage(`status-${sendCount}`, id);
        sentMessages.push(next);
        return next;
    });
    return {
        id,
        platform: 'telegram' as const,
        send,
        _statusMsg: statusMsg,
        _sentMessages: sentMessages,
    };
}

function createMockMessage(overrides: Record<string, unknown> = {}) {
    const channel = createMockChannel();
    return {
        message: {
            id: 'msg-1',
            platform: 'telegram' as const,
            content: 'hello',
            author: {
                id: 'user-1',
                platform: 'telegram' as const,
                username: 'test',
                isBot: false,
            },
            channel,
            attachments: [],
            createdAt: new Date(),
            react: jest.fn().mockResolvedValue(undefined),
            reply: jest.fn().mockResolvedValue({
                id: '2',
                platform: 'telegram' as const,
                channelId: 'chat-123',
                edit: jest.fn(),
                delete: jest.fn(),
            }),
            ...overrides,
        },
        channel,
    };
}

function createMockCdp() {
    return {
        injectMessage: jest.fn().mockResolvedValue({ ok: true, cascadeId: 'test-cascade-id' }),
        injectMessageWithImageFiles: jest.fn().mockResolvedValue({ ok: true, cascadeId: 'test-cascade-id' }),
        setCachedCascadeId: jest.fn(),
        getGrpcClient: jest.fn().mockResolvedValue({ isReady: () => true }),
        getActiveCascadeId: jest.fn().mockResolvedValue('test-cascade-id'),
        getActiveSessionInfo: jest.fn().mockResolvedValue({ title: 'Session Title', summary: 'Summary' }),
        getCurrentModel: jest.fn().mockResolvedValue(null),
        setUiMode: jest.fn().mockResolvedValue({ ok: true }),
    };
}

function createMockRuntime(cdp = createMockCdp(), projectName = 'test-project') {
    const sendPrompt = jest.fn().mockImplementation(async (options: any) => {
        if (options.imageFilePaths && options.imageFilePaths.length > 0) {
            if (options.overrideCascadeId) {
                return cdp.injectMessageWithImageFiles(options.text, [...options.imageFilePaths], options.overrideCascadeId);
            }
            return cdp.injectMessageWithImageFiles(options.text, [...options.imageFilePaths]);
        }
        if (options.overrideCascadeId) {
            return cdp.injectMessage(options.text, options.overrideCascadeId);
        }
        return cdp.injectMessage(options.text);
    });

    const getMonitoringTarget = jest.fn().mockImplementation(async (preferredCascadeId?: string | null) => {
        const grpcClient = await cdp.getGrpcClient();
        if (!grpcClient) return null;
        const cascadeId = preferredCascadeId || await cdp.getActiveCascadeId();
        if (!cascadeId) return null;
        return { grpcClient, cascadeId };
    });

    return {
        getProjectName: jest.fn().mockReturnValue(projectName),
        setActiveCascade: jest.fn().mockImplementation(async (cascadeId: string | null) => {
            cdp.setCachedCascadeId(cascadeId);
        }),
        syncUiMode: jest.fn().mockImplementation(async (modeName: string) => cdp.setUiMode(modeName)),
        sendPrompt,
        sendPromptWithMonitoringTarget: jest.fn().mockImplementation(async (options: any) => {
            const injectResult = await sendPrompt(options);
            if (!injectResult.ok) {
                return { injectResult, monitoringTarget: null };
            }
            return {
                injectResult,
                monitoringTarget: await getMonitoringTarget(injectResult.cascadeId || options.overrideCascadeId || null),
            };
        }),
        getCurrentModel: jest.fn().mockImplementation(async () => cdp.getCurrentModel()),
        getActiveSessionInfo: jest.fn().mockImplementation(async () => cdp.getActiveSessionInfo()),
        getMonitoringTarget,
        getConnectedCdp: jest.fn().mockReturnValue(cdp),
        getCdpUnsafe: jest.fn().mockReturnValue(cdp),
    };
}

function createMockPool(cdp = createMockCdp()) {
    return {
        getOrConnect: jest.fn().mockResolvedValue(cdp),
        extractProjectName: jest.fn().mockReturnValue('test-project'),
        getActiveWorkspaceNames: jest.fn().mockReturnValue([]),
    };
}

function createBridge(pool = createMockPool()) {
    return {
        pool,
        lastActiveWorkspace: null,
        lastActiveChannel: null,
        approvalChannelByWorkspace: new Map(),
        approvalChannelBySession: new Map(),
        autoAccept: { isEnabled: () => false },
    } as any;
}

function createTelegramBindingRepo(binding?: { chatId: string; workspacePath: string }) {
    return {
        findByChatId: jest.fn().mockReturnValue(binding),
    } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTelegramMessageHandler', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const { ensureWorkspaceRuntime } = jest.requireMock('../../src/services/cdpBridgeManager');
        ensureWorkspaceRuntime.mockImplementation(async (bridge: any, workspacePath: string) => {
            const cdp = await bridge.pool.getOrConnect(workspacePath);
            const projectName = bridge.pool.extractProjectName(workspacePath);
            return {
                runtime: createMockRuntime(cdp, projectName),
                cdp,
                projectName,
            };
        });
    });

    it('returns a function', () => {
        const handler = createTelegramMessageHandler({
            bridge: createBridge(),
            telegramBindingRepo: createTelegramBindingRepo(),
        });
        expect(typeof handler).toBe('function');
    });

    it('does nothing for empty (whitespace-only) messages', async () => {
        const { message } = createMockMessage({ content: '   ' });
        const telegramBindingRepo = createTelegramBindingRepo();

        const handler = createTelegramMessageHandler({
            bridge: createBridge(),
            telegramBindingRepo,
        });

        await handler(message as any);

        expect(telegramBindingRepo.findByChatId).not.toHaveBeenCalled();
        expect(message.reply).not.toHaveBeenCalled();
    });

    it('sends error reply if no workspace binding found for chat', async () => {
        const { message } = createMockMessage();
        const telegramBindingRepo = createTelegramBindingRepo(undefined);

        const handler = createTelegramMessageHandler({
            bridge: createBridge(),
            telegramBindingRepo,
        });

        await handler(message as any);

        expect(telegramBindingRepo.findByChatId).toHaveBeenCalledWith('chat-123');
        expect(message.reply).toHaveBeenCalledWith({
            text: 'No project is linked to this chat. Use /project to bind a workspace.',
        });
    });

    it('connects to CDP and sends prompt', async () => {
        const { ensureWorkspaceRuntime } = jest.requireMock('../../src/services/cdpBridgeManager');
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message } = createMockMessage({ content: 'test prompt' });

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(ensureWorkspaceRuntime).toHaveBeenCalledWith(
            bridge,
            '/workspace/a',
            expect.objectContaining({
                enableActionDetectors: true,
                userMessageSinkKey: 'telegram:chat-123',
                onUserMessage: expect.any(Function),
            }),
        );
        expect(mockCdp.injectMessage).toHaveBeenCalledWith('test prompt');
    });

    it('passes the current prompt as the monitor anchor', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message } = createMockMessage({ content: 'test prompt' });

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(GrpcResponseMonitor).toHaveBeenCalled();
        const monitorOptions = GrpcResponseMonitor.mock.calls[0][0];
        expect(monitorOptions.expectedUserMessage).toBe('test prompt');
    });

    it('sets previously joined cascade ID before sending prompt', async () => {
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message } = createMockMessage({ content: 'test prompt' });
        const sessionStateStore = new TelegramSessionStateStore();
        sessionStateStore.setSelectedSession('chat-123', 'History Session', 'cascade-123');

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo, sessionStateStore });
        await handler(message as any);

        expect(mockCdp.setCachedCascadeId).toHaveBeenCalledWith('cascade-123');
        expect(mockCdp.injectMessage).toHaveBeenCalledWith('test prompt', 'cascade-123');
    });

    it('reuses the last cascade id for the next message in the same chat', async () => {
        const mockCdp = createMockCdp();
        mockCdp.injectMessage
            .mockResolvedValueOnce({ ok: true, cascadeId: 'cascade-new' })
            .mockResolvedValueOnce({ ok: true, cascadeId: 'cascade-new' });
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const sessionStateStore = new TelegramSessionStateStore();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo, sessionStateStore });

        const { message: firstMessage } = createMockMessage({ content: 'first prompt' });
        const { message: secondMessage } = createMockMessage({ content: 'second prompt' });

        await handler(firstMessage as any);
        await handler(secondMessage as any);

        expect(sessionStateStore.getCurrentCascadeId('chat-123')).toBe('cascade-new');
        expect(mockCdp.injectMessage).toHaveBeenNthCalledWith(1, 'first prompt');
        expect(mockCdp.injectMessage).toHaveBeenNthCalledWith(2, 'second prompt', 'cascade-new');
    });

    it('calls message.react() after successful CDP connection', async () => {
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(message.react).toHaveBeenCalledWith('\u{1F440}');
    });

    it('handles CDP connection errors gracefully', async () => {
        const { ensureWorkspaceRuntime } = jest.requireMock('../../src/services/cdpBridgeManager');
        const pool = createMockPool();
        ensureWorkspaceRuntime.mockRejectedValueOnce(new Error('Connection refused'));
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(message.reply).toHaveBeenCalledWith({
            text: 'Failed to connect to workspace: Connection refused',
        });
        expect(message.react).toHaveBeenCalledWith('\u{1F440}');
    });

    it('sends error reply when injectMessage fails', async () => {
        const mockCdp = createMockCdp();
        mockCdp.injectMessage.mockResolvedValue({ ok: false, error: 'Inject failed' });
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(message.reply).toHaveBeenCalledWith({
            text: 'Failed to send message: Inject failed',
        });
    });

    it('registers approval workspace channel and starts detectors', async () => {
        const {
            registerApprovalWorkspaceChannel,
            ensureWorkspaceRuntime,
        } = jest.requireMock('../../src/services/cdpBridgeManager');

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(registerApprovalWorkspaceChannel).toHaveBeenCalledWith(
            bridge,
            'test-project',
            message.channel,
        );
        expect(ensureWorkspaceRuntime).toHaveBeenCalledWith(
            bridge,
            '/workspace/a',
            expect.objectContaining({
                enableActionDetectors: true,
                userMessageSinkKey: 'telegram:chat-123',
                onUserMessage: expect.any(Function),
            }),
        );
    });

    it('detects PC-side session switch and updates tracked cascade ID instead of ignoring', async () => {
        const { ensureWorkspaceRuntime } = jest.requireMock('../../src/services/cdpBridgeManager');
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const sessionStateStore = new TelegramSessionStateStore();
        sessionStateStore.setSelectedSession('chat-123', 'Bound Session', 'cascade-chat');
        const { message, channel } = createMockMessage({ content: 'test prompt' });

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo, sessionStateStore });
        await handler(message as any);

        const runtimeOptions = ensureWorkspaceRuntime.mock.calls[0][2];
        const sendCountBeforePassive = channel.send.mock.calls.length;
        await runtimeOptions.onUserMessage({ text: 'UI typed in another session', cascadeId: 'cascade-other' });
        await Promise.resolve();

        // The message should be forwarded (session switch detected)
        expect(channel.send.mock.calls.length).toBe(sendCountBeforePassive + 1);
        expect(channel.send).toHaveBeenCalledWith({ text: '🖥️ UI typed in another session' });
        // The tracked cascade ID should be updated
        expect(sessionStateStore.getCurrentCascadeId('chat-123')).toBe('cascade-other');
    });

    it('suppresses passive responses when the chat switches to a different cascade before completion', async () => {
        let finishPassive: (() => Promise<void>) | null = null;
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn(),
            startPassive: jest.fn().mockImplementation(async () => {
                if (opts.onProgress) opts.onProgress('Passive partial');
                finishPassive = async () => {
                    if (opts.onComplete) await opts.onComplete('Passive final');
                };
            }),
            stop: jest.fn().mockResolvedValue(undefined),
            isActive: jest.fn().mockReturnValue(true),
        }));

        const channel = createMockChannel();
        channel._statusMsg.edit.mockImplementation(async () => channel._statusMsg);
        const runtime = createMockRuntime();
        const sessionStateStore = new TelegramSessionStateStore();
        sessionStateStore.setSelectedSession('chat-123', 'Bound Session', 'cascade-a');

        await handlePassiveUserMessage(
            channel as any,
            runtime as any,
            { text: 'UI typed here', cascadeId: 'cascade-a' },
            undefined,
            undefined,
            sessionStateStore,
        );

        sessionStateStore.setCurrentCascadeId('chat-123', 'cascade-b');
        if (finishPassive) {
            await (finishPassive as () => Promise<void>)();
        }
        await new Promise((resolve) => setTimeout(resolve, 20));

        const allPayloads = [
            ...channel.send.mock.calls.map(([payload]: any[]) => payload.text),
            ...channel._statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text),
        ].filter(Boolean);

        expect(allPayloads.some((text: string) => text.includes('Passive final'))).toBe(false);
    });

    it('deduplicates repeated passive UI messages for the same cascade and text', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        const originalImpl = GrpcResponseMonitor.getMockImplementation();
        const startPassive = jest.fn().mockResolvedValue(undefined);
        GrpcResponseMonitor.mockImplementation(() => ({
            start: jest.fn(),
            startPassive,
            stop: jest.fn().mockResolvedValue(undefined),
            isActive: jest.fn().mockReturnValue(true),
            getPhase: jest.fn().mockReturnValue('waiting'),
        }));

        const channel = createMockChannel();
        const runtime = createMockRuntime();
        const sessionStateStore = new TelegramSessionStateStore();
        sessionStateStore.setSelectedSession('chat-123', 'Bound Session', 'cascade-a');
        const constructorCountBefore = GrpcResponseMonitor.mock.calls.length;

        await handlePassiveUserMessage(
            channel as any,
            runtime as any,
            { text: 'Repeated from PC', cascadeId: 'cascade-a' },
            undefined,
            undefined,
            sessionStateStore,
        );
        // Let fire-and-forget async startPassiveResponseMonitor resolve
        await new Promise((resolve) => setTimeout(resolve, 50));

        await handlePassiveUserMessage(
            channel as any,
            runtime as any,
            { text: 'Repeated from PC', cascadeId: 'cascade-a' },
            undefined,
            undefined,
            sessionStateStore,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Only one user-facing message sent (dedup blocks the second)
        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(channel.send).toHaveBeenCalledWith({ text: '🖥️ Repeated from PC' });
        // Only one monitor constructed (second call was deduplicated)
        const constructorCountAfter = GrpcResponseMonitor.mock.calls.length;
        expect(constructorCountAfter - constructorCountBefore).toBe(1);

        // Restore original mock to avoid contaminating subsequent tests
        if (originalImpl) GrpcResponseMonitor.mockImplementation(originalImpl);
    });

    it('mirrors passive raw output in place instead of sending a separate final Telegram message', async () => {
        let finishPassive: (() => Promise<void>) | null = null;
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn(),
            startPassive: jest.fn().mockImplementation(async () => {
                if (opts.onProgress) opts.onProgress('Analyzed\n\nCreating');
                finishPassive = async () => {
                    if (opts.onComplete) await opts.onComplete('Analyzed\n\nCreating\n\nFinal answer');
                };
            }),
            stop: jest.fn().mockResolvedValue(undefined),
            isActive: jest.fn().mockReturnValue(true),
        }));

        const channel = createMockChannel();
        const runtime = createMockRuntime();
        const sessionStateStore = new TelegramSessionStateStore();
        sessionStateStore.setSelectedSession('chat-123', 'Bound Session', 'cascade-a');

        await handlePassiveUserMessage(
            channel as any,
            runtime as any,
            { text: 'Mirror this', cascadeId: 'cascade-a' },
            undefined,
            undefined,
            sessionStateStore,
        );

        if (finishPassive) {
            await (finishPassive as () => Promise<void>)();
        }
        await Promise.resolve();

        expect(channel.send).toHaveBeenNthCalledWith(1, { text: '🖥️ Mirror this' });
        expect(channel.send).not.toHaveBeenCalledWith({ text: 'Analyzed\n\nCreating\n\nFinal answer' });
    });

    it('sets lastActiveWorkspace and lastActiveChannel on bridge', async () => {
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(bridge.lastActiveWorkspace).toBe('test-project');
        expect(bridge.lastActiveChannel).toBe(message.channel);
    });

    it('merges final response text into the existing status message after completion', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                // HTML-only delivery: must provide rendered HTML before completion
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<b>Response text</b>' } }],
                        runStatus: null
                    });
                }
                if (opts.onComplete) await opts.onComplete('Response text');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(channel.send).toHaveBeenNthCalledWith(1, { text: 'Generating...' });
        expect(channel._statusMsg.edit).toHaveBeenCalled();
        const editCalls = channel._statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text);
        expect(editCalls.some((t: string) => t.includes('Response text'))).toBe(true);
        expect(channel._statusMsg.delete).not.toHaveBeenCalled();
    });

    it('falls back to sending a new final message when the status edit fails', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<b>Response text</b>' } }],
                        runStatus: null
                    });
                }
                if (opts.onComplete) await opts.onComplete('Response text');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();
        channel._statusMsg.edit.mockImplementation(async (payload: any) => {
            if (payload?.text?.includes('Response text')) {
                throw new Error('edit failed');
            }
            return createMockSentMessage('status-1', channel.id);
        });

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);
        await flushMicrotasks();
        // At least the Processing placeholder + a fallback send with the content
        expect(channel.send.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(channel.send).toHaveBeenNthCalledWith(1, { text: 'Generating...' });
        const allSendPayloads = channel.send.mock.calls.map(([p]: any[]) => p.text).filter(Boolean);
        expect(allSendPayloads.some((t: string) => t.includes('Response text'))).toBe(true);
        expect(channel._statusMsg.delete).toHaveBeenCalled();
    });

    it('sends "(Empty response from Antigravity)" when response is empty', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onComplete) await opts.onComplete('');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();
        channel._statusMsg.edit.mockImplementation(async () => channel._statusMsg);

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);
        await flushMicrotasks();

        expect(channel.send).toHaveBeenCalledWith({
            text: '(Empty response from Antigravity)',
        });
        // Status message should be deleted when empty response + no logs
        expect(channel._statusMsg.delete).toHaveBeenCalled();
    });

    it('uses the status message for the first chunk of long final messages', async () => {
        // Build a response that exceeds 4096 characters
        const longHtml = '<b>' + 'A'.repeat(5000) + '</b>';

        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: longHtml } }],
                        runStatus: null
                    });
                }
                if (opts.onComplete) await opts.onComplete('A'.repeat(5000));
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        // Should have split into multiple messages
        const allSendCalls = channel.send.mock.calls.map(([p]: any[]) => p.text);
        const allEditCalls = channel._statusMsg.edit.mock.calls.map(([p]: any[]) => p.text);
        const allPayloads = [...allEditCalls, ...allSendCalls].filter(Boolean);
        // At least the Processing + one overflow chunk
        expect(allPayloads.length).toBeGreaterThan(1);
        for (const payload of allPayloads) {
            if (payload === 'Generating...') continue;
            expect(payload.length).toBeLessThanOrEqual(4096);
        }
    });

    it('does not block later messages on the previous monitor lifecycle', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        const completions: Array<() => Promise<void>> = [];

        GrpcResponseMonitor.mockImplementation((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                completions.push(async () => {
                    if (opts.onComplete) {
                        await opts.onComplete('Response');
                    }
                });
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });

        const { message: msg1 } = createMockMessage({ content: 'first' });
        const { message: msg2 } = createMockMessage({ content: 'second' });

        const p1 = handler(msg1 as any);
        await flushMicrotasks();
        const p2 = handler(msg2 as any);
        await flushMicrotasks();

        expect(completions).toHaveLength(2);
        expect(mockCdp.injectMessage).toHaveBeenCalledTimes(2);
        expect(mockCdp.injectMessage).toHaveBeenCalledWith('first');
        expect(mockCdp.injectMessage).toHaveBeenCalledWith('second');

        await completions[0]();
        await completions[1]();
        await Promise.all([p1, p2]);
    });

    it('does not block subsequent messages when a task fails', async () => {
        const { ensureWorkspaceRuntime } = jest.requireMock('../../src/services/cdpBridgeManager');
        const mockCdp = createMockCdp();
        // First call fails, second succeeds
        const pool = createMockPool(mockCdp);
        ensureWorkspaceRuntime
            .mockRejectedValueOnce(new Error('first failure'))
            .mockResolvedValueOnce({
                runtime: createMockRuntime(mockCdp, 'test-project'),
                cdp: mockCdp,
                projectName: 'test-project',
            });
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });

        const { message: msg1 } = createMockMessage({ content: 'first' });
        const { message: msg2 } = createMockMessage({ content: 'second' });

        await handler(msg1 as any);
        await handler(msg2 as any);

        // Second message should still be processed
        expect(mockCdp.injectMessage).toHaveBeenCalledWith('second');
    });

    it('reports missing monitoring target without crashing', async () => {
        const mockCdp = createMockCdp();
        mockCdp.getGrpcClient.mockResolvedValue(null);
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage({ content: 'test prompt' });

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });

        await expect(handler(message as any)).resolves.toBeUndefined();

        expect(channel.send).toHaveBeenCalledWith({
            text: '❌ LS client unavailable — cannot monitor response.',
        });
    });

    it('does not crash when react() rejects', async () => {
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message } = createMockMessage();
        message.react.mockRejectedValue(new Error('react failed'));

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });

        // Should not throw
        await expect(handler(message as any)).resolves.toBeUndefined();
    });

    it('intercepts /project command and does not reach CDP path', async () => {
        const { ensureWorkspaceRuntime } = jest.requireMock('../../src/services/cdpBridgeManager');
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const telegramBindingRepo = createTelegramBindingRepo();
        const workspaceService = { scanWorkspaces: jest.fn().mockReturnValue(['proj-a']) } as any;
        const { message } = createMockMessage({ content: '/project' });

        const handler = createTelegramMessageHandler({
            bridge,
            telegramBindingRepo,
            workspaceService,
        });
        await handler(message as any);

        // /project should be handled by project command, NOT reach CDP
        expect(ensureWorkspaceRuntime).not.toHaveBeenCalled();
        expect(mockCdp.injectMessage).not.toHaveBeenCalled();
        // Should reply with workspace list (via project command handler)
        expect(message.reply).toHaveBeenCalled();
    });

    it('sends a "Generating..." status message before monitoring', async () => {
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        // First call to channel.send should be the status message
        expect(channel.send).toHaveBeenNthCalledWith(1, { text: 'Generating...' });
    });

    it('edits status message with rendered HTML timeline from Antigravity', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<blockquote>Reading file.ts</blockquote>' } }],
                        runStatus: null
                    });
                }
                if (opts.onComplete) await opts.onComplete('Done response');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(channel._statusMsg.edit).toHaveBeenCalled();
        const editCalls = channel._statusMsg.edit.mock.calls;
        const logCall = editCalls.find(([payload]: any[]) => payload.text.includes('Reading file.ts'));
        expect(logCall).toBeDefined();
    });

    it('splits oversized rendered timelines across multiple status messages without truncation', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        const longTimelineHtml = `<blockquote>${Array.from(
            { length: 900 },
            (_v, index) => `Step ${index + 1} - reviewing a very long Antigravity timeline row`,
        ).join('<br>')}</blockquote>`;
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: longTimelineHtml } }],
                        runStatus: null
                    });
                }
                // text-to-html path: finalText must also contain the content
                const longFinalText = Array.from(
                    { length: 900 },
                    (_v, index) => `Step ${index + 1} - reviewing a very long Antigravity timeline row`,
                ).join('\n');
                if (opts.onComplete) await opts.onComplete(longFinalText);
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);
        await flushMicrotasks();

        const allPayloads = [
            ...channel._statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text),
            ...channel.send.mock.calls.map(([payload]: any[]) => payload.text),
        ];
        const streamedText = allPayloads.join('\n');
        expect(streamedText).toContain('Step 1');
        expect(streamedText).toContain('Step 900');

        for (const payloadText of allPayloads) {
            if (!payloadText) continue;
            expect(payloadText.length).toBeLessThanOrEqual(4096);
        }

        expect(channel.send.mock.calls.length).toBeGreaterThan(2);
        for (const [payload] of channel._statusMsg.edit.mock.calls) {
            expect(payload.text.length).toBeLessThanOrEqual(4096);
        }
    });

    it('streams rendered timeline into the status message before completion', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<blockquote>Partial streamed answer</blockquote>' } }],
                        runStatus: null
                    });
                }
                if (opts.onComplete) await opts.onComplete('Final answer');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(channel._statusMsg.edit).toHaveBeenCalled();
        const renderedFrames = channel._statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text);
        expect(renderedFrames.some((text: string) => text.includes('Partial streamed answer'))).toBe(true);
        expect(channel.send).not.toHaveBeenCalledWith({ text: 'Final answer' });
    });

    it('passes through later rendered steps to Telegram without surfacing generating noise', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<blockquote>Partial streamed answer</blockquote>' } }],
                        runStatus: null
                    });
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<blockquote>Now let me look at the listAllSessions function<br><br>Partial streamed answer</blockquote>' } }],
                        runStatus: null
                    });
                }
                // text-to-html path: finalText must contain the content we check for
                if (opts.onComplete) await opts.onComplete('Now let me look at the listAllSessions function\n\nPartial streamed answer');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        const renderedFrames = channel._statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text);
        expect(renderedFrames.some((text: string) => text.includes('Now let me look at the listAllSessions function'))).toBe(true);
        expect(renderedFrames.some((text: string) => /(^|\n)\s*generating\s*($|\n)/i.test(text))).toBe(false);
    });

    it('keeps passthrough html unescaped in Telegram activity text', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<blockquote><b>Reviewing</b><br>next step</blockquote>' } }],
                        runStatus: null
                    });
                }
                if (opts.onComplete) await opts.onComplete('Final answer');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        const renderedFrames = channel._statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text);
        expect(renderedFrames.some((text: string) => text.includes('<b>Reviewing</b>') && text.includes('next step'))).toBe(true);
        expect(renderedFrames.some((text: string) => text.includes('&lt;b&gt;Reviewing&lt;/b&gt;'))).toBe(false);
    });

    it('opens a new streaming status card when the existing Telegram card hits the length limit', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<blockquote>Partial streamed answer</blockquote>' } }],
                        runStatus: null
                    });
                }
                if (opts.onComplete) await opts.onComplete('Final answer');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();
        channel._statusMsg.edit.mockImplementation(async (payload: any) => {
            if (payload?.text?.includes('Partial streamed answer')) {
                throw new Error('message is too long');
            }
            return createMockSentMessage('status-1', channel.id);
        });

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
            text: expect.stringContaining('Partial streamed answer'),
        }));
        expect(channel._statusMsg.delete).not.toHaveBeenCalled();
    });

    it('shows rendered thinking text without duplicating the same content from preview', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        const repeatedText = 'Let me first run ESLint to see all the warnings.';
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: `<blockquote>${repeatedText}</blockquote>` } }],
                        runStatus: null
                    });
                }
                if (opts.onComplete) await opts.onComplete('Final answer');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        const streamedFrames = channel._statusMsg.edit.mock.calls
            .map(([payload]: any[]) => payload.text)
            .filter((text: string) => text.includes(repeatedText));

        expect(streamedFrames.length).toBeGreaterThan(0);
        for (const frame of streamedFrames) {
            expect(frame.split(repeatedText).length - 1).toBe(1);
        }
    });

    it('splits oversized rendered previews across status messages without truncation', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        const startMarker = 'START-MARKER';
        const endMarker = 'END-MARKER';
        const longPreview = `${startMarker}\n${'P'.repeat(5000)}\n${endMarker}`;
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: longPreview } }],
                        runStatus: null
                    });
                }
                if (opts.onComplete) await opts.onComplete('Done');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        // Status message edits should never exceed Telegram's 4096 char limit
        const allEdits = channel._statusMsg.edit.mock.calls;
        for (const [payload] of allEdits) {
            expect(payload.text.length).toBeLessThanOrEqual(4096);
        }
        const allPayloads = [
            ...channel._statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text),
            ...channel.send.mock.calls.map(([payload]: any[]) => payload.text),
            ...channel._sentMessages.flatMap((sent: any) =>
                sent.edit?.mock?.calls?.map(([payload]: any[]) => payload.text) ?? [],
            ),
        ];
        const streamedText = allPayloads.join('\n');
        expect(streamedText).toContain(startMarker);
        expect(streamedText).toContain(endMarker);
        expect(channel.send.mock.calls.length).toBeGreaterThan(1);
    });

    it('keeps both prefix and tail of oversized rendered previews', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        const prefixMarker = 'The __claw__ workspace is your agent workspace';
        const tailMarker = 'Ran command: npx eslint .';
        const longPreview = `${prefixMarker}\n${'A'.repeat(3000)}\n${tailMarker}`;
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: longPreview } }],
                        runStatus: null
                    });
                }
                if (opts.onComplete) await opts.onComplete('Done');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        const previewFrames = [
            ...channel._statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text),
            ...channel.send.mock.calls.map(([payload]: any[]) => payload.text),
            ...channel._sentMessages.flatMap((sent: any) =>
                sent.edit?.mock?.calls?.map(([payload]: any[]) => payload.text) ?? [],
            ),
        ];

        const combinedPreviewText = previewFrames.join('\n');
        expect(combinedPreviewText).toContain('agent workspace');
        expect(combinedPreviewText).toContain(tailMarker);
    });

    it('coalesces bursty streaming updates and delivers final content correctly', async () => {
        jest.useFakeTimers();
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<blockquote>Step 1</blockquote>' } }],
                        runStatus: null
                    });
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<blockquote>Step 2</blockquote>' } }],
                        runStatus: null
                    });
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<blockquote>Step 3</blockquote>' } }],
                        runStatus: null
                    });
                }
                await new Promise((resolve) => setTimeout(resolve, 30));
                if (opts.onComplete) await opts.onComplete('Done response');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        const handlerPromise = handler(message as any);

        await jest.advanceTimersByTimeAsync(50);
        await handlerPromise;

        // Behavior test: final delivered content should contain 'Step 3'
        // (the latest rendered timeline). We don't care how many intermediate
        // frames were coalesced — only that the final content is correct.
        const allPayloads = [
            ...channel._statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text),
            ...channel.send.mock.calls.map(([payload]: any[]) => payload.text),
        ];
        expect(allPayloads.some((text: string) => text.includes('Step 3'))).toBe(true);

        jest.useRealTimers();
    });

    it('delivers final text content to Telegram on completion', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                // HTML-only delivery: provide rendered HTML before completion
                if (opts.onStepsUpdate) {
                    opts.onStepsUpdate({
                        steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '<b>Final output</b>' } }],
                        runStatus: null
                    });
                }
                if (opts.onComplete) await opts.onComplete('Final output');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        // Behavior: the final output text should be delivered to Telegram
        // (via edit or send, we don't care which mechanism).
        const allPayloads = [
            ...channel._statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text),
            ...channel.send.mock.calls.map(([payload]: any[]) => payload.text),
        ];
        expect(allPayloads.some((text: string) => text.includes('Final output'))).toBe(true);
    });

    it('does not intercept /project when workspaceService is not provided', async () => {
        const { message } = createMockMessage({ content: '/project' });
        const telegramBindingRepo = createTelegramBindingRepo(undefined);

        const handler = createTelegramMessageHandler({
            bridge: createBridge(),
            telegramBindingRepo,
            // workspaceService intentionally omitted
        });
        await handler(message as any);

        // Falls through to normal binding check → "No project is linked"
        expect(telegramBindingRepo.findByChatId).toHaveBeenCalled();
        expect(message.reply).toHaveBeenCalledWith({
            text: 'No project is linked to this chat. Use /project to bind a workspace.',
        });
    });

    it.each(['/help', '/status', '/stop', '/ping', '/start'])(
        'intercepts %s command and does not reach CDP path',
        async (cmd) => {
            const { ensureWorkspaceRuntime } = jest.requireMock('../../src/services/cdpBridgeManager');
            const mockCdp = createMockCdp();
            const pool = createMockPool(mockCdp);
            const bridge = createBridge(pool);
            const telegramBindingRepo = createTelegramBindingRepo({
                chatId: 'chat-123',
                workspacePath: '/workspace/a',
            });
            const { message } = createMockMessage({ content: cmd });

            const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
            await handler(message as any);

            // Built-in commands should NOT reach CDP
            expect(ensureWorkspaceRuntime).not.toHaveBeenCalled();
            expect(mockCdp.injectMessage).not.toHaveBeenCalled();
            // Should reply with command-specific text
            expect(message.reply).toHaveBeenCalled();
        },
    );

    describe('mode push to Antigravity on CDP connect', () => {
        it('pushes ModeService mode to Antigravity on connect', async () => {
            const mockCdp = {
                ...createMockCdp(),
                setUiMode: jest.fn().mockResolvedValue({ ok: true }),
            };
            const pool = createMockPool(mockCdp);
            const bridge = createBridge(pool);
            const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
            const telegramBindingRepo = createTelegramBindingRepo(binding);
            const modeService = {
                getCurrentMode: jest.fn().mockReturnValue('fast'),
                markSynced: jest.fn(),
            } as any;
            const { message } = createMockMessage();

            const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo, modeService });
            await handler(message as any);

            expect(mockCdp.setUiMode).toHaveBeenCalledWith('fast');
            expect(modeService.markSynced).toHaveBeenCalled();
        });

        it('pushes user-selected mode (plan) to Antigravity', async () => {
            const mockCdp = {
                ...createMockCdp(),
                setUiMode: jest.fn().mockResolvedValue({ ok: true }),
            };
            const pool = createMockPool(mockCdp);
            const bridge = createBridge(pool);
            const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
            const telegramBindingRepo = createTelegramBindingRepo(binding);
            const modeService = {
                getCurrentMode: jest.fn().mockReturnValue('plan'),
                markSynced: jest.fn(),
            } as any;
            const { message } = createMockMessage();

            const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo, modeService });
            await handler(message as any);

            expect(mockCdp.setUiMode).toHaveBeenCalledWith('plan');
            expect(modeService.markSynced).toHaveBeenCalled();
        });

        it('does not crash when mode push fails', async () => {
            const mockCdp = {
                ...createMockCdp(),
                setUiMode: jest.fn().mockResolvedValue({ ok: false, error: 'mode not found' }),
            };
            const pool = createMockPool(mockCdp);
            const bridge = createBridge(pool);
            const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
            const telegramBindingRepo = createTelegramBindingRepo(binding);
            const modeService = {
                getCurrentMode: jest.fn().mockReturnValue('plan'),
                markSynced: jest.fn(),
            } as any;
            const { message } = createMockMessage();

            const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo, modeService });
            await expect(handler(message as any)).resolves.toBeUndefined();

            expect(mockCdp.setUiMode).toHaveBeenCalledWith('plan');
            expect(modeService.markSynced).not.toHaveBeenCalled();
        });

        it('does not attempt sync when modeService is not provided', async () => {
            const mockCdp = {
                ...createMockCdp(),
                setUiMode: jest.fn(),
            };
            const pool = createMockPool(mockCdp);
            const bridge = createBridge(pool);
            const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
            const telegramBindingRepo = createTelegramBindingRepo(binding);
            const { message } = createMockMessage();

            const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
            await handler(message as any);

            expect(mockCdp.setUiMode).not.toHaveBeenCalled();
        });

        it('displays current mode and model in status message', async () => {
            const mockCdp = {
                ...createMockCdp(),
                getCurrentModel: jest.fn().mockResolvedValue('Claude 4.0 Ultra'),
            };
            const pool = createMockPool(mockCdp);
            const bridge = createBridge(pool);
            const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
            const telegramBindingRepo = createTelegramBindingRepo(binding);
            const modeService = {
                getCurrentMode: jest.fn().mockReturnValue('fast'),
                markSynced: jest.fn(),
            } as any;
            const { message } = createMockMessage();

            const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo, modeService });
            await handler(message as any);

            // Mode is pushed to CDP on connect and markSynced is called on success
            expect(mockCdp.setUiMode).toHaveBeenCalledWith('fast');
            expect(modeService.markSynced).toHaveBeenCalled();
        });
    });

    describe('activeMonitors registration', () => {
        it('registers monitor in activeMonitors map during response monitoring', async () => {
            const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
            GrpcResponseMonitor.mockImplementationOnce((opts: any) => {
                const monitor = {
                    start: jest.fn().mockImplementation(async () => {
                        if (opts.onComplete) await opts.onComplete('Response');
                    }),
                    stop: jest.fn().mockResolvedValue(undefined),
                };
                return monitor;
            });

            const mockCdp = createMockCdp();
            const pool = createMockPool(mockCdp);
            const bridge = createBridge(pool);
            const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
            const telegramBindingRepo = createTelegramBindingRepo(binding);
            const activeMonitors = new Map<string, any>();
            const { message } = createMockMessage();

            const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo, activeMonitors });
            await handler(message as any);
            await flushMicrotasks();

            // After completion, monitor should have been removed from the map
            expect(activeMonitors.size).toBe(0);
        });

        it('passes activeMonitors to command handler for /stop access', async () => {
            const { ensureWorkspaceRuntime } = jest.requireMock('../../src/services/cdpBridgeManager');
            const mockCdp = createMockCdp();
            const pool = createMockPool(mockCdp);
            const bridge = createBridge(pool);
            const telegramBindingRepo = createTelegramBindingRepo({
                chatId: 'chat-123',
                workspacePath: '/workspace/a',
            });
            const activeMonitors = new Map<string, any>();
            const { message } = createMockMessage({ content: '/stop' });

            const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo, activeMonitors });
            await handler(message as any);

            // /stop is intercepted as a command — CDP path not reached
            expect(ensureWorkspaceRuntime).not.toHaveBeenCalled();
        });
    });

    it('forwards unknown slash commands to Antigravity as normal messages', async () => {
        const { ensureWorkspaceRuntime } = jest.requireMock('../../src/services/cdpBridgeManager');
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message } = createMockMessage({ content: '/unknown_command' });

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        // Unknown commands should be forwarded to Antigravity via CDP
        expect(ensureWorkspaceRuntime).toHaveBeenCalled();
        expect(mockCdp.injectMessage).toHaveBeenCalledWith('/unknown_command');
    });
});

describe('createCoalescedStatusRenderer', () => {
    it('flushes the latest pending html frame after an immediate text frame', async () => {
        const channel = createMockChannel();
        const statusMsg = channel._statusMsg;
        statusMsg.edit.mockImplementation(async () => statusMsg);
        const messages = [statusMsg];
        const renderer = createCoalescedStatusRenderer(
            channel as any,
            () => messages,
            (nextMessages) => {
                messages.splice(0, messages.length, ...nextMessages);
            },
        );

        renderer.request('Let me first run ESLint to see all the current warnings.', true);
        renderer.request('<b>Running background command</b>\n<code>npx eslint . 2>&1 | head -200</code>', true);
        await renderer.flush();

        const editPayloads = statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text);
        expect(editPayloads).toContain('Let me first run ESLint to see all the current warnings.');
        expect(editPayloads).toContain('<b>Running background command</b>\n<code>npx eslint . 2>&1 | head -200</code>');
    });

    it('promotes the first sent status message to the latest pending html frame', async () => {
        const channel = createMockChannel();
        channel._statusMsg.edit.mockImplementation(async () => channel._statusMsg);
        const messages: any[] = [];
        const renderer = createCoalescedStatusRenderer(
            channel as any,
            () => messages,
            (nextMessages) => {
                messages.splice(0, messages.length, ...nextMessages);
            },
        );

        renderer.request('Thinking...', true);
        renderer.request('<b>Running background command</b>\n<code>npx eslint . 2>&1 | head -200</code>', true);
        await renderer.flush();

        const sendPayloads = channel.send.mock.calls.map(([payload]: any[]) => payload.text);
        expect(sendPayloads).toContain('Thinking...');
        const editPayloads = channel._statusMsg.edit.mock.calls.map(([payload]: any[]) => payload.text);
        expect(editPayloads).toContain('<b>Running background command</b>\n<code>npx eslint . 2>&1 | head -200</code>');
    });
});
