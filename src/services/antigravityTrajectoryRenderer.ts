import * as fs from 'fs';
import * as path from 'path';
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

// ---------------------------------------------------------------------------
// Bundle path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the installed Antigravity chat.js bundle.
 *
 * Precedence:
 * 1. `ANTIGRAVITY_BUNDLE_PATH` env override
 * 2. OS-specific default path
 */
function getAntigravityBundlePath(): string {
    if (process.env.ANTIGRAVITY_BUNDLE_PATH) {
        return process.env.ANTIGRAVITY_BUNDLE_PATH;
    }

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData) {
            return path.join(
                localAppData,
                'Programs', 'Antigravity', 'resources', 'app',
                'extensions', 'antigravity', 'out', 'media', 'chat.js',
            );
        }
    }

    if (process.platform === 'darwin') {
        return '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/out/media/chat.js';
    }

    // Linux / fallback — check common AppImage extract paths
    const home = process.env.HOME || '/tmp';
    return path.join(home, '.local', 'share', 'Antigravity', 'resources', 'app', 'extensions', 'antigravity', 'out', 'media', 'chat.js');
}

// ---------------------------------------------------------------------------
// AntigravityTrajectoryRenderer — bundle-first detached strategy
// ---------------------------------------------------------------------------

export class AntigravityTrajectoryRenderer {
    /**
     * Per-context cache of `Runtime.compileScript` scriptIds.
     * Once a context has been bootstrapped, we only need `runScript` to re-activate globals.
     */
    private readonly bootstrappedContexts = new Map<number, string>();
    private lastSuccessfulContextId: number | null = null;
    private bundleSource: string | null = null;

    constructor(private readonly cdpService: CdpService) { }

    async renderTrajectory(
        request: AntigravityTrajectoryRenderRequest,
    ): Promise<AntigravityTrajectoryRenderResult> {
        const t0 = Date.now();
        const steps = Array.isArray(request.steps) ? [...request.steps] : [];
        const orderedContexts = this.getOrderedContexts();

        if (orderedContexts.length === 0) {
            return {
                ok: false,
                error: 'No CDP execution contexts are available',
            };
        }

        // Fast path: try the last successful context first
        if (this.lastSuccessfulContextId !== null) {
            const cached = orderedContexts.find(c => c.context.id === this.lastSuccessfulContextId);
            if (cached) {
                const result = await this.renderInContext(cached.context.id, {
                    steps,
                    runStatus: request.runStatus ?? null,
                    trajectory: request.trajectory ?? null,
                    format: request.format ?? 'text',
                });
                if (result.ok) {
                    logger.debug(`[TrajectoryRenderer] Fast-path render in ${Date.now() - t0}ms (ctx=${cached.context.id})`);
                    return result;
                }
                // Cached context failed — clear it and fall through to full scan
                this.lastSuccessfulContextId = null;
            }
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
                this.lastSuccessfulContextId = context.id;
                logger.debug(`[TrajectoryRenderer] Full-scan render in ${Date.now() - t0}ms (ctx=${context.id})`);
                return result;
            }

            lastFailure = result;
        }

        logger.debug(`[TrajectoryRenderer] All contexts failed in ${Date.now() - t0}ms (tried=${orderedContexts.length})`);
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

    // ─── Per-context render pipeline ─────────────────────────────────

