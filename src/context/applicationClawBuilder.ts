import { Effect } from 'effect';

import type { ScheduleRecord } from '../database/scheduleRepository';
import type { AgentRouter } from '../services/agentRouter';
import { AgentRouter as AgentRouterImpl } from '../services/agentRouter';
import type { ClawCommandInterceptor } from '../services/clawCommandInterceptor';
import { ClawCommandInterceptor as ClawCommandInterceptorImpl } from '../services/clawCommandInterceptor';
import { getCurrentCdp } from '../services/cdpBridgeManager';
import type { ExtractionMode } from '../utils/config';
import {
    ApplicationContext,
    ApplicationContextTag,
} from './applicationContext';
import { createScheduleJobCallback } from '../bot/scheduleJobRunner';

export interface BuildClawRuntimeOptions {
    readonly extractionMode: ExtractionMode;
    readonly clawWorkspacePath: string;
    readonly getTelegramNotify: () => ((text: string) => Promise<void>) | null;
}

export interface ClawRuntimeArtifacts {
    readonly scheduleJobCallback: (schedule: ScheduleRecord) => Promise<void>;
    readonly clawInterceptor: ClawCommandInterceptor;
    readonly agentRouter: AgentRouter;
}

export async function buildClawRuntimeArtifacts(
    context: ApplicationContext,
    options: BuildClawRuntimeOptions,
): Promise<ClawRuntimeArtifacts> {
    return Effect.runPromise(
        Effect.gen(function* () {
            const ctx = yield* ApplicationContextTag;

            let clawInterceptor: ClawCommandInterceptor | null = null;
            const scheduleJobCallback = createScheduleJobCallback({
                bridge: ctx.bridge,
                chatSessionService: ctx.chatSessionService,
                clawWorkspacePath: options.clawWorkspacePath,
                getTelegramNotify: options.getTelegramNotify,
                getClawInterceptor: () => clawInterceptor,
            });

            const agentRouter = new AgentRouterImpl({
                pool: ctx.bridge.pool,
                chatSessionService: ctx.chatSessionService,
                workspaceService: ctx.workspaceService,
                extractionMode: options.extractionMode,
            });

            clawInterceptor = new ClawCommandInterceptorImpl({
                scheduleService: ctx.scheduleService,
                jobCallback: scheduleJobCallback,
                clawWorkspacePath: options.clawWorkspacePath,
                agentRouter,
                cdpServiceResolver: () => getCurrentCdp(ctx.bridge),
                onAgentResponse: async (fromAgent: string, summary: string, outputPath: string) => {
                    try {
                        const activeWorkspace = ctx.bridge.lastActiveWorkspace;
                        if (!activeWorkspace) {
                            return;
                        }

                        const runtime = ctx.bridge.pool.getOrCreateRuntime(
                            ctx.workspaceService.getWorkspacePath(activeWorkspace),
                        );
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
                    } catch {
                        // Surface only via interceptor flow; startup composition stays side-effect free.
                    }
                },
            });

            return {
                scheduleJobCallback,
                clawInterceptor,
                agentRouter,
            } satisfies ClawRuntimeArtifacts;
        }).pipe(
            Effect.provideService(ApplicationContextTag, context),
        ),
    );
}
