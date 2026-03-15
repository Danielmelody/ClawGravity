jest.mock('../../src/services/cdpBridgeManager', () => ({
    ensureWorkspaceRuntime: jest.fn(),
}));

jest.mock('../../src/services/grpcCascadeClient', () => ({
    extractCascadeRunStatus: jest.fn(),
}));

jest.mock('../../src/bot/telegramMessageHandler', () => ({
    handlePassiveUserMessage: jest.fn(),
    startMonitorForActiveSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    },
}));

import {
    getTelegramBotInfoWithRetry,
    runTelegramStartupTasks,
} from '../../src/bot/telegramStartup';
import { ensureWorkspaceRuntime } from '../../src/services/cdpBridgeManager';
import { extractCascadeRunStatus } from '../../src/services/grpcCascadeClient';
import { startMonitorForActiveSession } from '../../src/bot/telegramMessageHandler';

describe('telegramStartup', () => {
    it('retries getMe before succeeding', async () => {
        const telegramBot = {
            api: {
                getMe: jest.fn()
                    .mockRejectedValueOnce(new Error('temporary'))
                    .mockResolvedValue({ id: 42, username: 'claw_bot' }),
            },
        };

        const botInfo = await getTelegramBotInfoWithRetry(telegramBot as any, 3, 0);

        expect(botInfo).toEqual({ id: 42, username: 'claw_bot' });
        expect(telegramBot.api.getMe).toHaveBeenCalledTimes(2);
    });

    it('sends startup messages and resumes passive monitoring', async () => {
        const rawRPC = jest.fn().mockResolvedValue({ trajectory: {} });
        const runtime = {
            getActiveCascadeId: jest.fn().mockResolvedValue('cascade-123456789012'),
            getMonitoringTarget: jest.fn().mockResolvedValue({
                grpcClient: { rawRPC },
            }),
        };

        (ensureWorkspaceRuntime as jest.Mock)
            .mockResolvedValueOnce({
                cdp: {
                    getCurrentModel: jest.fn().mockResolvedValue('gpt-5'),
                    getCurrentMode: jest.fn().mockResolvedValue('planning'),
                },
            })
            .mockResolvedValueOnce({
                runtime,
                projectName: 'proj-a',
            });
        (extractCascadeRunStatus as jest.Mock).mockReturnValue('CASCADE_RUN_STATUS_RUNNING');

        const telegramBot = {
            api: {
                getMe: jest.fn(),
                sendMessage: jest.fn().mockResolvedValue(undefined),
            },
            toInputFile: jest.fn(),
        };
        const sessionStateStore = {
            setCurrentCascadeId: jest.fn(),
        };

        await runTelegramStartupTasks({
            telegramBot: telegramBot as any,
            telegramBindingRepo: {
                findAll: () => [{ chatId: '1001', workspacePath: 'proj-a' }],
            } as any,
            sessionStateStore: sessionStateStore as any,
            activeMonitors: new Map(),
            bridge: {
                pool: {
                    getActiveWorkspaceNames: () => ['proj-a'],
                },
            } as any,
            workspaceService: {
                scanWorkspaces: () => ['proj-a'],
                getWorkspacePath: () => 'C:/workspaces/proj-a',
            } as any,
            modelService: {
                getDefaultModel: () => 'default-model',
            } as any,
            modeService: {
                getCurrentMode: () => 'default',
                setMode: jest.fn(),
            } as any,
            clawWorkspacePath: 'C:/workspaces/__claw__',
            clawInterceptor: null,
        });

        expect(telegramBot.api.sendMessage).toHaveBeenCalledTimes(1);
        expect(telegramBot.api.sendMessage).toHaveBeenCalledWith(
            '1001',
            expect.stringContaining('ClawGravity Online'),
            { parse_mode: 'HTML' },
        );
        expect(sessionStateStore.setCurrentCascadeId).toHaveBeenCalledWith(
            '1001',
            'cascade-123456789012',
        );
        expect(startMonitorForActiveSession).toHaveBeenCalledWith(
            expect.any(Object),
            runtime,
            'cascade-123456789012',
            expect.any(Map),
            undefined,
            sessionStateStore,
        );
    });
});