    private async renderInContext(
        contextId: number,
        request: Required<AntigravityTrajectoryRenderRequest>,
    ): Promise<AntigravityTrajectoryRenderResult> {
        try {
            const t0 = Date.now();
            let result = await this.evaluateRenderProbe(contextId, request);
            if (result.ok) {
                return result;
            }

            if (this.shouldBootstrapBundle(result)) {
                logger.debug(`[TrajectoryRenderer] Bootstrapping bundle for ctx=${contextId} (probe took ${Date.now() - t0}ms)`);
                const tBoot = Date.now();
                const bootstrapped = await this.ensureBundleInContext(contextId);
                logger.debug(`[TrajectoryRenderer] Bootstrap ${bootstrapped ? 'OK' : 'FAILED'} for ctx=${contextId} in ${Date.now() - tBoot}ms`);
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
            logger.debug(`[TrajectoryRenderer] Context ${contextId} probe failed: ${message}`);
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

    private shouldBootstrapBundle(result: AntigravityTrajectoryRenderResult): boolean {
        const err = result.error || '';
        return err.includes('uCe is not defined')
            || err.includes('w6 is not defined')
            || err.includes('Bundle globals are not available')
            || err.includes('p is not defined')
            || err.includes('u is not defined');
    }

    // ─── Bundle injection via compileScript / runScript ──────────────

    private async ensureBundleInContext(contextId: number): Promise<boolean> {
        try {
            // If we've already compiled the bundle in this context, just re-run it
            const existingScriptId = this.bootstrappedContexts.get(contextId);
            if (existingScriptId) {
                const available = await this.checkBundleGlobals(contextId);
                if (available) return true;

                // Globals lost (page reloaded?) — re-run the compiled script
                await this.cdpService.call('Runtime.runScript', {
                    scriptId: existingScriptId,
                    executionContextId: contextId,
                    returnByValue: true,
                });
                return await this.checkBundleGlobals(contextId);
            }

            // First-time bootstrap: read and compile the bundle
            const source = this.loadBundleSource();
            if (!source) return false;

            const compileResult = await this.cdpService.call('Runtime.compileScript', {
                expression: source,
                sourceURL: 'antigravity://chat-bundle.js',
                persistScript: true,
                executionContextId: contextId,
            });

            const scriptId = compileResult?.scriptId;
            if (!scriptId) {
                logger.debug(`[TrajectoryRenderer] compileScript returned no scriptId for ctx=${contextId}`);
                return false;
            }

            await this.cdpService.call('Runtime.runScript', {
                scriptId,
                executionContextId: contextId,
                returnByValue: true,
            });

            const available = await this.checkBundleGlobals(contextId);
            if (available) {
                this.bootstrappedContexts.set(contextId, scriptId);
            }
            return available;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug(`[TrajectoryRenderer] Bundle bootstrap failed for ctx=${contextId}: ${message}`);
            return false;
        }
    }

    private async checkBundleGlobals(contextId: number): Promise<boolean> {
        const response = await this.cdpService.call('Runtime.evaluate', {
            expression: `(() => !!(typeof uCe === 'function' && typeof w6 === 'function' && typeof p === 'object' && typeof u === 'object'))()`,
            returnByValue: true,
            contextId,
        });
        return response?.result?.value === true;
    }

    private loadBundleSource(): string | null {
        if (this.bundleSource !== null) return this.bundleSource;

        const bundlePath = getAntigravityBundlePath();
        try {
            this.bundleSource = fs.readFileSync(bundlePath, 'utf-8');
            logger.debug(`[TrajectoryRenderer] Loaded bundle from ${bundlePath} (${this.bundleSource.length} bytes)`);
            return this.bundleSource;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`[TrajectoryRenderer] Failed to read bundle from ${bundlePath}: ${message}`);
            return null;
        }
    }

    // ─── Detached render expression ──────────────────────────────────

    private buildRenderExpression(
        request: Required<AntigravityTrajectoryRenderRequest>,
    ): string {
        const payloadJson = JSON.stringify({
            steps: request.steps,
            runStatus: request.runStatus,
            trajectory: request.trajectory,
            format: request.format,
        });

        return `(async () => {
            if (typeof uCe !== 'function' || typeof w6 !== 'function') {
                return {
                    ok: false,
                    error: 'Bundle globals are not available in this execution context',
                    diagnostics: { panelPresent: false, frameworkHint: null, candidates: [] },
                };
            }

            const input = ${payloadJson};

            const rawTrajectory = input.trajectory && typeof input.trajectory === 'object'
                ? input.trajectory
                : {
                    steps: input.steps,
                    cascadeId: 'detached-cascade',
                    trajectoryId: 'detached-trajectory:detached-cascade',
                    trajectoryType: 4,
                    generatorMetadata: [],
                    executorMetadatas: [],
                };

            const resolveRunStatus = (value) => {
                if (typeof value === 'number') return value;
                if (typeof M$ !== 'undefined') {
                    if (value === 'CASCADE_RUN_STATUS_RUNNING' || value === 'RUNNING') return M$.RUNNING || 2;
                    if (value === 'CASCADE_RUN_STATUS_IDLE' || value === 'IDLE') return M$.IDLE || 1;
                }
                return typeof value === 'string' && value.includes('RUNNING') ? 2 : 1;
            };

            const noopFn = () => {};
            const noopRef = { current: null };
            const emptyObj = {};

            const minimalCascadeContext = {
                state: {
                    cascadeStateProvider: {
                        getCascadeId: () => rawTrajectory.cascadeId || 'detached-cascade',
                        getState: () => ({ status: resolveRunStatus(input.runStatus) }),
                    },
                },
                events: {
                    sendMessage: noopFn,
                    cancelRun: noopFn,
                    retryLastStep: noopFn,
                    applyCodeBlock: noopFn,
                },
                services: {},
            };

            const providerProps = {
                cascadeContext: minimalCascadeContext,
                workspaceInfo: { workspaceFolders: [] },
                unleashState: emptyObj,
                stepHandler: {
                    handleStepAction: noopFn,
                    handleToolCallAction: noopFn,
                },
                chatParams: { artifactsDir: '', knowledgeDir: '', hasDevExtension: false },
                renderers: {
                    markdown: (props) => {
                        if (typeof p !== 'undefined' && p.jsx) {
                            return p.jsx('div', { dangerouslySetInnerHTML: { __html: props.children || '' } });
                        }
                        return null;
                    },
                },
                restartUserStatusUpdater: noopFn,
                getStepRendererConfig: () => undefined,
                userStatus: emptyObj,
                trajectorySummariesProvider: {
                    getSummary: () => null,
                    getLatestSummary: () => null,
                },
                inputBoxRef: noopRef,
                tokenizationService: {
                    tokenize: (text) => [{ type: 'text', value: text }],
                },
                metadata: emptyObj,
            };

            try {
                const renderProps = {
                    trajectory: rawTrajectory,
                    status: resolveRunStatus(input.runStatus),
                    queuedSteps: [],
                    debugMode: false,
                    sectionVirtualizer: undefined,
                    isSubtrajectory: false,
                    failedToSendOptimisticStep: () => false,
                    viewportHeight: 0,
                    forceScrollToBottom: undefined,
                };

                const container = document.createElement('div');

                if (typeof u !== 'undefined' && u.H) {
                    const root = u.H(container);
                    root.render(
                        p.jsx(w6, {
                            ...providerProps,
                            children: p.jsx(uCe, renderProps),
                        }),
                    );
                } else {
                    return {
                        ok: false,
                        error: 'Preact render API (u.H) is not available',
                        diagnostics: { panelPresent: false, frameworkHint: 'bundle-injected', candidates: ['uCe', 'w6'] },
                    };
                }

                // Preact may flush its render queue asynchronously.
                // Retry reading innerHTML with increasing delays to handle complex renders
                // that need more than a single microtask tick to commit their VDOM.
                const flushDelays = [0, 16, 50];
                let html = '';
                let text = '';
                for (const delay of flushDelays) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    html = container.innerHTML.trim();
                    if (html) break;
                }
                text = (container.textContent || '').trim();
                const preferred = input.format === 'text' ? text : html;
                const format = input.format === 'text' ? 'text' : 'html';

                if (!preferred) {
                    return {
                        ok: false,
                        error: 'The detached bundle renderer returned empty content'
                            + ' (steps=' + input.steps.length
                            + ', runStatus=' + (input.runStatus || 'null')
                            + ', flushAttempts=' + flushDelays.length + ')',
                        diagnostics: { panelPresent: false, frameworkHint: 'bundle-injected', candidates: ['uCe', 'w6'] },
                    };
                }

                return {
                    ok: true,
                    content: preferred,
                    format,
                    strategy: 'bundle-detached-render',
                    diagnostics: { panelPresent: false, frameworkHint: 'bundle-injected', candidates: ['uCe', 'w6'] },
                };
            } catch (error) {
                return {
                    ok: false,
                    error: String(error && error.stack || error),
                    diagnostics: { panelPresent: false, frameworkHint: 'bundle-injected', candidates: ['uCe', 'w6'] },
                };
            }
        })()`;
    }
}
