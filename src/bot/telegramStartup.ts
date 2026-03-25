import { TelegramBindingRepository } from '../database/telegramBindingRepository';
import { ChatSessionService } from '../services/chatSessionService';
import { wrapTelegramChannel, type TelegramBotLike } from '../platform/telegram/wrappers';
import type { ClawCommandInterceptor } from '../services/clawCommandInterceptor';
import {
    CdpBridge,
    ensureWorkspaceRuntime,
    registerApprovalWorkspaceChannel,
} from '../services/cdpBridgeManager';
import { extractCascadeRunStatus } from '../services/grpcCascadeClient';
import { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import { ModeService } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { buildStartupStatusSnapshot } from '../services/startupStatus';
import type { WorkspaceRuntime } from '../services/workspaceRuntime';
import { WorkspaceService } from '../services/workspaceService';
import { logger } from '../utils/logger';
import { extractProjectNameFromPath } from '../utils/pathUtils';
import { APP_VERSION } from '../utils/version';
import { TelegramSessionStateStore } from './telegramJoinCommand';
import { handlePassiveUserMessage, startMonitorForActiveSession } from './telegramMessageHandler';

export interface TelegramStartupTasksDeps {
    readonly telegramBot: TelegramBotLike;
    readonly telegramBindingRepo: TelegramBindingRepository;
    readonly sessionStateStore: TelegramSessionStateStore;
    readonly activeMonitors: Map<string, GrpcResponseMonitor>;
    readonly bridge: CdpBridge;
    readonly workspaceService: WorkspaceService;
    readonly modelService: ModelService;
    readonly modeService: ModeService;
    readonly clawWorkspacePath: string;
    readonly clawInterceptor?: ClawCommandInterceptor | null;
    readonly chatSessionService?: ChatSessionService;
}

export async function getTelegramBotInfoWithRetry(
    telegramBot: TelegramBotLike,
    retries = 3,
    delayMs = 3000,
): Promise<{ id: number; username?: string }> {
    const api = telegramBot.api as TelegramBotLike['api'] & {
        getMe(): Promise<{ id: number; username?: string }>;
    };

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            return await api.getMe();
        } catch (error: unknown) {
            if (attempt === retries) {
                throw error;
            }
            logger.warn(
                `[Telegram] getMe() failed (attempt ${attempt}/${retries}): ` +
                `${(error as Error).message ?? error}. Retrying in ${delayMs / 1000}s...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    throw new Error(`getMe() failed after ${retries} attempts`);
}

async function sendTelegramStartupMessage({
    telegramBot,
    telegramBindingRepo,
    sessionStateStore,
    bridge,
    workspaceService,
    modelService,
    modeService,
    clawWorkspacePath,
    chatSessionService,
}: Pick<
    TelegramStartupTasksDeps,
    'telegramBot'
    | 'telegramBindingRepo'
    | 'sessionStateStore'
    | 'bridge'
    | 'workspaceService'
    | 'modelService'
    | 'modeService'
    | 'clawWorkspacePath'
    | 'chatSessionService'
>): Promise<void> {
    const bindings = telegramBindingRepo.findAll();
    if (bindings.length === 0) return;

    let cdpModel: string | null = null;
    let cdpMode: string | null = null;
    try {
        const prepared = await ensureWorkspaceRuntime(bridge, clawWorkspacePath);
        const cdp = prepared.cdp;
        cdpModel = await cdp.getCurrentModel();
        cdpMode = await cdp.getCurrentMode();
    } catch (error: unknown) {
        logger.debug(
            'Telegram startup CDP probe missed (__claw__):',
            error instanceof Error ? error.message : error,
        );
    }

    const {
        startupModel,
        startupMode,
    } = buildStartupStatusSnapshot({
        bridge,
        cdpMode,
        cdpModel,
        modeService,
        modelService,
    });

    // Pre-fetch session list so we can resolve per-chat cascade → title
    let allSessions: { title: string; cascadeId?: string; isActive?: boolean }[] = [];
    try {
        if (chatSessionService) {
            const prepared = await ensureWorkspaceRuntime(bridge, clawWorkspacePath).catch(() => null);
            if (prepared) {
                allSessions = await chatSessionService.listAllSessions(prepared.cdp);
            }
        }
    } catch {
        // Non-critical — just skip session display
    }

    const autoApprove = bridge.autoAccept.isEnabled();
    const activeWorkspaces = new Set(bridge.pool.getActiveWorkspaceNames());
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    const buildGreeting = (binding: { chatId: string; workspacePath: string }): string => {
        const projectName = extractProjectNameFromPath(
            workspaceService.getWorkspacePath(binding.workspacePath),
        );
        const isConnected = activeWorkspaces.has(projectName);
        const connDot = isConnected ? '🟢' : '🟡';

        const lines = [
            `⚡ <b>ClawGravity Online</b>`,
            '',
            `${connDot}  <code>${projectName}</code>`,
            `🤖  <b>${startupModel}</b> · <code>${startupMode}</code>`,
            `🛡  Auto-approve: <b>${autoApprove ? 'ON' : 'OFF'}</b>`,
        ];

        // Resolve session title for this specific chat
        const chatCascadeId = sessionStateStore.getCurrentCascadeId(binding.chatId);
        let sessionTitle: string | null = null;
        if (chatCascadeId) {
            const match = allSessions.find(s => s.cascadeId === chatCascadeId);
            if (match) sessionTitle = match.title;
        }

        if (sessionTitle) {
            lines.push(`💬  Session: ${sessionTitle}`);
        }

        lines.push('');
        lines.push(`<i>v${APP_VERSION} · ${timeStr}</i>`);

        return lines.join('\n');
    };

    const sendWithRetry = async (
        chatId: number | string,
        text: string,
        retries = 3,
        delayMs = 2000,
    ): Promise<void> => {
        for (let attempt = 1; attempt <= retries; attempt += 1) {
            try {
                await telegramBot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
                return;
            } catch (error: unknown) {
                if (attempt < retries) {
                    logger.debug(
                        `[Telegram] Startup message attempt ${attempt}/${retries} failed, ` +
                        `retrying in ${delayMs}ms...`,
                    );
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                    continue;
                }
                throw error;
            }
        }
    };

    const results = await Promise.allSettled(
        bindings.map((binding) => sendWithRetry(binding.chatId, buildGreeting(binding))),
    );
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length > 0) {
        logger.warn(
            `[Telegram] Startup message failed for ${failed.length}/${bindings.length} chat(s) after retries: ` +
            `${(failed[0] as PromiseRejectedResult).reason?.message ?? 'unknown error'}`,
        );
        return;
    }

    logger.info(`Telegram startup message sent to ${bindings.length} bound chat(s).`);
}

async function startTelegramEagerMirroring({
    telegramBot,
    telegramBindingRepo,
    sessionStateStore,
    activeMonitors,
    bridge,
    workspaceService,
    clawInterceptor,
}: Pick<
    TelegramStartupTasksDeps,
    'telegramBot'
    | 'telegramBindingRepo'
    | 'sessionStateStore'
    | 'activeMonitors'
    | 'bridge'
    | 'workspaceService'
    | 'clawInterceptor'
>): Promise<void> {
    const bindings = telegramBindingRepo.findAll();

    for (const binding of bindings) {
        try {
            const workspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
            const channel = wrapTelegramChannel(
                telegramBot.api,
                binding.chatId,
                telegramBot.toInputFile,
            );
            let runtime: WorkspaceRuntime | null = null;
            const prepared = await ensureWorkspaceRuntime(bridge, workspacePath, {
                userMessageSinkKey: `telegram:${binding.chatId}`,
                onUserMessage: (info) => {
                    if (!runtime) return;
                    handlePassiveUserMessage(
                        channel,
                        runtime,
                        info,
                        activeMonitors,
                        clawInterceptor ?? undefined,
                        sessionStateStore,
                    ).catch((error: unknown) => {
                        logger.error(
                            '[TelegramPassive:Startup] Error handling PC message:',
                            error instanceof Error ? error.message : String(error),
                        );
                    });
                },
            });
            runtime = prepared.runtime;
            
            bridge.lastActiveWorkspace = prepared.projectName;
            bridge.lastActiveChannel = channel;
            registerApprovalWorkspaceChannel(bridge, prepared.projectName, channel);

            const cascadeId = await runtime.getActiveCascadeId().catch(() => null);
            if (cascadeId) {
                sessionStateStore.setCurrentCascadeId(binding.chatId, cascadeId);

                try {
                    const monitoringTarget = await runtime.getMonitoringTarget(cascadeId);
                    if (monitoringTarget) {
                        const trajectory = await monitoringTarget.grpcClient.rawRPC(
                            'GetCascadeTrajectory',
                            { cascadeId },
                        );
                        const runStatus = extractCascadeRunStatus(trajectory);
                        if (runStatus === 'CASCADE_RUN_STATUS_RUNNING') {
                            logger.info(
                                `[TelegramPassive:Startup] Cascade ${cascadeId.slice(0, 12)}... ` +
                                'is still streaming - starting passive monitor',
                            );
                            await startMonitorForActiveSession(
                                channel,
                                runtime,
                                cascadeId,
                                activeMonitors,
                                clawInterceptor ?? undefined,
                                sessionStateStore,
                            );
                        }
                    }
                } catch (error: unknown) {
                    logger.debug(
                        `[TelegramPassive:Startup] runStatus check failed for ${cascadeId.slice(0, 12)}...: ` +
                        `${(error as Error).message || error}`,
                    );
                }
            }

            logger.info(
                `[TelegramPassive] Eager mirroring started for ${prepared.projectName} -> chat ${binding.chatId}`,
            );
        } catch (error: unknown) {
            logger.warn(
                `[TelegramPassive] Failed to start eager mirroring for ${binding.workspacePath}: ` +
                `${(error as Error).message || error}`,
            );
        }
    }
}

export async function runTelegramStartupTasks(
    deps: TelegramStartupTasksDeps,
): Promise<void> {
    await sendTelegramStartupMessage(deps);
    await startTelegramEagerMirroring(deps);
}
