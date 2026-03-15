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

    it('builds telegram runtime artifacts and starts/stops the adapter flow', async () => {
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

            await runtime.start();
            await runtime.shutdown();

            expect(telegramBot.api.setMyCommands).toHaveBeenCalled();
            expect(telegramBot.start).toHaveBeenCalled();
            expect(telegramBot.stop).toHaveBeenCalled();
        } finally {
            context.db.close();
        }
    });

    it('telegram notify only broadcasts to direct chats', async () => {
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
            runtime.telegramBindingRepo.upsert({ chatId: '-2002', workspacePath: 'proj-b' });

            await runtime.notify('hello');

            expect(telegramBot.api.sendMessage).toHaveBeenCalledTimes(1);
            expect(telegramBot.api.sendMessage).toHaveBeenCalledWith(
                '1001',
                'hello',
                { parse_mode: 'HTML' },
            );
        } finally {
            context.db.close();
        }
    });
});
