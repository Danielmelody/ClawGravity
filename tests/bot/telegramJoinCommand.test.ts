import {
    handleTelegramJoinCommand,
    handleTelegramJoinSelect,
    TelegramSessionStateStore,
    TG_JOIN_SELECT_ID,
} from '../../src/bot/telegramJoinCommand';
import { TelegramRecentMessageRepository } from '../../src/database/telegramRecentMessageRepository';
import type { PlatformMessage, PlatformSelectInteraction } from '../../src/platform/types';
import Database from 'better-sqlite3';

jest.mock('../../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock('../../src/services/cdpBridgeManager', () => ({
    ...jest.requireActual('../../src/services/cdpBridgeManager'),
    ensureWorkspaceRuntime: jest.fn(),
}));

function createMessage(chatId = 'chat-1'): PlatformMessage {
    return {
        id: 'msg-1',
        platform: 'telegram',
        content: '/history',
        author: {
            id: 'user-1',
            platform: 'telegram',
            username: 'tester',
            isBot: false,
        },
        channel: {
            id: chatId,
            platform: 'telegram',
            send: jest.fn(),
        },
        attachments: [],
        createdAt: new Date(),
        react: jest.fn().mockResolvedValue(undefined),
        reply: jest.fn().mockResolvedValue({
            id: 'sent-1',
            platform: 'telegram',
            channelId: chatId,
            edit: jest.fn(),
            delete: jest.fn(),
        }),
    } as any;
}

function createInteraction(value: string, chatId = 'chat-1'): PlatformSelectInteraction {
    return {
        id: 'int-1',
        platform: 'telegram',
        customId: TG_JOIN_SELECT_ID,
        user: {
            id: 'user-1',
            platform: 'telegram',
            username: 'tester',
            isBot: false,
        },
        channel: {
            id: chatId,
            platform: 'telegram',
            send: jest.fn(),
        },
        values: [value],
        messageId: 'msg-1',
        deferUpdate: jest.fn().mockResolvedValue(undefined),
        reply: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn(),
    } as any;
}

describe('TelegramSessionStateStore', () => {
    it('tracks selected session and recent messages', () => {
        const store = new TelegramSessionStateStore();
        store.setSelectedSession('chat-1', 'Session A');
        store.pushRecentMessage('chat-1', 'First');
        store.pushRecentMessage('chat-1', 'Second');
        store.pushRecentMessage('chat-1', 'Third');

        expect(store.getSelectedSession('chat-1')).toEqual({ title: 'Session A', id: '' });
        expect(store.getRecentMessages('chat-1', 2)).toEqual(['Second', 'Third']);

        store.clearSelectedSession('chat-1');
        expect(store.getSelectedSession('chat-1')).toBeNull();
    });

    it('tracks the current cascade id per chat', () => {
        const store = new TelegramSessionStateStore();
        store.setSelectedSession('chat-1', 'Session A', 'cascade-a');
        expect(store.getCurrentCascadeId('chat-1')).toBe('cascade-a');

        store.setCurrentCascadeId('chat-1', 'cascade-b');
        expect(store.getSelectedSession('chat-1')).toEqual({ title: 'Session A', id: 'cascade-b' });
        expect(store.getCurrentCascadeId('chat-1')).toBe('cascade-b');
    });

    it('loads recent messages from SQLite persistence after restart', () => {
        const db = new Database(':memory:');
        const repo = new TelegramRecentMessageRepository(db);
        const writer = new TelegramSessionStateStore(repo);
        writer.pushRecentMessage('chat-1', 'First');
        writer.pushRecentMessage('chat-1', 'Second');
        writer.pushRecentMessage('chat-1', 'Third');

        const reader = new TelegramSessionStateStore(repo);
        expect(reader.getRecentMessages('chat-1', 2)).toEqual(['Second', 'Third']);

        db.close();
    });
});

