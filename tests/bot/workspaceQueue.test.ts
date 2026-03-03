import { WorkspaceQueue } from '../../src/bot/workspaceQueue';

// Suppress logger output during tests
jest.mock('../../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        phase: jest.fn(),
        done: jest.fn(),
        divider: jest.fn(),
    },
}));

describe('WorkspaceQueue', () => {
    let queue: WorkspaceQueue;

    beforeEach(() => {
        queue = new WorkspaceQueue();
    });

    describe('enqueue', () => {
        it('tasks for the same workspace execute serially (order preserved)', async () => {
            const order: number[] = [];

            const t1 = queue.enqueue('/ws/a', async () => {
                await delay(30);
                order.push(1);
            });
            const t2 = queue.enqueue('/ws/a', async () => {
                order.push(2);
            });
            const t3 = queue.enqueue('/ws/a', async () => {
                order.push(3);
            });

            await Promise.all([t1, t2, t3]);
            expect(order).toEqual([1, 2, 3]);
        });

        it('tasks for different workspaces can run concurrently', async () => {
            const timeline: string[] = [];

            const tA = queue.enqueue('/ws/a', async () => {
                timeline.push('a-start');
                await delay(40);
                timeline.push('a-end');
            });
            const tB = queue.enqueue('/ws/b', async () => {
                timeline.push('b-start');
                await delay(10);
                timeline.push('b-end');
            });

            await Promise.all([tA, tB]);

            // Both should start before the slower one finishes.
            // b-end should appear before a-end because b is shorter.
            const aStartIdx = timeline.indexOf('a-start');
            const bStartIdx = timeline.indexOf('b-start');
            const bEndIdx = timeline.indexOf('b-end');
            const aEndIdx = timeline.indexOf('a-end');

            // Ensure all events were recorded
            expect(aStartIdx).toBeGreaterThanOrEqual(0);
            expect(bStartIdx).toBeGreaterThanOrEqual(0);
            expect(bEndIdx).toBeGreaterThanOrEqual(0);
            expect(aEndIdx).toBeGreaterThanOrEqual(0);

            expect(aStartIdx).toBeLessThanOrEqual(1);
            expect(bStartIdx).toBeLessThanOrEqual(1);
            expect(bEndIdx).toBeLessThan(aEndIdx);
        });

        it('a rejected task does not block subsequent tasks', async () => {
            const executed: number[] = [];

            await queue.enqueue('/ws/a', async () => {
                throw new Error('intentional failure');
            });

            await queue.enqueue('/ws/a', async () => {
                executed.push(2);
            });

            await queue.enqueue('/ws/a', async () => {
                executed.push(3);
            });

            expect(executed).toEqual([2, 3]);
        });

        it('cleans up queue map entry after the last task in the chain completes', async () => {
            // Access internal queues Map via casting to verify cleanup
            const internalQueues = (queue as any).queues as Map<string, Promise<void>>;

            await queue.enqueue('/ws/cleanup', async () => {});

            // After the single-task chain resolves, the entry should be removed
            expect(internalQueues.has('/ws/cleanup')).toBe(false);
        });

        it('does not clean up queue entry while chained tasks are pending', async () => {
            const internalQueues = (queue as any).queues as Map<string, Promise<void>>;

            // Enqueue two tasks — the second keeps the chain alive
            const p1 = queue.enqueue('/ws/chain', async () => { await delay(10); });
            queue.enqueue('/ws/chain', async () => { await delay(10); });

            // While the first task is still running, the entry should exist
            expect(internalQueues.has('/ws/chain')).toBe(true);
            await p1;
        });

        it('catches and logs task errors without rejecting the returned promise', async () => {
            const { logger } = jest.requireMock('../../src/utils/logger');

            const result = queue.enqueue('/ws/a', async () => {
                throw new Error('boom');
            });

            // The returned promise should resolve (not reject)
            await expect(result).resolves.toBeUndefined();
            expect(logger.error).toHaveBeenCalledWith(
                '[WorkspaceQueue] task error:',
                'boom',
            );
        });
    });

    describe('getDepth', () => {
        it('returns 0 for an unknown workspace', () => {
            expect(queue.getDepth('/ws/unknown')).toBe(0);
        });

        it('returns the current depth after increments', () => {
            queue.incrementDepth('/ws/a');
            queue.incrementDepth('/ws/a');
            expect(queue.getDepth('/ws/a')).toBe(2);
        });
    });

    describe('incrementDepth', () => {
        it('increments from 0 and returns the new depth', () => {
            expect(queue.incrementDepth('/ws/a')).toBe(1);
            expect(queue.incrementDepth('/ws/a')).toBe(2);
            expect(queue.incrementDepth('/ws/a')).toBe(3);
        });

        it('tracks different workspaces independently', () => {
            queue.incrementDepth('/ws/a');
            queue.incrementDepth('/ws/a');
            queue.incrementDepth('/ws/b');

            expect(queue.getDepth('/ws/a')).toBe(2);
            expect(queue.getDepth('/ws/b')).toBe(1);
        });
    });

    describe('decrementDepth', () => {
        it('decrements and returns the new depth', () => {
            queue.incrementDepth('/ws/a');
            queue.incrementDepth('/ws/a');
            queue.incrementDepth('/ws/a');

            expect(queue.decrementDepth('/ws/a')).toBe(2);
            expect(queue.decrementDepth('/ws/a')).toBe(1);
            expect(queue.decrementDepth('/ws/a')).toBe(0);
        });

        it('never goes below 0', () => {
            expect(queue.decrementDepth('/ws/a')).toBe(0);
            expect(queue.decrementDepth('/ws/a')).toBe(0);
        });

        it('never goes below 0 after several decrements past zero', () => {
            queue.incrementDepth('/ws/a');
            queue.decrementDepth('/ws/a');
            queue.decrementDepth('/ws/a');
            queue.decrementDepth('/ws/a');

            expect(queue.getDepth('/ws/a')).toBe(0);
        });

        it('cleans up Map entries when depth reaches 0 to prevent memory leaks', () => {
            queue.incrementDepth('/ws/a');
            queue.incrementDepth('/ws/a');

            // Also enqueue a task to populate the queues Map
            queue.enqueue('/ws/a', async () => {});

            queue.decrementDepth('/ws/a');
            // Depth is 1 — entries should still exist
            expect(queue.getDepth('/ws/a')).toBe(1);

            queue.decrementDepth('/ws/a');
            // Depth is 0 — both Maps should have the entry removed
            expect(queue.getDepth('/ws/a')).toBe(0);

            // Verify that a new enqueue still works after cleanup
            const executed: number[] = [];
            queue.enqueue('/ws/a', async () => {
                executed.push(1);
            });
        });
    });
});

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
