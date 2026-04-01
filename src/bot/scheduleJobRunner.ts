import * as path from 'path';

import type { ScheduleRecord } from '../database/scheduleRepository';
import {
    CdpBridge,
    ensureWorkspaceRuntime,
} from '../services/cdpBridgeManager';
import { ChatSessionService } from '../services/chatSessionService';
import type { ClawCommandInterceptor } from '../services/clawCommandInterceptor';
import { CdpService } from '../services/cdpService';
import { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import { logger } from '../utils/logger';

export interface CreateScheduleJobCallbackOptions {
    readonly bridge: CdpBridge;
    readonly chatSessionService: ChatSessionService;
    readonly clawWorkspacePath: string;
    readonly getTelegramNotify: () => ((text: string) => Promise<void>) | null;
    readonly getClawInterceptor: () => ClawCommandInterceptor | null;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isAntigravityBusy(cdp: CdpService): Promise<boolean> {
    try {
        const grpcClient = await cdp.getGrpcClient();
        const cascadeId = grpcClient ? await cdp.getActiveCascadeId() : null;
        if (!grpcClient || !cascadeId) return false;

        const trajectory = await grpcClient.rawRPC('GetCascadeTrajectory', { cascadeId }) as {
            trajectory?: { cascadeRunStatus?: string };
            status?: string;
        };
        const status = trajectory.trajectory?.cascadeRunStatus || trajectory.status || '';
        return status === 'CASCADE_RUN_STATUS_RUNNING';
    } catch {
        return false;
    }
}

async function waitForIdle(cdp: CdpService, maxWaitMs = 3600_000): Promise<boolean> {
    const checkIntervalMs = 10_000;
    const maxChecks = Math.ceil(maxWaitMs / checkIntervalMs);

    for (let i = 0; i < maxChecks; i += 1) {
        const busy = await isAntigravityBusy(cdp);
        if (!busy) return true;

        logger.debug(`[ScheduleJob] Antigravity is busy, waiting... (${i + 1}/${maxChecks})`);
        await delay(checkIntervalMs);
    }

    return false;
}

export function createScheduleJobCallback(
    options: CreateScheduleJobCallbackOptions,
): (schedule: ScheduleRecord) => Promise<void> {
    const {
        bridge,
        clawWorkspacePath,
        getTelegramNotify,
        getClawInterceptor,
    } = options;

    return async (schedule: ScheduleRecord): Promise<void> => {
        logger.info(
            `[ScheduleJob] Firing schedule #${schedule.id}: "${schedule.prompt.slice(0, 80)}..." ` +
            `-> claw-workspace=${clawWorkspacePath}`,
        );

        try {
            const prepared = await ensureWorkspaceRuntime(bridge, clawWorkspacePath);
            const cdp = prepared.cdp;
            const projectName = prepared.projectName;

            const busy = await isAntigravityBusy(cdp);
            if (busy) {
                logger.warn(`[ScheduleJob] Schedule #${schedule.id}: Claw workspace is busy - waiting for previous task...`);

                const becameIdle = await waitForIdle(cdp, 3600_000);
                if (!becameIdle) {
                    logger.error(`[ScheduleJob] Schedule #${schedule.id}: Still busy after 60min - SKIPPING`);
                    return;
                }

                logger.info(`[ScheduleJob] Schedule #${schedule.id}: Claw workspace idle - proceeding`);
                await delay(3000);
            }

            bridge.lastActiveWorkspace = projectName;

            await prepared.runtime.clearActiveCascade();
            logger.debug(`[ScheduleJob] Schedule #${schedule.id}: Prepared fresh session state`);

            const d = new Date();
            const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const svFormatter = new Intl.DateTimeFormat('sv-SE', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit',
                hour12: false, timeZone
            });
            const localTimeStr = svFormatter.format(d).replace('T', ' ');
            const utcTimeStr = d.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';

            const cronPrompt = [
                'A scheduled reminder has been triggered. The reminder content is:',
                '',
                schedule.prompt,
                '',
                'Please relay this reminder to the user in a helpful and friendly way.',
                `Current time: ${localTimeStr} (${timeZone}) / ${utcTimeStr}`
            ].join('\n');

            const injectResult = await prepared.runtime.sendPrompt({ text: cronPrompt });
            if (!injectResult.ok) {
                logger.error(`[ScheduleJob] Schedule #${schedule.id} inject failed: ${injectResult.error}`);
                return;
            }

            logger.done(`[ScheduleJob] Schedule #${schedule.id} prompt injected - monitoring response...`);

            const monitoringTarget = await prepared.runtime.getMonitoringTarget(injectResult.cascadeId);
            if (!monitoringTarget) {
                logger.error(`[ScheduleJob] Schedule #${schedule.id}: gRPC monitor unavailable`);
                const telegramNotify = getTelegramNotify();
                if (telegramNotify) {
                    await telegramNotify(`🦞 Schedule #${schedule.id} failed: gRPC monitor unavailable.`).catch(() => {});
                }
                return;
            }

            const monitor = new GrpcResponseMonitor({
                grpcClient: monitoringTarget.grpcClient,
                cascadeId: monitoringTarget.cascadeId,
                maxDurationMs: 3600_000,
                onComplete: async (finalText: string | undefined) => {
                    let outputText = finalText?.trim() || '';
                    if (outputText.length === 0) {
                        logger.warn(`[ScheduleJob] Schedule #${schedule.id}: Empty response from Antigravity`);
                        return;
                    }

                    const maxClawDepth = 3;
                    let clawDepth = 0;

                    while (true) {
                        const label = clawDepth > 0 ? ` (follow-up #${clawDepth})` : '';
                        logger.divider(`Schedule #${schedule.id} Response${label}`);
                        console.info(outputText.slice(0, 500));
                        logger.divider();

                        const telegramNotify = getTelegramNotify();
                        if (telegramNotify) {
                            const header = `🦞 <b>Schedule #${schedule.id}${label}</b>\n\n`;
                            const truncated = outputText.length > 3500 ? `${outputText.slice(0, 3500)}...` : outputText;
                            await telegramNotify(header + truncated).catch((error: unknown) => {
                                logger.error(`[ScheduleJob] Telegram notify failed:`, (error as Error).message || error);
                            });
                        }

                        const clawInterceptor = getClawInterceptor();
                        if (!clawInterceptor || clawDepth >= maxClawDepth) break;

                        const results = await clawInterceptor.execute(outputText);
                        if (results.length === 0) break;

                        for (const result of results) {
                            logger.info(
                                `[ScheduleJob] @claw:${result.command.action} -> ` +
                                `${result.success ? 'OK' : 'FAIL'}: ${result.message}`,
                            );
                        }

                        const resultLines = results.map((result) =>
                            `@claw:${result.command.action} - ${result.success ? 'OK' : 'FAIL'}\n${result.message}`,
                        );
                        const feedback = `[ClawGravity Command Results]\n\n${resultLines.join('\n\n')}`;

                        await delay(2000);
                        const followUpInjectResult = await prepared.runtime.sendPrompt({ text: feedback });
                        if (!followUpInjectResult.ok) {
                            logger.error(`[ScheduleJob] Failed to inject @claw results: ${followUpInjectResult.error}`);
                            break;
                        }

                        logger.done(
                            `[ScheduleJob] @claw results injected - awaiting follow-up (depth=${clawDepth + 1})...`,
                        );

                        const followUpTarget = await prepared.runtime.getMonitoringTarget(followUpInjectResult.cascadeId);
                        if (!followUpTarget) {
                            logger.error(
                                `[ScheduleJob] Schedule #${schedule.id}: gRPC monitor unavailable for @claw follow-up`,
                            );
                            break;
                        }

                        outputText = await new Promise<string>((resolve) => {
                            const followUp = new GrpcResponseMonitor({
                                grpcClient: followUpTarget.grpcClient,
                                cascadeId: followUpTarget.cascadeId,
                                maxDurationMs: 3600_000,
                                onComplete: async (text: string | undefined) => resolve(text?.trim() || ''),
                                onTimeout: async () => {
                                    logger.warn(
                                        `[ScheduleJob] @claw follow-up timed out (depth=${clawDepth + 1})`,
                                    );
                                    resolve('');
                                },
                            });
                            followUp.start();
                        });

                        clawDepth += 1;
                        if (outputText.length === 0) break;
                    }
                },
                onTimeout: async (lastText: string | undefined) => {
                    logger.warn(`[ScheduleJob] Schedule #${schedule.id}: Response timed out`);
                    const telegramNotify = getTelegramNotify();
                    if (telegramNotify && lastText) {
                        await telegramNotify(
                            `🦞 Schedule #${schedule.id} timed out:\n\n${lastText.slice(0, 2000)}`,
                        ).catch(() => {});
                    }
                },
            });
            monitor.start();
        } catch (error: unknown) {
            const message = (error as Error).message || String(error);
            if (message.includes('No matching') || message.includes('ECONNREFUSED') || message.includes('not found')) {
                logger.error(
                    `[ScheduleJob] Schedule #${schedule.id}: Cannot connect to "${path.basename(clawWorkspacePath)}" workspace. ` +
                    `Please open "${clawWorkspacePath}" in a separate Antigravity window.`,
                );
                return;
            }

            logger.error(`[ScheduleJob] Schedule #${schedule.id} failed:`, message);
        }
    };
}
