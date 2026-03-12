/**
 * CoalescedRenderScheduler — coalesces frequent render updates to avoid rate limits.
 * Extracted from bot/index.ts for reusability and testability.
 */

const DEFAULT_COALESCE_MS = 75;

export interface RenderScheduler<T> {
    request: (payload: T, immediate?: boolean) => void;
    flush: () => Promise<void>;
    dispose: () => void;
}

export function createCoalescedRenderScheduler<T>(
    apply: (payload: T) => Promise<void>,
    coalescePeriodMs: number = DEFAULT_COALESCE_MS,
): RenderScheduler<T> {
    let pendingPayload: T | null = null;
    let renderTimer: NodeJS.Timeout | null = null;
    let renderPromise: Promise<void> | null = null;
    let disposed = false;

    const scheduleFlush = () => {
        if (disposed || renderTimer) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            void flushPending();
        }, coalescePeriodMs);
    };

    const flushPending = async (): Promise<void> => {
        if (disposed || renderPromise) {
            return renderPromise ?? Promise.resolve();
        }

        renderPromise = (async () => {
            while (!disposed && pendingPayload) {
                const nextPayload = pendingPayload;
                pendingPayload = null;
                await apply(nextPayload);
            }
        })()
            .catch(() => { })
            .finally(() => {
                renderPromise = null;
                if (!disposed && pendingPayload) {
                    scheduleFlush();
                }
            });

        return renderPromise;
    };

    return {
        request(payload: T, immediate = false): void {
            if (disposed) return;
            pendingPayload = payload;

            if (immediate) {
                if (renderTimer) {
                    clearTimeout(renderTimer);
                    renderTimer = null;
                }
                void flushPending();
                return;
            }

            scheduleFlush();
        },
        async flush(): Promise<void> {
            if (renderTimer) {
                clearTimeout(renderTimer);
                renderTimer = null;
            }
            await flushPending();
        },
        dispose(): void {
            disposed = true;
            pendingPayload = null;
            if (renderTimer) {
                clearTimeout(renderTimer);
                renderTimer = null;
            }
        },
    };
}
