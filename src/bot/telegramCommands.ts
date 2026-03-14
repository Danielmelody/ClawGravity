/**
 * Telegram command parser and handlers.
 *
 * Handles built-in bot commands that can be answered immediately
 * without routing through CDP/Antigravity:
 *   /start      — Welcome message
 *   /help       — List available commands
 *   /status     — Show bot connection status
 *   /stop       — Interrupt active LLM generation
 *   /ping       — Latency check
 *   /mode       — Switch execution mode
 *   /model      — Switch LLM model
 *   /screenshot — Capture Antigravity screenshot
 *   /autoaccept — Toggle auto-accept for approval dialogs
 *   /template   — List and execute prompt templates
 *   /logs       — Show recent log entries
 *   /new        — Start a new chat session
 *   /clear      — Clear current conversation history
 */

import fs from 'fs';
import type { PlatformMessage, MessagePayload } from '../platform/types';
import type { TelegramBotLike } from '../platform/telegram/wrappers';
import type { CdpBridge } from '../services/cdpBridgeManager';
import type { WorkspaceService } from '../services/workspaceService';
import { ensureWorkspaceRuntime, getCurrentCdp } from '../services/cdpBridgeManager';
import type { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import type { ModeService } from '../services/modeService';
import type { ModelService } from '../services/modelService';
import type { TelegramBindingRepository } from '../database/telegramBindingRepository';
import type { TemplateRepository } from '../database/templateRepository';
import type { ChatSessionService } from '../services/chatSessionService';
import type { ScheduleService } from '../services/scheduleService';
import type { ScheduleRecord } from '../database/scheduleRepository';
import { buildModePayload } from '../ui/modeUi';
import { buildModelsPayload, type QuotaData } from '../ui/modelsUi';
import { buildAutoAcceptPayload } from '../ui/autoAcceptUi';
import { buildTemplatePayload } from '../ui/templateUi';
import { buildScreenshotPayload } from '../ui/screenshotUi';
import { logBuffer } from '../utils/logBuffer';
import { logger } from '../utils/logger';
import { escapeHtml } from '../platform/telegram/trajectoryRenderer';
import type { TelegramSessionStateStore } from './telegramJoinCommand';
import { handleTelegramJoinCommand } from './telegramJoinCommand';
import { restartCurrentProcess } from '../services/processRestartService';
import type { TelegramMessageTracker } from '../services/telegramMessageTracker';
import { APP_VERSION } from '../utils/version';

// ---------------------------------------------------------------------------
// Known commands (used by both parser and /help output)
// ---------------------------------------------------------------------------

const KNOWN_COMMANDS = ['start', 'help', 'status', 'stop', 'restart', 'ping', 'mode', 'model', 'screenshot', 'autoaccept', 'template', 'template_add', 'template_delete', 'project_create', 'logs', 'new', 'clear', 'session', 'history', 'inspect', 'schedule', 'schedule_add', 'schedule_remove'] as const;
type KnownCommand = typeof KNOWN_COMMANDS[number];

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export interface ParsedTelegramCommand {
    readonly command: string;
    readonly args: string;
}

/**
 * Parse a Telegram command from message text.
 *
 * Accepted formats:
 *   /command
 *   /command args text
 *   /command@BotName
 *   /command@BotName args text
 *
 * Returns null if the text is not a known command (unknown commands
 * are forwarded to Antigravity as normal messages).
 */
export function parseTelegramCommand(text: string): ParsedTelegramCommand | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/(\w+)(?:@\S+)?(?:\s+(.*))?$/);
    if (!match) return null;

    const command = match[1].toLowerCase();
    if (!(KNOWN_COMMANDS as readonly string[]).includes(command)) return null;

    return {
        command,
        args: (match[2] ?? '').trim(),
    };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface TelegramCommandDeps {
    readonly bridge: CdpBridge;
    readonly modeService?: ModeService;
    readonly modelService?: ModelService;
    readonly telegramBindingRepo?: TelegramBindingRepository;
    readonly templateRepo?: TemplateRepository;
    readonly workspaceService?: WorkspaceService;
    readonly chatSessionService?: ChatSessionService;
    readonly fetchQuota?: () => Promise<unknown[]>;
    /** Shared map of active response monitors keyed by project name.
     *  Used by /stop to halt monitoring and prevent stale re-sends. */
    readonly activeMonitors?: Map<string, GrpcResponseMonitor>;
    readonly sessionStateStore?: TelegramSessionStateStore;
    /** Schedule service for managing cron-based tasks */
    readonly scheduleService?: ScheduleService;
    /** Callback invoked when a schedule fires to execute a prompt */
    readonly scheduleJobCallback?: (schedule: ScheduleRecord) => void;
    /** Bot API for direct Telegram API calls (e.g. deleteMessage). */
    readonly botApi?: TelegramBotLike['api'];
    /** Message tracker for clearing chat messages. */
    readonly messageTracker?: TelegramMessageTracker;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Handle a parsed Telegram command.
 * Routes to the appropriate sub-handler based on command name.
 */
export async function handleTelegramCommand(
    deps: TelegramCommandDeps,
    message: PlatformMessage,
    parsed: ParsedTelegramCommand,
): Promise<{ forwardAsMessage?: string } | void> {
    const argsDisplay = parsed.args ? ` ${parsed.args}` : '';
    logger.info(`[TelegramCommand] /${parsed.command}${argsDisplay} (chat=${message.channel.id})`);

    try {
        switch (parsed.command as KnownCommand) {
            case 'start':
                await handleStart(message);
                break;
            case 'help':
                await handleHelp(message);
                break;
            case 'status':
                await handleStatus(deps, message);
                break;
            case 'stop':
                await handleStop(deps, message);
                break;
            case 'restart':
                await handleRestart(deps, message);
                break;
            case 'ping':
                await handlePing(message);
                break;
            case 'mode':
                await handleMode(deps, message);
                break;
            case 'model':
                await handleModel(deps, message);
                break;
            case 'screenshot':
                await handleScreenshot(deps, message);
                break;
            case 'autoaccept':
                await handleAutoAccept(deps, message, parsed.args);
                break;
            case 'template':
                await handleTemplate(deps, message);
                break;
            case 'template_add':
                await handleTemplateAdd(deps, message, parsed.args);
                break;
            case 'template_delete':
                await handleTemplateDelete(deps, message, parsed.args);
                break;
            case 'project_create':
                await handleProjectCreate(deps, message, parsed.args);
                break;
            case 'logs':
                await handleLogs(message, parsed.args);
                break;
            case 'new':
                await handleNew(deps, message);
                break;
            case 'clear':
                await handleClear(deps, message);
                break;
            case 'session':
            case 'history':
                await handleSession(deps, message);
                break;
            case 'inspect':
                return handleInspect(deps, message);
            case 'schedule':
                await handleScheduleList(deps, message);
                break;
            case 'schedule_add':
                await handleScheduleAdd(deps, message, parsed.args);
                break;
            case 'schedule_remove':
                await handleScheduleRemove(deps, message, parsed.args);
                break;
            default:
                // Should not happen — parser filters unknowns
                break;
        }
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[TelegramCommand] /${parsed.command} failed: ${errMsg}`);
        await message.reply({
            text: `❌ Command /${parsed.command} failed: ${errMsg?.slice(0, 200) || 'unknown error'}`,
        }).catch(logger.error);
    }
}

// ---------------------------------------------------------------------------
// Sub-handlers
// ---------------------------------------------------------------------------

async function handleStart(message: PlatformMessage): Promise<void> {
    const text = [
        '<b>Welcome to ClawGravity!</b>',
        '',
        'This bot connects you to Antigravity AI workspaces.',
        '',
        'Get started:',
        '1. Use /project to bind this chat to a workspace',
        '2. Send any message to start chatting with Antigravity',
        '',
        'Type /help for a list of available commands.',
    ].join('\n');

    await message.reply({ text }).catch(logger.error);
}

async function handleHelp(message: PlatformMessage): Promise<void> {
    const text = [
        '<b>Available Commands</b>',
        '',
        '/project — Manage workspace bindings',
        '/status — Show bot status and connections',
        '/mode — Switch execution mode',
        '/model — Switch LLM model',
        '/screenshot — Capture Antigravity screenshot',
        '/autoaccept — Toggle auto-accept mode',
        '/template — List prompt templates',
        '/template_add — Add a prompt template',
        '/template_delete — Delete a prompt template',
        '/project_create — Create a new workspace',
        '/new — Start a new chat session',
        '/clear — Clear conversation history',
        '/session — Switch to an existing session',
        '/history — Browse chat history (alias for /session)',
        '/inspect — Toggle inspect mode (analyze TG ↔ Antigravity diffs)',
        '/schedule — List scheduled tasks',
        '/schedule_add — Add a scheduled task',
        '/schedule_remove — Remove a scheduled task',
        '/logs — Show recent log entries',
        '/stop — Interrupt active LLM generation',
        '/restart — Fully restart the bot process',
        '/ping — Check bot latency',
        '/help — Show this help message',
        '',
        'Any other message is forwarded to Antigravity.',
    ].join('\n');

    await message.reply({ text }).catch(logger.error);
}

async function handleStatus(deps: TelegramCommandDeps, message: PlatformMessage): Promise<void> {
    const chatId = message.channel.id;

    // Current chat binding
    const binding = deps.telegramBindingRepo?.findByChatId(chatId);
    const boundProject = binding?.workspacePath ?? '(none)';

    // CDP connection status for this chat's project
    const activeWorkspaces = deps.bridge.pool.getActiveWorkspaceNames();
    const projectConnected = binding
        ? activeWorkspaces.some((name) => binding.workspacePath.includes(name) || name.includes(binding.workspacePath))
        : false;

    const mode = deps.modeService
        ? deps.modeService.getCurrentMode()
        : 'unknown';

    // Read current model from the UI (CDP) — the single source of truth
    const cdp = getCurrentCdp(deps.bridge);
    const currentModel = (cdp ? await cdp.getCurrentModel() : null)
        || deps.modelService?.getDefaultModel()
        || 'Auto (UI)';

    const lines = [
        '<b>Bot Status</b>',
        '',
        `Version: ${APP_VERSION}`,
        `CDP: ${projectConnected ? '✅ Connected' : '❌ Not connected'}`,
        `Project: ${escapeHtml(boundProject)}`,
        `Active connections: ${activeWorkspaces.length > 0 ? activeWorkspaces.map(escapeHtml).join(', ') : 'none'}`,
    ];

    // Fetch and display quota info
    if (deps.fetchQuota) {
        try {
            const quotaData = await deps.fetchQuota();
            if (quotaData.length > 0) {
                lines.push('');
                lines.push('<b>Model Quota:</b>');
                for (const m of quotaData) {
                    const mr = m as Record<string, unknown>;
                    const label = (mr.label as string) || (mr.model as string) || 'Unknown';
                    const quotaInfo = mr.quotaInfo as Record<string, unknown> | undefined;
                    if (quotaInfo) {
                        const pct = Math.round((quotaInfo.remainingFraction as number) * 100);
                        const barLen = 10;
                        const filled = Math.round(pct / barLen);
                        const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
                        let resetLabel = '';
                        const resetTime = quotaInfo.resetTime as string | undefined;
                        if (resetTime) {
                            const resetMs = new Date(resetTime).getTime() - Date.now();
                            if (resetMs > 0) {
                                const h = Math.floor(resetMs / 3_600_000);
                                const m2 = Math.floor((resetMs % 3_600_000) / 60_000);
                                resetLabel = h > 0 ? ` (resets in ${h}h ${m2}m)` : ` (resets in ${m2}m)`;
                            }
                        }
                        lines.push(`  ${escapeHtml(label)}: ${bar} ${pct}%${resetLabel}`);
                    } else {
                        lines.push(`  ${escapeHtml(label)}: N/A`);
                    }
                }
            }
        } catch (err: unknown) {
            lines.push('');
            lines.push(`<i>Quota fetch failed: ${escapeHtml((err instanceof Error ? err.message : String(err)) || 'unknown')}</i>`);
        }
    }

    lines.push('');
    lines.push(`<i>${escapeHtml(mode)} | ${escapeHtml(currentModel)}</i>`);

    await message.reply({ text: lines.join('\n') }).catch(logger.error);
}

async function handleStop(deps: TelegramCommandDeps, message: PlatformMessage): Promise<void> {
    const workspace = deps.bridge.lastActiveWorkspace;
    const cdp = getCurrentCdp(deps.bridge);

    if (!cdp) {
        logger.warn('[TelegramCommand:stop] No CDP — lastActiveWorkspace:', workspace ?? '(null)');
        await message.reply({ text: 'No active workspace connection.' }).catch(logger.error);
        return;
    }

    try {
        const grpcClient = await cdp.getGrpcClient();
        const cascadeId = grpcClient ? await cdp.getActiveCascadeId() : null;
        if (!grpcClient || !cascadeId) {
            await message.reply({ text: 'No active backend stream to stop.' }).catch(logger.error);
            return;
        }

        logger.info(`[TelegramCommand:stop] Cancelling cascade ${cascadeId.slice(0, 12)}...`);
        await grpcClient.cancelCascade(cascadeId);

        if (workspace && deps.activeMonitors) {
            const monitor = deps.activeMonitors.get(workspace);
            if (monitor?.isActive()) {
                await monitor.stop().catch(() => { });
            }
            deps.activeMonitors.delete(workspace);
        }

        logger.done('[TelegramCommand:stop] Cancelled via gRPC');
        await message.reply({ text: 'Generation stopped.' }).catch(logger.error);
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('[TelegramCommand:stop]', errMsg);
        await message.reply({ text: 'Failed to stop generation.' }).catch(logger.error);
    }
}

async function handleRestart(deps: TelegramCommandDeps, message: PlatformMessage): Promise<void> {
    try {
        logger.info('[TelegramCommand:restart] Compiling & restarting bot process...');
        await message.reply({ text: '� Compiling code & restarting bot...' }).catch(logger.error);

        const result = await restartCurrentProcess();
        if (!result.ok) {
            throw new Error(result.error || 'unknown error');
        }

        logger.done(`[TelegramCommand:restart] Replacement process launched (pid=${result.pid ?? 'unknown'})`);
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('[TelegramCommand:restart]', errMsg);
        await message.reply({ text: `❌ Restart failed:\n<pre>${escapeHtml(errMsg || 'unknown error')}</pre>` }).catch(logger.error);
    }
}

async function handlePing(message: PlatformMessage): Promise<void> {
    await message.reply({ text: 'Pong!' }).catch(logger.error);
}

async function handleMode(deps: TelegramCommandDeps, message: PlatformMessage): Promise<void> {
    if (!deps.modeService) {
        await message.reply({ text: 'Mode service not available.' }).catch(logger.error);
        return;
    }

    const isPending = deps.modeService.isPendingSync();
    const payload = buildModePayload(deps.modeService.getCurrentMode(), isPending);
    await message.reply(payload).catch(logger.error);
}

async function ensureTelegramRuntimeForChat(
    deps: TelegramCommandDeps,
    message: PlatformMessage,
): Promise<Awaited<ReturnType<typeof ensureWorkspaceRuntime>> | null> {
    const chatId = message.channel.id;
    const binding = deps.telegramBindingRepo?.findByChatId(chatId);
    const activeWorkspaces = deps.bridge.pool.getActiveWorkspaceNames();
    const fallbackWorkspace = activeWorkspaces.length === 1 ? activeWorkspaces[0] : null;
    const workspaceName = binding?.workspacePath ?? deps.bridge.lastActiveWorkspace ?? fallbackWorkspace;
    if (!workspaceName) {
        return null;
    }

    const workspacePath = deps.workspaceService
        ? deps.workspaceService.getWorkspacePath(workspaceName)
        : workspaceName;
    const prepared = await ensureWorkspaceRuntime(deps.bridge, workspacePath);
    deps.bridge.lastActiveWorkspace = prepared.projectName;
    deps.bridge.lastActiveChannel = message.channel;
    return prepared;
}

async function handleModel(deps: TelegramCommandDeps, message: PlatformMessage): Promise<void> {
    let runtimePrepared: Awaited<ReturnType<typeof ensureWorkspaceRuntime>> | null;
    try {
        runtimePrepared = await ensureTelegramRuntimeForChat(deps, message);
    } catch (err: unknown) {
        logger.error('[TelegramCommand:model] runtime bootstrap failed:', err instanceof Error ? err.message : String(err));
        await message.reply({ text: 'Failed to connect to Antigravity.' }).catch(logger.error);
        return;
    }

    if (!runtimePrepared) {
        await message.reply({ text: 'Not connected to Antigravity.' }).catch(logger.error);
        return;
    }

    const models = await runtimePrepared.runtime.getUiModels();
    const currentModel = await runtimePrepared.runtime.getCurrentModel();
    const quotaData = deps.fetchQuota ? await deps.fetchQuota() : [];
    const defaultModel = deps.modelService?.getDefaultModel() ?? null;

    const payload = buildModelsPayload(models, currentModel, quotaData as QuotaData[], defaultModel);
    if (!payload) {
        await message.reply({ text: 'No models available.' }).catch(logger.error);
        return;
    }

    await message.reply(payload).catch(logger.error);
}

async function handleScreenshot(deps: TelegramCommandDeps, message: PlatformMessage): Promise<void> {
    const cdp = getCurrentCdp(deps.bridge);
    const payload = await buildScreenshotPayload(cdp);

    // If the payload contains files, send them as text (base64) since
    // Telegram file sending requires special API calls handled by the adapter.
    if (payload.files && payload.files.length > 0) {
        await sendFilePayload(message, payload);
    } else {
        await message.reply(payload).catch(logger.error);
    }
}

async function handleAutoAccept(deps: TelegramCommandDeps, message: PlatformMessage, args: string): Promise<void> {
    // If args are provided (e.g. /autoaccept on), handle directly
    if (args) {
        const result = deps.bridge.autoAccept.handle(args);
        await message.reply({ text: result.message }).catch(logger.error);
        return;
    }

    // No args — show interactive UI with buttons
    const payload = buildAutoAcceptPayload(deps.bridge.autoAccept.isEnabled());
    await message.reply(payload).catch(logger.error);
}

async function handleTemplate(deps: TelegramCommandDeps, message: PlatformMessage): Promise<void> {
    if (!deps.templateRepo) {
        await message.reply({ text: 'Template service not available.' }).catch(logger.error);
        return;
    }

    const templates = deps.templateRepo.findAll();
    const payload = buildTemplatePayload(templates);
    await message.reply(payload).catch(logger.error);
}

async function handleTemplateAdd(deps: TelegramCommandDeps, message: PlatformMessage, args: string): Promise<void> {
    if (!deps.templateRepo) {
        await message.reply({ text: 'Template service not available.' }).catch(logger.error);
        return;
    }

    // Split args into name (first word) and prompt (rest)
    const spaceIndex = args.indexOf(' ');
    if (!args || spaceIndex === -1) {
        await message.reply({
            text: 'Usage: /template_add &lt;name&gt; &lt;prompt&gt;\nExample: /template_add daily-report Write a daily standup report',
        }).catch(logger.error);
        return;
    }

    const name = args.slice(0, spaceIndex);
    const prompt = args.slice(spaceIndex + 1).trim();

    try {
        deps.templateRepo.create({ name, prompt });
        await message.reply({ text: `Template '${escapeHtml(name)}' created.` }).catch(logger.error);
    } catch (err: unknown) {
        const errObj = err as Record<string, unknown>;
        if ((errObj.message as string | undefined)?.includes('UNIQUE constraint')) {
            await message.reply({ text: `Template '${escapeHtml(name)}' already exists.` }).catch(logger.error);
        } else {
            const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('[TelegramCommand:template_add]', errMsg);
            await message.reply({ text: 'Failed to create template.' }).catch(logger.error);
        }
    }
}

async function handleTemplateDelete(deps: TelegramCommandDeps, message: PlatformMessage, args: string): Promise<void> {
    if (!deps.templateRepo) {
        await message.reply({ text: 'Template service not available.' }).catch(logger.error);
        return;
    }

    const name = args.trim();
    if (!name) {
        await message.reply({
            text: 'Usage: /template_delete &lt;name&gt;\nExample: /template_delete daily-report',
        }).catch(logger.error);
        return;
    }

    const deleted = deps.templateRepo.deleteByName(name);
    if (deleted) {
        await message.reply({ text: `Template '${escapeHtml(name)}' deleted.` }).catch(logger.error);
    } else {
        await message.reply({ text: `Template '${escapeHtml(name)}' not found.` }).catch(logger.error);
    }
}

async function handleProjectCreate(deps: TelegramCommandDeps, message: PlatformMessage, args: string): Promise<void> {
    if (!deps.workspaceService) {
        await message.reply({ text: 'Workspace service not available.' }).catch(logger.error);
        return;
    }

    const name = args.trim();
    if (!name) {
        await message.reply({
            text: 'Usage: /project_create &lt;name&gt;\nExample: /project_create NewProject',
        }).catch(logger.error);
        return;
    }

    try {
        const safePath = deps.workspaceService.validatePath(name);

        if (deps.workspaceService.exists(name)) {
            await message.reply({ text: `Workspace '${escapeHtml(name)}' already exists.` }).catch(logger.error);
            return;
        }

        fs.mkdirSync(safePath, { recursive: true });
        await message.reply({ text: `Workspace '${escapeHtml(name)}' created.` }).catch(logger.error);
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('[TelegramCommand:project_create]', errMsg);
        await message.reply({ text: `Failed to create workspace: ${escapeHtml(errMsg || 'unknown error')}` }).catch(logger.error);
    }
}

async function handleLogs(message: PlatformMessage, args: string): Promise<void> {
    const countArg = args ? parseInt(args, 10) : 20;
    const count = isNaN(countArg) ? 20 : Math.min(Math.max(countArg, 1), 50);

    const entries = logBuffer.getRecent(count);
    if (entries.length === 0) {
        await message.reply({ text: 'No log entries.' }).catch(logger.error);
        return;
    }

    const lines = entries.map(
        (e) => `<code>${e.timestamp.slice(11, 19)}</code> [${e.level.toUpperCase()}] ${escapeHtml(e.message)}`,
    );

    const text = `<b>Recent Logs (${entries.length})</b>\n\n${lines.join('\n')}`;

    // Telegram message limit is 4096 chars
    const truncated = text.length > 4096 ? text.slice(0, 4090) + '\n...' : text;
    await message.reply({ text: truncated }).catch(logger.error);
}

/**
 * Resolve the workspace binding for a chat and prepare the runtime.
 * Returns the prepared runtime or null (after sending an error reply).
 */
async function resolveWorkspaceRuntime(
    deps: TelegramCommandDeps,
    message: PlatformMessage,
    logTag: string,
): Promise<{ runtime: unknown; binding: unknown; projectName: string } | null> {
    const chatId = message.channel.id;
    const binding = deps.telegramBindingRepo?.findByChatId(chatId);
    if (!binding) {
        await message.reply({
            text: 'No project is linked to this chat. Use /project to bind a workspace first.',
        }).catch(logger.error);
        return null;
    }

    try {
        const runtimePrepared = await ensureWorkspaceRuntime(
            deps.bridge,
            deps.workspaceService
                ? deps.workspaceService.getWorkspacePath(binding.workspacePath)
                : binding.workspacePath,
        );
        return { runtime: runtimePrepared.runtime, binding, projectName: runtimePrepared.projectName };
    } catch (err: unknown) {
        logger.error(`[TelegramCommand:${logTag}] runtime bootstrap failed:`, err instanceof Error ? err.message : String(err));
        await message.reply({ text: 'Failed to connect to Antigravity.' }).catch(logger.error);
        return null;
    }
}

/**
 * Convenience helper: verify chatSessionService exists and resolve the workspace runtime.
 * Returns null (after sending error reply) if either check fails.
 */
async function resolveWithSessionService(
    deps: TelegramCommandDeps,
    message: PlatformMessage,
    logTag: string,
): Promise<{ runtime: unknown; binding: unknown; projectName: string; chatSessionService: NonNullable<typeof deps.chatSessionService> } | null> {
    if (!deps.chatSessionService) {
        await message.reply({ text: 'Chat session service not available.' }).catch(logger.error);
        return null;
    }
    const resolved = await resolveWorkspaceRuntime(deps, message, logTag);
    if (!resolved) return null;
    return { ...resolved, chatSessionService: deps.chatSessionService };
}

async function stopProjectMonitors(
    activeMonitors: TelegramCommandDeps['activeMonitors'],
    projectName: string,
): Promise<void> {
    if (!activeMonitors) return;

    for (const key of [projectName, `passive:${projectName}`]) {
        const monitor = activeMonitors.get(key);
        if (monitor?.isActive()) {
            await monitor.stop().catch(() => { });
        }
        activeMonitors.delete(key);
    }
}

/**
 * Shared helper: start a new backend chat session, stop monitors, and reset
 * session state. Returns `{ ok: true }` or `{ ok: false, error }`.
 */
async function resetChatSession(
    deps: TelegramCommandDeps,
    resolved: { runtime: unknown; projectName: string; chatSessionService: NonNullable<typeof deps.chatSessionService> },
    chatId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const runtime = resolved.runtime as Record<string, unknown>;
    const result = await (runtime.startNewChat as (service: unknown) => Promise<{ ok: boolean; error?: string }>)(resolved.chatSessionService);
    if (!result.ok) return { ok: false, error: result.error || 'unknown error' };

    await stopProjectMonitors(deps.activeMonitors, resolved.projectName);
    deps.sessionStateStore?.clearSelectedSession(chatId);
    const newCascadeId = typeof runtime.getActiveCascadeId === 'function'
        ? await (runtime.getActiveCascadeId as () => Promise<string | null>)().catch(() => null)
        : null;
    if (newCascadeId) {
        deps.sessionStateStore?.setCurrentCascadeId(chatId, newCascadeId);
    }
    return { ok: true };
}

async function handleNew(deps: TelegramCommandDeps, message: PlatformMessage): Promise<void> {
    const resolved = await resolveWithSessionService(deps, message, 'new');
    if (!resolved) return;
    const chatId = message.channel.id;

    try {
        const result = await resetChatSession(deps, resolved, chatId);
        if (result.ok) {
            await message.reply({ text: 'New chat session started.' }).catch(logger.error);
        } else {
            logger.warn('[TelegramCommand:new] startNewChat failed:', result.error);
            await message.reply({
                text: `Failed to start new chat: ${escapeHtml(result.error)}`,
            }).catch(logger.error);
        }
    } catch (err: unknown) {
        logger.error('[TelegramCommand:new] startNewChat threw:', err instanceof Error ? err.message : String(err));
        await message.reply({ text: 'Failed to start new chat.' }).catch(logger.error);
    }
}

async function handleClear(deps: TelegramCommandDeps, message: PlatformMessage): Promise<void> {
    const resolved = await resolveWithSessionService(deps, message, 'clear');
    if (!resolved) return;
    const chatId = message.channel.id;

    try {
        const result = await resetChatSession(deps, resolved, chatId);
        if (result.ok) {
            // Delete tracked bot messages from the Telegram chat (visual clear)
            if (deps.messageTracker && deps.botApi) {
                const userMsgId = Number(message.id);
                await deps.messageTracker.clearChat(
                    chatId,
                    deps.botApi,
                    isNaN(userMsgId) ? undefined : userMsgId,
                );
            }

            await message.channel.send({ text: '\u{1F5D1}\uFE0F Conversation history cleared. Starting fresh.' }).catch(logger.error);
        } else {
            logger.warn('[TelegramCommand:clear] startNewChat failed:', result.error);
            await message.reply({
                text: `Failed to clear history: ${escapeHtml(result.error)}`,
            }).catch(logger.error);
        }
    } catch (err: unknown) {
        logger.error('[TelegramCommand:clear] startNewChat threw:', err instanceof Error ? err.message : String(err));
        await message.reply({ text: 'Failed to clear conversation history.' }).catch(logger.error);
    }
}

async function handleInspect(
    deps: TelegramCommandDeps,
    message: PlatformMessage,
): Promise<{ forwardAsMessage?: string } | void> {
    const chatId = message.channel.id;

    if (!deps.sessionStateStore) {
        await message.reply({ text: 'Session state not available.' }).catch(logger.error);
        return;
    }

    const current = deps.sessionStateStore.getInspect(chatId);
    const next = !current;
    deps.sessionStateStore.setInspect(chatId, next);

    const emoji = next ? '🔍' : '💤';
    const label = next ? 'ON' : 'OFF';
    const detail = next
        ? 'Each response will be analyzed for TG ↔ Antigravity diffs. Auto-fix enabled.'
        : 'Inspect mode disabled.';

    logger.info(`[TelegramCommand:inspect] inspect=${next} (chat=${chatId})`);
    await message.reply({ text: `${emoji} Inspect: <b>${label}</b>\n${detail}` }).catch(logger.error);
}

async function handleSession(deps: TelegramCommandDeps, message: PlatformMessage): Promise<void> {
    if (!deps.chatSessionService || !deps.telegramBindingRepo || !deps.sessionStateStore) {
        await message.reply({ text: 'History session picker is not available.' }).catch(logger.error);
        return;
    }

    await handleTelegramJoinCommand({
        bridge: deps.bridge,
        telegramBindingRepo: deps.telegramBindingRepo,
        workspaceService: deps.workspaceService,
        chatSessionService: deps.chatSessionService,
        sessionStateStore: deps.sessionStateStore,
        activeMonitors: deps.activeMonitors,
    }, message);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Schedule command handlers
// ---------------------------------------------------------------------------

async function handleScheduleList(deps: TelegramCommandDeps, message: PlatformMessage): Promise<void> {
    if (!deps.scheduleService) {
        await message.reply({ text: 'Schedule service not available.' }).catch(logger.error);
        return;
    }

    const schedules = deps.scheduleService.listSchedules();
    if (schedules.length === 0) {
        await message.reply({ text: '📅 No scheduled tasks. Use /schedule_add to create one.' }).catch(logger.error);
        return;
    }

    const lines = [
        '<b>📅 Scheduled Tasks</b>',
        '',
        ...schedules.map((s) => {
            const status = s.enabled ? '✅' : '⏸️';
            const workspace = s.workspacePath.split(/[\\/]/).pop() || s.workspacePath;
            return `${status} <b>#${s.id}</b> <code>${escapeHtml(s.cronExpression)}</code>\n   ${escapeHtml(s.prompt.slice(0, 100))}${s.prompt.length > 100 ? '...' : ''}\n   📁 ${escapeHtml(workspace)}`;
        }),
        '',
        'Use /schedule_remove &lt;id&gt; to delete.',
    ];

    const text = lines.join('\n');
    const truncated = text.length > 4096 ? text.slice(0, 4090) + '\n...' : text;
    await message.reply({ text: truncated }).catch(logger.error);
}