describe('handleTelegramJoinCommand', () => {
    beforeEach(() => {
        const { ensureWorkspaceRuntime } = jest.requireMock('../../src/services/cdpBridgeManager');
        ensureWorkspaceRuntime.mockImplementation(async (bridge: any, workspacePath: string) => {
            const cdp = await bridge.pool.getOrConnect(workspacePath);
            return {
                runtime: {
                    listAllSessions: jest.fn().mockImplementation(async (chatSessionService: any) => chatSessionService.listAllSessions(cdp)),
                    getConversationHistory: jest.fn().mockImplementation(async (chatSessionService: any, options: any) => chatSessionService.getConversationHistory(cdp, options)),
                    setActiveCascade: jest.fn().mockImplementation(async (cascadeId: string) => cdp.setCachedCascadeId?.(cascadeId)),
                },
                cdp,
                projectName: bridge.pool.extractProjectName?.(workspacePath) ?? workspacePath,
            };
        });
    });

    it('shows a select menu with history sessions', async () => {
        const message = createMessage();
        const cdp = {};
        const deps = {
            bridge: { pool: { getOrConnect: jest.fn().mockResolvedValue(cdp), extractProjectName: jest.fn().mockReturnValue('DeepMarket') } },
            telegramBindingRepo: { findByChatId: jest.fn().mockReturnValue({ chatId: 'chat-1', workspacePath: 'DeepMarket' }) },
            workspaceService: { getWorkspacePath: jest.fn().mockReturnValue('/workspace/DeepMarket') },
            chatSessionService: {
                listAllSessions: jest.fn().mockResolvedValue([
                    { title: 'History A', isActive: false },
                    { title: 'History B', isActive: true },
                ]),
            },
            sessionStateStore: new TelegramSessionStateStore(),
        } as any;

        await handleTelegramJoinCommand(deps, message);

        expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
            text: expect.stringContaining('Select a history session'),
            components: expect.arrayContaining([
                expect.objectContaining({
                    components: expect.arrayContaining([
                        expect.objectContaining({
                            type: 'selectMenu',
                            customId: TG_JOIN_SELECT_ID,
                        }),
                    ]),
                }),
            ]),
        }));
    });
});

describe('handleTelegramJoinSelect', () => {
    beforeEach(() => {
        const { ensureWorkspaceRuntime } = jest.requireMock('../../src/services/cdpBridgeManager');
        ensureWorkspaceRuntime.mockImplementation(async (bridge: any, workspacePath: string) => {
            const cdp = await bridge.pool.getOrConnect(workspacePath);
            return {
                runtime: {
                    listAllSessions: jest.fn().mockImplementation(async (chatSessionService: any) => chatSessionService.listAllSessions(cdp)),
                    getConversationHistory: jest.fn().mockImplementation(async (chatSessionService: any, options: any) => chatSessionService.getConversationHistory(cdp, options)),
                    setActiveCascade: jest.fn().mockImplementation(async (cascadeId: string) => cdp.setCachedCascadeId?.(cascadeId)),
                },
                cdp,
                projectName: bridge.pool.extractProjectName?.(workspacePath) ?? workspacePath,
            };
        });
    });

    it('activates selected session and sends extracted history to Telegram', async () => {
        const interaction = createInteraction('History A');
        const cdp = { setCachedCascadeId: jest.fn() };
        const store = new TelegramSessionStateStore();

        const deps = {
            bridge: { pool: { getOrConnect: jest.fn().mockResolvedValue(cdp), extractProjectName: jest.fn().mockReturnValue('DeepMarket') } },
            telegramBindingRepo: { findByChatId: jest.fn().mockReturnValue({ chatId: 'chat-1', workspacePath: 'DeepMarket' }) },
            workspaceService: { getWorkspacePath: jest.fn().mockReturnValue('/workspace/DeepMarket') },
            chatSessionService: {
                activateSessionByTitle: jest.fn().mockResolvedValue({ ok: true }),
                listAllSessions: jest.fn().mockResolvedValue([
                    { title: 'History A', isActive: false, cascadeId: 'cascade-a' },
                    { title: 'History B', isActive: true, cascadeId: 'cascade-b' },
                ]),
                getConversationHistory: jest.fn().mockResolvedValue({
                    messages: [
                        { role: 'user', text: 'What changed?' },
                        { role: 'assistant', text: 'I updated the selector logic.' },
                    ],
                    truncated: false,
                }),
            },
            sessionStateStore: store,
        } as any;

        await handleTelegramJoinSelect(deps, interaction);

        expect(deps.chatSessionService.listAllSessions).toHaveBeenCalledWith(cdp);
        expect(cdp.setCachedCascadeId).toHaveBeenCalledWith('cascade-a');
        expect(deps.chatSessionService.getConversationHistory).toHaveBeenCalledWith(cdp, {
            maxMessages: 500,
            maxScrollSteps: 40,
        });
        expect(store.getSelectedSession('chat-1')).toEqual({ title: 'History A', id: 'cascade-a' });
        expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({
            text: expect.stringContaining('Joined history session'),
            components: [],
        }));
        expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({
            text: expect.stringContaining('<b>History: History A</b>'),
        }));
        expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({
            text: expect.stringContaining('<b>You</b>'),
        }));
    });
});
