import { EventEmitter } from 'events';
import { GrpcResponseMonitor } from '../../src/services/grpcResponseMonitor';

class FakeGrpcClient extends EventEmitter {
    rawRPC = jest.fn().mockResolvedValue({
        trajectory: {
            steps: [],
            cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
        },
    });

    streamCascadeUpdates = jest.fn(() => new AbortController());
}

describe('GrpcResponseMonitor stream fallback', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    it('switches to polling when the stream emits an error payload', async () => {
        const client = new FakeGrpcClient();
        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-123',
        });

        await monitor.start();
        client.emit('data', { type: 'error', text: 'schema mismatch' });
        await Promise.resolve();
        await Promise.resolve();

        expect(client.rawRPC).toHaveBeenCalledWith('GetCascadeTrajectory', {
            cascadeId: 'cascade-123',
        });

        await monitor.stop();
    });

    it('emits planner thinking details during polling fallback', async () => {
        const client = new FakeGrpcClient();
        const logs: string[] = [];
        const progress: string[] = [];
        let completedText = '';

        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_USER_INPUT',
                            userInput: { userResponse: 'debug this' },
                        },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                thinking: '**Analyze**\n\nInspecting the current workspace and tracing the bug.',
                            },
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_USER_INPUT',
                            userInput: { userResponse: 'debug this' },
                        },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                thinking: '**Analyze**\n\nInspecting the current workspace and tracing the bug.',
                                modifiedResponse: 'DONE',
                                response: 'DONE',
                            },
                        },
                    ],
                },
            });

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
        client.emit('error', new Error('415'));
        await Promise.resolve();
        await Promise.resolve();

        expect(logs.join('\n')).toContain('Inspecting the current workspace');

        await jest.advanceTimersByTimeAsync(1500);

        expect(progress).toContain('DONE');
        expect(completedText).toBe('DONE');

        await monitor.stop();
    });

    it('renders known tools with prettier summaries and still reports results', async () => {
        const client = new FakeGrpcClient();
        const logs: string[] = [];
        let completedText = '';

        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_USER_INPUT',
                            userInput: { userResponse: 'find monitor' },
                        },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
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
                        {
                            type: 'CORTEX_STEP_TYPE_FIND',
                            status: 'CORTEX_STEP_STATUS_DONE',
                            metadata: {
                                toolCall: {
                                    name: 'find_by_name',
                                    argumentsJson: JSON.stringify({
                                        Pattern: '*grpcResponseMonitor*',
                                        SearchDirectory: 'c:\\repo',
                                        SearchType: 'file',
                                    }),
                                },
                            },
                            find: {
                                pattern: '*grpcResponseMonitor*',
                                searchDirectory: 'c:\\repo',
                                totalResults: 3,
                            },
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_USER_INPUT',
                            userInput: { userResponse: 'find monitor' },
                        },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: 'DONE',
                                modifiedResponse: 'DONE',
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
                        {
                            type: 'CORTEX_STEP_TYPE_FIND',
                            status: 'CORTEX_STEP_STATUS_DONE',
                            metadata: {
                                toolCall: {
                                    name: 'find_by_name',
                                    argumentsJson: JSON.stringify({
                                        Pattern: '*grpcResponseMonitor*',
                                        SearchDirectory: 'c:\\repo',
                                        SearchType: 'file',
                                    }),
                                },
                            },
                            find: {
                                pattern: '*grpcResponseMonitor*',
                                searchDirectory: 'c:\\repo',
                                totalResults: 3,
                            },
                        },
                    ],
                },
            });

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-123',
            onProcessLog: (text) => logs.push(text),
            onComplete: (text) => {
                completedText = text;
            },
        });

        await monitor.start();
        client.emit('error', new Error('415'));
        await Promise.resolve();
        await Promise.resolve();

        expect(logs).toContain('📂 Finding files matching "*grpcResponseMonitor*" in repo');
        expect(logs).toContain('📂 Found 3 files matching "*grpcResponseMonitor*" in repo');

        await jest.advanceTimersByTimeAsync(1500);

        expect(completedText).toBe('DONE');

        await monitor.stop();
    });

    it('falls back to raw tool summaries for unknown tools', async () => {
        const client = new FakeGrpcClient();
        const logs: string[] = [];
        let completedText = '';

        client.rawRPC
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_USER_INPUT',
                            userInput: { userResponse: 'do mystery work' },
                        },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
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
                    ],
                },
            })
            .mockResolvedValueOnce({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_USER_INPUT',
                            userInput: { userResponse: 'do mystery work' },
                        },
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: 'DONE',
                                modifiedResponse: 'DONE',
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
                    ],
                },
            });

        const monitor = new GrpcResponseMonitor({
            grpcClient: client as any,
            cascadeId: 'cascade-unknown',
            onProcessLog: (text) => logs.push(text),
            onComplete: (text) => {
                completedText = text;
            },
        });

        await monitor.start();
        client.emit('error', new Error('415'));
        await Promise.resolve();
        await Promise.resolve();

        expect(logs).toContain('🛠️ Tool mystery_tool: foo=bar | target=alpha');

        await jest.advanceTimersByTimeAsync(1500);

        expect(completedText).toBe('DONE');

        await monitor.stop();
    });
});