async function handleScheduleAdd(deps: TelegramCommandDeps, message: PlatformMessage, args: string): Promise<void> {
    if (!deps.scheduleService) {
        await message.reply({ text: 'Schedule service not available.' }).catch(logger.error);
        return;
    }

    // Parse: first 5 cron fields, then the rest is the prompt
    // e.g. "0 9 * * * run the daily report"
    const parts = args.trim().split(/\s+/);
    if (parts.length < 6) {
        await message.reply({
            text: 'Usage: /schedule_add &lt;cron expression&gt; &lt;prompt&gt;\nExample: /schedule_add 0 9 * * * Run the daily standup report',
        }).catch(logger.error);
        return;
    }

    const cronExpression = parts.slice(0, 5).join(' ');
    const prompt = parts.slice(5).join(' ');

    // Resolve workspace binding for this chat
    const chatId = message.channel.id;
    const binding = deps.telegramBindingRepo?.findByChatId(chatId);
    if (!binding) {
        await message.reply({
            text: 'No project is linked to this chat. Use /project to bind a workspace first.',
        }).catch(logger.error);
        return;
    }

    const workspacePath = deps.workspaceService
        ? deps.workspaceService.getWorkspacePath(binding.workspacePath)
        : binding.workspacePath;

    try {
        const jobCallback = deps.scheduleJobCallback;
        if (!jobCallback) {
            await message.reply({ text: 'Schedule execution callback not configured.' }).catch(logger.error);
            return;
        }

        const record = deps.scheduleService.addSchedule(
            cronExpression,
            prompt,
            workspacePath,
            jobCallback,
        );

        await message.reply({
            text: `✅ Schedule #${record.id} created.\n<code>${escapeHtml(cronExpression)}</code> → ${escapeHtml(prompt.slice(0, 100))}`,
        }).catch(logger.error);
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('[TelegramCommand:schedule_add]', errMsg);
        await message.reply({
            text: `Failed to add schedule: ${escapeHtml(errMsg || 'unknown error')}`,
        }).catch(logger.error);
    }
}

