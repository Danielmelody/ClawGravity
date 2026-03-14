import { logger } from '../utils/logger';
import * as fs from 'fs';
import { ScheduleService } from './scheduleService';
import type { ScheduleRecord } from '../database/scheduleRepository';
import type { JobCallback } from './scheduleService';
import type { AgentRouter } from './agentRouter';
import type { CdpService } from './cdpService';

/**
 * Parsed @claw command from Antigravity's response text.
 */
export interface ClawCommand {
    action: string;           // e.g. 'schedule_add', 'schedule_list', 'schedule_remove', 'agent_send', 'agent_list'
    params: Record<string, string>;
    raw: string;              // The original matched block
}

/**
 * Result of executing a @claw command.
 */
export interface ClawCommandResult {
    command: ClawCommand;
    success: boolean;
    message: string;
}

/**
 * Regex to match @claw command blocks in Antigravity's output.
 *
 * Supported formats:
 *
 *   ```@claw
 *   action: schedule_add
 *   cron: * /3 * * * *
 *   prompt: Hello, this is ping #{count}
 *   ```
 *
 * Or inline:
 *   @claw:schedule_add cron="* /3 * * * *" prompt="Hello"
 */
const CLAW_BLOCK_REGEX = /```@claw\s*\n([\s\S]*?)```/g;
const CLAW_INLINE_REGEX = /@claw:(\w+)\s+(.+)/g;

/**
 * Parse @claw command blocks from text.
 */
export function parseClawCommands(text: string): ClawCommand[] {
    const commands: ClawCommand[] = [];

    // Parse fenced code block format
    let match;
    while ((match = CLAW_BLOCK_REGEX.exec(text)) !== null) {
        const raw = match[0];
        const body = match[1].trim();
        const params: Record<string, string> = {};
        let action = '';

        for (const line of body.split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const key = line.slice(0, colonIdx).trim().toLowerCase();
            const value = line.slice(colonIdx + 1).trim();
            if (key === 'action') {
                action = value;
            } else {
                params[key] = value;
            }
        }

        if (action) {
            commands.push({ action, params, raw });
        }
    }

    // Parse inline format: @claw:action key="value" key="value"
    CLAW_INLINE_REGEX.lastIndex = 0;
    while ((match = CLAW_INLINE_REGEX.exec(text)) !== null) {
        const raw = match[0];
        const action = match[1];
        const paramsStr = match[2];
        const params: Record<string, string> = {};

        // Parse key="value" or key=value pairs
        const paramRegex = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
        let paramMatch;
        while ((paramMatch = paramRegex.exec(paramsStr)) !== null) {
            const key = paramMatch[1].toLowerCase();
            const value = paramMatch[2] ?? paramMatch[3] ?? paramMatch[4];
            params[key] = value;
        }

        commands.push({ action, params, raw });
    }

    return commands;
}

/**
 * Check if text contains any @claw commands.
 */
