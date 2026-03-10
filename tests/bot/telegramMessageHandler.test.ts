import { createTelegramMessageHandler } from '../../src/bot/telegramMessageHandler';
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
        stop: jest.fn().mockResolvedValue(undefined),
    })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSentMessage(id = '1', channelId = 'chat-123') {
    return {
        id,
        platform: 'telegram' as const,
        channelId,
        edit: jest.fn().mockResolvedValue({
            id,
            platform: 'telegram' as const,
            channelId,
            edit: jest.fn(),
            delete: jest.fn(),
        }),
        delete: jest.fn().mockResolvedValue(undefined),
    };
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
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(channel.send).toHaveBeenNthCalledWith(1, { text: 'Processing...' });
        expect(channel._statusMsg.edit).toHaveBeenCalledWith({ text: 'Response text' });
        expect(channel._statusMsg.delete).not.toHaveBeenCalled();
    });

    it('falls back to sending a new final message when the status edit fails', async () => {
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();
        channel._statusMsg.edit.mockImplementation(async (payload: any) => {
            if (payload?.text === 'Response text') {
                throw new Error('edit failed');
            }
            return createMockSentMessage('status-1', channel.id);
        });

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(channel.send).toHaveBeenCalledTimes(2);
        expect(channel.send).toHaveBeenNthCalledWith(1, { text: 'Processing...' });
        expect(channel.send).toHaveBeenNthCalledWith(2, { text: 'Response text' });
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

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        expect(channel.send).toHaveBeenCalledWith({
            text: '(Empty response from Antigravity)',
        });
        // Status message should be deleted when empty response + no logs
        expect(channel._statusMsg.delete).toHaveBeenCalled();
    });

    it('uses the status message for the first chunk of long final messages', async () => {
        // Build a response that exceeds 4096 characters
        const longText = 'A'.repeat(5000);

        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onComplete) await opts.onComplete(longText);
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

        expect(channel.send).toHaveBeenCalledTimes(2);
        expect(channel.send).toHaveBeenNthCalledWith(1, { text: 'Processing...' });
        expect(channel._statusMsg.edit).toHaveBeenCalledWith({ text: 'A'.repeat(4096) });
        expect(channel.send).toHaveBeenNthCalledWith(2, { text: 'A'.repeat(904) });
    });

    it('queues messages for same workspace (serial execution)', async () => {
        const executionOrder: number[] = [];
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');

        let callCount = 0;
        GrpcResponseMonitor.mockImplementation((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                callCount++;
                const current = callCount;
                // Simulate first message taking longer
                if (current === 1) {
                    await new Promise((r) => setTimeout(r, 30));
                }
                executionOrder.push(current);
                if (opts.onComplete) await opts.onComplete(`Response ${current}`);
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

        // Fire both without awaiting — they should serialize
        const p1 = handler(msg1 as any);
        const p2 = handler(msg2 as any);
        await Promise.all([p1, p2]);

        // Due to queue serialization, 1 always completes before 2
        expect(executionOrder).toEqual([1, 2]);
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

    it('sends a "Processing..." status message before monitoring', async () => {
        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message, channel } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        // First call to channel.send should be the status message
        expect(channel.send).toHaveBeenNthCalledWith(1, { text: 'Processing...' });
    });

    it('edits status message with rendered HTML timeline from Antigravity', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onRenderedTimeline) {
                    opts.onRenderedTimeline({
                        content: '<blockquote>Reading file.ts</blockquote>',
                        format: 'html',
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

        // Status message should have been edited with rendered timeline HTML
        expect(channel._statusMsg.edit).toHaveBeenCalled();
        const editCalls = channel._statusMsg.edit.mock.calls;
        const logCall = editCalls.find(([payload]: any[]) => payload.text.includes('Reading file.ts'));
        expect(logCall).toBeDefined();
    });

    it('splits oversized rendered timelines across multiple streaming status messages without truncation', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        const longTimelineHtml = `<blockquote>${Array.from(
            { length: 900 },
            (_v, index) => `Step ${index + 1} - reviewing a very long Antigravity timeline row`,
        ).join('<br>')}</blockquote>`;
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onRenderedTimeline) {
                    opts.onRenderedTimeline({
                        content: longTimelineHtml,
                        format: 'html',
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
            const openBlockquotes = (payloadText.match(/<blockquote>/g) || []).length;
            const closeBlockquotes = (payloadText.match(/<\/blockquote>/g) || []).length;
            expect(openBlockquotes).toBe(closeBlockquotes);
        }

        expect(channel.send.mock.calls.length).toBeGreaterThan(2);
        for (const [payload] of channel._statusMsg.edit.mock.calls) {
            expect(payload.text.length).toBeLessThanOrEqual(4096);
        }
    });

    it('streams partial output into the status message before completion', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onProgress) opts.onProgress('Partial streamed answer');
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
        expect(channel._statusMsg.edit).toHaveBeenCalledWith({ text: 'Final answer' });
    });

    it('shows thinking text without duplicating the same content from preview', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        const repeatedText = 'Let me first run ESLint to see all the warnings.';
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onPhaseChange) opts.onPhaseChange('thinking', repeatedText);
                if (opts.onProgress) opts.onProgress(repeatedText);
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

    it('splits oversized streaming previews across status messages without truncation', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        const startMarker = 'START-MARKER';
        const endMarker = 'END-MARKER';
        const longPreview = `${startMarker}\n${'P'.repeat(5000)}\n${endMarker}`;
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onProgress) opts.onProgress(longPreview);
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
        ];
        const streamedText = allPayloads.join('\n');
        expect(streamedText).toContain(startMarker);
        expect(streamedText).toContain(endMarker);
        expect(channel.send.mock.calls.length).toBeGreaterThan(1);
        expect(channel._statusMsg.edit).toHaveBeenCalledWith({ text: 'Done' });
    });

    it('keeps both prefix and tail of oversized streaming previews', async () => {
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        const prefixMarker = 'The __claw__ workspace is your agent workspace';
        const tailMarker = 'Ran command: npx eslint .';
        const longPreview = `${prefixMarker}\n${'A'.repeat(3000)}\n${tailMarker}`;
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onProgress) opts.onProgress(longPreview);
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
        ].filter((text: string) => text.includes('<blockquote>'));

        expect(previewFrames.some((text: string) => text.includes(prefixMarker))).toBe(true);
        expect(previewFrames.some((text: string) => text.includes(tailMarker))).toBe(true);
    });

    it('coalesces bursty streaming updates down to the latest status frame', async () => {
        jest.useFakeTimers();
        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onRenderedTimeline) {
                    opts.onRenderedTimeline({ content: '<blockquote>Step 1</blockquote>', format: 'html' });
                    opts.onRenderedTimeline({ content: '<blockquote>Step 2</blockquote>', format: 'html' });
                    opts.onRenderedTimeline({ content: '<blockquote>Step 3</blockquote>', format: 'html' });
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

        const renderedFrames = channel._statusMsg.edit.mock.calls
            .map(([payload]: any[]) => payload.text)
            .filter((text: string) => text.includes('Step '));

        expect(renderedFrames.some((text: string) => text.includes('Step 3'))).toBe(true);
        expect(renderedFrames.some((text: string) => text.includes('Step 1'))).toBe(false);
        expect(renderedFrames.some((text: string) => text.includes('Step 2'))).toBe(false);
        expect(renderedFrames.length).toBeLessThanOrEqual(2);

        jest.useRealTimers();
    });

    it('calls logger.divider on completion for final output only', async () => {
        const { logger: mockLogger } = jest.requireMock('../../src/utils/logger');

        const { GrpcResponseMonitor } = jest.requireMock('../../src/services/grpcResponseMonitor');
        GrpcResponseMonitor.mockImplementationOnce((opts: any) => ({
            start: jest.fn().mockImplementation(async () => {
                if (opts.onComplete) await opts.onComplete('Final output');
            }),
            stop: jest.fn().mockResolvedValue(undefined),
        }));

        const mockCdp = createMockCdp();
        const pool = createMockPool(mockCdp);
        const bridge = createBridge(pool);
        const binding = { chatId: 'chat-123', workspacePath: '/workspace/a' };
        const telegramBindingRepo = createTelegramBindingRepo(binding);
        const { message } = createMockMessage();

        const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo });
        await handler(message as any);

        // logger.divider should have been called for process log + output + final
        const dividerCalls = mockLogger.divider.mock.calls.map((c: any[]) => c[0]);
        expect(dividerCalls.some((c: string) => c.includes('Output'))).toBe(true);
        expect(dividerCalls).not.toContain('Process Log');
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
            const { message, channel } = createMockMessage();

            const handler = createTelegramMessageHandler({ bridge, telegramBindingRepo, modeService });
            await handler(message as any);

            const statusEdit = channel._statusMsg.edit.mock.calls.find(
                ([payload]: any[]) => payload.text.includes('Current Mode: Fast') && payload.text.includes('Model: Claude 4.0 Ultra'),
            );
            expect(statusEdit).toBeDefined();
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
