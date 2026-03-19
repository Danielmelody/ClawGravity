import { buildApplicationContext } from '../../src/context/applicationContextBuilder';
import { buildTelegramRuntimeArtifacts } from '../../src/context/applicationTelegramBuilder';
import type { AppConfig } from '../../src/utils/config';

describe('applicationTelegramBuilder', () => {
    const config: AppConfig = {
        allowedUserIds: ['123'],
        workspaceBaseDir: process.cwd(),
        autoApproveFileEdits: false,
        logLevel: 'info',
        extractionMode: 'structured',
        platforms: ['telegram'],
        telegramAllowedUserIds: ['42'],
        telegramToken: 'telegram-token',
    };

    function createMockTelegramBot() {
        return {
            token: 'telegram-token',
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn(),
            on: jest.fn(),
            api: {
                sendMessage: jest.fn().mockResolvedValue(undefined),
                editMessageText: jest.fn().mockResolvedValue(undefined),
                deleteMessage: jest.fn().mockResolvedValue(undefined),
                getChat: jest.fn().mockResolvedValue({ id: 42 }),
                answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
                setMyCommands: jest.fn().mockResolvedValue(undefined),
            },
            toInputFile: jest.fn(),
        };
    }

    it('start/shutdown lifecycle completes without errors', async () => {
        const context = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });
        const telegramBot = createMockTelegramBot();

        try {
            const runtime = await buildTelegramRuntimeArtifacts(context, {
                config,
                telegramBot: telegramBot as any,
                botUserId: '42',
            });

            // The lifecycle should complete without throwing
            await runtime.start();
            await runtime.shutdown();
        } finally {
            context.db.close();
        }
    });

    it('notify only broadcasts to direct chats, not group chats', async () => {
        const context = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });
        const telegramBot = createMockTelegramBot();

        try {
            const runtime = await buildTelegramRuntimeArtifacts(context, {
                config,
                telegramBot: telegramBot as any,
                botUserId: '42',
            });

            // Direct chat IDs are positive, group chat IDs start with '-'
            runtime.telegramBindingRepo.upsert({ chatId: '1001', workspacePath: 'proj-a' });
            runtime.telegramBindingRepo.upsert({ chatId: '-2002', workspacePath: 'proj-b' });
            runtime.telegramBindingRepo.upsert({ chatId: '3003', workspacePath: 'proj-c' });

            await runtime.notify('hello');

            // Only the two direct chats should receive the message
            expect(telegramBot.api.sendMessage).toHaveBeenCalledTimes(2);

            const chatIds = telegramBot.api.sendMessage.mock.calls.map(
                (call: unknown[]) => call[0],
            );
            expect(chatIds).toContain('1001');
            expect(chatIds).toContain('3003');
            expect(chatIds).not.toContain('-2002');
        } finally {
            context.db.close();
        }
    });

    it('notify does nothing when there are no bindings', async () => {
        const context = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });
        const telegramBot = createMockTelegramBot();

        try {
            const runtime = await buildTelegramRuntimeArtifacts(context, {
                config,
                telegramBot: telegramBot as any,
                botUserId: '42',
            });

            await runtime.notify('hello');

            expect(telegramBot.api.sendMessage).not.toHaveBeenCalled();
        } finally {
            context.db.close();
        }
    });

    it('notify delivers message content in HTML parse mode', async () => {
        const context = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });
        const telegramBot = createMockTelegramBot();

        try {
            const runtime = await buildTelegramRuntimeArtifacts(context, {
                config,
                telegramBot: telegramBot as any,
                botUserId: '42',
            });

            runtime.telegramBindingRepo.upsert({ chatId: '1001', workspacePath: 'proj-a' });

            await runtime.notify('<b>Schedule #1</b> completed');

            expect(telegramBot.api.sendMessage).toHaveBeenCalledWith(
                '1001',
                '<b>Schedule #1</b> completed',
                { parse_mode: 'HTML' },
            );
        } finally {
            context.db.close();
        }
    });
});
