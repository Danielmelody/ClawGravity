/**
 * PromptSession — encapsulates the complex state and logic of a single interaction
 * with Antigravity, including UI rendering, status updates, and cleanup.
 *
 * This replaces the giant closure in bot/index.ts:sendPromptToAntigravity
 */

import { Message, EmbedBuilder } from 'discord.js';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { CdpService } from '../services/cdpService';
import { ModeService } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { ChatSessionService } from '../services/chatSessionService';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { ChannelManager } from '../services/channelManager';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { UserPreferenceRepository, OutputFormat } from '../database/userPreferenceRepository';
import { ExtractionMode } from '../utils/config';
import { buildEmbedDescriptions } from '../utils/discordFormatter';
import { t } from '../utils/i18n';
import { LiveEmbedTrack } from './liveEmbedTrack';
import { GrpcResponseMonitor } from '../services/grpcResponseMonitor';
import { createCoalescedRenderScheduler, type RenderScheduler } from './coalescedRenderScheduler';
import { renderStepsToDiscordMarkdown } from '../services/trajectoryStepRenderer';
import { escapeHtml } from '../platform/telegram/trajectoryRenderer';
import type { Logger } from '../utils/logger';

export interface PromptOptions {
    chatSessionService?: ChatSessionService;
    chatSessionRepo?: ChatSessionRepository;
    channelManager?: ChannelManager;
    titleGenerator?: TitleGeneratorService;
    userPrefRepo?: UserPreferenceRepository;
    extractionMode?: ExtractionMode;
    onFullCompletion?: () => void;
}

export interface PromptSessionDependencies {
    message: Message;
    prompt: string;
    cdp: CdpService;
    modeService: ModeService;
    modelService: ModelService;
    inboundImages?: { url: string; mimeType: string; localPath?: string }[];
    options?: PromptOptions;
    
    // Inject the enqueue queues to avoid global state if possible,
    // but for now we'll accept them or import them.
    enqueueGeneral: (task: () => Promise<void>, label?: string) => Promise<void>;
    enqueueResponse: (task: () => Promise<void>, label?: string) => Promise<void>;
    enqueueActivity: (task: () => Promise<void>, label?: string) => Promise<void>;
    telemetryModeName: string;
    telemetryModelName: string;
    logger: Logger;
    
    // Config values needed for the session
    config: {
        autoRenameThreshold: number;
        coalesceMs: number;
    };
    
    // Actions
    autoRenameChannel: (newTitle: string) => Promise<void>;
    tryEmergencyExtractText: (cdp: CdpService, currentFinal: string, logger: unknown) => Promise<string>;
    userStopRequestedChannels: Set<string>;
    
    // Global notification
    telegramNotify?: ((text: string) => Promise<void>) | null;
}

export class PromptSession {
    private isFinalized = false;
    private completionSignaled = false;
    private stopRequested = false;
    private hasInitialRender = false;
    private startTime: number;
    
    // Live Tracks
    private responseTrack: LiveEmbedTrack;
    private activityTrack: LiveEmbedTrack;
    
    // Outputs
    private finalResponse = '';
    private finalActivity = '';
    private latestRenderedActivityText = '';
    private currentMode: string;
    private currentModel: string;
    private outputFormat: OutputFormat = 'embed';
    
    // Schedulers
    private responseScheduler!: RenderScheduler<{ text: string; force?: boolean }>;
    private activityScheduler!: RenderScheduler<{ text: string; force?: boolean; isFinal?: boolean }>;
    
    // Grpc
    private monitor: GrpcResponseMonitor | null = null;
    
    private readonly MAX_EMBED_LENGTH = 4096;

    constructor(private deps: PromptSessionDependencies) {
        this.startTime = Date.now();
        this.currentMode = this.deps.modeService.getCurrentMode();
        this.currentModel = this.deps.modelService.getCurrentModel();
        
        if (this.deps.options?.userPrefRepo) {
            this.outputFormat = this.deps.options.userPrefRepo.getOutputFormat(this.deps.message.author.id);
        }

        this.responseTrack = new LiveEmbedTrack({
            maxDescriptionLen: this.MAX_EMBED_LENGTH,
            buildDescriptions: (text: string) => buildEmbedDescriptions(text, this.MAX_EMBED_LENGTH),
            enqueue: this.deps.enqueueResponse,
        });

        this.activityTrack = new LiveEmbedTrack({
            maxDescriptionLen: this.MAX_EMBED_LENGTH,
            buildDescriptions: (text: string) => buildEmbedDescriptions(text, this.MAX_EMBED_LENGTH),
            enqueue: this.deps.enqueueActivity,
        });

        this.setupSchedulers();
    }

