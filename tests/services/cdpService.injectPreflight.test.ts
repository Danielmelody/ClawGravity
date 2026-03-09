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
