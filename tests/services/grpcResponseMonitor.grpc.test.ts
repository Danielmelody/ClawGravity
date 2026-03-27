import { EventEmitter } from 'events';
import { GrpcResponseMonitor } from '../../src/services/grpcResponseMonitor';

class FakeGrpcClient extends EventEmitter {
    rawRPC = jest.fn();
}

describe('GrpcResponseMonitor polling', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    it('polls repeatedly and enters thinking phase', async () => {
        const client = new FakeGrpcClient();
        const progress: string[] = [];
        let completedText = '';
        const onPhaseChange = jest.fn();

        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                thinking: '**Analyze**\\n\\nInspecting the current workspace and tracing the bug.',
                            },
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'DONE' } },
                    ],
                },
            });

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-123',
            expectedUserMessage: 'hi',
            onProgress: (text) => progress.push(text),
            onPhaseChange,
            onComplete: (text) => {
                completedText = text;
            },
        });

        await monitor.start();
        await Promise.resolve();
        await Promise.resolve();

        // 1st poll (immediate)
        expect(client.rawRPC).toHaveBeenCalledTimes(1);
        expect(onPhaseChange).toHaveBeenCalledWith('thinking', null);
        expect(onPhaseChange).toHaveBeenCalledWith('thinking', '**Analyze**\\n\\nInspecting the current workspace and tracing the bug.');

        // 2nd poll (T=500ms)
        await jest.advanceTimersByTimeAsync(500);
        expect(client.rawRPC).toHaveBeenCalledTimes(2);

        expect(completedText).toBe('DONE');

        await monitor.stop();
    });

    it('emits unified text stream instead of forcing callers to merge thinking and response', async () => {
        const client = new FakeGrpcClient();
        const onTextUpdate = jest.fn();
        const onPhaseChange = jest.fn();

        client.rawRPC.mockResolvedValue({
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                    {
                        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                        plannerResponse: {
                            thinking: 'Analyzed project',
                        },
                    },
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
        await jest.advanceTimersByTimeAsync(500);

        // Thinking text goes through onPhaseChange, not onTextUpdate
        expect(onPhaseChange).toHaveBeenCalledWith('thinking', null);
        expect(onPhaseChange).toHaveBeenCalledWith('thinking', 'Analyzed project');
        // onTextUpdate only receives trajectory response text
        expect(onTextUpdate).toHaveBeenCalledWith('Final reply');

        await monitor.stop();
    });

    it('recovers a completed response from trajectory', async () => {
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
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-123',
            expectedUserMessage: 'hi',
            onComplete,
        });

        await monitor.start();
        await Promise.resolve();
        await Promise.resolve();
        expect(client.rawRPC).toHaveBeenCalledTimes(1);
        expect(onComplete).toHaveBeenCalledWith('Recovered reply');

        await monitor.stop();
    });

    it('keeps polling when the cascade is still running before completing', async () => {
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
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-123',
            expectedUserMessage: 'hi',
            onComplete,
        });

        await monitor.start();
        await Promise.resolve();
        await Promise.resolve();
        
        // T=0: first poll (immediate) using mockResolvedValueOnce 1 (RUNNING)
        expect(client.rawRPC).toHaveBeenCalledTimes(1);
        expect(onComplete).not.toHaveBeenCalled();

        // T=500: second poll using mockResolvedValueOnce 2 (IDLE)
        await jest.advanceTimersByTimeAsync(500);
        expect(client.rawRPC).toHaveBeenCalledTimes(2);
        expect(onComplete).toHaveBeenCalledWith('Recovered after retry');

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
        await Promise.resolve();
        await Promise.resolve();
        
        // T=0: first poll (immediate) using mockResolvedValueOnce 1 (RUNNING)
        expect(onProgress).toHaveBeenCalledWith('让我看看当前项目的结构！');
        expect(onComplete).not.toHaveBeenCalled();

        // T=500: second poll using mockResolvedValueOnce 2 (IDLE and aggregated string)
        await jest.advanceTimersByTimeAsync(500);

        // Text changes because it now correctly concatenates both assistant steps
        // rather than replacing.
        expect(onProgress).toHaveBeenCalledWith('让我看看当前项目的结构！\n\n完整回复');
        expect(onComplete).toHaveBeenCalledWith('让我看看当前项目的结构！\n\n完整回复');

        await monitor.stop();
    });

    it('does not finalize on an empty assistant placeholder for the anchored user turn', async () => {
        const client = new FakeGrpcClient();
        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE', // Antigravity sometimes sends IDLE prematurely
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

        // T=0: first poll (immediate) using mockResolvedValueOnce 1.
        expect(client.rawRPC).toHaveBeenCalledTimes(1);
        expect(onComplete).not.toHaveBeenCalled();
        expect(onTimeout).not.toHaveBeenCalled();

        // T=500: second poll using mockResolvedValueOnce 2.
        await jest.advanceTimersByTimeAsync(500);

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

        // T=0: first poll (immediate) using mockResolvedValueOnce 1
        expect(client.rawRPC).toHaveBeenCalledTimes(1);
        expect(onComplete).not.toHaveBeenCalled();
        expect(onTimeout).not.toHaveBeenCalled();

        // T=500: second poll using mockResolvedValueOnce 2 (RUNNING)
        await jest.advanceTimersByTimeAsync(500);
        expect(client.rawRPC).toHaveBeenCalledTimes(2);
        expect(onComplete).not.toHaveBeenCalled();
        expect(onTimeout).not.toHaveBeenCalled();

        // T=1000: third poll using mockResolvedValueOnce 3 (IDLE with commit reply)
        await jest.advanceTimersByTimeAsync(500);
        expect(client.rawRPC).toHaveBeenCalledTimes(3);
        expect(onComplete).toHaveBeenCalledWith('Commit reply');
        expect(onComplete).not.toHaveBeenCalledWith('Previous reply');

        await monitor.stop();
    });

    it('continues step and text updates after the anchor disappears from a truncated trajectory', async () => {
        const client = new FakeGrpcClient();
        const onProgress = jest.fn();
        const onStepsUpdate = jest.fn();
        const onComplete = jest.fn();

        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: { response: 'Preparing patch' },
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: { response: 'Preparing patch' },
                        },
                        {
                            type: 'CORTEX_STEP_TYPE_RESPONSE',
                            assistantResponse: { text: 'Applying fix after truncation' },
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: { response: 'Preparing patch' },
                        },
                        {
                            type: 'CORTEX_STEP_TYPE_RESPONSE',
                            assistantResponse: { text: 'Final reply after truncation' },
                        },
                    ],
                },
            });

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-truncated-tail',
            expectedUserMessage: 'commit',
            onProgress,
            onStepsUpdate,
            onComplete,
        });

        await monitor.start();
        await Promise.resolve();
        await Promise.resolve();

        expect(onProgress).toHaveBeenCalledWith('Preparing patch');
        expect(onStepsUpdate).toHaveBeenNthCalledWith(1, {
            steps: [
                { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    plannerResponse: { response: 'Preparing patch' },
                },
            ],
            runStatus: 'CASCADE_RUN_STATUS_RUNNING',
        });

        await jest.advanceTimersByTimeAsync(500);

        expect(onProgress).toHaveBeenLastCalledWith('Preparing patch\n\nApplying fix after truncation');
        expect(onStepsUpdate).toHaveBeenNthCalledWith(2, {
            steps: [
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    plannerResponse: { response: 'Preparing patch' },
                },
                {
                    type: 'CORTEX_STEP_TYPE_RESPONSE',
                    assistantResponse: { text: 'Applying fix after truncation' },
                },
            ],
            runStatus: 'CASCADE_RUN_STATUS_RUNNING',
        });

        await jest.advanceTimersByTimeAsync(500);

        expect(onComplete).toHaveBeenCalledWith('Preparing patch\n\nFinal reply after truncation');

        await monitor.stop();
    });

    it('emits sliced render steps instead of the full historical trajectory', async () => {
        const client = new FakeGrpcClient();
        const onStepsUpdate = jest.fn();

        client.rawRPC.mockResolvedValue({
            trajectory: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                steps: [
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'older prompt' } },
                    { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Older reply' } },
                    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                    { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Current reply' } },
                ],
            },
        });

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-render-slice',
            expectedUserMessage: 'commit',
            onStepsUpdate,
        });

        await monitor.start();
        await Promise.resolve();
        await Promise.resolve();

        expect(onStepsUpdate).toHaveBeenCalledWith({
            steps: [
                { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit' } },
                { type: 'CORTEX_STEP_TYPE_RESPONSE', assistantResponse: { text: 'Current reply' } },
            ],
            runStatus: 'CASCADE_RUN_STATUS_RUNNING',
        });

        await monitor.stop();
    });

    it('emits onTimeout if maxDurationMs is reached', async () => {
        const client = new FakeGrpcClient();
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
            cascadeId: 'cascade-timeout',
            expectedUserMessage: 'hi',
            maxDurationMs: 2000,
            onComplete,
            onTimeout,
        });

        await monitor.start();

        await jest.advanceTimersByTimeAsync(2500);

        expect(client.rawRPC).toHaveBeenCalledTimes(4); // 500, 1000, 1500, 2000
        expect(onComplete).not.toHaveBeenCalled();
        expect(onTimeout).toHaveBeenCalledWith('');

        await monitor.stop();
    });
});