    private setupSchedulers() {
        this.responseScheduler = createCoalescedRenderScheduler<{ text: string; force?: boolean }>(
            async ({ text, force }: { text: string; force?: boolean }) => {
                if (this.isFinalized && !force) return;
                const v = force ? this.responseTrack.version : this.responseTrack.bumpVersion();
                const safeText = text || '...';
                const footerText = this.isFinalized 
                    ? `Phase: Idle | Model: ${this.currentModel} | Mode: ${this.deps.telemetryModeName}`
                    : `Phase: Generating... | Model: ${this.currentModel} | Mode: ${this.deps.telemetryModeName}`;
                
                await this.responseTrack.upsert(
                    this.deps.message.channel as { send: (...args: unknown[]) => Promise<unknown> },
                    this.outputFormat,
                    this.isFinalized,
                    t('bot.embed.live.title'),
                    safeText,
                    0x3498DB,
                    footerText,
                    { source: 'sched:response', expectedVersion: v }
                );
            },
            this.deps.config.coalesceMs
        );

        this.activityScheduler = createCoalescedRenderScheduler<{ text: string; force?: boolean; isFinal?: boolean }>(
            async ({ text, force, isFinal }: { text: string; force?: boolean; isFinal?: boolean }) => {
                if (this.outputFormat === 'plain') return; // Activity is embed-only
                if (this.isFinalized && !force) return;
                const v = force ? this.activityTrack.version : this.activityTrack.bumpVersion();
                if (!text.trim() && !force) return;
                
                let safeText = text.trim();
                let title = 'Working...';
                let color = 0xF1C40F; // YELLOW

                if (isFinal) {
                    title = 'Action Completed';
                    color = 0x2ECC71; // GREEN
                    if (!safeText) safeText = 'The requested action has been completed.';
                } else if (!safeText) {
                    safeText = 'Waiting for details from Antigravity...';
                }

                await this.activityTrack.upsert(
                    this.deps.message.channel as { send: (...args: unknown[]) => Promise<unknown> },
                    'embed', // activities are always embeds
                    this.isFinalized,
                    title,
                    safeText,
                    color,
                    'ClawGravity Activity',
                    { source: 'sched:activity', expectedVersion: v }
                );
            },
            this.deps.config.coalesceMs
        );
    }

