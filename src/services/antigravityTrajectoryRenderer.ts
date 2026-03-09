import { CdpContext, CdpService } from './cdpService';
import { logger } from '../utils/logger';

export type AntigravityTrajectoryRenderFormat = 'text' | 'html' | 'auto';

export interface AntigravityTrajectoryRenderRequest {
    readonly steps: readonly unknown[];
    readonly runStatus?: string | null;
    readonly trajectory?: unknown | null;
    readonly format?: AntigravityTrajectoryRenderFormat;
}

export interface AntigravityTrajectoryRenderResult {
    readonly ok: boolean;
    readonly content?: string;
    readonly format?: 'text' | 'html';
    readonly contextId?: number;
    readonly strategy?: string;
    readonly diagnostics?: {
        readonly panelPresent?: boolean;
        readonly frameworkHint?: string | null;
        readonly candidates?: readonly string[];
    };
    readonly error?: string;
}

interface RuntimeProbeResult {
    readonly ok?: boolean;
    readonly content?: string;
    readonly format?: 'text' | 'html';
    readonly strategy?: string;
    readonly diagnostics?: {
        readonly panelPresent?: boolean;
        readonly frameworkHint?: string | null;
        readonly candidates?: readonly string[];
    };
    readonly error?: string;
}

interface ScoredContext {
    readonly context: CdpContext;
    readonly score: number;
}

const RENDER_PROBE_TIMEOUT_MS = 12_000;
const DEBUGGER_BOOTSTRAP_TIMEOUT_MS = 15_000;
const HELPER_AVAILABILITY_EXPRESSION = `(() => {
    const helpers = window.__agRendererHelpers;
    return !!(
        helpers
        && typeof helpers.nT === 'function'
        && typeof helpers.L === 'function'
        && typeof helpers.Pml === 'function'
        && helpers.HA
        && helpers.al
        && helpers.Zb
        && helpers.Vhe
        && helpers.Don
    );
})()`;

export class AntigravityTrajectoryRenderer {
    private readonly helperBootstrapPromises = new Map<number, Promise<boolean>>();

    constructor(private readonly cdpService: CdpService) { }

    async renderTrajectory(
        request: AntigravityTrajectoryRenderRequest,
    ): Promise<AntigravityTrajectoryRenderResult> {
        const steps = Array.isArray(request.steps) ? [...request.steps] : [];
        const orderedContexts = this.getOrderedContexts();

        if (orderedContexts.length === 0) {
            return {
                ok: false,
                error: 'No CDP execution contexts are available',
            };
        }

        let lastFailure: AntigravityTrajectoryRenderResult | null = null;

        for (const { context } of orderedContexts) {
            const result = await this.renderInContext(context.id, {
                steps,
                runStatus: request.runStatus ?? null,
                trajectory: request.trajectory ?? null,
                format: request.format ?? 'text',
            });

            if (result.ok) {
                return result;
            }

            lastFailure = result;
        }

        return lastFailure ?? {
            ok: false,
            error: 'Antigravity trajectory renderer was not found in any execution context',
        };
    }

    private getOrderedContexts(): ScoredContext[] {
        const primaryContextId = this.cdpService.getPrimaryContextId();

        return this.cdpService
            .getContexts()
            .map((context) => ({
                context,
                score: this.scoreContext(context, primaryContextId),
            }))
            .sort((left, right) => {
                if (right.score !== left.score) {
                    return right.score - left.score;
                }
                return left.context.id - right.context.id;
            });
    }

    private scoreContext(context: CdpContext, primaryContextId: number | null): number {
        let score = 0;
        const name = `${context.name || ''} ${context.url || ''}`.toLowerCase();

        if (name.includes('cascade-panel')) score += 100;
        if (name.includes('cascade')) score += 40;
        if (name.includes('agent')) score += 20;
        if (context.auxData?.isDefault) score += 10;
        if (context.id === primaryContextId) score += 5;

        return score;
    }

    private async renderInContext(
        contextId: number,
        request: Required<AntigravityTrajectoryRenderRequest>,
    ): Promise<AntigravityTrajectoryRenderResult> {
        try {
            let result = await this.evaluateRenderProbe(contextId, request);
            if (result.ok) {
                return result;
            }

            if (this.shouldBootstrapHelpers(result)) {
                const bootstrapped = await this.ensureRendererHelpersInContext(contextId);
                if (bootstrapped) {
                    result = await this.evaluateRenderProbe(contextId, request);
                    if (result.ok) {
                        return result;
                    }
                }
            }

            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug(`[AntigravityTrajectoryRenderer] Context ${contextId} probe failed: ${message}`);
            return {
                ok: false,
                error: message,
                contextId,
            };
        }
    }

