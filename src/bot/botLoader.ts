import { logger } from '../utils/logger';
import type { LogLevel } from '../utils/logger';
import {
    Client, GatewayIntentBits, Events,
} from 'discord.js';
import * as path from 'path';

import { setApplicationContext } from '../context/applicationContext';
import { buildClawRuntimeArtifacts } from '../context/applicationClawBuilder';
import { buildApplicationCommandHandlers } from '../context/applicationCommandBuilder';
import { buildDiscordRuntimeArtifacts } from '../context/applicationDiscordBuilder';
import { buildApplicationContext } from '../context/applicationContextBuilder';
import { buildTelegramRuntimeArtifacts } from '../context/applicationTelegramBuilder';
import { prepareClawWorkspace } from './clawWorkspaceSetup';
import {
    createDiscordPromptRuntimeArtifacts,
} from './discordPromptRuntime';
import { runDiscordStartupTasks } from './discordStartup';
import {
    getTelegramBotInfoWithRetry,
    runTelegramStartupTasks,
} from './telegramStartup';

import { loadConfig } from '../utils/config';

// CDP integration services
import { ensureAntigravityRunning } from '../services/antigravityLauncher';
import { handleScreenshot } from '../ui/screenshotUi';

// Telegram platform support
import { Bot, InputFile } from 'grammy';
import type { TelegramBotLike } from '../platform/telegram/wrappers';
import { clearShutdownHooks, registerShutdownHook } from '../services/processRestartService';
import { PromptSession } from './promptSession';

export let globalTelegramNotifier: ((text: string) => Promise<void>) | null = null;

/** Tracks channel IDs where /stop was explicitly invoked by the user */
const userStopRequestedChannels = new Set<string>();
const activeDiscordPromptSessions = new Map<string, PromptSession>();

// =============================================================================
// Bot main entry point
// =============================================================================