    async execute() {
        const { message, prompt, cdp, logger } = this.deps;
        
        try {
            await message.react('🚀').catch(() => { });

            if (this.deps.options?.chatSessionRepo && this.deps.options?.titleGenerator && this.deps.message.channel.isTextBased?.()) {
                const session = this.deps.options.chatSessionRepo.findByChannelId(this.deps.message.channelId);
                // Background rename trigger based on interaction count in original code, simplifying for now
                if (session && session.displayName === t('(Untitled)')) {
                    // Auto-rename logic happens after completion now or via background process
                }
            }

            logger.info(`> Sending to model: ${this.deps.telemetryModelName}`);

            let injectResult;

            if (this.deps.inboundImages && this.deps.inboundImages.length > 0) {
                // Download images to temp files first
                const tempFiles: string[] = [];
                
                try {
                    for (let i = 0; i < this.deps.inboundImages.length; i++) {
                        const img = this.deps.inboundImages[i];
                        if ('localPath' in img && typeof (img as { localPath?: string }).localPath === 'string' && (img as { localPath?: string }).localPath) {
                            tempFiles.push((img as { localPath: string }).localPath);
                            continue;
                        }
                        const ext = img.mimeType === 'image/jpeg' ? '.jpg' : img.mimeType === 'image/png' ? '.png' : '.webp';
                        const tmpPath = path.join(os.tmpdir(), `ag_img_${Date.now()}_${i}${ext}`);
                        
                        await new Promise<void>((resolve, reject) => {
                            const file = fs.createWriteStream(tmpPath);
                            https.get(img.url, (response: import('http').IncomingMessage) => {
                                response.pipe(file);
                                file.on('finish', () => {
                                    file.close();
                                    resolve();
                                });
                            }).on('error', (err: unknown) => {
                                fs.unlink(tmpPath, () => {});
                                reject(err);
                            });
                        });
                        tempFiles.push(tmpPath);
                    }
                    
                    injectResult = await cdp.injectMessageWithImageFiles(prompt, tempFiles);
                } finally {
                    // Cleanup tmp files
                    for (const tmpPath of tempFiles) {
                        const wasProvidedByCaller = this.deps.inboundImages?.some(
                            (img) => 'localPath' in img && (img as { localPath?: string }).localPath === tmpPath,
                        );
                        if (!wasProvidedByCaller) {
                            fs.unlink(tmpPath, () => {});
                        }
                    }
                }
            } else {
                injectResult = await cdp.injectMessage(prompt);
            }
            
            if (!injectResult.ok) {
                return this.handleInitialError(injectResult.error || 'Failed to inject message');
            }

            const grpcClient = await cdp.getGrpcClient();
            const cascadeId = injectResult.cascadeId || (grpcClient ? await cdp.getActiveCascadeId() : null);

            if (!grpcClient || !cascadeId) {
                return this.handleInitialError('gRPC monitor unavailable. Unable to track the response stream.');
            }
            
            logger.info(`Prompt injected via CDP (Cascade: ${cascadeId}) - starting gRPC monitor`);

            this.monitor = new GrpcResponseMonitor({
                grpcClient,
                cascadeId,
                maxDurationMs: 300_000,
                expectedUserMessage: this.deps.prompt,
                onPhaseChange: () => {
                    // Phase transitions are handled by monitor internally
                },
                onProgress: (text: string) => this.handleContentDelta(text),
                onStepsUpdate: (data: { steps: unknown[]; runStatus: string | null }) => {
                    const activityText = renderStepsToDiscordMarkdown(data.steps as Array<{ [key: string]: unknown }>, data.runStatus);
                    this.handleActivity(activityText, data.runStatus === 'complete');
                },
                onComplete: (finalText: string) => this.handleComplete(finalText),
                onTimeout: (lastText: string) => this.handleTimeout(lastText),
            });

            await this.monitor.start();

        } catch (error: unknown) {
            logger.error('Unhandled error in sendPromptToAntigravity:', error);
            await this.handleInitialError((error as Error).message || String(error));
        }
    }

    private handleContentDelta(fullText: string) {
        if (this.stopRequested || this.deps.userStopRequestedChannels.has(this.deps.message.channelId)) {
            // Already aborted
            return;
        }

        this.finalResponse = fullText;
        if (!this.hasInitialRender) {
            this.responseScheduler.request({ text: this.finalResponse, force: true }, true);
            this.hasInitialRender = true;
        } else {
            this.responseScheduler.request({ text: this.finalResponse });
        }
    }

    private handleActivity(activityText: string, isFinal: boolean) {
        if (this.stopRequested || this.deps.userStopRequestedChannels.has(this.deps.message.channelId)) {
            return;
        }

        const normalized = activityText.trim();
        if (!normalized || normalized === this.latestRenderedActivityText) {
            return;
        }

        this.latestRenderedActivityText = normalized;
        this.finalActivity = normalized;
        this.activityScheduler.request({ text: this.finalActivity, isFinal });
    }

    private async handleComplete(finalText: string) {
        if (this.stopRequested) {
            return;
        }
        if (finalText?.trim()) {
            this.finalResponse = finalText;
        }
        this.deps.logger.info('gRPC stream complete');
        await this.finalizeAndCleanup(this.finalResponse.trim() ? '✅' : '⚠️');
    }