    private async evaluateRenderProbe(
        contextId: number,
        request: Required<AntigravityTrajectoryRenderRequest>,
    ): Promise<AntigravityTrajectoryRenderResult> {
        const response = await this.cdpService.callWithRetry('Runtime.evaluate', {
            expression: this.buildRenderExpression(request),
            returnByValue: true,
            awaitPromise: true,
            contextId,
        }, RENDER_PROBE_TIMEOUT_MS);

        const value = response?.result?.value as RuntimeProbeResult | undefined;
        if (value?.ok && typeof value.content === 'string' && value.content.trim().length > 0) {
            return {
                ok: true,
                content: value.content,
                format: value.format ?? 'text',
                strategy: value.strategy,
                contextId,
                diagnostics: value.diagnostics,
            };
        }

        return {
            ok: false,
            error: value?.error || 'Renderer probe returned no content',
            contextId,
            diagnostics: value?.diagnostics,
        };
    }

    private shouldBootstrapHelpers(result: AntigravityTrajectoryRenderResult): boolean {
        return result.error === 'The Antigravity panel helpers are not available in this execution context';
    }

    private async ensureRendererHelpersInContext(contextId: number): Promise<boolean> {
        const inFlight = this.helperBootstrapPromises.get(contextId);
        if (inFlight) {
            return inFlight;
        }

        const bootstrapPromise = this.bootstrapRendererHelpers(contextId)
            .catch((error) => {
                logger.debug(
                    `[AntigravityTrajectoryRenderer] Failed to bootstrap renderer helpers in context ${contextId}: ${error instanceof Error ? error.message : String(error)}`,
                );
                return false;
            })
            .finally(() => {
                this.helperBootstrapPromises.delete(contextId);
            });

        this.helperBootstrapPromises.set(contextId, bootstrapPromise);
        return bootstrapPromise;
    }

