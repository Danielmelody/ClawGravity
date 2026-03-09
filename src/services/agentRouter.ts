import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import type { ExtractionMode } from '../utils/config';
import { CdpConnectionPool } from './cdpConnectionPool';
import { ChatSessionService } from './chatSessionService';
import { GrpcResponseMonitor } from './grpcResponseMonitor';
import { WorkspaceRuntime } from './workspaceRuntime';
import { WorkspaceService } from './workspaceService';

/**
 * A task to be delegated to a sub-agent.
 */
export interface SubAgentTask {
    /** Parent agent's project name */
    parentAgent: string;
    /** Target sub-agent's project name */
    targetAgent: string;
    /** Task description / instructions for the sub-agent */
    task: string;
}

/**
 * Result of a sub-agent task execution.
 *
 * Follows the standard sub-agent pattern:
 *   - summary: concise result (injected back to parent — context-safe)
 *   - outputPath: full output saved to file (read on demand via agent_read)
 */
export interface SubAgentResult {
    ok: boolean;
    /** Concise summary extracted from the sub-agent's response (context-safe) */
    summary?: string;
    /** Path to file containing the full response */
    outputPath?: string;
    /** Total character count of the full response */
    outputLength?: number;
    /** Error description (on failure) */
    error?: string;
}

// Marker used to instruct the sub-agent and to extract the summary
const SUMMARY_MARKER = '## Summary';

/**
 * AgentRouter — delegates tasks to sub-agents (other Antigravity instances).
 *
 * Follows the standard sub-agent pattern (cf. Claude Code Task tool, Codex):
 *   1. Parent sends a scoped task to a sub-agent
 *   2. Sub-agent executes autonomously (new session, full tool access)
 *   3. Sub-agent's full output is saved to a file
 *   4. A concise summary is extracted and returned to the parent
 *   5. Parent can read the full output on demand via agent_read
 */
export class AgentRouter {
    private readonly pool: CdpConnectionPool;
    private readonly chatSessionService: ChatSessionService;
    private readonly workspaceService: WorkspaceService;
    private readonly extractionMode: ExtractionMode;
    private readonly responseDir: string;
    private readonly responseTimeoutMs: number;

    constructor(options: {
        pool: CdpConnectionPool;
        chatSessionService: ChatSessionService;
        workspaceService: WorkspaceService;
        extractionMode?: ExtractionMode;
        responseTimeoutMs?: number;
        responseDir?: string;
    }) {
        this.pool = options.pool;
        this.chatSessionService = options.chatSessionService;
        this.workspaceService = options.workspaceService;
        this.extractionMode = options.extractionMode ?? 'structured';
        this.responseTimeoutMs = options.responseTimeoutMs ?? 300_000;

        this.responseDir = options.responseDir
            ?? path.join(options.workspaceService.getBaseDir(), 'agent_responses');
        if (!fs.existsSync(this.responseDir)) {
            fs.mkdirSync(this.responseDir, { recursive: true });
        }
    }

    /**
     * List all available sub-agents.
     */
    listAgents(): string[] {
        const connected = new Set(this.pool.getActiveWorkspaceNames());
        try {
            for (const name of this.workspaceService.scanWorkspaces()) {
                connected.add(name);
            }
        } catch (err: any) {
            logger.debug(`[AgentRouter] Workspace scan failed: ${err?.message}`);
        }
        return [...connected].sort();
    }

