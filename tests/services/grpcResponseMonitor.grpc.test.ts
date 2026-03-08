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
        expect(onPhaseChange).toHaveBeenCalledWith('error', null);
        expect(onTimeout).toHaveBeenCalledWith('');

        await monitor.stop();
    });

    it('emits planner thinking details from streamed payloads and completes on idle status', async () => {
        const client = new FakeGrpcClient();
        const logs: string[] = [];
        const progress: string[] = [];
        let completedText = '';

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-123',
            onProcessLog: (text) => logs.push(text),
            onProgress: (text) => progress.push(text),
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
            type: 'text',
            text: 'DONE',
            raw: { result: {} },
        });
        client.emit('data', {
            type: 'status',
            text: 'CASCADE_RUN_STATUS_IDLE',
            raw: { result: {} },
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(logs.join('\n')).toContain('Inspecting the current workspace');
        expect(progress).toContain('DONE');
        expect(completedText).toBe('DONE');
        expect(client.rawRPC).not.toHaveBeenCalled();

        await monitor.stop();
    });

    it('renders known tools with prettier summaries from streamed planner payloads', async () => {
        const client = new FakeGrpcClient();
        const logs: string[] = [];
        let completedText = '';

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-123',
            onProcessLog: (text) => logs.push(text),
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
                        toolCalls: [
                            {
                                id: 'tool-1',
                                name: 'find_by_name',
                                argumentsJson: JSON.stringify({
                                    Pattern: '*grpcResponseMonitor*',
                                    SearchDirectory: 'c:\\repo',
                                    SearchType: 'file',
                                }),
                            },
                        ],
                    },
                },
            },
        });
        client.emit('data', {
            type: 'text',
            text: 'DONE',
            raw: { result: {} },
        });
        client.emit('data', {
            type: 'status',
            text: 'CASCADE_RUN_STATUS_IDLE',
            raw: { result: {} },
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(logs).toContain('📂 Finding files matching "*grpcResponseMonitor*" in repo');
        expect(completedText).toBe('DONE');
        expect(client.rawRPC).not.toHaveBeenCalled();

        await monitor.stop();
    });

    it('falls back to raw tool summaries for unknown tools from streamed payloads', async () => {
        const client = new FakeGrpcClient();
        const logs: string[] = [];
        let completedText = '';

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-unknown',
            onProcessLog: (text) => logs.push(text),
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
                        toolCalls: [
                            {
                                id: 'mystery-1',
                                name: 'mystery_tool',
                                argumentsJson: JSON.stringify({
                                    foo: 'bar',
                                    target: 'alpha',
                                }),
                            },
                        ],
                    },
                },
            },
        });
        client.emit('data', {
            type: 'text',
            text: 'DONE',
            raw: { result: {} },
        });
        client.emit('data', {
            type: 'status',
            text: 'CASCADE_RUN_STATUS_IDLE',
            raw: { result: {} },
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(logs).toContain('🛠️ Tool mystery_tool: foo=bar | target=alpha');
        expect(completedText).toBe('DONE');
        expect(client.rawRPC).not.toHaveBeenCalled();

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

    it('keeps polling past the old recovery grace window before completing', async () => {
        const client = new FakeGrpcClient();
        let pollCount = 0;
        client.rawRPC.mockImplementation(async () => {
            pollCount += 1;

            if (pollCount <= 8) {
                return {
                    trajectory: {
                        cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                        steps: [
                            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
                        ],
                    },
                };
            }

            if (pollCount === 9) {
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

        await jest.advanceTimersByTimeAsync(7_500);

        expect(client.rawRPC).toHaveBeenCalledTimes(10);
        expect(onComplete).toHaveBeenCalledWith('Late reply');
        expect(onTimeout).not.toHaveBeenCalled();

        await monitor.stop();
    });
});
