import * as fs from 'fs';
import * as path from 'path';

import { logger } from '../utils/logger';

const GEMINI_MD_CONTENT = [
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
    '**CLAW.md** - your persistent memory file. Read/write freely.',
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
    '- Only read when you need the full content - the preview may be sufficient.',
    '',
    '## Important Rules',
    '',
    '- Each scheduled task opens a **new session** - no conversation history carries over',
    '- Always read CLAW.md at the start of a scheduled task to restore context',
    '- Write important state back to CLAW.md before your response ends',
    '- This workspace is separate from the user\'s coding projects',
    '',
].join('\n');

const HEARTBEAT_MD_CONTENT = [
    '# 🦞 Heartbeat Checklist',
    '',
    '> This checklist runs on each heartbeat. Edit it to customize your periodic tasks.',
    '',
    '- [ ] Read CLAW.md for any pending tasks or reminders',
    '- [ ] Check if there are any new files or changes in this workspace',
    '- [ ] If nothing needs attention, reply with HEARTBEAT_OK',
    '',
].join('\n');

const CLAW_MD_CONTENT = [
    '# 🦞 Claw Agent Memory',
    '',
    '> Persistent memory across scheduled tasks and sessions.',
    '> Write here to remember things between tasks.',
    '',
    '## Notes',
    '',
    '_No entries yet._',
    '',
].join('\n');

export interface PrepareClawWorkspaceOptions {
    readonly clawWorkspacePath: string;
    readonly enabledScheduleCount: number;
}

function ensureTextFile(filePath: string, content: string, label: string): void {
    if (fs.existsSync(filePath)) {
        return;
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    logger.info(`[Claw] Created ${label}: ${filePath}`);
}

async function ensureDedicatedClawInstance(
    clawWorkspacePath: string,
    enabledScheduleCount: number,
): Promise<void> {
    if (enabledScheduleCount === 0) {
        logger.debug('[Claw] No enabled schedules - skipping dedicated Antigravity auto-launch');
        return;
    }

    logger.info(
        `[Claw] ${enabledScheduleCount} enabled schedule(s) found - ensuring Antigravity has agent workspace...`,
    );

    const http = await import('http');
    const net = await import('net');
    const { spawn } = await import('child_process');
    const { CDP_PORTS } = await import('../utils/cdpPorts');
    const { getAntigravityCliPath } = await import('../utils/pathUtils');

    const clawProjectName = path.basename(clawWorkspacePath);
    const checkPort = (port: number): Promise<boolean> =>
        new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
                let data = '';
                res.on('data', (chunk: string) => {
                    data += chunk;
                });
                res.on('end', () => {
                    try {
                        const tabs = JSON.parse(data) as Array<{ type: string; url?: string; title?: string }>;
                        resolve(
                            tabs
                                .filter((tab) => tab.type === 'page' && tab.url?.includes('workbench'))
                                .some((tab) => (tab.title || '').includes(clawProjectName)),
                        );
                    } catch {
                        resolve(false);
                    }
                });
            });
            req.on('error', () => resolve(false));
            req.setTimeout(2000, () => {
                req.destroy();
                resolve(false);
            });
        });

    for (const port of CDP_PORTS) {
        if (await checkPort(port)) {
            logger.info(`[Claw] "${clawProjectName}" workspace already open on CDP port ${port}`);
            return;
        }
    }

    const isPortFree = (port: number): Promise<boolean> =>
        new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => {
                server.close(() => resolve(true));
            });
            server.listen(port, '127.0.0.1');
        });

    let freePort: number | null = null;
    for (const port of CDP_PORTS) {
        if (await isPortFree(port)) {
            freePort = port;
            break;
        }
    }

    if (!freePort) {
        logger.warn(
            `[Claw] No free CDP port available to auto-launch "${clawProjectName}" workspace. Scheduled tasks may fail.`,
        );
        return;
    }

    logger.info(`[Claw] Launching Antigravity for "${clawProjectName}" workspace on CDP port ${freePort}...`);
    try {
        const child = spawn(
            getAntigravityCliPath(),
            [`--remote-debugging-port=${freePort}`, clawWorkspacePath],
            { stdio: 'ignore', detached: true, shell: process.platform === 'win32' },
        );
        child.unref();
        child.once('error', (error) => {
            logger.warn(`[Claw] Failed to launch Antigravity: ${error?.message || error}`);
        });
        logger.info(`[Claw] Antigravity launched for "${clawProjectName}" workspace (port ${freePort})`);
    } catch (error: unknown) {
        logger.warn(`[Claw] Failed to auto-launch Antigravity: ${(error as Error).message || error}`);
    }
}

export async function prepareClawWorkspace(
    options: PrepareClawWorkspaceOptions,
): Promise<void> {
    const { clawWorkspacePath, enabledScheduleCount } = options;

    if (!fs.existsSync(clawWorkspacePath)) {
        fs.mkdirSync(clawWorkspacePath, { recursive: true });
        logger.info(`[Claw] Created agent workspace: ${clawWorkspacePath}`);
    }

    await ensureDedicatedClawInstance(clawWorkspacePath, enabledScheduleCount);

    const geminiMdPath = path.join(clawWorkspacePath, 'GEMINI.md');
    fs.writeFileSync(geminiMdPath, GEMINI_MD_CONTENT, 'utf-8');
    logger.debug(`[Claw] GEMINI.md written to ${geminiMdPath}`);

    ensureTextFile(path.join(clawWorkspacePath, 'HEARTBEAT.md'), HEARTBEAT_MD_CONTENT, 'heartbeat checklist');
    ensureTextFile(path.join(clawWorkspacePath, 'CLAW.md'), CLAW_MD_CONTENT, 'memory file');
}
