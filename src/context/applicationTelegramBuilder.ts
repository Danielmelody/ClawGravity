import { Effect } from 'effect';

import { TelegramBindingRepository } from '../database/telegramBindingRepository';
import { TelegramSessionRoutingRepository } from '../database/telegramSessionRoutingRepository';
import { TelegramRecentMessageRepository } from '../database/telegramRecentMessageRepository';
import type { ScheduleRecord } from '../database/scheduleRepository';
import { createApprovalButtonAction } from '../handlers/approvalButtonAction';
import { createAutoAcceptButtonAction } from '../handlers/autoAcceptButtonAction';
import { createPlatformButtonHandler } from '../handlers/buttonHandler';
import { createErrorPopupButtonAction } from '../handlers/errorPopupButtonAction';
import { createModeSelectAction } from '../handlers/modeSelectAction';
import { createPlanningButtonAction } from '../handlers/planningButtonAction';
import { createRunCommandButtonAction } from '../handlers/runCommandButtonAction';
import { createPlatformSelectHandler } from '../handlers/selectHandler';
import { createTemplateButtonAction } from '../handlers/templateButtonAction';
import { createModelButtonAction } from '../handlers/modelButtonAction';
import { TelegramAdapter } from '../platform/telegram/telegramAdapter';
import type { PlatformSelectInteraction, PlatformType } from '../platform/types';
import type { ClawCommandInterceptor } from '../services/clawCommandInterceptor';
import { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import { TelegramMessageTracker } from '../services/telegramMessageTracker';
import { logger } from '../utils/logger';
import type { AppConfig } from '../utils/config';
import type { TelegramBotLike } from '../platform/telegram/wrappers';
import { createTelegramJoinSelectHandler, TelegramSessionStateStore } from '../bot/telegramJoinCommand';
import { createTelegramMessageHandler } from '../bot/telegramMessageHandler';
import { EventRouter } from '../bot/eventRouter';
import { createTelegramSelectHandler } from '../bot/telegramProjectCommand';
import {
    ApplicationContext,
    ApplicationContextTag,
} from './applicationContext';

const TELEGRAM_COMMANDS = [
    { command: 'start', description: 'Welcome message' },
    { command: 'project', description: 'Manage workspace bindings' },
    { command: 'status', description: 'Show bot status and connections' },
    { command: 'mode', description: 'Switch execution mode' },
    { command: 'model', description: 'Switch LLM model' },
    { command: 'screenshot', description: 'Capture Antigravity screenshot' },
    { command: 'autoaccept', description: 'Toggle auto-accept mode' },
    { command: 'template', description: 'List prompt templates' },
    { command: 'template_add', description: 'Add a prompt template' },
    { command: 'template_delete', description: 'Delete a prompt template' },
    { command: 'project_create', description: 'Create a new workspace' },
    { command: 'new', description: 'Start a new chat session' },
    { command: 'session', description: 'Switch to an existing session' },
    { command: 'inspect', description: 'Toggle per-session inspect mode for auto-analysis' },
    { command: 'schedule', description: 'List scheduled tasks' },
    { command: 'schedule_add', description: 'Add a scheduled task' },
    { command: 'schedule_remove', description: 'Remove a scheduled task' },
    { command: 'logs', description: 'Show recent log entries' },
    { command: 'stop', description: 'Interrupt active LLM generation' },
    { command: 'restart', description: 'Fully restart the bot process' },
    { command: 'help', description: 'Show available commands' },
    { command: 'ping', description: 'Check bot latency' },
] as const;

export interface BuildTelegramRuntimeOptions {
    readonly config: AppConfig;
    readonly telegramBot: TelegramBotLike;
    readonly botUserId: string;
    readonly clawInterceptor?: ClawCommandInterceptor | null;
    readonly scheduleJobCallback?: (schedule: ScheduleRecord) => void;
}

export interface TelegramRuntimeArtifacts {
    readonly telegramBindingRepo: TelegramBindingRepository;
    readonly telegramSessionRoutingRepo: TelegramSessionRoutingRepository;
    readonly telegramRecentMessageRepo: TelegramRecentMessageRepository;
    readonly sessionStateStore: TelegramSessionStateStore;
    readonly activeMonitors: Map<string, GrpcResponseMonitor>;
    readonly notify: (text: string) => Promise<void>;
    readonly start: () => Promise<void>;
    readonly shutdown: () => Promise<void>;
}

export async function buildTelegramRuntimeArtifacts(
    context: ApplicationContext,
    options: BuildTelegramRuntimeOptions,
): Promise<TelegramRuntimeArtifacts> {
    return Effect.runPromise(
        Effect.gen(function* () {
            const ctx = yield* ApplicationContextTag;

            const telegramBindingRepo = new TelegramBindingRepository(ctx.db);
            const telegramSessionRoutingRepo = new TelegramSessionRoutingRepository(ctx.db);
            const telegramRecentMessageRepo = new TelegramRecentMessageRepository(ctx.db);
            const telegramAdapter = new TelegramAdapter(options.telegramBot, options.botUserId);
            const sessionStateStore = new TelegramSessionStateStore(telegramRecentMessageRepo, telegramSessionRoutingRepo);
            const messageTracker = new TelegramMessageTracker();
            const activeMonitors = new Map<string, GrpcResponseMonitor>();

            const telegramHandler = createTelegramMessageHandler({
                bridge: ctx.bridge,
                telegramBindingRepo,
                workspaceService: ctx.workspaceService,
                modeService: ctx.modeService,
                modelService: ctx.modelService,
                templateRepo: ctx.templateRepo,
                fetchQuota: () => ctx.bridge.quota.fetchQuota(),
                activeMonitors,
                botToken: options.config.telegramToken,
                botApi: options.telegramBot.api,
                chatSessionService: ctx.chatSessionService,
                sessionStateStore,
                scheduleService: ctx.scheduleService,
                scheduleJobCallback: options.scheduleJobCallback,
                clawInterceptor: options.clawInterceptor ?? undefined,
                messageTracker,
            });

            const projectSelectHandler = createTelegramSelectHandler({
                workspaceService: ctx.workspaceService,
                telegramBindingRepo,
            });
            const joinSelectHandler = createTelegramJoinSelectHandler({
                bridge: ctx.bridge,
                telegramBindingRepo,
                workspaceService: ctx.workspaceService,
                chatSessionService: ctx.chatSessionService,
                sessionStateStore,
                activeMonitors,
                clawInterceptor: options.clawInterceptor ?? undefined,
            });
            const modeSelectAction = createModeSelectAction({
                bridge: ctx.bridge,
                modeService: ctx.modeService,
            });
            const telegramSelectHandler = createPlatformSelectHandler({
                actions: [modeSelectAction],
            });
            const compositeSelectHandler = async (
                interaction: PlatformSelectInteraction,
            ): Promise<void> => {
                if (interaction.customId === 'mode_select') {
                    await telegramSelectHandler(interaction);
                    return;
                }
                if (interaction.customId === 'tg_join_select') {
                    await joinSelectHandler(interaction);
                    return;
                }
                await projectSelectHandler(interaction);
            };

            const allowedUsers = new Map<PlatformType, ReadonlySet<string>>();
            if (options.config.telegramAllowedUserIds && options.config.telegramAllowedUserIds.length > 0) {
                allowedUsers.set('telegram', new Set(options.config.telegramAllowedUserIds));
            } else {
                logger.warn('Telegram platform enabled but TELEGRAM_ALLOWED_USER_IDS is empty — all users will be denied access.');
            }

            const telegramButtonHandler = createPlatformButtonHandler({
                actions: [
                    createApprovalButtonAction({ bridge: ctx.bridge }),
                    createPlanningButtonAction({ bridge: ctx.bridge }),
                    createErrorPopupButtonAction({ bridge: ctx.bridge }),
                    createRunCommandButtonAction({ bridge: ctx.bridge }),
                    createModelButtonAction({
                        bridge: ctx.bridge,
                        fetchQuota: () => ctx.bridge.quota.fetchQuota(),
                        modelService: ctx.modelService,
                        userPrefRepo: ctx.userPrefRepo,
                    }),
                    createAutoAcceptButtonAction({ autoAcceptService: ctx.bridge.autoAccept }),
                    createTemplateButtonAction({ bridge: ctx.bridge, templateRepo: ctx.templateRepo }),
                ],
            });

            const eventRouter = new EventRouter(
                { allowedUsers },
                {
                    onMessage: telegramHandler,
                    onButtonInteraction: telegramButtonHandler,
                    onSelectInteraction: compositeSelectHandler,
                },
            );
            eventRouter.registerAdapter(telegramAdapter);

            const notify = async (text: string): Promise<void> => {
                const bindings = telegramBindingRepo.findAll()
                    .filter((binding) => !binding.chatId.startsWith('-'));
                if (bindings.length === 0) return;

                const results = await Promise.allSettled(
                    bindings.map((binding) =>
                        options.telegramBot.api.sendMessage(binding.chatId, text, { parse_mode: 'HTML' }),
                    ),
                );
                const failed = results.filter((result) => result.status === 'rejected');
                if (failed.length > 0) {
                    logger.warn(`[Claw] Telegram notify failed for ${failed.length}/${bindings.length} chat(s)`);
                }
            };

            const start = async (): Promise<void> => {
                if (options.telegramBot.api.setMyCommands) {
                    await options.telegramBot.api.setMyCommands(TELEGRAM_COMMANDS).catch((error: unknown) => {
                        logger.warn('Failed to register Telegram commands:', error instanceof Error ? error.message : error);
                    });
                }
                await eventRouter.startAll();
            };

            const shutdown = async (): Promise<void> => {
                for (const monitor of activeMonitors.values()) {
                    await monitor.stop().catch(() => { /* ignore */ });
                }
                activeMonitors.clear();
                await eventRouter.stopAll();
            };

            return {
                telegramBindingRepo,
                telegramSessionRoutingRepo,
                telegramRecentMessageRepo,
                sessionStateStore,
                activeMonitors,
                notify,
                start,
                shutdown,
            } satisfies TelegramRuntimeArtifacts;
        }).pipe(
            Effect.provideService(ApplicationContextTag, context),
        ),
    );
}