export function hasClawCommands(text: string): boolean {
    return /```@claw\s*\n|@claw:\w+/.test(text);
}

/**
 * ClawCommandInterceptor — scans Antigravity's AI responses for @claw
 * directives and automatically executes them.
 *
 * This enables Antigravity to self-invoke ClawGravity features like
 * scheduled tasks by outputting structured @claw blocks in its response.
 */
export class ClawCommandInterceptor {
    private scheduleService: ScheduleService;
    private jobCallback: JobCallback;
    private clawWorkspacePath: string;
    private agentRouter?: AgentRouter;
    private cdpServiceResolver?: () => CdpService | null;
    /** Callback invoked when an agent_send response is saved — injects notification back to sender. */
    private onAgentResponse?: (fromAgent: string, filePath: string, preview: string) => void;

    constructor(opts: {
        scheduleService: ScheduleService;
        jobCallback: JobCallback;
        clawWorkspacePath: string;
        agentRouter?: AgentRouter;
        cdpServiceResolver?: () => CdpService | null;
        /** Called when agent_send response is saved — inject short notification to sender. */
        onAgentResponse?: (fromAgent: string, filePath: string, preview: string) => void;
    }) {
        this.scheduleService = opts.scheduleService;
        this.jobCallback = opts.jobCallback;
        this.clawWorkspacePath = opts.clawWorkspacePath;
        this.agentRouter = opts.agentRouter;
        this.cdpServiceResolver = opts.cdpServiceResolver;
        this.onAgentResponse = opts.onAgentResponse;
    }

    /**
     * Scan response text for @claw commands and execute them.
     * Returns array of results (empty if no commands found).
     */
    async execute(responseText: string): Promise<ClawCommandResult[]> {
        if (!hasClawCommands(responseText)) return [];

        const commands = parseClawCommands(responseText);
        if (commands.length === 0) return [];

        logger.info(`[ClawInterceptor] Found ${commands.length} @claw command(s) in AI response`);

        const results: ClawCommandResult[] = [];
        for (const cmd of commands) {
            const result = await this.executeCommand(cmd);
            results.push(result);
        }
        return results;
    }

    private async executeCommand(cmd: ClawCommand): Promise<ClawCommandResult> {
        try {
            switch (cmd.action) {
                case 'schedule_add':
                    return this.handleScheduleAdd(cmd);
                case 'schedule_list':
                    return this.handleScheduleList(cmd);
                case 'schedule_remove':
                    return this.handleScheduleRemove(cmd);
                case 'agent_list':
                    return this.handleAgentList(cmd);
                case 'agent_send':
                    return await this.handleAgentSend(cmd);
                case 'agent_read':
                    return this.handleAgentRead(cmd);
                case 'gateway_restart':
                    return await this.handleGatewayRestart(cmd);
                default:
                    return {
                        command: cmd,
                        success: false,
                        message: `Unknown @claw action: ${cmd.action}`,
                    };
            }
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[ClawInterceptor] Error executing @claw:${cmd.action}:`, errMsg);
            return {
                command: cmd,
                success: false,
                message: `Error: ${errMsg}`,
            };
        }
    }

    private handleScheduleAdd(cmd: ClawCommand): ClawCommandResult {
        const cron = cmd.params.cron;
        const prompt = cmd.params.prompt;

        if (!cron || !prompt) {
            return {
                command: cmd,
                success: false,
                message: 'Missing required params: cron and prompt',
            };
        }

        const record = this.scheduleService.addSchedule(
            cron,
            prompt,
            this.clawWorkspacePath,
            this.jobCallback,
        );

        logger.done(`[ClawInterceptor] Schedule #${record.id} created: "${cron}" → "${prompt.slice(0, 60)}..."`);
        return {
            command: cmd,
            success: true,
            message: `Schedule #${record.id} created (${cron})`,
        };
    }

    private handleScheduleList(cmd: ClawCommand): ClawCommandResult {
        const schedules = this.scheduleService.listSchedules();
        const list = schedules
            .map((s: ScheduleRecord) => `#${s.id}: [${s.cronExpression}] ${s.prompt.slice(0, 50)}`)
            .join('\n');

        return {
            command: cmd,
            success: true,
            message: schedules.length > 0 ? `Active schedules:\n${list}` : 'No active schedules',
        };
    }

    private handleScheduleRemove(cmd: ClawCommand): ClawCommandResult {
        const id = parseInt(cmd.params.id, 10);
        if (isNaN(id)) {
            return {
                command: cmd,
                success: false,
                message: 'Missing or invalid param: id (must be a number)',
            };
        }

        const removed = this.scheduleService.removeSchedule(id);
        return {
            command: cmd,
            success: removed,
            message: removed ? `Schedule #${id} removed` : `Schedule #${id} not found`,
        };
    }

    private handleAgentList(cmd: ClawCommand): ClawCommandResult {
        if (!this.agentRouter) {
            return {
                command: cmd,
                success: false,
                message: 'Agent router is not available. Multi-agent communication is not configured.',
            };
        }

        const agents = this.agentRouter.listAgents();
        const list = agents.length > 0
            ? agents.map(name => `• ${name}`).join('\n')
            : '(none)';

        logger.info(`[ClawInterceptor] agent_list: ${agents.length} agent(s) available`);
        return {
            command: cmd,
            success: true,
            message: `Available agents (${agents.length}):\n${list}`,
        };
    }

    private async handleAgentSend(cmd: ClawCommand): Promise<ClawCommandResult> {
        if (!this.agentRouter) {
            return {
                command: cmd,
                success: false,
                message: 'Agent router is not available. Multi-agent communication is not configured.',
            };
        }

        const to = cmd.params.to;
        const message = cmd.params.message || cmd.params.task;

        if (!to || !message) {
            return {
                command: cmd,
                success: false,
                message: 'Missing required params: to and message',
            };
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const parentAgent = require('path').basename(this.clawWorkspacePath);

        logger.info(`[ClawInterceptor] agent_send: "${parentAgent}" → "${to}" (${message.length} chars)`);

        const result = await this.agentRouter.delegateTask({
            parentAgent,
            targetAgent: to,
            task: message,
        });

        if (result.ok && result.summary) {
            // Relay the summary back to the parent agent
            if (this.onAgentResponse) {
                this.onAgentResponse(to, result.summary, result.outputPath ?? '');
            }

            logger.done(`[ClawInterceptor] Sub-agent "${to}" completed — summary: ${result.summary.length} chars`);
            return {
                command: cmd,
                success: true,
                message: [
                    `[Task completed by ${to}]`,
                    '',
                    result.summary,
                    '',
                    `Full output (${result.outputLength} chars): ${result.outputPath}`,
                ].join('\n'),
            };
        } else {
            return {
                command: cmd,
                success: false,
                message: result.error || `Sub-agent "${to}" failed to complete the task`,
            };
        }
    }

    private handleAgentRead(cmd: ClawCommand): ClawCommandResult {
        const filePath = cmd.params.file || cmd.params.path;

        if (!filePath) {
            return {
                command: cmd,
                success: false,
                message: 'Missing required param: file (path to response file)',
            };
        }

        try {
            if (!fs.existsSync(filePath)) {
                return {
                    command: cmd,
                    success: false,
                    message: `Response file not found: ${filePath}`,
                };
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            logger.info(`[ClawInterceptor] agent_read: ${filePath} (${content.length} chars)`);
            return {
                command: cmd,
                success: true,
                message: content,
            };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return {
                command: cmd,
                success: false,
                message: `Failed to read response file: ${errMsg}`,
            };
        }
    }

    private async handleGatewayRestart(cmd: ClawCommand): Promise<ClawCommandResult> {
        const cdpService = this.cdpServiceResolver?.();
        if (!cdpService) {
            return {
                command: cmd,
                success: false,
                message: 'Gateway restart not available: CdpService is not configured or no active workspace.',
            };
        }

        logger.info('[ClawInterceptor] gateway_restart: executing full gateway restart...');
        const result = await cdpService.resetGateway();
        const stepsText = result.steps.join('; ');

        return {
            command: cmd,
            success: result.ok,
            message: result.ok
                ? `Gateway restarted successfully: ${stepsText}`
                : `Gateway restart partial: ${stepsText}${result.error ? ` Error: ${result.error}` : ''}`,
        };
    }
}
