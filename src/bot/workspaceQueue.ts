import { logger } from '../utils/logger';

/**
 * Per-workspace prompt queue.
 * Serializes tasks per workspace path to prevent concurrent sends
 * to the same Antigravity workspace.
 */
export class WorkspaceQueue {
    private readonly queues = new Map<string, Promise<void>>();
    private readonly depths = new Map<string, number>();

    /**
     * Enqueue a task for a given workspace. Tasks for the same workspace
     * execute serially; tasks for different workspaces run concurrently.
     */
    enqueue(workspacePath: string, task: () => Promise<void>): Promise<void> {
        // .catch: ensure a prior rejection never stalls the chain
        const current = (this.queues.get(workspacePath) ?? Promise.resolve()).catch(() => {});
        const next = current.then(async () => {
            try {
                await task();
            } catch (err: unknown) {
                logger.error('[WorkspaceQueue] task error:', (err as Error)?.message || err);
            }
        }).finally(() => {
            // Clean up if this is still the latest promise in the chain
            if (this.queues.get(workspacePath) === next) {
                this.queues.delete(workspacePath);
            }
        });
        this.queues.set(workspacePath, next);
        return next;
    }

    /** Get current queue depth for a workspace. */
    getDepth(workspacePath: string): number {
        return this.depths.get(workspacePath) ?? 0;
    }

    /** Increment queue depth. Returns the new depth. */
    incrementDepth(workspacePath: string): number {
        const current = this.depths.get(workspacePath) ?? 0;
        const next = current + 1;
        this.depths.set(workspacePath, next);
        return next;
    }

    /** Decrement queue depth. Returns the new depth (min 0). Cleans up Map entries when depth reaches 0. */
    decrementDepth(workspacePath: string): number {
        const current = this.depths.get(workspacePath) ?? 1;
        const next = Math.max(0, current - 1);
        if (next === 0) {
            this.depths.delete(workspacePath);
            this.queues.delete(workspacePath);
        } else {
            this.depths.set(workspacePath, next);
        }
        return next;
    }
}
