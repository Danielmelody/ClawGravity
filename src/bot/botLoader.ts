import { t } from "../utils/i18n";
import { APP_VERSION } from '../utils/version';
import { logger } from '../utils/logger';
import type { LogLevel } from '../utils/logger';
import { logBuffer } from '../utils/logBuffer';
import {
    Client, GatewayIntentBits, Events, Message,
    ChatInputCommandInteraction,
    EmbedBuilder, MessageFlags,
} from 'discord.js';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

import { ApplicationContext, setApplicationContext } from '../context/applicationContext';

import { wrapDiscordChannel } from '../platform/discord/wrappers';
import type { PlatformType } from '../platform/types';
import { loadConfig, resolveResponseDeliveryMode } from '../utils/config';
import type { ExtractionMode } from '../utils/config';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { registerSlashCommands } from '../commands/registerSlashCommands';

import { ModeService, MODE_DISPLAY_NAMES, MODE_UI_NAMES } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { TemplateRepository } from '../database/templateRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { ScheduleRepository } from '../database/scheduleRepository';
import type { ScheduleRecord } from '../database/scheduleRepository';
import { WorkspaceService } from '../services/workspaceService';
import {
    WorkspaceCommandHandler,
} from '../commands/workspaceCommandHandler';
import { ChatCommandHandler } from '../commands/chatCommandHandler';
import {
    CleanupCommandHandler,
} from '../commands/cleanupCommandHandler';
import { ChannelManager } from '../services/channelManager';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { JoinCommandHandler } from '../commands/joinCommandHandler';