    /**
     * Delegate a task to a sub-agent and wait for the result.
     *
     * The sub-agent executes the task in an isolated session.
     * Its full output is saved to a file; a concise summary is extracted
     * and returned for the parent agent to consume without context explosion.
     */
    async delegateTask(task: SubAgentTask): Promise<SubAgentResult> {
        const { parentAgent, targetAgent, task: taskDescription } = task;

        logger.info(`[AgentRouter] Delegating task to "${targetAgent}" from "${parentAgent}" (${taskDescription.length} chars)`);

        // 1. Resolve & validate target workspace
        let targetPath: string;
        try {
            targetPath = this.workspaceService.getWorkspacePath(targetAgent);
        } catch (err: any) {
            return { ok: false, error: `Cannot resolve workspace for "${targetAgent}": ${err?.message}` };
        }

        if (!this.workspaceService.exists(targetAgent)) {
            return { ok: false, error: `Sub-agent workspace "${targetAgent}" does not exist` };
        }

        // 2. Connect to the sub-agent's Antigravity instance
        let runtime: WorkspaceRuntime;
        try {
            runtime = this.pool.getOrCreateRuntime(targetPath);
            await runtime.ready();
        } catch (err: any) {
            return {
                ok: false,
                error: `Cannot connect to sub-agent "${targetAgent}". Is Antigravity open? Error: ${err?.message}`,
            };
        }

        // 3. Isolate: open a new chat session
        try {
            const newChat = await runtime.startNewChat(this.chatSessionService);
            if (newChat.ok) {
                logger.debug(`[AgentRouter] New session opened on "${targetAgent}"`);
                await new Promise(r => setTimeout(r, 1500));
            } else {
                logger.warn(`[AgentRouter] Could not open new session on "${targetAgent}": ${newChat.error}`);
            }
        } catch (err: any) {
            logger.warn(`[AgentRouter] New session failed on "${targetAgent}": ${err?.message}`);
        }

        // 4. Build task prompt (instructs sub-agent to end with ## Summary)
        const prompt = this.buildTaskPrompt(parentAgent, taskDescription);

        // 5. Inject into sub-agent
        const injectResult = await runtime.sendPrompt({ text: prompt });
        if (!injectResult.ok) {
            return { ok: false, error: `Failed to inject task into "${targetAgent}": ${injectResult.error}` };
        }

        logger.info(`[AgentRouter] Task injected into "${targetAgent}" — waiting for completion...`);

        // 6. Wait for response, extract summary, save full output
        try {
            const fullResponse = await this.waitForResponse(runtime, prompt, injectResult.cascadeId);
            if (!fullResponse) {
                return { ok: false, error: `Sub-agent "${targetAgent}" returned an empty response` };
            }

            const outputPath = this.saveOutput(targetAgent, fullResponse);
            const summary = this.extractSummary(fullResponse);

            logger.done(`[AgentRouter] Task completed by "${targetAgent}" — summary: ${summary.length} chars, full: ${fullResponse.length} chars`);

            return {
                ok: true,
                summary,
                outputPath,
                outputLength: fullResponse.length,
            };
        } catch (err: any) {
            return { ok: false, error: `Task execution failed for "${targetAgent}": ${err?.message}` };
        }
    }

    /**
     * Build the task prompt for a sub-agent.
     *
     * Follows the sub-agent pattern:
     * - Clearly scoped task description
     * - Instruction to end with a concise ## Summary section
     * - Parent context for attribution
     */
    buildTaskPrompt(parentAgent: string, taskDescription: string): string {
        return [
            `[Sub-Agent Task — delegated by: ${parentAgent}]`,
            '',
            taskDescription,
            '',
            '---',
            'IMPORTANT: When you have completed this task, you MUST end your response with a concise summary section:',
            '',
            '## Summary',
            '(Write 2-5 sentences summarizing what you did and the key findings/results.)',
            '',
            `This summary will be relayed back to ${parentAgent}. The full response is saved separately.`,
        ].join('\n');
    }

    /**
     * Extract the ## Summary section from a sub-agent's response.
     * Falls back to the last ~500 chars if no Summary section is found.
     */
    extractSummary(response: string): string {
        // Try to find ## Summary section
        const markerIdx = response.lastIndexOf(SUMMARY_MARKER);
        if (markerIdx !== -1) {
            const afterMarker = response.slice(markerIdx + SUMMARY_MARKER.length).trim();
            // Take everything after ## Summary until the next ## heading or end
            const nextHeading = afterMarker.search(/\n## /);
            const summaryText = nextHeading !== -1
                ? afterMarker.slice(0, nextHeading).trim()
                : afterMarker.trim();

            if (summaryText.length > 0) {
                return summaryText.length > 1000
                    ? summaryText.slice(0, 1000) + '...'
                    : summaryText;
            }
        }

        logger.debug('[AgentRouter] No ## Summary found');
        return '';
    }

    /**
     * Save the full sub-agent output to a timestamped file.
     */
    private saveOutput(agentName: string, response: string): string {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const fileName = `${timestamp}_${safeName}.md`;
        const filePath = path.join(this.responseDir, fileName);

        const content = [
            `# Sub-Agent Output: ${agentName}`,
            `> Task completed at ${new Date().toLocaleString()}`,
            '',
            response,
        ].join('\n');

        fs.writeFileSync(filePath, content, 'utf-8');
        return filePath;
    }

    /**
     * Wait for the sub-agent to complete its response.
     */
    private async waitForResponse(
        runtime: WorkspaceRuntime,
        expectedUserMessage?: string,
        preferredCascadeId?: string,
    ): Promise<string | null> {
        const target = await runtime.getMonitoringTarget(preferredCascadeId);
        if (!target) {
            throw new Error('gRPC monitor unavailable for sub-agent response');
        }

        return new Promise((resolve, reject) => {
            const monitorConfig = {
                onComplete: (finalText: string) => resolve(finalText?.trim() || null),
                onTimeout: (lastText: string) => {
                    logger.warn(`[AgentRouter] Sub-agent response timed out`);
                    resolve(lastText?.trim() || null);
                },
            };

            const monitor = new GrpcResponseMonitor({
                grpcClient: target.grpcClient,
                cascadeId: target.cascadeId,
                maxDurationMs: this.responseTimeoutMs,
                expectedUserMessage,
                ...monitorConfig
            });

            try {
                monitor.start();
            } catch (err) {
                reject(err);
            }
        });
    }
}
