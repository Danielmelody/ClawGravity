import { GrpcCascadeClient } from '../../src/services/grpcCascadeClient';

describe('GrpcCascadeClient stream event parsing', () => {
    function parse(raw: any) {
        const client = new GrpcCascadeClient();
        return (client as any).parseStreamEvent(raw);
    }

    it('extracts assistant response text from stream payloads', () => {
        expect(parse({
            result: {
                assistantResponse: {
                    text: 'Hello from assistant',
                },
            },
        })).toEqual(expect.objectContaining({
            type: 'text',
            text: 'Hello from assistant',
        }));
    });

    it('extracts planner response text from nested step payloads', () => {
        expect(parse({
            result: {
                step: {
                    plannerResponse: {
                        response: 'Plan ready',
                    },
                },
            },
        })).toEqual(expect.objectContaining({
            type: 'text',
            text: 'Plan ready',
        }));
    });

    it('recognizes nested tool calls and cascade status updates', () => {
        expect(parse({
            result: {
                step: {
                    toolCall: {
                        name: 'bash',
                    },
                },
            },
        })).toEqual(expect.objectContaining({ type: 'tool_call' }));

        expect(parse({
            result: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
            },
        })).toEqual(expect.objectContaining({
            type: 'status',
            text: 'CASCADE_RUN_STATUS_IDLE',
        }));
    });
});

describe('GrpcCascadeClient createCascade', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns null when the initial message send fails for a new cascade', async () => {
        const client = new GrpcCascadeClient();
        jest.spyOn(client as any, 'rpc').mockResolvedValue({ cascadeId: 'cascade-123' });
        jest.spyOn(client, 'sendMessage').mockResolvedValue({
            ok: false,
            error: 'missing model',
        });

        await expect(client.createCascade('hello', 1154)).resolves.toBeNull();
        expect(client.sendMessage).toHaveBeenCalledWith('cascade-123', 'hello', 1154);
        expect(client.getLastOperationError()).toBe('missing model');
    });

    it('stores the StartCascade RPC error for later diagnostics', async () => {
        const client = new GrpcCascadeClient();
        jest.spyOn(client as any, 'rpc').mockRejectedValue(new Error('LS StartCascade: 400 - bad request'));

        await expect(client.createCascade('hello')).resolves.toBeNull();
        expect(client.getLastOperationError()).toBe('LS StartCascade: 400 - bad request');
    });
});

describe('decodeWorkspaceId', () => {
    let decodeWorkspaceId: typeof import('../../src/services/grpcCascadeClient').decodeWorkspaceId;

    beforeAll(async () => {
        const mod = await import('../../src/services/grpcCascadeClient');
        decodeWorkspaceId = mod.decodeWorkspaceId;
    });

    it('decodes a Windows workspace ID with drive letter', () => {
        // file_c_3A_Users_Daniel_Projects_MyApp → c:/Users/Daniel/Projects/MyApp
        expect(decodeWorkspaceId('file_c_3A_Users_Daniel_Projects_MyApp'))
            .toBe('c:/Users/Daniel/Projects/MyApp');
    });

    it('decodes a Mac/Linux workspace ID', () => {
        expect(decodeWorkspaceId('file_home_user_projects_app'))
            .toBe('home/user/projects/app');
    });

    it('handles workspace ID without file_ prefix', () => {
        expect(decodeWorkspaceId('c_3A_Source_MyProject'))
            .toBe('c:/Source/MyProject');
    });

    it('handles case-insensitive _3a_ encoding', () => {
        expect(decodeWorkspaceId('file_d_3a_Dev_Project'))
            .toBe('d:/Dev/Project');
    });

    it('decodes real observed workspace ID from Antigravity', () => {
        // Real observed: --workspace_id file_c_3A_Users_Daniel_Projects_DeepMarket
        expect(decodeWorkspaceId('file_c_3A_Users_Daniel_Projects_DeepMarket'))
            .toBe('c:/Users/Daniel/Projects/DeepMarket');
    });
});
