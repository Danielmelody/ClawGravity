import type { Message } from 'discord.js';

import { ChatSessionRepository } from '../database/chatSessionRepository';
import type { PromptDispatchOptions } from '../services/promptDispatcher';
import { CdpBridge } from '../services/cdpBridgeManager';
import { CdpService } from '../services/cdpService';
import { ChannelManager } from '../services/channelManager';
import { ModeService, MODE_UI_NAMES } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { logger } from '../utils/logger';
import { resolveResponseDeliveryMode } from '../utils/config';
import { InboundImageAttachment } from '../utils/imageHandler';
import { PromptSession } from './promptSession';

const RESPONSE_DELIVERY_MODE = resolveResponseDeliveryMode();
const AUTO_RENAME_THRESHOLD = 5;
const COALESCE_PERIOD_MS = 75;
type DiscordPromptDispatchOptions = Partial<PromptDispatchOptions> & {
    onFullCompletion?: () => void;
};

export const getResponseDeliveryModeForTest = (): string => RESPONSE_DELIVERY_MODE;

function createSerialTaskQueue(
    queueName: string,
    traceId: string,
): { enqueue: (task: () => Promise<void>, label?: string) => Promise<void> } {
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
                } catch (error: unknown) {
                    logger.error(
                        `[sendQueue:${traceId}:${queueName}] error #${seq} label=${label}:`,
                        (error as Error).message || error,
                    );
                } finally {
                    queueDepth = Math.max(0, queueDepth - 1);
                }
            });

            return queue;
        },
    };
}

export function createSerialTaskQueueForTest(
    queueName: string,
    traceId: string,
): (task: () => Promise<void>, label?: string) => Promise<void> {
    const queue = createSerialTaskQueue(queueName, traceId);
    return queue.enqueue;
}

export interface DiscordPromptRuntimeOptions {
    readonly activePromptSessions: Map<string, PromptSession>;
    readonly userStopRequestedChannels: Set<string>;
    readonly getTelegramNotifier: () => ((text: string) => Promise<void>) | null;
}

export interface DiscordPromptRuntimeArtifacts {
    readonly sendPromptImpl: (
        bridge: CdpBridge,
        message: Message,
        prompt: string,
        cdp: CdpService,
        modeService: ModeService,
        modelService: ModelService,
        inboundImages?: InboundImageAttachment[],
        options?: DiscordPromptDispatchOptions,
    ) => Promise<void>;
    readonly autoRenameChannel: (
        message: Message,
        chatSessionRepo: ChatSessionRepository,
        titleGenerator: TitleGeneratorService,
        channelManager: ChannelManager,
        cdp?: CdpService,
    ) => Promise<void>;
}

export function createDiscordPromptRuntimeArtifacts(
    options: DiscordPromptRuntimeOptions,
): DiscordPromptRuntimeArtifacts {
    const sendPromptImpl: DiscordPromptRuntimeArtifacts['sendPromptImpl'] = async (
        _bridge,
        message,
        prompt,
        cdp,
        modeService,
        modelService,
        inboundImages = [],
        promptOptions: DiscordPromptDispatchOptions = {},
    ): Promise<void> => {
        const monitorTraceId = `${cdp.getContexts()[0] || 'unknown'}-${Date.now()}`;
        const enqueueGeneral = createSerialTaskQueue('general', monitorTraceId).enqueue;
        const enqueueResponse = createSerialTaskQueue('response', monitorTraceId).enqueue;
        const enqueueActivity = createSerialTaskQueue('activity', monitorTraceId).enqueue;

        const telemetryModeName = MODE_UI_NAMES[modeService.getCurrentMode()] || modeService.getCurrentMode();
        const telemetryModelName = (await cdp.getCurrentModel()) || '';

        const autoRenameSessionChannel = async (newTitle: string): Promise<void> => {
            if (message.channel.isTextBased() && 'setName' in message.channel) {
                await message.channel.setName(newTitle).catch((error) => {
                    logger.warn(`Failed to rename channel: ${error.message}`);
                });
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
                if (contextId !== null) {
                    callParams.contextId = contextId;
                }
                const result = await cdp.call('Runtime.evaluate', callParams) as { result?: { value?: unknown } };
                const value = result.result?.value;
                return typeof value === 'string' ? value.trim() : '';
            } catch {
                return '';
            }
        };

        try {
            logger.prompt(prompt);
            const wrappedOptions = {
                ...promptOptions,
                onFullCompletion: () => {
                    options.activePromptSessions.delete(message.channelId);
                    promptOptions.onFullCompletion?.();
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
                    coalesceMs: COALESCE_PERIOD_MS,
                },
                autoRenameChannel: autoRenameSessionChannel,
                tryEmergencyExtractText,
                userStopRequestedChannels: options.userStopRequestedChannels,
                telegramNotify: options.getTelegramNotifier(),
            });

            options.activePromptSessions.set(message.channelId, session);
            await session.execute();
        } catch (error: unknown) {
            options.activePromptSessions.delete(message.channelId);
            promptOptions.onFullCompletion?.();
            logger.error('[sendPromptToAntigravity] Setup failure:', error);
        }
    };

    const autoRenameChannel: DiscordPromptRuntimeArtifacts['autoRenameChannel'] = async (
        message,
        chatSessionRepo,
        titleGenerator,
        channelManager,
        _cdp,
    ): Promise<void> => {
        const session = chatSessionRepo.findByChannelId(message.channelId);
        if (!session || session.isRenamed) return;

        const guild = message.guild;
        if (!guild) return;

        try {
            const title = await titleGenerator.generateTitle(message.content);
            const newName = `${session.sessionNumber}-${title}`;
            await channelManager.renameChannel(guild, message.channelId, newName);
            chatSessionRepo.updateDisplayName(message.channelId, title);
        } catch (error) {
            logger.error('[AutoRename] Rename failed:', error);
        }
    };

    return {
        sendPromptImpl,
        autoRenameChannel,
    };
}
