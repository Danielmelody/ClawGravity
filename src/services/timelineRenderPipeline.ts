import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal renderer interface — only what the pipeline needs. */
export interface TimelineRenderer {
    renderTrajectory(request: {
        steps: any[];
        runStatus: string | null;
        trajectory: any | null;
        format: 'text' | 'html' | 'auto';
    }): Promise<{
        ok: boolean;
        content?: string;
        format?: string;
        error?: string;
        strategy?: string;
        contextId?: number;
    }>;
}

export interface TimelineRenderSnapshot {
    renderSteps: any[];
    renderTrajectory: any | null;
    runStatus: string | null;
}

export interface RenderedTimeline {
    content: string;
    format: 'text' | 'html';
    strategy?: string;
    contextId?: number;
}

export type OnRenderedTimeline = (timeline: RenderedTimeline) => void;

/**
 * Manages the render-pipeline for timeline HTML snapshots.
 *
 * Guarantees:
 *  - At most one render in flight at any time.
 *  - Rapid schedule() calls coalesce to the latest snapshot (queue-of-one).
 *  - drain() resolves only when ALL queued work has been processed.
 *  - After dispose(), no further renders fire and no callbacks are invoked.
 *
 * This class owns 0 timers and depends on nothing from GrpcResponseMonitor.
 */
export class TimelineRenderPipeline {
    private disposed = false;
    private renderPromise: Promise<void> | null = null;
    private queuedSnapshot: TimelineRenderSnapshot | null = null;
    private lastRenderKey: string | null = null;
    private lastRenderContent: string | null = null;

    constructor(
        private readonly renderer: TimelineRenderer,
        private readonly onRendered: OnRenderedTimeline,
        private readonly buildKey: (snapshot: TimelineRenderSnapshot) => string,
    ) { }

    /**
     * Schedule a render. If one is already in flight, the snapshot is queued
     * and will be rendered after the current one completes (queue-of-one).
     */
    schedule(snapshot: TimelineRenderSnapshot): void {
        if (this.disposed) return;
        if (!Array.isArray(snapshot.renderSteps) || snapshot.renderSteps.length === 0) return;

        const key = this.buildKey(snapshot);
        if (key === this.lastRenderKey) return;

        if (this.renderPromise) {
            this.queuedSnapshot = snapshot;
            return;
        }

        this.renderPromise = this.runRender(snapshot, key)
            .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                logger.debug(`[TimelineRenderPipeline] Render failed: ${msg}`);
            })
            .finally(() => {
                this.renderPromise = null;
                if (!this.queuedSnapshot || this.disposed) {
                    this.queuedSnapshot = null;
                    return;
                }
                const queued = this.queuedSnapshot;
                this.queuedSnapshot = null;
                this.schedule(queued);
            });
    }

    /**
     * Wait for all in-flight and queued renders to complete.
     * Must be called BEFORE dispose() to ensure onRendered fires
     * for the final render.
     */
    async drain(): Promise<void> {
        while (this.renderPromise) {
            await this.renderPromise;
        }
    }

    /**
     * Prevent any future renders and discard the queue.
     */
    dispose(): void {
        this.disposed = true;
        this.queuedSnapshot = null;
    }

    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------

    private async runRender(
        snapshot: TimelineRenderSnapshot,
        renderKey: string,
    ): Promise<void> {
        if (this.disposed) return;

        const t0 = Date.now();
        const result = await this.renderer.renderTrajectory({
            steps: snapshot.renderSteps,
            runStatus: snapshot.runStatus,
            trajectory: snapshot.renderTrajectory,
            format: 'html',
        });
        const renderMs = Date.now() - t0;

        if (this.disposed) return;
        if (!result.ok || !result.content || result.format !== 'html') {
            logger.debug(
                `[TimelineRenderPipeline] Render skipped (${renderMs}ms): ok=${result.ok}, ` +
                `format=${result.format}, contentLen=${result.content?.length ?? 0}, ` +
                `error=${result.error || 'none'}, steps=${snapshot.renderSteps.length}`,
            );
            return;
        }

        const content = result.content.trim();
        if (!content || content === this.lastRenderContent) {
            this.lastRenderKey = renderKey;
            return;
        }

        if (renderMs > 2000) {
            logger.warn(`[TimelineRenderPipeline] Render took ${renderMs}ms (strategy=${result.strategy}, ctx=${result.contextId})`);
        } else {
            logger.debug(`[TimelineRenderPipeline] Render OK in ${renderMs}ms (strategy=${result.strategy})`);
        }

        this.lastRenderKey = renderKey;
        this.lastRenderContent = content;
        this.onRendered({
            content,
            format: result.format ?? 'text',
            strategy: result.strategy,
            contextId: result.contextId,
        });
    }
}
