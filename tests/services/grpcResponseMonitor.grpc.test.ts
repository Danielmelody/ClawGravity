import { EventEmitter } from 'events';
import { GrpcResponseMonitor } from '../../src/services/grpcResponseMonitor';

class FakeGrpcClient extends EventEmitter {
    rawRPC = jest.fn();
    streamCascadeUpdates = jest.fn(() => new AbortController());
}

describe('GrpcResponseMonitor stream-first fallback', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    it('does not fall back to polling when the stream emits an error payload', async () => {
        const client = new FakeGrpcClient();
        const onTimeout = jest.fn();
        const onPhaseChange = jest.fn();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-123',
            onTimeout,
            onPhaseChange,
        });

        await monitor.start();
        client.emit('data', { type: 'error', text: 'schema mismatch' });
        await Promise.resolve();
        await Promise.resolve();

        expect(client.rawRPC).not.toHaveBeenCalled();
        expect(onPhaseChange).toHaveBeenCalledWith('error', 'Stream payload error: schema mismatch');
        expect(onTimeout).toHaveBeenCalledWith('');

        await monitor.stop();
    });

    it('enters thinking phase from streamed planner payloads and completes on idle status', async () => {
        const client = new FakeGrpcClient();
        const progress: string[] = [];
        let completedText = '';
        const onPhaseChange = jest.fn();

        client.rawRPC.mockResolvedValue({
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                steps: [
                    { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'DONE' } },
                ],
            },
        });

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-123',
            onProgress: (text) => progress.push(text),
            onPhaseChange,
            onComplete: (text) => {
                completedText = text;
            },
        });

        await monitor.start();
        client.emit('data', {
            type: 'status',
            text: 'CASCADE_RUN_STATUS_RUNNING',
            raw: {
                result: {
                    plannerResponse: {
                        thinking: '**Analyze**\n\nInspecting the current workspace and tracing the bug.',
                    },
                },
            },
        });
        client.emit('data', {
            type: 'status',
            text: 'CASCADE_RUN_STATUS_IDLE',
            raw: { result: {} },
        });

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve(); // Extra tick for promise chaining

        expect(onPhaseChange).toHaveBeenCalledWith('thinking', null);
        expect(completedText).toBe('DONE');
        expect(client.rawRPC).toHaveBeenCalled();

        await monitor.stop();
    });

    it('passes through thinking deltas on repeated streamed planner payloads', async () => {
        const client = new FakeGrpcClient();
        const onPhaseChange = jest.fn();

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-thinking-delta',
            onPhaseChange,
        });

        await monitor.start();
        client.emit('data', {
            type: 'status',
            text: 'CASCADE_RUN_STATUS_RUNNING',
            raw: {
                result: {
                    plannerResponse: {
                        thinking: 'Analyzed project',
                    },
                },
            },
        });
        client.emit('data', {
            type: 'status',
            text: 'CASCADE_RUN_STATUS_RUNNING',
            raw: {
                result: {
                    plannerResponse: {
                        thinking: 'Analyzed project\nRan command',
                    },
                },
            },
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(onPhaseChange).toHaveBeenCalledWith('thinking', null);
        expect(onPhaseChange).toHaveBeenCalledWith('thinking', 'Analyzed project');
        expect(onPhaseChange).toHaveBeenCalledWith('thinking', 'Ran command');

        await monitor.stop();
    });

    it('emits a unified text stream instead of forcing callers to merge thinking and response', async () => {
        const client = new FakeGrpcClient();
        const onTextUpdate = jest.fn();
        const onPhaseChange = jest.fn();

        client.rawRPC.mockResolvedValue({
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                    { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Final reply' } },
                ],
            },
        });

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-unified-stream',
            expectedUserMessage: 'hi',
            onProgress: onTextUpdate,
            onPhaseChange,
        });

        await monitor.start();
        client.emit('data', {
            type: 'status',
            text: 'CASCADE_RUN_STATUS_RUNNING',
            raw: {
                result: {
                    plannerResponse: {
                        thinking: 'Analyzed project',
                    },
                },
            },
        });
        client.emit('data', { type: 'status', raw: { diff: { fieldDiffs: [{ updateSingular: { stringValue: 'delta' } }] } } });

        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(8);
        // readTrajectorySnapshot is async — flush the microtask queue
        // so applyTrajectorySnapshot runs and fires onProgress
        for (let i = 0; i < 10; i++) await Promise.resolve();

        // Thinking text goes through onPhaseChange, not onTextUpdate
        expect(onPhaseChange).toHaveBeenCalledWith('thinking', null);
        // onTextUpdate only receives trajectory response text
        expect(onTextUpdate).toHaveBeenCalledWith('Final reply');

        await monitor.stop();
    });

    it('recovers a completed response from trajectory when the stream closes before activity', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC.mockResolvedValue({
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                    { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Recovered reply' } },
                ],
            },
        });

        const onComplete = jest.fn();
        const onTimeout = jest.fn();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-123',
            onComplete,
            onTimeout,
        });

        await monitor.start();
        client.emit('complete');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve(); // Extra tick: finishSuccessfully is async (drains timeline pipeline)
        await Promise.resolve(); // Extra tick: stop() promise chain

        expect(client.rawRPC).toHaveBeenCalledWith('GetCascadeTrajectory', { cascadeId: 'cascade-123' });
        expect(onComplete).toHaveBeenCalledWith('Recovered reply');
        expect(onTimeout).not.toHaveBeenCalled();

        await monitor.stop();
    });

    it('retries recovery once when the cascade is still running before completing', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'Recovered after retry' } },
                    ],
                },
            });

        const onComplete = jest.fn();
        const onTimeout = jest.fn();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-123',
            onComplete,
            onTimeout,
        });

        await monitor.start();
        client.emit('complete');
        await Promise.resolve();

        await jest.advanceTimersByTimeAsync(750);

        expect(client.rawRPC).toHaveBeenCalledTimes(2);
        expect(onComplete).toHaveBeenCalledWith('Recovered after retry');
        expect(onTimeout).not.toHaveBeenCalled();

        await monitor.stop();
    });

    it('falls back to trajectory polling after a transport error and streams recovered progress', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Partial reply' } },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Final reply' } },
                    ],
                },
            });

        const onProgress = jest.fn();
        const onComplete = jest.fn();
        const onTimeout = jest.fn();
        const onPhaseChange = jest.fn();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-415',
            onProgress,
            onComplete,
            onTimeout,
            onPhaseChange,
        });

        await monitor.start();
        client.emit('error', new Error('HTTP 415: unsupported media type'));
        await Promise.resolve();
        await Promise.resolve();

        await jest.advanceTimersByTimeAsync(1500);

        expect(client.rawRPC).toHaveBeenCalledTimes(3);
        expect(onProgress).toHaveBeenCalledWith('Partial reply');
        expect(onProgress).toHaveBeenCalledWith('Final reply');
        expect(onComplete).toHaveBeenCalledWith('Final reply');
        expect(onTimeout).not.toHaveBeenCalled();
        expect(onPhaseChange).toHaveBeenCalledWith('thinking', null);
        expect(onPhaseChange).toHaveBeenCalledWith('generating', 'Partial reply');

        await monitor.stop();
    });

    it('fetches a trajectory snapshot on generic diff notifications without the old 300ms lag', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC.mockResolvedValue({
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                    { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Partial reply' } },
                ],
            },
        });

        const onProgress = jest.fn();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-fast-diff',
            expectedUserMessage: 'hi',
            onProgress,
        });

        await monitor.start();
        client.emit('data', { type: 'status', raw: { diff: { fieldDiffs: [{ updateSingular: { stringValue: 'delta' } }] } } });
        await Promise.resolve();

        expect(client.rawRPC).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(8);

        expect(client.rawRPC).toHaveBeenCalledWith('GetCascadeTrajectory', { cascadeId: 'cascade-fast-diff' });
        expect(onProgress).toHaveBeenCalledWith('Partial reply');

        await monitor.stop();
    });

    it('uses the top-level trajectory status when cascadeRunStatus is absent', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC
            .mockResolvedValueOnce({
                status: 'CASCADE_RUN_STATUS_RUNNING',
                trajectory: {
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: '让我看看当前项目的结构！',
                                toolCalls: [{ id: 'tool-1', name: 'list_dir' }],
                            },
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                status: 'CASCADE_RUN_STATUS_IDLE',
                trajectory: {
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: '让我看看当前项目的结构！',
                                toolCalls: [{ id: 'tool-1', name: 'list_dir' }],
                            },
                        },
                        { type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY', listDirectory: {} },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: '完整回复',
                            },
                        },
                    ],
                },
            });

        const onProgress = jest.fn();
        const onComplete = jest.fn();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-top-status',
            expectedUserMessage: 'commit',
            onProgress,
            onComplete,
        });

        await monitor.start();
        client.emit('error', new Error('HTTP 415: unsupported media type'));
        await Promise.resolve();
        await Promise.resolve();

        expect(onProgress).toHaveBeenCalledWith('让我看看当前项目的结构！\n🔧 list_dir');
        expect(onComplete).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(750);

        // Text changes because it now correctly concatenates both assistant steps
        // rather than replacing.
        expect(onProgress).toHaveBeenLastCalledWith('让我看看当前项目的结构！\n🔧 list_dir\n\n完整回复');
        expect(onComplete).toHaveBeenCalledWith('让我看看当前项目的结构！\n🔧 list_dir\n\n完整回复');

        await monitor.stop();
    });

    it('waits for a stable terminal assistant step when trajectory status is missing', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: '让我看看当前项目的结构！',
                                toolCalls: [{ id: 'tool-1', name: 'list_dir' }],
                            },
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: '让我看看当前项目的结构！',
                                toolCalls: [{ id: 'tool-1', name: 'list_dir' }],
                            },
                        },
                        { type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY', listDirectory: {} },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: '完整回复',
                            },
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: '让我看看当前项目的结构！',
                                toolCalls: [{ id: 'tool-1', name: 'list_dir' }],
                            },
                        },
                        { type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY', listDirectory: {} },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: '完整回复',
                            },
                        },
                    ],
                },
            });

        const onComplete = jest.fn();
        const onProgress = jest.fn();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-missing-status',
            expectedUserMessage: 'commit',
            onProgress,
            onComplete,
        });

        await monitor.start();
        client.emit('error', new Error('HTTP 415: unsupported media type'));
        await Promise.resolve();
        await Promise.resolve();

        expect(onProgress).toHaveBeenCalledWith('让我看看当前项目的结构！\n🔧 list_dir');
        expect(onComplete).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(750);

        expect(onProgress).toHaveBeenLastCalledWith('让我看看当前项目的结构！\n🔧 list_dir\n\n完整回复');
        expect(onComplete).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(750);

        expect(onComplete).toHaveBeenCalledWith('让我看看当前项目的结构！\n🔧 list_dir\n\n完整回复');

        await monitor.stop();
    });

    it('does not finalize on an empty assistant placeholder for the anchored user turn', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Previous reply' } },
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: '' } },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Previous reply' } },
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Commit reply' } },
                    ],
                },
            });

        const onComplete = jest.fn();
        const onTimeout = jest.fn();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-empty-placeholder',
            expectedUserMessage: 'commit',
            onComplete,
            onTimeout,
        });

        await monitor.start();
        client.emit('error', new Error('HTTP 415: unsupported media type'));
        await Promise.resolve();
        await Promise.resolve();

        expect(onComplete).not.toHaveBeenCalled();
        expect(onTimeout).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(750);

        expect(client.rawRPC).toHaveBeenCalledTimes(2);
        expect(onComplete).toHaveBeenCalledWith('Commit reply');
        expect(onTimeout).not.toHaveBeenCalled();

        await monitor.stop();
    });

    it('waits for the anchored user turn instead of completing the previous response', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Previous reply' } },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Previous reply' } },
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Previous reply' } },
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Commit reply' } },
                    ],
                },
            });

        const onComplete = jest.fn();
        const onTimeout = jest.fn();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-anchor-wait',
            expectedUserMessage: 'commit',
            onComplete,
            onTimeout,
        });

        await monitor.start();
        client.emit('error', new Error('HTTP 415: unsupported media type'));
        await Promise.resolve();
        await Promise.resolve();

        expect(onComplete).not.toHaveBeenCalled();
        expect(onTimeout).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1500);

        expect(client.rawRPC).toHaveBeenCalledTimes(3);
        expect(onComplete).toHaveBeenCalledWith('Commit reply');
        expect(onComplete).not.toHaveBeenCalledWith('Previous reply');
        expect(onTimeout).not.toHaveBeenCalled();

        await monitor.stop();
    });

    it('keeps polling past the old recovery grace window before completing', async () => {
        const client = new FakeGrpcClient();
        let pollCount = 0;
        client.rawRPC.mockImplementation(async () => {
            pollCount += 1;

            if (pollCount <= 4) {
                return {
                    trajectory: {
                        cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                        steps: [
                            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        ],
                    },
                };
            }

            if (pollCount === 5) {
                return {
                    trajectory: {
                        cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                        steps: [
                            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        ],
                    },
                };
            }

            return {
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Late reply' } },
                    ],
                },
            };
        });

        const onComplete = jest.fn();
        const onTimeout = jest.fn();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-slow-fallback',
            maxDurationMs: 15_000,
            onComplete,
            onTimeout,
        });

        await monitor.start();
        client.emit('error', new Error('HTTP 415: unsupported media type'));
        await Promise.resolve();
        await Promise.resolve();

        // Exponential backoff timing:
        // 0 -> start
        // 500ms -> retry 1
        // 1000ms -> retry 2
        // 2000ms -> retry 3
        // 4000ms -> retry 4
        // 4000ms -> retry 5
        // Total time ~11.5s for 5 retries. We need more time to reach all 6 calls.
        await jest.advanceTimersByTimeAsync(25_000);

        // The mock expects 6 calls.
        expect(client.rawRPC).toHaveBeenCalledTimes(6);
        expect(onComplete).toHaveBeenCalledWith('Late reply');
        expect(onTimeout).not.toHaveBeenCalled();

        await monitor.stop();
    });

    it('renders timeline snapshots once per unique trajectory state', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC.mockResolvedValue({
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                    { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Partial reply' } },
                ],
            },
        });

        const trajectoryRenderer = {
            renderTrajectory: jest.fn().mockResolvedValue({
                ok: true,
                content: '<blockquote>Rendered timeline</blockquote>',
                format: 'html',
            }),
        };
        const onRenderedTimeline = jest.fn();

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-rendered-timeline',
            expectedUserMessage: 'commit',
            trajectoryRenderer: trajectoryRenderer as any,
            onRenderedTimeline,
        });

        await monitor.start();
        client.emit('error', new Error('HTTP 415: unsupported media type'));
        await Promise.resolve();
        await Promise.resolve();

        await jest.advanceTimersByTimeAsync(1600);

        expect(trajectoryRenderer.renderTrajectory).toHaveBeenCalledTimes(1);
        expect(trajectoryRenderer.renderTrajectory).toHaveBeenCalledWith({
            steps: [
                { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Partial reply' } },
            ],
            runStatus: 'CASCADE_RUN_STATUS_RUNNING',
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                    { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Partial reply' } },
                ],
            },
            format: 'html',
        });
        expect(onRenderedTimeline).toHaveBeenCalledTimes(1);
        expect(onRenderedTimeline).toHaveBeenCalledWith({
            content: '<blockquote>Rendered timeline</blockquote>',
            format: 'html',
            strategy: undefined,
            contextId: undefined,
        });

        await monitor.stop();
    });

    it('renders timeline while the cascade is still running on RUNNING status events', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC.mockResolvedValue({
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'review code' } },
                    {
                        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                        plannerResponse: {
                            thinking: 'Analyzed project',
                            response: '',
                        },
                    },
                ],
            },
        });

        const trajectoryRenderer = {
            renderTrajectory: jest.fn().mockResolvedValue({
                ok: true,
                content: '<blockquote>Analyzed project</blockquote>',
                format: 'html',
            }),
        };
        const onRenderedTimeline = jest.fn();

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-running-html',
            expectedUserMessage: 'review code',
            trajectoryRenderer: trajectoryRenderer as any,
            onRenderedTimeline,
        });

        await monitor.start();
        client.emit('data', {
            type: 'status',
            text: 'CASCADE_RUN_STATUS_RUNNING',
            raw: {
                result: {
                    plannerResponse: {
                        thinking: 'Analyzed project',
                    },
                },
            },
        });

        await jest.advanceTimersByTimeAsync(8);
        // readTrajectorySnapshot + TimelineRenderPipeline.runRender are deeply async
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(trajectoryRenderer.renderTrajectory).toHaveBeenCalledTimes(1);
        expect(onRenderedTimeline).toHaveBeenCalledWith({
            content: '<blockquote>Analyzed project</blockquote>',
            format: 'html',
            strategy: undefined,
            contextId: undefined,
        });

        await monitor.stop();
    });

    it('re-renders timeline when the same step grows in place', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'review cdpService.ts' } },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                thinking: 'Reading the file.',
                                response: '',
                            },
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'review cdpService.ts' } },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                thinking: 'Reading the file.\nAnalyzed cdpService.ts #L1-800',
                                response: '',
                            },
                        },
                    ],
                },
            });

        const trajectoryRenderer = {
            renderTrajectory: jest.fn()
                .mockResolvedValueOnce({
                    ok: true,
                    content: '<blockquote>Reading the file.</blockquote>',
                    format: 'html',
                })
                .mockResolvedValueOnce({
                    ok: true,
                    content: '<blockquote>Reading the file.<br>Analyzed cdpService.ts #L1-800</blockquote>',
                    format: 'html',
                }),
        };
        const onRenderedTimeline = jest.fn();

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-timeline-streaming',
            expectedUserMessage: 'review cdpService.ts',
            trajectoryRenderer: trajectoryRenderer as any,
            onRenderedTimeline,
        });

        await monitor.start();

        client.emit('data', { type: 'status', text: 'DIFF_1', raw: { result: {} } });
        await jest.advanceTimersByTimeAsync(350);
        await Promise.resolve();

        client.emit('data', { type: 'status', text: 'DIFF_2', raw: { result: {} } });
        await jest.advanceTimersByTimeAsync(350);
        await Promise.resolve();

        expect(trajectoryRenderer.renderTrajectory).toHaveBeenCalledTimes(2);
        expect(onRenderedTimeline).toHaveBeenCalledTimes(2);
        expect(onRenderedTimeline).toHaveBeenNthCalledWith(1, {
            content: '<blockquote>Reading the file.</blockquote>',
            format: 'html',
            strategy: undefined,
            contextId: undefined,
        });
        expect(onRenderedTimeline).toHaveBeenNthCalledWith(2, {
            content: '<blockquote>Reading the file.<br>Analyzed cdpService.ts #L1-800</blockquote>',
            format: 'html',
            strategy: undefined,
            contextId: undefined,
        });

        await monitor.stop();
    });

    it('re-opens stream after recovery exhaustion when cascade is still running', async () => {
        const client = new FakeGrpcClient();
        // All 8 recovery polls return RUNNING with no assistant response yet
        client.rawRPC.mockResolvedValue({
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                ],
            },
        });

        const onComplete = jest.fn();
        const onTimeout = jest.fn();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-reopen',
            maxDurationMs: 60_000,
            onComplete,
            onTimeout,
        });

        await monitor.start();
        // Stream closes before any activity → enters recovery
        client.emit('complete');
        await Promise.resolve();
        await Promise.resolve();

        // Exhaust all 8 recovery retries (500 + 1000 + 2000 + 4000*5 = ~23.5s)
        await jest.advanceTimersByTimeAsync(30_000);

        expect(client.rawRPC).toHaveBeenCalledTimes(8);
        expect(onComplete).not.toHaveBeenCalled();
        expect(onTimeout).not.toHaveBeenCalled();

        // After exhaustion, streamCascadeUpdates should be called AGAIN (re-opened stream)
        // Initial call = 1, re-open = 2
        expect(client.streamCascadeUpdates).toHaveBeenCalledTimes(2);

        // Now simulate the re-opened stream delivering events
        client.emit('data', { type: 'status', text: 'CASCADE_RUN_STATUS_RUNNING' });

        // Update mock to return completed response
        client.rawRPC.mockResolvedValue({
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                    { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Full response after re-open' } },
                ],
            },
        });

        client.emit('data', { type: 'status', text: 'CASCADE_RUN_STATUS_IDLE' });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(onComplete).toHaveBeenCalledWith('Full response after re-open');
        expect(onTimeout).not.toHaveBeenCalled();

        await monitor.stop();
    });
});
