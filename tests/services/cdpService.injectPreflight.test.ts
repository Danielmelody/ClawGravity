import { CdpService } from '../../src/services/cdpService';

describe('CdpService injection preflight', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('surfaces the last gRPC initialization error instead of the generic injection failure', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });

        (service as any).lastGrpcUnavailableReason =
            'gRPC unavailable: could not match workspace "antigravity-tunnel" to a Language Server process.';
        jest.spyOn(service as any, 'ensureGrpcClient').mockResolvedValue(null);

        const result = await service.injectMessage('hi');

        expect(result).toMatchObject({
            ok: false,
            error: 'gRPC unavailable: could not match workspace "antigravity-tunnel" to a Language Server process.',
        });
    });

    it('returns a plan review error when the active cascade is waiting in planning mode', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            rawRPC: jest.fn().mockResolvedValue({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: 'Plan: take a screenshot and inspect the page before proceeding.',
                                toolCalls: [{ name: 'mcp_chrome-devtools-mcp_take_screenshot' }],
                            },
                        },
                    ],
                },
            }),
            sendMessage: jest.fn(),
            createCascade: jest.fn(),
        };

        jest.spyOn(service as any, 'ensureGrpcClient').mockResolvedValue(mockClient);
        jest.spyOn(service, 'getActiveCascadeId').mockResolvedValue('cascade-plan-1');

        const result = await service.injectMessage('hi');

        expect(result).toMatchObject({
            ok: false,
            cascadeId: 'cascade-plan-1',
        });
        expect(result.error).toContain('Waiting for plan review');
        expect(result.error).toContain('mcp_chrome-devtools-mcp_take_screenshot');
        expect(mockClient.sendMessage).not.toHaveBeenCalled();
        expect(mockClient.createCascade).not.toHaveBeenCalled();
    });

    it('returns an approval error when the active cascade is waiting on a tool approval', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            rawRPC: jest.fn().mockResolvedValue({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_RESPONSE',
                            plannerResponse: {
                                toolCalls: [{ name: 'write_file' }],
                            },
                        },
                    ],
                },
            }),
            sendMessage: jest.fn(),
            createCascade: jest.fn(),
        };

        jest.spyOn(service as any, 'ensureGrpcClient').mockResolvedValue(mockClient);
        jest.spyOn(service, 'getActiveCascadeId').mockResolvedValue('cascade-approval-1');

        const result = await service.injectMessage('hi');

        expect(result).toMatchObject({
            ok: false,
            cascadeId: 'cascade-approval-1',
        });
        expect(result.error).toContain('Waiting for tool approval');
        expect(result.error).toContain('write_file');
        expect(mockClient.sendMessage).not.toHaveBeenCalled();
        expect(mockClient.createCascade).not.toHaveBeenCalled();
    });

    it('returns a run command confirmation error instead of a planning error for pending terminal commands', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            rawRPC: jest.fn().mockResolvedValue({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: 'Plan: inspect the repo and then run the suggested command.',
                                toolCalls: [{ name: 'task_boundary' }, { name: 'run_command' }],
                            },
                        },
                    ],
                },
            }),
            sendMessage: jest.fn(),
            createCascade: jest.fn(),
        };

        jest.spyOn(service as any, 'ensureGrpcClient').mockResolvedValue(mockClient);
        jest.spyOn(service, 'getActiveCascadeId').mockResolvedValue('cascade-run-command-1');

        const result = await service.injectMessage('hi');

        expect(result).toMatchObject({
            ok: false,
            cascadeId: 'cascade-run-command-1',
        });
        expect(result.error).toContain('Waiting for command confirmation');
        expect(result.error).toContain('run_command');
        expect(result.error).toContain('task_boundary');
        expect(result.error).not.toContain('Waiting for plan review');
        expect(mockClient.sendMessage).not.toHaveBeenCalled();
        expect(mockClient.createCascade).not.toHaveBeenCalled();
    });

    it('does not block injection when the historical run_command step has already been canceled', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            rawRPC: jest.fn().mockResolvedValue({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                            plannerResponse: {
                                response: 'Now let me re-trigger distribution:',
                                toolCalls: [
                                    { id: 'tool-task', name: 'task_boundary' },
                                    { id: 'tool-run', name: 'run_command' },
                                ],
                            },
                        },
                        {
                            type: 'CORTEX_STEP_TYPE_TASK_BOUNDARY',
                            status: 'CORTEX_STEP_STATUS_DONE',
                            metadata: {
                                toolCall: { id: 'tool-task', name: 'task_boundary' },
                            },
                        },
                        {
                            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                            status: 'CORTEX_STEP_STATUS_CANCELED',
                            metadata: {
                                toolCall: { id: 'tool-run', name: 'run_command' },
                            },
                        },
                    ],
                },
            }),
            sendMessage: jest.fn().mockResolvedValue({ ok: true, data: {} }),
            createCascade: jest.fn(),
        };

        jest.spyOn(service as any, 'ensureGrpcClient').mockResolvedValue(mockClient);
        jest.spyOn(service, 'getActiveCascadeId').mockResolvedValue('cascade-run-command-2');
        jest.spyOn(service as any, 'resolveSelectedModelId').mockResolvedValue(null);
        service.setCachedCascadeId('cascade-run-command-2');

        const result = await service.injectMessage('continue');

        expect(result).toMatchObject({
            ok: true,
            cascadeId: 'cascade-run-command-2',
        });
        expect(mockClient.sendMessage).toHaveBeenCalledWith('cascade-run-command-2', 'continue', undefined);
        expect(mockClient.createCascade).not.toHaveBeenCalled();
    });

    it('surfaces createCascade failure details instead of collapsing them to the generic message', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            rawRPC: jest.fn().mockResolvedValue({
                trajectory: {
                    cascadeRunStatus: 'CASCADE_RUN_STATUS_RUNNING',
                    steps: [],
                },
            }),
            createCascade: jest.fn().mockResolvedValue(null),
            getLastOperationError: jest.fn().mockReturnValue('LS SendUserCascadeMessage: 400 - missing required field'),
            getUserStatus: jest.fn().mockResolvedValue({}),
        };

        jest.spyOn(service as any, 'ensureGrpcClient').mockResolvedValue(mockClient);
        jest.spyOn(service, 'getActiveCascadeId').mockResolvedValue(null);
        jest.spyOn(service as any, 'resolveSelectedModelId').mockResolvedValue(null);

        const result = await service.injectMessage('hi');

        expect(result).toMatchObject({
            ok: false,
            error: 'LS SendUserCascadeMessage: 400 - missing required field',
        });
        expect(mockClient.createCascade).toHaveBeenCalled();
    });
});
