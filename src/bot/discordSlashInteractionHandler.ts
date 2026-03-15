import {
    ChatInputCommandInteraction,
    EmbedBuilder,
} from 'discord.js';

import { ChatCommandHandler } from '../commands/chatCommandHandler';
import { CleanupCommandHandler } from '../commands/cleanupCommandHandler';
import { JoinCommandHandler } from '../commands/joinCommandHandler';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { WorkspaceCommandHandler } from '../commands/workspaceCommandHandler';
import type { ScheduleRecord } from '../database/scheduleRepository';
import { TemplateRepository } from '../database/templateRepository';
import { UserPreferenceRepository, OutputFormat } from '../database/userPreferenceRepository';
import {
    CdpBridge,
    getCurrentCdp,
} from '../services/cdpBridgeManager';
import { AutoAcceptService } from '../services/autoAcceptService';
import { MODE_DISPLAY_NAMES, ModeService } from '../services/modeService';
import { ScheduleService } from '../services/scheduleService';
import { restartCurrentProcess } from '../services/processRestartService';
import { logBuffer } from '../utils/logBuffer';
import type { LogLevel } from '../utils/logger';
import { formatAsPlainText } from '../utils/plainTextFormatter';
import { sendAutoAcceptUI } from '../ui/autoAcceptUi';
import { sendModeUI } from '../ui/modeUi';
import { sendModelsUI } from '../ui/modelsUi';
import { sendOutputUI } from '../ui/outputUi';
import { handleScreenshot } from '../ui/screenshotUi';
import { sendTemplateUI } from '../ui/templateUi';
import { t } from '../utils/i18n';

export interface ActivePromptSessionHandle {
    stopByUser(): Promise<boolean>;
}

export interface DiscordSlashInteractionDeps {
    interaction: ChatInputCommandInteraction;
    slashCommandHandler: SlashCommandHandler;
    bridge: CdpBridge;
    wsHandler: WorkspaceCommandHandler;
    chatHandler: ChatCommandHandler;
    cleanupHandler: CleanupCommandHandler;
    modeService: ModeService;
    autoAcceptService: AutoAcceptService;
    templateRepo: TemplateRepository;
    joinHandler?: JoinCommandHandler;
    userPrefRepo?: UserPreferenceRepository;
    scheduleService?: ScheduleService;
    scheduleJobCallback?: (schedule: ScheduleRecord) => void;
    activePromptSessions: Map<string, ActivePromptSessionHandle>;
}

export async function handleDiscordSlashInteraction(
    deps: DiscordSlashInteractionDeps,
): Promise<void> {
    const {
        interaction,
        slashCommandHandler,
        bridge,
        wsHandler,
        chatHandler,
        cleanupHandler,
        modeService,
        autoAcceptService,
        templateRepo,
        joinHandler,
        userPrefRepo,
        scheduleService,
        scheduleJobCallback,
        activePromptSessions,
    } = deps;
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

            const result = await slashCommandHandler.handleCommand('template', args);
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
            const activeSession = activePromptSessions.get(interaction.channelId);
            if (!activeSession) {
                await interaction.editReply({ content: '⚠️ No active generation is running in this channel.' });
                break;
            }

            try {
                const stopped = await activeSession.stopByUser();
                activePromptSessions.delete(interaction.channelId);

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