    private async handleTimeout(lastText: string) {
        if (this.stopRequested) {
            return;
        }
        this.deps.logger.warn('gRPC stream timed out');
        const phase = this.monitor?.getPhase?.();
        if (phase === 'quotaReached') {
            this.finalResponse = 'Model quota limit reached. Please wait or switch to a different model.';
            await this.finalizeAndCleanup('⚠️');
            return;
        }
        if (lastText?.trim()) {
            this.finalResponse = lastText;
        }
        // Try emergency extraction
        const extraText = !this.finalResponse.trim()
            ? await this.deps.tryEmergencyExtractText(this.deps.cdp, this.finalResponse, this.deps.logger)
            : '';
        if (extraText?.trim()) {
            this.deps.logger.info(`Emergency extracted ${extraText.length} additional chars`);
            this.finalResponse = extraText;
        }
        await this.finalizeAndCleanup('⚠️');
    }

    private async handleInitialError(errorMsg: string) {
        const title = errorMsg?.includes('Timeout waiting for')
            ? t('bot.embed.error.timeout.title')
            : t('bot.embed.error.general.title');

        if (this.outputFormat === 'plain') {
            await this.deps.enqueueGeneral(async () => {
                await this.deps.message.reply(`❌ **${title}**\n${errorMsg}`).catch(() => { });
            });
        } else {
            const errorEmbed = new EmbedBuilder()
                .setTitle(`❌ ${title}`)
                .setDescription(errorMsg || t('bot.embed.error.general.desc'))
                .setColor(0xE74C3C)
                .setTimestamp();

            await this.deps.enqueueGeneral(async () => {
                await this.deps.message.reply({ embeds: [errorEmbed] }).catch(() => { });
            });
        }
        
        this.deps.logger.error('Prompt injection failed:', errorMsg);
        await this.deps.message.reactions.removeAll().catch(e => this.deps.logger.debug('Failed to clear reactions', e));
        await this.deps.message.react('❌').catch(() => { });
        this.signalCompletion();
    }

    private async finalizeAndCleanup(finalReaction: string) {
        if (this.isFinalized) {
            return;
        }
        this.isFinalized = true;
        
        const { message, userStopRequestedChannels, logger } = this.deps;

        try {
            // Force final renders
            this.responseScheduler.request({ text: this.finalResponse, force: true }, true);
            if (this.finalActivity.trim()) {
                this.activityScheduler.request({ text: this.finalActivity, isFinal: true, force: true }, true);
            }

            await Promise.all([
                this.responseScheduler.flush(),
                this.activityScheduler.flush(),
            ]);

            this.responseScheduler.dispose();
            this.activityScheduler.dispose();

            // Cleanup transient status reactions before adding the final state.
            await message.reactions.removeAll().catch(e => logger.debug('Failed to clear reactions', e));
            await message.react(finalReaction).catch(() => { });

            if (userStopRequestedChannels.has(message.channelId)) {
                userStopRequestedChannels.delete(message.channelId);
            }

            // Notify Telegram if applicable
            if (this.deps.telegramNotify && this.finalResponse.trim()) {
                const shortResp = this.finalResponse.length > 500 ? this.finalResponse.slice(0, 500) + '...' : this.finalResponse;
                this.deps.telegramNotify(
                    `🦞 <b>Antigravity Response</b>\n\n${escapeHtml(shortResp)}`,
                ).catch(e => logger.error('Telegram notification error:', e));
            }
        } finally {
            this.signalCompletion();
        }
    }

    async stopByUser(): Promise<boolean> {
        if (this.isFinalized || this.stopRequested) {
            return false;
        }

        this.stopRequested = true;
        this.isFinalized = true;
        this.deps.userStopRequestedChannels.add(this.deps.message.channelId);

        try {
            await this.monitor?.stop().catch(() => { });
            this.responseScheduler.dispose();
            this.activityScheduler.dispose();
            await this.deps.message.reactions.removeAll().catch(e => this.deps.logger.debug('Failed to clear reactions', e));
            await this.deps.message.react('⏹️').catch(() => { });
        } finally {
            this.deps.userStopRequestedChannels.delete(this.deps.message.channelId);
            this.signalCompletion();
        }

        return true;
    }

    private signalCompletion(): void {
        if (this.completionSignaled) {
            return;
        }
        this.completionSignaled = true;
        this.deps.options?.onFullCompletion?.();
    }
}
