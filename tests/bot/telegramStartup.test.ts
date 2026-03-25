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

describe('telegramStartup', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getTelegramBotInfoWithRetry', () => {
        it('returns bot info on first attempt when API succeeds', async () => {
            const telegramBot = {
                api: {
                    getMe: jest.fn().mockResolvedValue({ id: 42, username: 'claw_bot' }),
                },
            };

            const botInfo = await getTelegramBotInfoWithRetry(telegramBot as any, 3, 0);

            expect(botInfo).toEqual({ id: 42, username: 'claw_bot' });
            expect(telegramBot.api.getMe).toHaveBeenCalledTimes(1);
        });

        it('retries on transient failures and eventually succeeds', async () => {
            const telegramBot = {
                api: {
                    getMe: jest.fn()
                        .mockRejectedValueOnce(new Error('temporary'))
                        .mockRejectedValueOnce(new Error('still failing'))
                        .mockResolvedValue({ id: 42, username: 'claw_bot' }),
                },
            };

            const botInfo = await getTelegramBotInfoWithRetry(telegramBot as any, 5, 0);

            expect(botInfo).toEqual({ id: 42, username: 'claw_bot' });
            expect(telegramBot.api.getMe).toHaveBeenCalledTimes(3);
        });

        it('throws after exhausting all retry attempts', async () => {
            const telegramBot = {
                api: {
                    getMe: jest.fn().mockRejectedValue(new Error('permanent failure')),
                },
            };

            await expect(
                getTelegramBotInfoWithRetry(telegramBot as any, 2, 0),
            ).rejects.toThrow('permanent failure');
            expect(telegramBot.api.getMe).toHaveBeenCalledTimes(2);
        });
    });

    describe('runTelegramStartupTasks', () => {
        it('sends a startup message containing "ClawGravity Online" to bound chats', async () => {
            (ensureWorkspaceRuntime as jest.Mock).mockResolvedValue({
                cdp: {
                    getCurrentModel: jest.fn().mockResolvedValue('gpt-5'),
                    getCurrentMode: jest.fn().mockResolvedValue('planning'),
                },
            });

            const sendMessage = jest.fn().mockResolvedValue(undefined);

            await runTelegramStartupTasks({
                telegramBot: {
                    api: { sendMessage },
                    toInputFile: jest.fn(),
                } as any,
                telegramBindingRepo: {
                    findAll: () => [{ chatId: '1001', workspacePath: 'proj-a' }],
                } as any,
                sessionStateStore: {
                    setCurrentCascadeId: jest.fn(),
                    getCurrentCascadeId: jest.fn().mockReturnValue(null),
                } as any,
                activeMonitors: new Map(),
                bridge: {
                    pool: { getActiveWorkspaceNames: () => ['proj-a'] },
                    autoAccept: { isEnabled: () => false },
                } as any,
                workspaceService: {
                    scanWorkspaces: () => ['proj-a'],
                    getWorkspacePath: () => 'C:/workspaces/proj-a',
                } as any,
                modelService: { getDefaultModel: () => 'default-model' } as any,
                modeService: { getCurrentMode: () => 'default', setMode: jest.fn() } as any,
                clawWorkspacePath: 'C:/workspaces/__claw__',
                clawInterceptor: null,
            });

            // Verify the message was sent and contains the expected content
            expect(sendMessage).toHaveBeenCalled();
            const messageText = sendMessage.mock.calls[0][1];
            expect(messageText).toContain('ClawGravity Online');
        });

        it('resumes passive monitoring when a cascade is still running', async () => {
            const runtime = {
                getActiveCascadeId: jest.fn().mockResolvedValue('cascade-abc'),
                getMonitoringTarget: jest.fn().mockResolvedValue({
                    grpcClient: {
                        rawRPC: jest.fn().mockResolvedValue({ trajectory: {} }),
                    },
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
            const sessionStateStore = {
                setCurrentCascadeId: jest.fn(),
                getCurrentCascadeId: jest.fn().mockReturnValue(null),
            };

            await runTelegramStartupTasks({
                telegramBot: {
                    api: { sendMessage: jest.fn().mockResolvedValue(undefined) },
                    toInputFile: jest.fn(),
                } as any,
                telegramBindingRepo: {
                    findAll: () => [{ chatId: '1001', workspacePath: 'proj-a' }],
                } as any,
                sessionStateStore: sessionStateStore as any,
                activeMonitors: new Map(),
                bridge: {
                    pool: { getActiveWorkspaceNames: () => ['proj-a'] },
                    autoAccept: { isEnabled: () => false },
                } as any,
                workspaceService: {
                    scanWorkspaces: () => ['proj-a'],
                    getWorkspacePath: () => 'C:/workspaces/proj-a',
                } as any,
                modelService: { getDefaultModel: () => 'default-model' } as any,
                modeService: { getCurrentMode: () => 'default', setMode: jest.fn() } as any,
                clawWorkspacePath: 'C:/workspaces/__claw__',
                clawInterceptor: null,
            });

            // The cascade ID should be persisted for the chat
            expect(sessionStateStore.setCurrentCascadeId).toHaveBeenCalledWith(
                '1001',
                'cascade-abc',
            );
        });

        it('completes without error when no chats are bound', async () => {
            await expect(
                runTelegramStartupTasks({
                    telegramBot: {
                        api: { sendMessage: jest.fn() },
                        toInputFile: jest.fn(),
                    } as any,
                    telegramBindingRepo: { findAll: () => [] } as any,
                    sessionStateStore: { setCurrentCascadeId: jest.fn() } as any,
                    activeMonitors: new Map(),
                    bridge: {
                        pool: { getActiveWorkspaceNames: () => [] },
                        autoAccept: { isEnabled: () => false },
                    } as any,
                    workspaceService: {
                        scanWorkspaces: () => [],
                        getWorkspacePath: () => '',
                    } as any,
                    modelService: { getDefaultModel: () => 'default-model' } as any,
                    modeService: { getCurrentMode: () => 'default', setMode: jest.fn() } as any,
                    clawWorkspacePath: 'C:/workspaces/__claw__',
                    clawInterceptor: null,
                }),
            ).resolves.toBeUndefined();
        });
    });
});