    private async bootstrapRendererHelpers(contextId: number): Promise<boolean> {
        if (await this.hasRendererHelpers(contextId)) {
            return true;
        }

        await this.cdpService.call('Debugger.enable', {});

        let breakpointId: string | null = null;
        try {
            const objectId = await this.getRendererFunctionObjectId(contextId);
            if (!objectId) {
                return false;
            }

            const pausedPromise = new Promise<boolean>((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('Timed out while waiting for renderer helper bootstrap'));
                }, DEBUGGER_BOOTSTRAP_TIMEOUT_MS);

                this.cdpService.once('Debugger.paused', async (params: any) => {
                    clearTimeout(timer);
                    try {
                        const frameId = params?.callFrames?.[0]?.callFrameId;
                        if (!frameId) {
                            throw new Error('Debugger paused without a call frame');
                        }

                        await this.cdpService.call('Debugger.evaluateOnCallFrame', {
                            callFrameId: frameId,
                            expression: `(() => {
                                window.__agRendererHelpers = { nT, L, Pml, HA, al, Zb, Vhe, Don };
                                return true;
                            })()`,
                            returnByValue: true,
                        });
                        await this.cdpService.call('Debugger.resume', {});
                        resolve(true);
                    } catch (error) {
                        try {
                            await this.cdpService.call('Debugger.resume', {});
                        } catch {
                            // Ignore resume failures after a debugger error.
                        }
                        reject(error);
                    }
                });
            });

            const breakpoint = await this.cdpService.call('Debugger.setBreakpointOnFunctionCall', {
                objectId,
            });
            breakpointId = breakpoint?.breakpointId ?? null;

            try {
                await this.cdpService.call('Runtime.evaluate', {
                    expression: this.buildRendererFunctionTriggerExpression(),
                    contextId,
                    awaitPromise: true,
                });
            } catch {
                // The trigger call may throw because aBe expects live context during normal execution.
                // The function-call breakpoint fires before that matters.
            }

            await pausedPromise;
            return await this.hasRendererHelpers(contextId);
        } finally {
            if (breakpointId) {
                try {
                    await this.cdpService.call('Debugger.removeBreakpoint', { breakpointId });
                } catch {
                    // Ignore breakpoint cleanup failures.
                }
            }

            try {
                await this.cdpService.call('Debugger.disable', {});
            } catch {
                // Ignore debugger cleanup failures.
            }
        }
    }

    private async hasRendererHelpers(contextId: number): Promise<boolean> {
        const response = await this.cdpService.call('Runtime.evaluate', {
            expression: HELPER_AVAILABILITY_EXPRESSION,
            returnByValue: true,
            awaitPromise: true,
            contextId,
        });
        return response?.result?.value === true;
    }

    private async getRendererFunctionObjectId(contextId: number): Promise<string | null> {
        const response = await this.cdpService.call('Runtime.evaluate', {
            expression: this.buildRendererFunctionLookupExpression(),
            contextId,
            awaitPromise: true,
        });

        return response?.result?.objectId ?? null;
    }

    private buildRendererFunctionLookupExpression(): string {
        return `(() => {
            const panelRoot = document.querySelector('.antigravity-agent-side-panel');
            const root = panelRoot ? (panelRoot.__k || panelRoot.l || null) : null;
            if (!root) return null;

            let found = null;
            const walk = (node) => {
                if (!node || found) return;
                const typeName = typeof node.type === 'function'
                    ? (node.type.name || '(anon)')
                    : String(node.type);
                if (typeName === 'aBe') {
                    found = node;
                    return;
                }
                if (Array.isArray(node.__k)) {
                    node.__k.forEach(walk);
                }
            };
            walk(root);
            return found?.type || null;
        })()`;
    }

    private buildRendererFunctionTriggerExpression(): string {
        return `(() => {
            const panelRoot = document.querySelector('.antigravity-agent-side-panel');
            const root = panelRoot ? (panelRoot.__k || panelRoot.l || null) : null;
            if (!root) return null;

            let found = null;
            const walk = (node) => {
                if (!node || found) return;
                const typeName = typeof node.type === 'function'
                    ? (node.type.name || '(anon)')
                    : String(node.type);
                if (typeName === 'aBe') {
                    found = node;
                    return;
                }
                if (Array.isArray(node.__k)) {
                    node.__k.forEach(walk);
                }
            };
            walk(root);
            return found ? found.type(found.props) : null;
        })()`;
    }

    private buildRenderExpression(
        request: Required<AntigravityTrajectoryRenderRequest>,
    ): string {
        const payloadJson = JSON.stringify({
            steps: request.steps,
            runStatus: request.runStatus,
            trajectory: request.trajectory,
            format: request.format,
        });

        return `(() => {
            const input = ${payloadJson};
            const panelRoot = document.querySelector('.antigravity-agent-side-panel');
            const diagnostics = {
                panelPresent: !!panelRoot,
                frameworkHint: panelRoot ? 'preact-panel-runtime' : null,
                candidates: [],
            };
            if (!panelRoot) {
                return {
                    ok: false,
                    error: 'Antigravity agent side panel is not mounted in this execution context',
                    diagnostics,
                };
            }

            const normalizeEnumKey = (value) => (
                typeof value === 'string'
                    ? value.replace(/^[A-Z0-9]+(?:_[A-Z0-9]+)*_/, '')
                    : value
            );

            const mapEnum = (enumObject, value, fallback) => {
                if (typeof value === 'number') return value;
                if (typeof value !== 'string') return fallback;
                const key = normalizeEnumKey(value);
                return typeof enumObject?.[key] === 'number'
                    ? enumObject[key]
                    : fallback;
            };

            const clone = (value) => {
                if (value == null || typeof value !== 'object') return value;
                if (Array.isArray(value)) return value.map(clone);
                const out = {};
                for (const [key, nested] of Object.entries(value)) {
                    out[key] = clone(nested);
                }
                return out;
            };

            const findRendererNode = () => {
                const root = panelRoot.__k || panelRoot.l || null;
                if (!root) return null;

                let found = null;
                const walk = (node) => {
                    if (!node || found) return;
                    const typeName = typeof node.type === 'function'
                        ? (node.type.name || '(anon)')
                        : String(node.type);
                    if (typeName === 'aBe') {
                        found = node;
                        return;
                    }
                    if (Array.isArray(node.__k)) {
                        node.__k.forEach(walk);
                    }
                };
                walk(root);
                return found;
            };

            const rendererNode = findRendererNode();
            if (!rendererNode?.type || !rendererNode?.__c?.context) {
                return {
                    ok: false,
                    error: 'The Antigravity trajectory renderer is not mounted in this execution context',
                    diagnostics,
                };
            }

            const moduleHelpers = (() => {
                const helpers = window.__agRendererHelpers || null;
                if (!helpers) return null;

                return {
                    aBe: rendererNode.type,
                    nT: helpers.nT,
                    L: helpers.L,
                    Pml: helpers.Pml,
                    HA: helpers.HA,
                    al: helpers.al,
                    Zb: helpers.Zb,
                    Vhe: helpers.Vhe,
                    Don: helpers.Don,
                };
            })();

            if (!moduleHelpers) {
                return {
                    ok: false,
                    error: 'The Antigravity panel helpers are not available in this execution context',
                    diagnostics,
                };
            }

            diagnostics.candidates.push('panel:aBe');
            diagnostics.candidates.push('window.__agRendererHelpers.nT');
            diagnostics.candidates.push('window.__agRendererHelpers.Pml');

            const normalizeCaseValue = (caseKey, value) => {
                const base = clone(value || {});

                switch (caseKey) {
                    case 'userInput':
                        return {
                            $typeName: 'exa.cortex_pb.CortexStepUserInput',
                            items: (base.items || []).map((item) => {
                                if (!item || typeof item !== 'object') return item;
                                if (item.chunk) return item;
                                if (typeof item.text === 'string') {
                                    return {
                                        $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
                                        chunk: {
                                            case: 'text',
                                            value: item.text,
                                        },
                                    };
                                }
                                return item;
                            }),
                            userResponse: base.userResponse || '',
                            artifactComments: base.artifactComments || [],
                            fileDiffComments: base.fileDiffComments || [],
                            fileComments: base.fileComments || [],
                            isQueuedMessage: !!base.isQueuedMessage,
                            clientType: base.clientType || 0,
                            query: base.query || '',
                            images: base.images || [],
                            media: base.media || [],
                            userConfig: base.userConfig || undefined,
                        };
                    case 'conversationHistory':
                        return {
                            $typeName: 'exa.cortex_pb.ConversationHistory',
                            content: base.content || '',
                        };
                    case 'ephemeralMessage':
                        return {
                            $typeName: 'exa.cortex_pb.CortexStepEphemeralMessage',
                            content: base.content || '',
                            media: base.media || [],
                            triggeredHeuristics: base.triggeredHeuristics || [],
                            attachments: base.attachments || [],
                            domTreeUri: base.domTreeUri || '',
                        };
                    case 'plannerResponse':
                        return {
                            $typeName: 'exa.cortex_pb.CortexStepPlannerResponse',
                            response: base.response || '',
                            modifiedResponse: base.modifiedResponse || '',
                            thinking: base.thinking || '',
                            signature: base.signature || '',
                            thinkingSignature: base.thinkingSignature || '',
                            thinkingRedacted: !!base.thinkingRedacted,
                            messageId: base.messageId || '',
                            providerAssignedMessageId: base.providerAssignedMessageId || '',
                            toolCalls: base.toolCalls || [],
                            knowledgeBaseItems: base.knowledgeBaseItems || [],
                            stopReason: base.stopReason || '',
                            thinkingDuration: typeof base.thinkingDuration === 'object' ? base.thinkingDuration : undefined,
                        };
                    case 'viewFile':
                        return {
                            $typeName: 'exa.cortex_pb.CortexStepViewFile',
                            absolutePathUri: base.absolutePathUri || '',
                            startLine: base.startLine || 1,
                            endLine: base.endLine || 0,
                            content: base.content || '',
                            isSkillFile: !!base.isSkillFile,
                            rawContent: base.rawContent || base.content || '',
                            triggeredMemories: base.triggeredMemories || [],
                            numLines: base.numLines || 0,
                            numBytes: base.numBytes || 0,
                            isInjectedReminder: !!base.isInjectedReminder,
                        };
                    case 'checkpoint':
                        return {
                            $typeName: 'exa.cortex_pb.CortexStepCheckpoint',
                            checkpointIndex: base.checkpointIndex || 0,
                            intentOnly: !!base.intentOnly,
                            includedStepIndexStart: base.includedStepIndexStart || 0,
                            includedStepIndexEnd: base.includedStepIndexEnd || 0,
                            conversationTitle: base.conversationTitle || '',
                            userIntent: base.userIntent || '',
                            sessionSummary: base.sessionSummary || '',
                            codeChangeSummary: base.codeChangeSummary || '',
                            modelSummarizationFailed: !!base.modelSummarizationFailed,
                            usedFallbackSummary: !!base.usedFallbackSummary,
                            artifactSnapshots: base.artifactSnapshots || [],
                            conversationLogUris: base.conversationLogUris || [],
                            trajectoryFileDiffs: base.trajectoryFileDiffs || [],
                            userRequests: base.userRequests || [],
                            editedFileMap: base.editedFileMap || {},
                            includedStepIndices: base.includedStepIndices || [],
                            memorySummary: base.memorySummary || '',
                        };
                    default:
                        return base;
                }
            };

            const adaptSourceInfo = (info) => (
                info
                    ? {
                        $typeName: 'exa.cortex_pb.SourceTrajectoryStepInfo',
                        trajectoryId: info.trajectoryId,
                        stepIndex: info.stepIndex,
                        metadataIndex: info.metadataIndex,
                        cascadeId: info.cascadeId,
                    }
                    : undefined
            );

            const adaptMetadata = (metadata) => (
                metadata
                    ? {
                        $typeName: 'exa.cortex_pb.CortexStepMetadata',
                        ...clone(metadata),
                        source: mapEnum(moduleHelpers.Vhe, metadata.source, metadata.source),
                        sourceTrajectoryStepInfo: adaptSourceInfo(metadata.sourceTrajectoryStepInfo),
                    }
                    : undefined
            );

            const adaptStep = (step) => {
                const reservedStepKeys = new Set([
                    '$typeName',
                    'type',
                    'status',
                    'metadata',
                    'completedInteractions',
                    'subtrajectory',
                    'error',
                    'userRejected',
                ]);
                const caseKey = Object.keys(step || {}).find((key) => !reservedStepKeys.has(key));
                const adapted = {
                    $typeName: 'gemini_coder.Step',
                    type: mapEnum(moduleHelpers.HA, step?.type, step?.type),
                    status: mapEnum(moduleHelpers.al, step?.status, step?.status),
                    metadata: adaptMetadata(step?.metadata),
                    completedInteractions: clone(step?.completedInteractions || []),
                };

                if (caseKey) {
                    adapted.step = {
                        case: caseKey,
                        value: normalizeCaseValue(caseKey, step?.[caseKey]),
                    };
                }

                if (step?.subtrajectory) {
                    adapted.subtrajectory = adaptTrajectory(step.subtrajectory);
                }
                if (step?.error) {
                    adapted.error = clone(step.error);
                }
                if (step?.userRejected !== undefined) {
                    adapted.userRejected = step.userRejected;
                }

                return adapted;
            };

            const adaptTrajectory = (trajectory) => {
                const rawTrajectory = trajectory || {};
                return {
                    $typeName: 'gemini_coder.Trajectory',
                    trajectoryId: rawTrajectory.trajectoryId || rendererNode.props?.trajectory?.trajectoryId || 'detached-trajectory',
                    cascadeId: rawTrajectory.cascadeId || rendererNode.props?.trajectory?.cascadeId || 'detached-cascade',
                    trajectoryType: mapEnum(moduleHelpers.Don, rawTrajectory.trajectoryType, rawTrajectory.trajectoryType ?? 4),
                    steps: Array.isArray(rawTrajectory.steps) ? rawTrajectory.steps.map(adaptStep) : [],
                    parentReferences: clone(rawTrajectory.parentReferences || []),
                    generatorMetadata: clone(rawTrajectory.generatorMetadata || []),
                    executorMetadatas: clone(rawTrajectory.executorMetadatas || []),
                    source: rawTrajectory.source,
                    metadata: clone(rawTrajectory.metadata),
                };
            };

            try {
                const rawTrajectory = input.trajectory && typeof input.trajectory === 'object'
                    ? input.trajectory
                    : {
                        steps: input.steps,
                        cascadeId: rendererNode.props?.trajectory?.cascadeId,
                        trajectoryId: rendererNode.props?.trajectory?.trajectoryId,
                        trajectoryType: rendererNode.props?.trajectory?.trajectoryType,
                        generatorMetadata: [],
                        executorMetadatas: [],
                    };
                const trajectory = adaptTrajectory(rawTrajectory);
                const renderProps = {
                    trajectory,
                    status: mapEnum(moduleHelpers.Zb, input.runStatus, 1),
                    queuedSteps: [],
                    debugMode: false,
                    sectionVirtualizer: undefined,
                    isSubtrajectory: false,
                    failedToSendOptimisticStep: () => false,
                    viewportHeight: 0,
                    forceScrollToBottom: undefined,
                };

                const container = document.createElement('div');
                moduleHelpers.nT(
                    moduleHelpers.L(
                        moduleHelpers.Pml,
                        {
                            context: rendererNode.__c.context,
                            children: moduleHelpers.L(moduleHelpers.aBe, renderProps),
                        },
                    ),
                    container,
                );

                const html = container.innerHTML.trim();
                const text = (container.textContent || '').trim();
                const preferred = input.format === 'text'
                    ? text
                    : html;
                const format = input.format === 'text' ? 'text' : 'html';

                if (!preferred) {
                    return {
                        ok: false,
                        error: 'The detached Antigravity renderer returned empty content',
                        diagnostics,
                    };
                }

                return {
                    ok: true,
                    content: preferred,
                    format,
                    strategy: 'workbench-panel-detached-render',
                    diagnostics,
                };
            } catch (error) {
                return {
                    ok: false,
                    error: String(error && error.stack || error),
                    diagnostics,
                };
            }
        })()`;
    }
}
