import { GrpcCascadeClient } from '../../src/services/grpcCascadeClient';


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

    it('passes the selected model into StartCascade when creating a new cascade', async () => {
        const client = new GrpcCascadeClient();
        const rpc = jest.spyOn(client as any, 'rpc').mockResolvedValue({ cascadeId: 'cascade-123' });
        jest.spyOn(client, 'sendMessage').mockResolvedValue({ ok: true, data: {} });

        await expect(client.createCascade('hello', 'MODEL_PLACEHOLDER_M26')).resolves.toBe('cascade-123');

        expect(rpc).toHaveBeenCalledWith('StartCascade', {
            source: 0,
            cascadeConfig: {
                plannerConfig: {
                    conversational: {},
                    planModel: 'MODEL_PLACEHOLDER_M26',
                },
            },
        });
    });
});

describe('GrpcCascadeClient sendMessage media payload', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('puts inlineData as a direct property, not nested inside payload', async () => {
        const client = new GrpcCascadeClient();
        const rpc = jest.spyOn(client as any, 'rpc').mockResolvedValue({});

        await client.sendMessage('cascade-123', 'Look at this image', undefined, [
            { mimeType: 'image/jpeg', inlineData: 'base64data==' },
        ]);

        expect(rpc).toHaveBeenCalledWith('SendUserCascadeMessage', expect.objectContaining({
            cascadeId: 'cascade-123',
            media: [
                expect.objectContaining({
                    mimeType: 'image/jpeg',
                    inlineData: 'base64data==',
                }),
            ],
        }));

        // Must NOT have a nested payload wrapper
        const payload = rpc.mock.calls[0][1] as Record<string, unknown>;
        const mediaItems = payload.media as Record<string, unknown>[];
        expect(mediaItems[0]).not.toHaveProperty('payload');
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