async function handleScheduleRemove(deps: TelegramCommandDeps, message: PlatformMessage, args: string): Promise<void> {
    if (!deps.scheduleService) {
        await message.reply({ text: 'Schedule service not available.' }).catch(logger.error);
        return;
    }

    const id = parseInt(args.trim(), 10);
    if (isNaN(id)) {
        await message.reply({
            text: 'Usage: /schedule_remove &lt;id&gt;\nUse /schedule to see available schedule IDs.',
        }).catch(logger.error);
        return;
    }

    const removed = deps.scheduleService.removeSchedule(id);
    if (removed) {
        await message.reply({ text: `🗑️ Schedule #${id} removed.` }).catch(logger.error);
    } else {
        await message.reply({ text: `Schedule #${id} not found.` }).catch(logger.error);
    }
}

/**
 * Send a MessagePayload that contains file attachments.
 * Falls back to a text reply if file sending is not supported.
 */
async function sendFilePayload(message: PlatformMessage, payload: MessagePayload): Promise<void> {
    // Try sending with files — the Telegram adapter supports this if sendPhoto is available
    try {
        await message.reply(payload);
    } catch (err: unknown) {
        logger.warn('[TelegramCommand:screenshot] File sending failed:', err instanceof Error ? err.message : err);
        await message.reply({ text: 'Screenshot captured but file sending failed.' }).catch(logger.error);
    }
}