export const startBot = async (cliLogLevel?: LogLevel) => {
    clearShutdownHooks();
    const config = loadConfig();
    logger.setLogLevel(cliLogLevel ?? config.logLevel);
    const promptRuntime = createDiscordPromptRuntimeArtifacts({
        activePromptSessions: activeDiscordPromptSessions,
        userStopRequestedChannels,
        getTelegramNotifier: () => globalTelegramNotifier,
    });

    // Auto-launch Antigravity with CDP port if not already running.
    // Pass the __claw__ workspace so it opens directly instead of an empty window.
    const clawDir = config.clawWorkspace ?? path.join(config.workspaceBaseDir, '__claw__');
    await ensureAntigravityRunning(clawDir);

    const appContext = await buildApplicationContext({
        config,
        sendPromptImpl: promptRuntime.sendPromptImpl,
    });
    setApplicationContext(appContext);

    const {
        db,
        modeService,
        modelService,
        workspaceService,
        chatSessionService,
        scheduleService,
        workspaceBindingRepo,
        chatSessionRepo,
        scheduleRepo,
        bridge,
    } = appContext;

    // Initialize command handlers (joinHandler is created after client, see below)
    const commandHandlers = await buildApplicationCommandHandlers(appContext);

    registerShutdownHook('core:schedules', () => {
        scheduleService.stopAll();
    });
    registerShutdownHook('core:connections', () => {
        bridge.pool.disconnectAll();
    });
    registerShutdownHook('core:database', () => {
        try {
            db.close();
        } catch {
            // Ignore close errors during shutdown.
        }
    });

    // Shared notification function — gets wired up once Telegram platform initializes.
    // scheduleJobCallback can call this to broadcast cron results to all bound chats.
    let telegramNotify: ((text: string) => Promise<void>) | null = null;

    // Resolve Claw workspace — dedicated directory for the agent's tasks and memory.
    // This keeps scheduled work isolated from the user's active conversations.
    const clawWorkspacePath = clawDir;

    const enabledSchedules = scheduleRepo.findEnabled();
    await prepareClawWorkspace({
        clawWorkspacePath,
        enabledScheduleCount: enabledSchedules.length,
    });

    const clawRuntime = await buildClawRuntimeArtifacts(appContext, {
        extractionMode: config.extractionMode,
        clawWorkspacePath,
        getTelegramNotify: () => telegramNotify,
    });
    const scheduleJobCallback = clawRuntime.scheduleJobCallback;
    const clawInterceptor = clawRuntime.clawInterceptor;

    // Restore persisted schedules on startup
    const restoredCount = scheduleService.restoreAll(scheduleJobCallback);
    if (restoredCount > 0) {
        logger.info(`[Schedule] Restored ${restoredCount} scheduled task(s)`);
    }

    // Discord platform — only initialise the Discord client when the platform is enabled
    if (config.platforms.includes('discord')) {

        if (!config.discordToken || !config.clientId) {
            logger.error('Discord platform enabled but discordToken or clientId is missing. Skipping Discord initialization.');
        } else {

            const discordToken = config.discordToken;
            const discordClientId = config.clientId;

            const client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent,
                ]
            });

            const discordRuntime = await buildDiscordRuntimeArtifacts(appContext, {
                config,
                client,
                commandHandlers,
                handleScreenshot,
                autoRenameChannel: promptRuntime.autoRenameChannel,
                activePromptSessions: activeDiscordPromptSessions,
                scheduleJobCallback,
            });

            client.once(Events.ClientReady, async (readyClient) => {
                logger.info(`Ready! Logged in as ${readyClient.user.tag} | extractionMode=${config.extractionMode}`);
                await runDiscordStartupTasks({
                    client,
                    discordToken,
                    discordClientId,
                    guildId: config.guildId,
                    bridge,
                    workspaceBindingRepo,
                    chatSessionRepo,
                    workspaceService,
                    chatSessionService,
                    modeService,
                    modelService,
                });
            });

            registerShutdownHook('platform:discord', () => {
                client.destroy();
            });

            client.on(Events.InteractionCreate, discordRuntime.interactionHandler);
            client.on(Events.MessageCreate, discordRuntime.messageHandler);

            await client.login(discordToken);

        } // end: else (credentials present)
    } // end: Discord platform gate

    // Telegram platform
    if (config.platforms.includes('telegram') && config.telegramToken) {
        try {
            const telegramBot = new Bot(config.telegramToken);
            // Attach toInputFile so wrappers can convert Buffer to grammY InputFile
            (telegramBot as unknown as { toInputFile: (data: Buffer, filename?: string) => InputFile }).toInputFile = (data: Buffer, filename?: string) => new InputFile(data, filename);
            const botInfo = await getTelegramBotInfoWithRetry(telegramBot as unknown as TelegramBotLike);

            const telegramRuntime = await buildTelegramRuntimeArtifacts(appContext, {
                config,
                telegramBot: telegramBot as unknown as TelegramBotLike,
                botUserId: String(botInfo.id),
                clawInterceptor,
                scheduleJobCallback,
            });
            const telegramBindingRepo = telegramRuntime.telegramBindingRepo;
            const telegramSessionStateStore = telegramRuntime.sessionStateStore;
            const activeMonitors = telegramRuntime.activeMonitors;

            // Wire up the telegramNotify function so scheduled tasks can broadcast to Telegram
            telegramNotify = telegramRuntime.notify;
            globalTelegramNotifier = telegramNotify;

            // Global error → Telegram: every logger.error() is forwarded automatically.
            // The hook batches errors with a 10 s debounce window to avoid flooding.
            logger.setErrorHook((msg) => globalTelegramNotifier?.(msg));

            logger.debug(`[Claw] Telegram notify wired up for schedule results and global notifications`);

            await telegramRuntime.start();
            registerShutdownHook('platform:telegram', telegramRuntime.shutdown);

            logger.info(`Telegram bot started: @${botInfo.username} (${config.telegramAllowedUserIds?.length ?? 0} allowed users)`);
            await runTelegramStartupTasks({
                telegramBot: telegramBot as unknown as TelegramBotLike,
                telegramBindingRepo,
                sessionStateStore: telegramSessionStateStore,
                activeMonitors,
                bridge,
                workspaceService,
                modelService,
                modeService,
                clawWorkspacePath,
                clawInterceptor,
            });
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            logger.error('Failed to start Telegram adapter:', message);
        }
    }
};