// CDP integration services
import { CdpService } from '../services/cdpService';
import { ChatSessionService } from '../services/chatSessionService';
import { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import { ClawCommandInterceptor } from '../services/clawCommandInterceptor';
import { AgentRouter } from '../services/agentRouter';
import { ensureAntigravityRunning } from '../services/antigravityLauncher';
import { AutoAcceptService } from '../services/autoAcceptService';
import { PromptDispatcher } from '../services/promptDispatcher';
import { ScheduleService } from '../services/scheduleService';
import {
    CdpBridge,
    ensureWorkspaceRuntime,
    getCurrentCdp,
    initCdpBridge,
    parseApprovalCustomId,
    parseErrorPopupCustomId,
    parsePlanningCustomId,
    parseRunCommandCustomId,
    registerApprovalSessionChannel,
    registerApprovalWorkspaceChannel,
} from '../services/cdpBridgeManager';
import {
    InboundImageAttachment,
} from '../utils/imageHandler';
import { sendModeUI } from '../ui/modeUi';
import { sendModelsUI } from '../ui/modelsUi';
import { sendTemplateUI } from '../ui/templateUi';
import { sendAutoAcceptUI } from '../ui/autoAcceptUi';
import { sendOutputUI } from '../ui/outputUi';
import { handleScreenshot } from '../ui/screenshotUi';
import { UserPreferenceRepository, OutputFormat } from '../database/userPreferenceRepository';
import { formatAsPlainText } from '../utils/plainTextFormatter';
import { createInteractionCreateHandler } from '../events/interactionCreateHandler';
import { createMessageCreateHandler } from '../events/messageCreateHandler';

// Telegram platform support
import { Bot, InputFile } from 'grammy';
import { TelegramAdapter } from '../platform/telegram/telegramAdapter';
import { TelegramBindingRepository } from '../database/telegramBindingRepository';
import { TelegramRecentMessageRepository } from '../database/telegramRecentMessageRepository';
import { TelegramMessageTracker } from '../services/telegramMessageTracker';
import type { WorkspaceRuntime } from '../services/workspaceRuntime';
import { createTelegramMessageHandler, handlePassiveUserMessage, startMonitorForActiveSession } from './telegramMessageHandler';
import type { TelegramCommandDeps } from './telegramCommands';
import { extractCascadeRunStatus } from '../services/grpcCascadeClient';
import { wrapTelegramChannel, type TelegramBotLike } from '../platform/telegram/wrappers';
import { createTelegramSelectHandler } from './telegramProjectCommand';
import { createTelegramJoinSelectHandler, TelegramSessionStateStore } from './telegramJoinCommand';
import { EventRouter } from './eventRouter';
import { createPlatformButtonHandler } from '../handlers/buttonHandler';
import { createPlatformSelectHandler } from '../handlers/selectHandler';
import { createApprovalButtonAction } from '../handlers/approvalButtonAction';
import { createPlanningButtonAction } from '../handlers/planningButtonAction';
import { createErrorPopupButtonAction } from '../handlers/errorPopupButtonAction';
import { createRunCommandButtonAction } from '../handlers/runCommandButtonAction';
import { createModelButtonAction } from '../handlers/modelButtonAction';
import { createAutoAcceptButtonAction } from '../handlers/autoAcceptButtonAction';
import { createTemplateButtonAction } from '../handlers/templateButtonAction';
import { createModeSelectAction } from '../handlers/modeSelectAction';
import { clearShutdownHooks, registerShutdownHook, restartCurrentProcess } from '../services/processRestartService';
import { PromptSession } from './promptSession';

export let globalTelegramNotifier: ((text: string) => Promise<void>) | null = null;

// =============================================================================
// Embed color palette (color-coded by phase)
// =============================================================================


const RESPONSE_DELIVERY_MODE = resolveResponseDeliveryMode();
const AUTO_RENAME_THRESHOLD = 5; // Placeholder value, adjust as needed
const COALESCE_PERIOD_MS = 75; // Placeholder value, adjust as needed

/** Tracks channel IDs where /stop was explicitly invoked by the user */
const userStopRequestedChannels = new Set<string>();
const activeDiscordPromptSessions = new Map<string, PromptSession>();
export const getResponseDeliveryModeForTest = (): string => RESPONSE_DELIVERY_MODE;

function createSerialTaskQueue(queueName: string, traceId: string): { enqueue: (task: () => Promise<void>, label?: string) => Promise<void>; } {
    let queue: Promise<void> = Promise.resolve();
    let queueDepth = 0;
    let taskSeq = 0;

    return {
        enqueue: (task: () => Promise<void>, label: string = 'queue-task'): Promise<void> => {
            taskSeq += 1;
            const seq = taskSeq;
            queueDepth += 1;

            queue = queue.then(async () => {
                try {
                    await task();
                } catch (err: unknown) {
                    logger.error(`[sendQueue:${traceId}:${queueName}] error #${seq} label=${label}:`, (err as Error).message || err);
                } finally {
                    queueDepth = Math.max(0, queueDepth - 1);
                }
            });

            return queue;
        }
    };
}

export function createSerialTaskQueueForTest(queueName: string, traceId: string): (task: () => Promise<void>, label?: string) => Promise<void> {
    const queue = createSerialTaskQueue(queueName, traceId);
    return queue.enqueue;
}

async function restoreDiscordSessionsOnStartup(
    client: Client,
    bridge: CdpBridge,
    workspaceBindingRepo: WorkspaceBindingRepository,
    chatSessionRepo: ChatSessionRepository,
    workspaceService: WorkspaceService,
    chatSessionService: ChatSessionService,
): Promise<void> {
    const bindings = workspaceBindingRepo.findAll();
    if (bindings.length === 0) return;

    const restoredWorkspaces = new Set<string>();

    for (const binding of bindings) {
        if (restoredWorkspaces.has(binding.workspacePath)) continue;

        const session = chatSessionRepo.findLatestRestorableByWorkspace(binding.workspacePath);
        if (!session?.displayName) continue;

        try {
            const resolvedWorkspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
            const prepared = await ensureWorkspaceRuntime(bridge, resolvedWorkspacePath, {
                enableActionDetectors: true,
            });
            const runtime = prepared.runtime;
            const projectName = prepared.projectName;
            const discordChannel = client.channels.fetch
                ? await client.channels.fetch(session.channelId).catch(() => null)
                : null;

            if (!discordChannel || !discordChannel.isTextBased?.()) {
                logger.warn(`[StartupRestore] Channel not found or not text-based: ${session.channelId}`);
                continue;
            }

            const platformChannel = wrapDiscordChannel(discordChannel as import('discord.js').TextChannel);
            bridge.lastActiveWorkspace = projectName;
            bridge.lastActiveChannel = platformChannel;
            registerApprovalWorkspaceChannel(bridge, projectName, platformChannel);
            registerApprovalSessionChannel(bridge, projectName, session.displayName, platformChannel);

            const activationResult = await runtime.activateSessionByTitle(chatSessionService, session.displayName);
            if (!activationResult.ok) {
                logger.warn(
                    `[StartupRestore] Failed to restore session "${session.displayName}" for ${binding.workspacePath}: ` +
                    `${activationResult.error || 'unknown error'}`,
                );
                continue;
            }

            restoredWorkspaces.add(binding.workspacePath);
            logger.info(`[StartupRestore] Restored session "${session.displayName}" for workspace ${binding.workspacePath}`);
        } catch (error: unknown) {
            logger.warn(`[StartupRestore] Failed to restore workspace ${binding.workspacePath}: ${(error as Error).message || error}`);
        }
    }
}

/**
 * Sends a prompt to the Antigravity workspace via CDP and streams the response to Discord
 */
async function sendPromptToAntigravity(
    bridge: CdpBridge,
    message: Message,
    prompt: string,
    cdp: CdpService,
    modeService: ModeService,
    modelService: ModelService,
    inboundImages: InboundImageAttachment[] = [],
    options?: {
        chatSessionService: ChatSessionService;
        chatSessionRepo: ChatSessionRepository;
        channelManager: ChannelManager;
        titleGenerator: TitleGeneratorService;
        userPrefRepo?: UserPreferenceRepository;
        onFullCompletion?: () => void;
        extractionMode?: ExtractionMode;
    }
): Promise<void> {
    const monitorTraceId = `${cdp.getContexts()[0] || 'unknown'}-${Date.now()}`;
    const enqueueGeneral = createSerialTaskQueue('general', monitorTraceId).enqueue;
    const enqueueResponse = createSerialTaskQueue('response', monitorTraceId).enqueue;
    const enqueueActivity = createSerialTaskQueue('activity', monitorTraceId).enqueue;

    const telemetryModeName = MODE_UI_NAMES[modeService.getCurrentMode()] || modeService.getCurrentMode();
    const telemetryModelName = (await cdp.getCurrentModel()) || '';

    const autoRenameChannel = async (newTitle: string) => {
        if (message.channel.isTextBased() && 'setName' in message.channel) {
            await message.channel.setName(newTitle).catch(e => logger.warn(`Failed to rename channel: ${e.message}`));
        }
    };

    const tryEmergencyExtractText = async (): Promise<string> => {
        try {
            const contextId = cdp.getPrimaryContextId();
            const expression = `(() => {
                const panel = document.querySelector('.antigravity-agent-side-panel');
                const scope = panel || document;

                const candidateSelectors = [
                    '.rendered-markdown',
                    '.leading-relaxed.select-text',
                    '.flex.flex-col.gap-y-3',
                    '[data-message-author-role="assistant"]',
                    '[data-message-role="assistant"]',
                    '[class*="assistant-message"]',
                    '[class*="message-content"]',
                    '[class*="markdown-body"]',
                    '.prose',
                ];

                const looksLikeActivity = (text) => {
                    const normalized = (text || '').trim().toLowerCase();
                    if (!normalized) return true;
                    const activityPattern = /^(?:analy[sz]ing|reading|writing|running|searching|planning|thinking|processing|loading|executing|testing|debugging|analyzed|read|wrote|ran)/i;
                    return activityPattern.test(normalized) && normalized.length <= 220;
                };

                const clean = (text) => (text || '').replace(/\\r/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();

                const candidates = [];
                const seen = new Set();
                for (const selector of candidateSelectors) {
                    const nodes = scope.querySelectorAll(selector);
                    for (const node of nodes) {
                        if (!node || seen.has(node)) continue;
                        seen.add(node);
                        candidates.push(node);
                    }
                }

                for (let i = candidates.length - 1; i >= 0; i--) {
                    const node = candidates[i];
                    const text = clean(node.innerText || node.textContent || '');
                    if (!text || text.length < 20) continue;
                    if (looksLikeActivity(text)) continue;
                    if (/^(good|bad)$/i.test(text)) continue;
                    return text;
                }

                return '';
            })()`;

            const callParams: Record<string, unknown> = {
                expression,
                returnByValue: true,
                awaitPromise: true,
            };
            if (contextId !== null) callParams.contextId = contextId;
            const res = await cdp.call('Runtime.evaluate', callParams) as { result?: { value?: unknown } };
            const value = res.result?.value;
            return typeof value === 'string' ? value.trim() : '';
        } catch {
            return '';
        }
    };

    try {
        logger.prompt(prompt);
        const wrappedOptions = options
            ? {
                ...options,
                onFullCompletion: () => {
                    activeDiscordPromptSessions.delete(message.channelId);
                    options.onFullCompletion?.();
                },
            }
            : {
                onFullCompletion: () => {
                    activeDiscordPromptSessions.delete(message.channelId);
                },
            };

        const session = new PromptSession({
            message,
            prompt,
            cdp,
            modeService,
            modelService,
            inboundImages,
            options: wrappedOptions,
            enqueueGeneral,
            enqueueResponse,
            enqueueActivity,
            telemetryModeName,
            telemetryModelName,
            logger,
            config: {
                autoRenameThreshold: AUTO_RENAME_THRESHOLD,
                coalesceMs: COALESCE_PERIOD_MS
            },
            autoRenameChannel,
            tryEmergencyExtractText,
            userStopRequestedChannels,
            telegramNotify: globalTelegramNotifier
        });

        activeDiscordPromptSessions.set(message.channelId, session);
        await session.execute();
    } catch (e: unknown) {
        activeDiscordPromptSessions.delete(message.channelId);
        options?.onFullCompletion?.();
        logger.error('[sendPromptToAntigravity] Setup failure:', e);
    }
}

// =============================================================================
// Bot main entry point
// =============================================================================

export const startBot = async (cliLogLevel?: LogLevel) => {
    clearShutdownHooks();
    const config = loadConfig();
    logger.setLogLevel(cliLogLevel ?? config.logLevel);

    const dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : 'antigravity.db';
    const db = new Database(dbPath);
    const modeService = new ModeService();
    const modelService = new ModelService();
    const templateRepo = new TemplateRepository(db);
    const userPrefRepo = new UserPreferenceRepository(db);

    // Eagerly load default model from DB (single-user bot optimization)
    try {
        const firstUser = db.prepare('SELECT user_id FROM user_preferences LIMIT 1').get() as { user_id: string } | undefined;
        if (firstUser) {
            const savedDefault = userPrefRepo.getDefaultModel(firstUser.user_id);
            modelService.loadDefaultModel(savedDefault);
        }
    } catch {
        // DB may not have user_preferences yet — safe to ignore
    }
    const workspaceBindingRepo = new WorkspaceBindingRepository(db);
    const chatSessionRepo = new ChatSessionRepository(db);
    const workspaceService = new WorkspaceService(config.workspaceBaseDir);
    const channelManager = new ChannelManager();

    // Auto-launch Antigravity with CDP port if not already running.
    // Pass the __claw__ workspace so it opens directly instead of an empty window.
    const clawDir = config.clawWorkspace ?? path.join(config.workspaceBaseDir, '__claw__');
    await ensureAntigravityRunning(clawDir);

    // Initialize CDP bridge (lazy connection: pool creation only)
    const bridge = initCdpBridge(config.autoApproveFileEdits);

    // Initialize CDP-dependent services (constructor CDP dependency removed)
    const chatSessionService = new ChatSessionService();
    const titleGenerator = new TitleGeneratorService();
    const promptDispatcher = new PromptDispatcher({
        bridge,
        modeService,
        modelService,
        sendPromptImpl: sendPromptToAntigravity,
    });

    const scheduleRepo = new ScheduleRepository(db);
    const scheduleService = new ScheduleService(scheduleRepo);

    const appContext: ApplicationContext = {
        db,
        modeService,
        modelService,
        workspaceService,
        channelManager,
        chatSessionService,
        scheduleService,
        promptDispatcher,
        titleGenerator,
        templateRepo,
        workspaceBindingRepo,
        chatSessionRepo,
        scheduleRepo,
        userPrefRepo,
        bridge,
    };
    setApplicationContext(appContext);

    // Initialize command handlers (joinHandler is created after client, see below)
    const wsHandler = new WorkspaceCommandHandler(appContext);
    const chatHandler = new ChatCommandHandler(chatSessionService, chatSessionRepo, workspaceBindingRepo, channelManager, workspaceService, bridge.pool);
    const cleanupHandler = new CleanupCommandHandler(chatSessionRepo, workspaceBindingRepo);
    const slashCommandHandler = new SlashCommandHandler(templateRepo);

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

    /**
     * Check if Antigravity is currently generating a response via the backend trajectory status.
     * Returns true if busy, false if idle.
     */
    async function isAntigravityBusy(cdp: CdpService): Promise<boolean> {
        try {
            const grpcClient = await cdp.getGrpcClient();
            const cascadeId = grpcClient ? await cdp.getActiveCascadeId() : null;
            if (!grpcClient || !cascadeId) return false;

            const traj = await grpcClient.rawRPC('GetCascadeTrajectory', { cascadeId }) as { trajectory?: { cascadeRunStatus?: string }; status?: string };
            const status = traj.trajectory?.cascadeRunStatus || traj.status || '';
            return status === 'CASCADE_RUN_STATUS_RUNNING';
        } catch {
            return false; // If we can't check, assume not busy
        }
    }

    /**
     * Wait for Antigravity to finish generating (stop button disappears).
     * Returns true if idle within timeout, false if still busy.
     */
    async function waitForIdle(cdp: CdpService, maxWaitMs: number = 300_000): Promise<boolean> {
        const checkIntervalMs = 10_000; // Check every 10 seconds
        const maxChecks = Math.ceil(maxWaitMs / checkIntervalMs);

        for (let i = 0; i < maxChecks; i++) {
            const busy = await isAntigravityBusy(cdp);
            if (!busy) return true;
            logger.debug(`[ScheduleJob] Antigravity is busy, waiting... (${i + 1}/${maxChecks})`);
            await new Promise(r => setTimeout(r, checkIntervalMs));
        }
        return false;
    }

    // Shared notification function — gets wired up once Telegram platform initializes.
    // scheduleJobCallback can call this to broadcast cron results to all bound chats.
    let telegramNotify: ((text: string) => Promise<void>) | null = null;

    // ClawCommandInterceptor — scans AI output for @claw directives and auto-executes them.
    // Declared here (before scheduleJobCallback) so the callback can reference it.
    let clawInterceptor: ClawCommandInterceptor | null = null;

    // Resolve Claw workspace — dedicated directory for the agent's tasks and memory.
    // This keeps scheduled work isolated from the user's active conversations.
    const clawWorkspacePath = clawDir;

    // Ensure the Claw workspace directory exists
    if (!fs.existsSync(clawWorkspacePath)) {
        fs.mkdirSync(clawWorkspacePath, { recursive: true });
        logger.info(`[Claw] Created agent workspace: ${clawWorkspacePath}`);
    }

    // Auto-launch Antigravity with the agent workspace if not already open.
    // This ensures scheduled tasks always have a dedicated CDP endpoint.
    // Only launch if there are active schedules — avoids opening an empty
    // Antigravity window on every startup when no cron tasks are configured.
    const enabledSchedules = scheduleRepo.findEnabled();
    if (enabledSchedules.length === 0) {
        logger.debug('[Claw] No enabled schedules — skipping dedicated Antigravity auto-launch');
    } else {
        logger.info(`[Claw] ${enabledSchedules.length} enabled schedule(s) found — ensuring Antigravity has agent workspace...`);
        await (async () => {
            const http = await import('http');
            const { CDP_PORTS } = await import('../utils/cdpPorts');
            const clawProjectName = path.basename(clawWorkspacePath);

            // Check if the agent workspace is already open in ANY Antigravity instance.
            const checkPort = (port: number): Promise<{ hasClaw: boolean }> => {
                return new Promise((resolve) => {
                    const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
                        let data = '';
                        res.on('data', (chunk: string) => (data += chunk));
                        res.on('end', () => {
                            try {
                                const tabs = JSON.parse(data) as Array<{ type: string; url?: string; title?: string }>;
                                const hasClaw = tabs
                                    .filter((t) => t.type === 'page' && t.url?.includes('workbench'))
                                    .some((t) => (t.title || '').includes(clawProjectName));
                                resolve({ hasClaw });
                            } catch { resolve({ hasClaw: false }); }
                        });
                    });
                    req.on('error', () => resolve({ hasClaw: false }));
                    req.setTimeout(2000, () => { req.destroy(); resolve({ hasClaw: false }); });
                });
            };

            for (const port of CDP_PORTS) {
                const { hasClaw } = await checkPort(port);
                if (hasClaw) {
                    logger.info(`[Claw] "${clawProjectName}" workspace already open on CDP port ${port}`);
                    return;
                }
            }

            // Agent workspace not found on any port — launch a new instance
            const net = await import('net');
            const isPortFree = (port: number): Promise<boolean> => {
                return new Promise((resolve) => {
                    const server = net.createServer();
                    server.once('error', () => resolve(false));
                    server.once('listening', () => { server.close(() => resolve(true)); });
                    server.listen(port, '127.0.0.1');
                });
            };

            let freePort: number | null = null;
            for (const port of CDP_PORTS) {
                if (await isPortFree(port)) {
                    freePort = port;
                    break;
                }
            }

            if (!freePort) {
                logger.warn(`[Claw] No free CDP port available to auto-launch "${clawProjectName}" workspace. Scheduled tasks may fail.`);
                return;
            }

            logger.info(`[Claw] Launching Antigravity for "${clawProjectName}" workspace on CDP port ${freePort}...`);
            try {
                const { getAntigravityCliPath: getCliPath } = await import('../utils/pathUtils');
                const antigravityCli = getCliPath();
                const { spawn } = await import('child_process');
                const child = spawn(antigravityCli, [
                    `--remote-debugging-port=${freePort}`,
                    clawWorkspacePath,
                ], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
                child.unref();
                child.once('error', (err) => {
                    logger.warn(`[Claw] Failed to launch Antigravity: ${err?.message || err}`);
                });
                logger.info(`[Claw] Antigravity launched for "${clawProjectName}" workspace (port ${freePort})`);
            } catch (err: unknown) {
                logger.warn(`[Claw] Failed to auto-launch Antigravity: ${(err as Error).message || err}`);
            }
        })();
    } // end: else (enabledSchedules.length > 0)

    // Auto-generate GEMINI.md — Antigravity reads this to learn about @claw commands.
    // Regenerated on every boot to keep instructions up-to-date.
    const geminiMdPath = path.join(clawWorkspacePath, 'GEMINI.md');
    const geminiMdContent = [
        '# 🦞 ClawGravity Agent Instructions',
        '',
        '> This workspace is your dedicated home for autonomous operations.',
        '> You can invoke ClawGravity features and manage your own scheduled tasks.',
        '',
        '## Heartbeat System',
        '',
        '`HEARTBEAT.md` is your periodic task checklist. When a heartbeat cron fires,',
        'you will be asked to read and execute this checklist. The checklist is yours to edit.',
        '',
        'Example HEARTBEAT.md:',
        '```markdown',
        '- [ ] Check CLAW.md for pending tasks',
        '- [ ] Review any new files in this workspace',
        '- [ ] If nothing needs attention, reply with HEARTBEAT_OK',
        '```',
        '',
        'You can update HEARTBEAT.md at any time to change what your heartbeat checks for.',
        '',
        '## @claw Command Protocol',
        '',
        'To invoke ClawGravity features, include a `@claw` code block in your response.',
        'ClawGravity intercepts these blocks and executes them automatically.',
        '',
        '### Schedule a recurring task',
        '',
        '````',
        '```@claw',
        'action: schedule_add',
        'cron: */5 * * * *',
        'prompt: Read HEARTBEAT.md and execute the checklist. Update CLAW.md with results.',
        '```',
        '````',
        '',
        '- `cron`: Standard cron expression (minute hour day-of-month month day-of-week)',
        '- `prompt`: The message sent to you in a NEW session when the cron fires',
        '',
        '### List active schedules',
        '',
        '````',
        '```@claw',
        'action: schedule_list',
        '```',
        '````',
        '',
        '### Remove a schedule',
        '',
        '````',
        '```@claw',
        'action: schedule_remove',
        'id: 1',
        '```',
        '````',
        '',
        '## Persistent Memory',
        '',
        '**CLAW.md** — your persistent memory file. Read/write freely.',
        'Each scheduled task runs in a new chat session with NO previous context.',
        'CLAW.md is your ONLY way to persist state across sessions.',
        '',
        '## Multi-Agent Communication',
        '',
        'You can communicate with other Antigravity instances running on this machine.',
        'Each instance is identified by its workspace/project name.',
        '',
        '### List available agents',
        '',
        '````',
        '```@claw',
        'action: agent_list',
        '```',
        '````',
        '',
        '### Delegate a task to another agent',
        '',
        '````',
        '```@claw',
        'action: agent_send',
        'to: ProjectName',
        'message: Describe the task you want the sub-agent to perform.',
        '```',
        '````',
        '',
        '- The sub-agent runs the task in a new isolated session.',
        '- A concise **summary** is automatically extracted and injected back into your conversation.',
        '- The full output is saved to a file (path shown in result). Use `agent_read` if you need the full details.',
        '- Use `agent_list` first to discover available agents.',
        '- The sub-agent sees your task with a `[Sub-Agent Task]` prefix.',
        '',
        '### Read an agent response',
        '',
        '````',
        '```@claw',
        'action: agent_read',
        'file: /path/to/response/file.md',
        '```',
        '````',
        '',
        '- Use this to read the full response after receiving a notification.',
        '- Only read when you need the full content — the preview may be sufficient.',
        '',
        '## Important Rules',
        '',
        '- Each scheduled task opens a **new session** — no conversation history carries over',
        '- Always read CLAW.md at the start of a scheduled task to restore context',
        '- Write important state back to CLAW.md before your response ends',
        '- This workspace is separate from the user\'s coding projects',
        '',
    ].join('\n');
    fs.writeFileSync(geminiMdPath, geminiMdContent, 'utf-8');
    logger.debug(`[Claw] GEMINI.md written to ${geminiMdPath}`);

    // Ensure HEARTBEAT.md exists — the agent's periodic task checklist
    const heartbeatPath = path.join(clawWorkspacePath, 'HEARTBEAT.md');
    if (!fs.existsSync(heartbeatPath)) {
        fs.writeFileSync(heartbeatPath, [
            '# 🦞 Heartbeat Checklist',
            '',
            '> This checklist runs on each heartbeat. Edit it to customize your periodic tasks.',
            '',
            '- [ ] Read CLAW.md for any pending tasks or reminders',
            '- [ ] Check if there are any new files or changes in this workspace',
            '- [ ] If nothing needs attention, reply with HEARTBEAT_OK',
            '',
        ].join('\n'), 'utf-8');
        logger.info(`[Claw] Created heartbeat checklist: ${heartbeatPath}`);
    }

    // Also ensure CLAW.md memory file exists
    const clawMemoryPath = path.join(clawWorkspacePath, 'CLAW.md');
    if (!fs.existsSync(clawMemoryPath)) {
        fs.writeFileSync(clawMemoryPath, [
            '# 🦞 Claw Agent Memory',
            '',
            '> Persistent memory across scheduled tasks and sessions.',
            '> Write here to remember things between tasks.',
            '',
            '## Notes',
            '',
            '_No entries yet._',
            '',
        ].join('\n'), 'utf-8');
        logger.info(`[Claw] Created memory file: ${clawMemoryPath}`);
    }

    /**
     * Schedule job callback: dispatches the prompt to Antigravity via CDP.
     * This runs when a cron-scheduled task fires.
     *
     * Execution flow:
     *   1. Connect CDP to the dedicated agent workspace (separate Antigravity instance)
     *   2. Wait for any previous task to finish (busy detection)
     *   3. Open a new chat session (isolation)
     *   4. Inject the scheduled prompt
     *
     * IMPORTANT: The agent workspace must be opened in a SEPARATE Antigravity
     * window for scheduled tasks to work without interfering with the user.
     */
    const scheduleJobCallback = async (schedule: ScheduleRecord) => {
        logger.info(`[ScheduleJob] Firing schedule #${schedule.id}: "${schedule.prompt.slice(0, 80)}..." → claw-workspace=${clawWorkspacePath}`);
        try {
            const prepared = await ensureWorkspaceRuntime(bridge, clawWorkspacePath);
            const cdp = prepared.cdp;
            const projectName = prepared.projectName;

            // Safety check: is the claw workspace currently generating from a previous task?
            const busy = await isAntigravityBusy(cdp);
            if (busy) {
                logger.warn(`[ScheduleJob] Schedule #${schedule.id}: Claw workspace is busy — waiting for previous task...`);

                const becameIdle = await waitForIdle(cdp, 300_000);
                if (!becameIdle) {
                    logger.error(`[ScheduleJob] Schedule #${schedule.id}: Still busy after 5min — SKIPPING`);
                    return;
                }

                logger.info(`[ScheduleJob] Schedule #${schedule.id}: Claw workspace idle — proceeding`);
                await new Promise(r => setTimeout(r, 3000));
            }

            bridge.lastActiveWorkspace = projectName;

            // Open a new Antigravity session for this task
            const newChatResult = await prepared.runtime.startNewChat(chatSessionService);
            if (newChatResult.ok) {
                logger.debug(`[ScheduleJob] Schedule #${schedule.id}: New session opened`);
                await new Promise(r => setTimeout(r, 1500));
            } else {
                logger.warn(`[ScheduleJob] Schedule #${schedule.id}: Could not open new session: ${newChatResult.error}`);
            }

            const injectResult = await prepared.runtime.sendPrompt({ text: schedule.prompt });
            if (!injectResult.ok) {
                logger.error(`[ScheduleJob] Schedule #${schedule.id} inject failed: ${injectResult.error}`);
                return;
            }

            logger.done(`[ScheduleJob] Schedule #${schedule.id} prompt injected — monitoring response...`);

            const monitoringTarget = await prepared.runtime.getMonitoringTarget(injectResult.cascadeId);
            if (!monitoringTarget) {
                logger.error(`[ScheduleJob] Schedule #${schedule.id}: gRPC monitor unavailable`);
                if (telegramNotify) {
                    await (telegramNotify as (text: string) => Promise<void>)(
                        `🦞 Schedule #${schedule.id} failed: gRPC monitor unavailable.`,
                    ).catch(() => { });
                }
                return;
            }

            // Monitor the AI response and relay to Telegram
            const monitor = new GrpcResponseMonitor({
                grpcClient: monitoringTarget.grpcClient,
                cascadeId: monitoringTarget.cascadeId,
                maxDurationMs: 300_000,
                onComplete: async (finalText) => {
                    let outputText = finalText?.trim() || '';
                    if (outputText.length === 0) {
                        logger.warn(`[ScheduleJob] Schedule #${schedule.id}: Empty response from Antigravity`);
                        return;
                    }

                    const MAX_CLAW_DEPTH = 3;
                    let clawDepth = 0;

                    // Process response — handle @claw command chains with follow-up injection
                    while (true) {
                        const label = clawDepth > 0 ? ` (follow-up #${clawDepth})` : '';
                        logger.divider(`Schedule #${schedule.id} Response${label}`);
                        console.info(outputText.slice(0, 500));
                        logger.divider();

                        // Broadcast to Telegram
                        if (telegramNotify) {
                            const header = `🦞 <b>Schedule #${schedule.id}${label}</b>\n\n`;
                            const truncated = outputText.length > 3500 ? outputText.slice(0, 3500) + '...' : outputText;
                            await (telegramNotify as (text: string) => Promise<void>)(header + truncated).catch((e: unknown) =>
                                logger.error(`[ScheduleJob] Telegram notify failed:`, (e as Error).message || e)
                            );
                        }

                        // Intercept @claw commands
                        const interceptor = clawInterceptor;
                        if (!interceptor || clawDepth >= MAX_CLAW_DEPTH) break;

                        const results = await interceptor.execute(outputText);
                        if (results.length === 0) break;

                        for (const r of results) {
                            logger.info(`[ScheduleJob] @claw:${r.command.action} → ${r.success ? 'OK' : 'FAIL'}: ${r.message}`);
                        }

                        // Format results and inject back into Antigravity for AI continuation
                        const resultLines = results.map(r =>
                            `@claw:${r.command.action} — ${r.success ? 'OK' : 'FAIL'}\n${r.message}`
                        );
                        const feedback = `[ClawGravity Command Results]\n\n${resultLines.join('\n\n')}`;

                        await new Promise(r => setTimeout(r, 2000));
                        const injectResult = await prepared.runtime.sendPrompt({ text: feedback });
                        if (!injectResult.ok) {
                            logger.error(`[ScheduleJob] Failed to inject @claw results: ${injectResult.error}`);
                            break;
                        }

                        logger.done(`[ScheduleJob] @claw results injected — awaiting follow-up (depth=${clawDepth + 1})...`);

                        // Wait for the follow-up AI response
                        const followUpTarget = await prepared.runtime.getMonitoringTarget(injectResult.cascadeId);
                        if (!followUpTarget) {
                            logger.error(`[ScheduleJob] Schedule #${schedule.id}: gRPC monitor unavailable for @claw follow-up`);
                            break;
                        }

                        outputText = await new Promise<string>((resolve) => {
                            const followUp = new GrpcResponseMonitor({
                                grpcClient: followUpTarget.grpcClient,
                                cascadeId: followUpTarget.cascadeId,
                                maxDurationMs: 300_000,
                                onComplete: async (text) => resolve(text?.trim() || ''),
                                onTimeout: async () => {
                                    logger.warn(`[ScheduleJob] @claw follow-up timed out (depth=${clawDepth + 1})`);
                                    resolve('');
                                },
                            });
                            followUp.start();
                        });

                        clawDepth++;
                        if (outputText.length === 0) break;
                    }
                },
                onTimeout: async (lastText) => {
                    logger.warn(`[ScheduleJob] Schedule #${schedule.id}: Response timed out`);
                    if (telegramNotify && lastText) {
                        await (telegramNotify as (text: string) => Promise<void>)(`🦞 Schedule #${schedule.id} timed out:\n\n${lastText.slice(0, 2000)}`).catch(() => { });
                    }
                },
            });
            monitor.start();

        } catch (err: unknown) {
            const msg = (err as Error).message || String(err);
            if (msg.includes('No matching') || msg.includes('ECONNREFUSED') || msg.includes('not found')) {
                logger.error(`[ScheduleJob] Schedule #${schedule.id}: Cannot connect to "${path.basename(clawWorkspacePath)}" workspace. Please open "${clawWorkspacePath}" in a separate Antigravity window.`);
            } else {
                logger.error(`[ScheduleJob] Schedule #${schedule.id} failed:`, msg);
            }
        }
    };

    // Restore persisted schedules on startup
    const restoredCount = scheduleService.restoreAll(scheduleJobCallback);
    if (restoredCount > 0) {
        logger.info(`[Schedule] Restored ${restoredCount} scheduled task(s)`);
    }

    // Create AgentRouter for multi-agent communication
    const agentRouter = new AgentRouter({
        pool: bridge.pool,
        chatSessionService,
        workspaceService,
        extractionMode: config.extractionMode,
    });
    logger.info(`[Claw] Agent router ready — multi-agent communication enabled`);

    // Now instantiate the interceptor (after scheduleJobCallback is defined)
    clawInterceptor = new ClawCommandInterceptor({
        scheduleService,
        jobCallback: scheduleJobCallback,
        clawWorkspacePath,
        agentRouter,
        cdpServiceResolver: () => getCurrentCdp(bridge),
        onAgentResponse: async (fromAgent: string, summary: string, outputPath: string) => {
            // Inject the concise summary back to the parent agent (context-safe)
            try {
                const activeWorkspace = bridge.lastActiveWorkspace;
                if (activeWorkspace) {
                    const runtime = bridge.pool.getOrCreateRuntime(workspaceService.getWorkspacePath(activeWorkspace));
                    const notification = [
                        `[Sub-Agent Result from: ${fromAgent}]`,
                        '',
                        summary,
                        '',
                        outputPath ? `Full output saved to: ${outputPath}` : '',
                    ].filter(Boolean).join('\n');

                    const injectResult = await runtime.sendPrompt({ text: notification });
                    if (!injectResult.ok) {
                        throw new Error(injectResult.error || 'unknown injection error');
                    }
                    logger.done(`[Claw] Injected sub-agent summary from "${fromAgent}" (${summary.length} chars)`);
                } else {
                    logger.warn(`[Claw] Cannot inject sub-agent result from "${fromAgent}": no active CDP connection`);
                }
            } catch (err: unknown) {
                logger.error(`[Claw] Failed to inject sub-agent result: ${(err as Error).message || err}`);
            }
        },
    });
    logger.info(`[Claw] Command interceptor ready — @claw directives in AI responses will auto-execute`);

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

            const joinHandler = new JoinCommandHandler(chatSessionService, chatSessionRepo, workspaceBindingRepo, channelManager, bridge.pool, workspaceService, client, config.extractionMode);

            client.once(Events.ClientReady, async (readyClient) => {
                logger.info(`Ready! Logged in as ${readyClient.user.tag} | extractionMode=${config.extractionMode}`);

                try {
                    await registerSlashCommands(discordToken, discordClientId, config.guildId);
                } catch {
                    logger.warn('Failed to register slash commands, but text commands remain available.');
                }

                // Startup dashboard embed
                try {
                    const os = await import('os');
                    const projects = workspaceService.scanWorkspaces();

                    // Eagerly connect CDP to read actual model/mode from Antigravity UI
                    let cdpModel: string | null = null;
                    let cdpMode: string | null = null;
                    if (projects.length > 0) {
                        try {
                            const prepared = await ensureWorkspaceRuntime(bridge, projects[0]);
                            const cdp = prepared.cdp;
                            cdpModel = await cdp.getCurrentModel();
                            cdpMode = await cdp.getCurrentMode();
                        } catch (e) {
                            logger.debug('Startup CDP probe failed (will use defaults):', e instanceof Error ? e.message : e);
                        }
                    }

                    // Check CDP connection status
                    const activeWorkspaces = bridge.pool.getActiveWorkspaceNames();
                    const cdpStatus = activeWorkspaces.length > 0
                        ? `Connected (${activeWorkspaces.join(', ')})`
                        : 'Not connected';

                    const startupModel = cdpModel || modelService.getDefaultModel() || 'Not synced';
                    const startupMode = cdpMode || modeService.getCurrentMode();
                    if (cdpMode) modeService.setMode(cdpMode);

                    const dashboardEmbed = new EmbedBuilder()
                        .setTitle('ClawGravity Online')
                        .setColor(0x57F287)
                        .addFields(
                            { name: 'Version', value: APP_VERSION, inline: true },
                            { name: 'Node.js', value: process.versions.node, inline: true },
                            { name: 'OS', value: `${os.platform()} ${os.release()}`, inline: true },
                            { name: 'CDP', value: cdpStatus, inline: true },
                            { name: 'Projects', value: `${projects.length} registered`, inline: true },
                        )
                        .setFooter({ text: `${startupMode} | ${startupModel}` })
                        .setTimestamp();

                    // Send to the first available text channel in the guild
                    const guild = readyClient.guilds.cache.first();
                    if (guild) {
                        const channel = guild.channels.cache.find(
                            (ch) => ch.isTextBased() && !ch.isVoiceBased() && ch.permissionsFor(readyClient.user)?.has('SendMessages'),
                        );
                        if (channel && channel.isTextBased()) {
                            await channel.send({ embeds: [dashboardEmbed] });
                            logger.info('Startup dashboard embed sent.');
                        }
                    }
                } catch (error) {
                    logger.warn('Failed to send startup dashboard embed:', error);
                }

                try {
                    await restoreDiscordSessionsOnStartup(
                        client,
                        bridge,
                        workspaceBindingRepo,
                        chatSessionRepo,
                        workspaceService,
                        chatSessionService,
                    );
                } catch (error) {
                    logger.warn('Failed to restore Discord sessions on startup:', error);
                }
            });

            registerShutdownHook('platform:discord', () => {
                client.destroy();
            });

            // [Discord Interactions API] Slash command interaction handler
            client.on(Events.InteractionCreate, createInteractionCreateHandler({
                config,
                bridge,
                cleanupHandler,
                modeService,
                modelService,
                slashCommandHandler,
                wsHandler,
                chatHandler,
                client,
                sendModeUI,
                sendModelsUI,
                sendAutoAcceptUI,
                getCurrentCdp,
                parseApprovalCustomId,
                parseErrorPopupCustomId,
                parsePlanningCustomId,
                parseRunCommandCustomId,
                joinHandler,
                userPrefRepo,
                handleSlashInteraction: async (
                    interaction,
                    handler,
                    bridgeArg,
                    wsHandlerArg,
                    chatHandlerArg,
                    cleanupHandlerArg,
                    modeServiceArg,
                    modelServiceArg,
                    autoAcceptServiceArg,
                    clientArg,
                ) => handleSlashInteraction(
                    interaction,
                    handler,
                    bridgeArg,
                    wsHandlerArg,
                    chatHandlerArg,
                    cleanupHandlerArg,
                    modeServiceArg,
                    modelServiceArg,
                    autoAcceptServiceArg,
                    clientArg as Client,
                    promptDispatcher,
                    templateRepo,
                    joinHandler,
                    userPrefRepo,
                    scheduleService,
                    scheduleJobCallback,
                ),
                handleTemplateUse: async (interaction, templateId) => {
                    const template = templateRepo.findById(templateId);
                    if (!template) {
                        await interaction.followUp({
                            content: 'Template not found. It may have been deleted.',
                            flags: MessageFlags.Ephemeral,
                        });
                        return;
                    }

                    // Resolve CDP via workspace binding (same flow as text messages)
                    const channelId = interaction.channelId;
                    const workspacePath = wsHandler.getWorkspaceForChannel(channelId);

                    let cdp: CdpService | null;
                    if (workspacePath) {
                        try {
                            const prepared = await ensureWorkspaceRuntime(bridge, workspacePath, {
                                enableActionDetectors: true,
                            });
                            cdp = prepared.cdp;
                            const projectName = prepared.projectName;
                            bridge.lastActiveWorkspace = projectName;
                            const platformCh = interaction.channel ? wrapDiscordChannel(interaction.channel as import('discord.js').TextChannel) : null;
                            bridge.lastActiveChannel = platformCh;
                            if (platformCh) registerApprovalWorkspaceChannel(bridge, projectName, platformCh);
                            const session = chatSessionRepo.findByChannelId(channelId);
                            if (session?.displayName && platformCh) {
                                registerApprovalSessionChannel(bridge, projectName, session.displayName, platformCh);
                            }
                        } catch (e: unknown) {
                            await interaction.followUp({
                                content: `Failed to connect to workspace: ${(e as Error).message}`,
                                flags: MessageFlags.Ephemeral,
                            });
                            return;
                        }
                    } else {
                        cdp = getCurrentCdp(bridge);
                    }

                    if (!cdp) {
                        await interaction.followUp({
                            content: 'Not connected to CDP. Please connect to a project first.',
                            flags: MessageFlags.Ephemeral,
                        });
                        return;
                    }

                    const followUp = await interaction.followUp({
                        content: `Executing template **${template.name}**...`,
                    });

                    if (followUp instanceof Message) {
                        await promptDispatcher.send({
                            message: followUp,
                            prompt: template.prompt,
                            cdp,
                            inboundImages: [],
                            options: {
                                chatSessionService,
                                chatSessionRepo,
                                channelManager,
                                titleGenerator,
                                userPrefRepo,
                                extractionMode: config.extractionMode,
                            },
                        });
                    }
                },
            }));

            // [Text message handler]
            client.on(Events.MessageCreate, createMessageCreateHandler({
                config,
                bridge,
                modeService,
                modelService,
                slashCommandHandler,
                wsHandler,
                chatSessionService,
                chatSessionRepo,
                channelManager,
                titleGenerator,
                client,
                sendPromptToAntigravity: async (
                    _bridge,
                    message,
                    prompt,
                    cdp,
                    _modeService,
                    _modelService,
                    inboundImages = [],
                    options,
                ) => promptDispatcher.send({
                    message,
                    prompt,
                    cdp,
                    inboundImages,
                    options: options as import('../services/promptDispatcher').PromptDispatchOptions | undefined,
                }),
                autoRenameChannel,
                handleScreenshot,
                userPrefRepo,
            }));

            await client.login(discordToken);

        } // end: else (credentials present)
    } // end: Discord platform gate

    // Telegram platform
    if (config.platforms.includes('telegram') && config.telegramToken) {
        try {
            const telegramBot = new Bot(config.telegramToken);
            // Attach toInputFile so wrappers can convert Buffer to grammY InputFile
            (telegramBot as unknown as { toInputFile: (data: Buffer, filename?: string) => InputFile }).toInputFile = (data: Buffer, filename?: string) => new InputFile(data, filename);
            // Retry getMe() up to 3 times to handle transient network failures
            const botInfo = await (async () => {
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        return await telegramBot.api.getMe();
                    } catch (err: unknown) {
                        if (attempt === 3) throw err;
                        logger.warn(`[Telegram] getMe() failed (attempt ${attempt}/3): ${(err as Error).message ?? err}. Retrying in 3s...`);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
                throw new Error('getMe() failed after 3 attempts');
            })();

            const telegramBindingRepo = new TelegramBindingRepository(db);
            const telegramRecentMessageRepo = new TelegramRecentMessageRepository(db);
            const telegramAdapter = new TelegramAdapter(telegramBot as unknown as import('../platform/telegram/wrappers').TelegramBotLike, String(botInfo.id));
            const telegramSessionStateStore = new TelegramSessionStateStore(telegramRecentMessageRepo);

            const telegramMessageTracker = new TelegramMessageTracker();

            const activeMonitors = new Map<string, GrpcResponseMonitor>();
            const telegramHandler = createTelegramMessageHandler({
                bridge,
                telegramBindingRepo,
                workspaceService,
                modeService,
                modelService,
                templateRepo,
                fetchQuota: () => bridge.quota.fetchQuota(),
                activeMonitors,
                botToken: config.telegramToken,
                botApi: telegramBot.api as unknown as TelegramCommandDeps['botApi'],
                chatSessionService,
                sessionStateStore: telegramSessionStateStore,
                scheduleService,
                scheduleJobCallback,
                clawInterceptor,
                messageTracker: telegramMessageTracker,
            });

            // Wire up the telegramNotify function so scheduled tasks can broadcast to Telegram
            telegramNotify = async (text: string) => {
                // Only send to direct/private chats (positive chatId), not group chats
                const bindings = telegramBindingRepo.findAll()
                    .filter((b: { chatId: string }) => !b.chatId.startsWith('-'));
                if (bindings.length === 0) return;
                const results = await Promise.allSettled(
                    bindings.map((b: { chatId: string }) =>
                        telegramBot.api.sendMessage(b.chatId, text, { parse_mode: 'HTML' })
                    ),
                );
                const failed = results.filter((r: PromiseSettledResult<unknown>) => r.status === 'rejected');
                if (failed.length > 0) {
                    logger.warn(`[Claw] Telegram notify failed for ${failed.length}/${bindings.length} chat(s)`);
                }
            };
            globalTelegramNotifier = telegramNotify;
            logger.debug(`[Claw] Telegram notify wired up for schedule results and global notifications`);

            // Compose select handlers: project select + mode select
            const projectSelectHandler = createTelegramSelectHandler({
                workspaceService,
                telegramBindingRepo,
            });
            const joinSelectHandler = createTelegramJoinSelectHandler({
                bridge,
                telegramBindingRepo,
                workspaceService,
                chatSessionService,
                sessionStateStore: telegramSessionStateStore,
                activeMonitors,
                clawInterceptor,
            });
            const modeSelectAction = createModeSelectAction({ bridge, modeService });
            const telegramSelectHandler = createPlatformSelectHandler({
                actions: [
                    modeSelectAction,
                ],
            });
            // Composite handler that routes to the right handler
            const compositeSelectHandler = async (interaction: import('../platform/types').PlatformSelectInteraction) => {
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
            if (config.telegramAllowedUserIds && config.telegramAllowedUserIds.length > 0) {
                allowedUsers.set('telegram', new Set(config.telegramAllowedUserIds));
            } else {
                logger.warn('Telegram platform enabled but TELEGRAM_ALLOWED_USER_IDS is empty — all users will be denied access.');
            }

            const telegramButtonHandler = createPlatformButtonHandler({
                actions: [
                    createApprovalButtonAction({ bridge }),
                    createPlanningButtonAction({ bridge }),
                    createErrorPopupButtonAction({ bridge }),
                    createRunCommandButtonAction({ bridge }),
                    createModelButtonAction({ bridge, fetchQuota: () => bridge.quota.fetchQuota(), modelService, userPrefRepo }),
                    createAutoAcceptButtonAction({ autoAcceptService: bridge.autoAccept }),
                    createTemplateButtonAction({ bridge, templateRepo }),
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
            // Register bot commands BEFORE starting polling so Telegram shows "/" suggestions
            await telegramBot.api.setMyCommands([
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
                { command: 'clear', description: 'Clear conversation history' },
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
            ]).catch((e: unknown) => {
                logger.warn('Failed to register Telegram commands:', e instanceof Error ? e.message : e);
            });

            eventRouter.registerAdapter(telegramAdapter);
            await eventRouter.startAll();

            registerShutdownHook('platform:telegram', async () => {
                for (const monitor of activeMonitors.values()) {
                    await monitor.stop().catch(() => { });
                }
                activeMonitors.clear();
                await eventRouter.stopAll();
            });

            logger.info(`Telegram bot started: @${botInfo.username} (${config.telegramAllowedUserIds?.length ?? 0} allowed users)`);

            // Send startup message to all bound Telegram chats
            const bindings = telegramBindingRepo.findAll();
            if (bindings.length > 0) {
                const os = await import('os');
                const projects = workspaceService.scanWorkspaces();

                // Eagerly connect CDP to read actual model/mode from Antigravity UI
                // IMPORTANT: We use the dedicated Claw agent workspace (__claw__) to read state.
                // This ensures we always have a reliable, dedicated endpoint and memory space.
                let tgCdpModel: string | null = null;
                let tgCdpMode: string | null = null;

                try {
                    const prepared = await ensureWorkspaceRuntime(bridge, clawWorkspacePath);
                    const cdp = prepared.cdp;
                    tgCdpModel = await cdp.getCurrentModel();
                    tgCdpMode = await cdp.getCurrentMode();
                } catch (e) {
                    logger.debug(`Telegram startup CDP probe missed (__claw__):`, e instanceof Error ? e.message : e);
                }

                const activeWorkspaces = bridge.pool.getActiveWorkspaceNames();
                const cdpStatus = activeWorkspaces.length > 0
                    ? `Connected (${activeWorkspaces.join(', ')})`
                    : 'Not connected';

                const tgStartupModel = tgCdpModel || modelService.getDefaultModel() || 'Not synced';
                const tgStartupMode = tgCdpMode || modeService.getCurrentMode();
                if (tgCdpMode) modeService.setMode(tgCdpMode);

                const startupText = [
                    '<b>ClawGravity Online</b>',
                    '',
                    `Version: ${APP_VERSION}`,
                    `Node.js: ${process.versions.node}`,
                    `OS: ${os.platform()} ${os.release()}`,
                    `CDP: ${cdpStatus}`,
                    `Projects: ${projects.length} registered`,
                    '',
                    `<i>${tgStartupMode} | ${tgStartupModel}</i>`,
                ].join('\n');

                const sendWithRetry = async (chatId: number | string, text: string, retries = 3, delayMs = 2000): Promise<void> => {
                    for (let attempt = 1; attempt <= retries; attempt++) {
                        try {
                            await telegramBot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
                            return;
                        } catch (err) {
                            if (attempt < retries) {
                                logger.debug(`[Telegram] Startup message attempt ${attempt}/${retries} failed, retrying in ${delayMs}ms...`);
                                await new Promise((r) => setTimeout(r, delayMs));
                            } else {
                                throw err;
                            }
                        }
                    }
                };

                const results = await Promise.allSettled(
                    bindings.map((binding) => sendWithRetry(binding.chatId, startupText)),
                );
                const failed = results.filter((r) => r.status === 'rejected');
                if (failed.length > 0) {
                    logger.warn(`[Telegram] Startup message failed for ${failed.length}/${bindings.length} chat(s) after retries: ${(failed[0] as PromiseRejectedResult).reason?.message ?? 'unknown error'}`);
                } else {
                    logger.info(`Telegram startup message sent to ${bindings.length} bound chat(s).`);
                }

                // Eagerly start passive mirroring for all bound workspaces
                // so that PC-typed messages are forwarded to Telegram even if the user
                // never sends a message from Telegram first.
                for (const binding of bindings) {
                    try {
                        const bWorkspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
                        const tgChannel = wrapTelegramChannel(telegramBot.api as unknown as TelegramBotLike['api'], binding.chatId, (data: Buffer, filename?: string) => new InputFile(data, filename));
                        let startupRuntime: WorkspaceRuntime | null = null;
                        const prepared = await ensureWorkspaceRuntime(bridge, bWorkspacePath, {
                            userMessageSinkKey: `telegram:${binding.chatId}`,
                            onUserMessage: (info) => {
                                if (!startupRuntime) return;
                                handlePassiveUserMessage(
                                    tgChannel,
                                    startupRuntime,
                                    info,
                                    activeMonitors,
                                    clawInterceptor,
                                    telegramSessionStateStore,
                                )
                                    .catch((err: unknown) => logger.error('[TelegramPassive:Startup] Error handling PC message:', err instanceof Error ? err.message : String(err)));
                            },
                        });
                        startupRuntime = prepared.runtime;
                        const startupCascadeId = await startupRuntime.getActiveCascadeId().catch(() => null);
                        if (startupCascadeId) {
                            telegramSessionStateStore.setCurrentCascadeId(binding.chatId, startupCascadeId);

                            // Check if the active cascade is still streaming and resume monitoring
                            try {
                                const monitoringTarget = await startupRuntime.getMonitoringTarget(startupCascadeId);
                                if (monitoringTarget) {
                                    const traj = await monitoringTarget.grpcClient.rawRPC('GetCascadeTrajectory', { cascadeId: startupCascadeId });
                                    const runStatus = extractCascadeRunStatus(traj);
                                    if (runStatus === 'CASCADE_RUN_STATUS_RUNNING') {
                                        logger.info(`[TelegramPassive:Startup] Cascade ${startupCascadeId.slice(0, 12)}... is still streaming — starting passive monitor`);
                                        await startMonitorForActiveSession(
                                            tgChannel, startupRuntime, startupCascadeId,
                                            activeMonitors, clawInterceptor,
                                            telegramSessionStateStore,
                                        );
                                    }
                                }
                            } catch (err: unknown) {
                                logger.debug(`[TelegramPassive:Startup] runStatus check failed for ${startupCascadeId.slice(0, 12)}...: ${(err as Error).message || err}`);
                            }
                        }
                        logger.info(`[TelegramPassive] Eager mirroring started for ${prepared.projectName} → chat ${binding.chatId}`);
                    } catch (e: unknown) {
                        logger.warn(`[TelegramPassive] Failed to start eager mirroring for ${binding.workspacePath}: ${(e as Error).message || e}`);
                    }
                }
            }
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            logger.error('Failed to start Telegram adapter:', message);
        }
    }
};

/**
 * Auto-rename channel on first message send
 */
async function autoRenameChannel(
    message: Message,
    chatSessionRepo: ChatSessionRepository,
    titleGenerator: TitleGeneratorService,
    channelManager: ChannelManager,
    _cdp?: CdpService,
): Promise<void> {
    const session = chatSessionRepo.findByChannelId(message.channelId);
    if (!session || session.isRenamed) return;

    const guild = message.guild;
    if (!guild) return;

    try {
        const title = await titleGenerator.generateTitle(message.content);
        const newName = `${session.sessionNumber}-${title}`;
        await channelManager.renameChannel(guild, message.channelId, newName);
        chatSessionRepo.updateDisplayName(message.channelId, title);
    } catch (err) {
        logger.error('[AutoRename] Rename failed:', err);
    }
}

/**
 * Handle Discord Interactions API slash commands
 */
async function handleSlashInteraction(
    interaction: ChatInputCommandInteraction,
    handler: SlashCommandHandler,
    bridge: CdpBridge,
    wsHandler: WorkspaceCommandHandler,
    chatHandler: ChatCommandHandler,
    cleanupHandler: CleanupCommandHandler,
    modeService: ModeService,
    modelService: ModelService,
    autoAcceptService: AutoAcceptService,
    _client: Client,
    promptDispatcher: PromptDispatcher,
    templateRepo: TemplateRepository,
    joinHandler?: JoinCommandHandler,
    userPrefRepo?: UserPreferenceRepository,
    scheduleService?: ScheduleService,
    scheduleJobCallback?: (schedule: ScheduleRecord) => void,
): Promise<void> {
    const commandName = interaction.commandName;

    switch (commandName) {
        case 'help': {
            const helpFields = [
                {
                    name: '💬 Chat', value: [
                        '`/new` — Start a new chat session',
                        '`/clear` — Clear conversation history',
                        '`/chat` — Show current session info + list',
                    ].join('\n')
                },
                {
                    name: '🔗 Session', value: [
                        '`/session` — Switch to an existing session',
                        '`/mirror` — Toggle PC→Discord mirroring ON/OFF',
                    ].join('\n')
                },
                {
                    name: '⏹️ Control', value: [
                        '`/stop` — Interrupt active LLM generation',
                        '`/screenshot` — Capture Antigravity screen',
                    ].join('\n')
                },
                {
                    name: '⚙️ Settings', value: [
                        '`/mode` — Display and change execution mode',
                        '`/model [name]` — Display and change LLM model',
                        '`/output [format]` — Toggle Embed / Plain Text output',
                    ].join('\n')
                },
                {
                    name: '📁 Projects', value: [
                        '`/project` — Display project list',
                        '`/project create <name>` — Create a new project',
                    ].join('\n')
                },
                {
                    name: '📝 Templates', value: [
                        '`/template list` — Show templates with execute buttons (click to run)',
                        '`/template add <name> <prompt>` — Register a template',
                        '`/template delete <name>` — Delete a template',
                    ].join('\n')
                },
                {
                    name: '🔧 System', value: [
                        '`/status` — Display overall bot status',
                        '`/autoaccept` — Toggle auto-approve mode for approval dialogs via buttons',
                        '`/schedule` — Manage scheduled tasks (add/list/remove)',
                        '`/restart` — Fully restart the bot process',
                        '`/logs [lines] [level]` — View recent bot logs',
                        '`/cleanup [days]` — Clean up unused channels/categories',
                        '`/help` — Show this help',
                    ].join('\n')
                },
            ];

            const helpOutputFormat = userPrefRepo?.getOutputFormat(interaction.user.id) ?? 'embed';
            if (helpOutputFormat === 'plain') {
                const chunks = formatAsPlainText({
                    title: '📖 ClawGravity Commands',
                    description: 'Commands for controlling Antigravity from Discord.',
                    fields: helpFields,
                    footerText: 'Text messages are sent directly to Antigravity',
                });
                await interaction.editReply({ content: chunks[0] });
                break;
            }

            const embed = new EmbedBuilder()
                .setTitle('📖 ClawGravity Commands')
                .setColor(0x5865F2)
                .setDescription('Commands for controlling Antigravity from Discord.')
                .addFields(...helpFields)
                .setFooter({ text: 'Text messages are sent directly to Antigravity' })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
        }

        case 'mode': {
            await sendModeUI(interaction, modeService, { getCurrentCdp: () => getCurrentCdp(bridge) });
            break;
        }

        case 'model': {
            const modelName = interaction.options.getString('name');
            if (!modelName) {
                await sendModelsUI(interaction, {
                    getCurrentCdp: () => getCurrentCdp(bridge),
                    fetchQuota: async () => bridge.quota.fetchQuota(),
                });
            } else {
                const cdp = getCurrentCdp(bridge);
                if (!cdp) {
                    await interaction.editReply({ content: 'Not connected to CDP.' });
                    break;
                }
                const res = await cdp.setUiModel(modelName);
                if (res.ok) {

                    await interaction.editReply({ content: `Model changed to **${res.model}**.` });
                } else {
                    await interaction.editReply({ content: res.error || 'Failed to change model.' });
                }
            }
            break;
        }

        case 'template': {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'list') {
                const templates = templateRepo.findAll();
                await sendTemplateUI(interaction as unknown as { editReply: (opts: Record<string, unknown>) => Promise<unknown> }, templates);
                break;
            }

            let args: string[];
            switch (subcommand) {
                case 'add': {
                    const name = interaction.options.getString('name', true);
                    const prompt = interaction.options.getString('prompt', true);
                    args = ['add', name, prompt];
                    break;
                }
                case 'delete': {
                    const name = interaction.options.getString('name', true);
                    args = ['delete', name];
                    break;
                }
                default:
                    args = [];
            }

            const result = await handler.handleCommand('template', args);
            await interaction.editReply({ content: result.message });
            break;
        }

        case 'status': {
            const activeNames = bridge.pool.getActiveWorkspaceNames();
            const currentMode = modeService.getCurrentMode();

            const mirroringWorkspaces = activeNames.filter(
                (name) => bridge.pool.getUserMessageDetector(name)?.isActive(),
            );
            const mirrorStatus = mirroringWorkspaces.length > 0
                ? `📡 ON (${mirroringWorkspaces.join(', ')})`
                : '⚪ OFF';

            const statusFields = [
                { name: 'CDP Connection', value: activeNames.length > 0 ? `🟢 ${activeNames.length} project(s) connected` : '⚪ Disconnected', inline: true },
                { name: 'Mode', value: MODE_DISPLAY_NAMES[currentMode] || currentMode, inline: true },
                { name: 'Auto Approve', value: autoAcceptService.isEnabled() ? '🟢 ON' : '⚪ OFF', inline: true },
                { name: 'Mirroring', value: mirrorStatus, inline: true },
            ];

            let statusDescription: string;
            if (activeNames.length > 0) {
                const lines = activeNames.map((name) => {
                    const cdp = bridge.pool.getConnected(name);
                    const contexts = cdp ? cdp.getContexts().length : 0;
                    const detectorActive = bridge.pool.getApprovalDetector(name)?.isActive() ? ' [Detecting]' : '';
                    const mirrorActive = bridge.pool.getUserMessageDetector(name)?.isActive() ? ' [Mirror]' : '';
                    return `• **${name}** — Contexts: ${contexts}${detectorActive}${mirrorActive}`;
                });
                statusDescription = `**Connected Projects:**\n${lines.join('\n')}`;
            } else {
                statusDescription = 'Send a message to auto-connect to a project.';
            }

            const statusOutputFormat = userPrefRepo?.getOutputFormat(interaction.user.id) ?? 'embed';
            if (statusOutputFormat === 'plain') {
                const chunks = formatAsPlainText({
                    title: '🔧 Bot Status',
                    description: statusDescription,
                    fields: statusFields,
                });
                await interaction.editReply({ content: chunks[0] });
                break;
            }

            const embed = new EmbedBuilder()
                .setTitle('🔧 Bot Status')
                .setColor(activeNames.length > 0 ? 0x00CC88 : 0x888888)
                .addFields(...statusFields)
                .setDescription(statusDescription)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            break;
        }

        case 'autoaccept': {
            const requestedMode = interaction.options.getString('mode');
            if (!requestedMode) {
                await sendAutoAcceptUI(interaction, autoAcceptService);
                break;
            }

            const result = autoAcceptService.handle(requestedMode);
            await interaction.editReply({ content: result.message });
            break;
        }

        case 'output': {
            if (!userPrefRepo) {
                await interaction.editReply({ content: 'Output preference service not available.' });
                break;
            }

            const requestedFormat = interaction.options.getString('format');
            if (!requestedFormat) {
                const currentFormat = userPrefRepo.getOutputFormat(interaction.user.id);
                await sendOutputUI(interaction, currentFormat);
                break;
            }

            const format: OutputFormat = requestedFormat === 'plain' ? 'plain' : 'embed';
            userPrefRepo.setOutputFormat(interaction.user.id, format);
            const label = format === 'plain' ? 'Plain Text' : 'Embed';
            await interaction.editReply({ content: `Output format changed to **${label}**.` });
            break;
        }

        case 'screenshot': {
            await handleScreenshot(interaction, getCurrentCdp(bridge));
            break;
        }

        case 'stop': {
            const activeSession = activeDiscordPromptSessions.get(interaction.channelId);
            if (!activeSession) {
                await interaction.editReply({ content: '⚠️ No active generation is running in this channel.' });
                break;
            }

            try {
                const stopped = await activeSession.stopByUser();
                activeDiscordPromptSessions.delete(interaction.channelId);

                if (!stopped) {
                    await interaction.editReply({ content: '⚠️ No active generation is running in this channel.' });
                    break;
                }

                const embed = new EmbedBuilder()
                    .setTitle('⏹️ Generation Interrupted')
                    .setDescription('AI response generation was safely stopped.')
                    .setColor(0xE74C3C)
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            } catch (e: unknown) {
                await interaction.editReply({ content: `❌ Error during stop processing: ${(e as Error).message}` });
            }
            break;
        }

        case 'project': {
            const wsSub = interaction.options.getSubcommand(false);
            if (wsSub === 'create') {
                if (!interaction.guild) {
                    await interaction.editReply({ content: 'This command can only be used in a server.' });
                    break;
                }
                await wsHandler.handleCreate(interaction, interaction.guild);
            } else {
                // /project list or /project (default)
                await wsHandler.handleShow(interaction);
            }
            break;
        }

        case 'new': {
            await chatHandler.handleNew(interaction);
            break;
        }

        case 'clear': {
            await chatHandler.handleClear(interaction);
            break;
        }

        case 'chat': {
            await chatHandler.handleChat(interaction);
            break;
        }

        case 'session': {
            if (joinHandler) {
                await joinHandler.handleJoin(interaction, bridge);
            } else {
                await interaction.editReply({ content: t('⚠️ Join handler not available.') });
            }
            break;
        }

        case 'mirror': {
            if (joinHandler) {
                await joinHandler.handleMirror(interaction, bridge);
            } else {
                await interaction.editReply({ content: t('⚠️ Mirror handler not available.') });
            }
            break;
        }

        case 'cleanup': {
            await cleanupHandler.handleCleanup(interaction);
            break;
        }

        case 'ping': {
            const apiLatency = interaction.client.ws.ping;
            await interaction.editReply({ content: `🏓 Pong! API Latency is **${apiLatency}ms**.` });
            break;
        }

        case 'logs': {
            const lines = interaction.options.getInteger('lines') ?? 50;
            const level = interaction.options.getString('level') as LogLevel | null;
            const entries = logBuffer.getRecent(lines, level ?? undefined);

            if (entries.length === 0) {
                await interaction.editReply({ content: 'No log entries found.' });
                break;
            }

            const formatted = entries
                .map((e) => `${e.timestamp.slice(11, 19)} ${e.message}`)
                .join('\n');

            const MAX_CONTENT = 1900;
            const codeBlock = formatted.length <= MAX_CONTENT
                ? `\`\`\`\n${formatted}\n\`\`\``
                : `\`\`\`\n${formatted.slice(0, MAX_CONTENT)}\n\`\`\`\n(truncated — showing ${MAX_CONTENT} chars of ${formatted.length})`;

            await interaction.editReply({ content: codeBlock });
            break;
        }

        case 'schedule': {
            if (!scheduleService || !scheduleJobCallback) {
                await interaction.editReply({ content: '⚠️ Schedule service not available.' });
                break;
            }

            const scheduleSub = interaction.options.getSubcommand();

            if (scheduleSub === 'add') {
                const cronExpr = interaction.options.getString('cron', true);
                const prompt = interaction.options.getString('prompt', true);

                // Resolve workspace for this channel
                const workspacePath = wsHandler.getWorkspaceForChannel(interaction.channelId);
                if (!workspacePath) {
                    await interaction.editReply({ content: '⚠️ No workspace bound to this channel. Use `/project` first.' });
                    break;
                }

                try {
                    const record = scheduleService.addSchedule(
                        cronExpr,
                        prompt,
                        workspacePath,
                        scheduleJobCallback,
                    );
                    const embed = new EmbedBuilder()
                        .setTitle('📅 Schedule Created')
                        .setColor(0x57F287)
                        .addFields(
                            { name: 'ID', value: `#${record.id}`, inline: true },
                            { name: 'Cron', value: `\`${cronExpr}\``, inline: true },
                            { name: 'Prompt', value: prompt.slice(0, 200), inline: false },
                        )
                        .setTimestamp();
                    await interaction.editReply({ embeds: [embed] });
                } catch (err: unknown) {
                    await interaction.editReply({ content: `❌ Failed to create schedule: ${(err as Error).message || 'unknown error'}` });
                }
            } else if (scheduleSub === 'remove') {
                const scheduleId = interaction.options.getInteger('id', true);
                const removed = scheduleService.removeSchedule(scheduleId);
                if (removed) {
                    await interaction.editReply({ content: `🗑️ Schedule #${scheduleId} removed.` });
                } else {
                    await interaction.editReply({ content: `⚠️ Schedule #${scheduleId} not found.` });
                }
            } else {
                // 'list' or default
                const schedules = scheduleService.listSchedules();
                if (schedules.length === 0) {
                    await interaction.editReply({ content: '📅 No scheduled tasks. Use `/schedule add` to create one.' });
                    break;
                }

                const lines = schedules.map((s: ScheduleRecord) => {
                    const status = s.enabled ? '✅' : '⏸️';
                    const workspace = s.workspacePath.split(/[\\/]/).pop() || s.workspacePath;
                    return `${status} **#${s.id}** \`${s.cronExpression}\` → ${s.prompt.slice(0, 80)}${s.prompt.length > 80 ? '...' : ''} (📁 ${workspace})`;
                });

                const embed = new EmbedBuilder()
                    .setTitle('📅 Scheduled Tasks')
                    .setColor(0x5865F2)
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: 'Use /schedule remove <id> to delete' })
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            }
            break;
        }

        case 'restart': {
            try {
                await interaction.editReply({ content: '🔄 Restarting bot process...' });
                const result = await restartCurrentProcess();
                if (!result.ok) {
                    await interaction.editReply({ content: `❌ Bot restart failed: ${result.error || 'unknown error'}` });
                }
            } catch (e: unknown) {
                await interaction.editReply({ content: `❌ Bot restart failed: ${(e as Error).message}` });
            }
            break;
        }

        default:
            await interaction.editReply({
                content: `Unknown command: /${commandName}`,
            });
    }
}
