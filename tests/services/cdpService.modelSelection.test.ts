import { CdpService } from '../../src/services/cdpService';

describe('CdpService model selection', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    function primeUiModel(service: CdpService, uiModel: string): void {
        (service as any).ws = { readyState: 1 };
        (service as any).contexts = [{ id: 7, name: 'cascade-panel', url: 'vscode-webview://cascade-panel' }];
        jest.spyOn(service, 'call').mockResolvedValue({
            result: { value: uiModel },
        } as any);
    }

    it('resolves a numeric model id from the UI label before sending to an existing cascade', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            getUserStatus: jest.fn().mockResolvedValue({
                userStatus: {
                    cascadeModelConfigData: {
                        clientModelConfigs: [
                            {
                                label: 'Claude Opus 4.6 (Thinking)',
                                modelOrAlias: { model: 1154 },
                            },
                        ],
                    },
                },
            }),
            sendMessage: jest.fn().mockResolvedValue({ ok: true, data: { accepted: true } }),
        };

        primeUiModel(service, 'Claude Opus 4.6 (Thinking)');
        jest.spyOn(service as any, 'ensureGrpcClient').mockResolvedValue(mockClient);
        service.setCachedCascadeId('cascade-123');

        await expect(service.injectMessage('hello')).resolves.toMatchObject({
            ok: true,
            cascadeId: 'cascade-123',
        });

        expect(mockClient.sendMessage).toHaveBeenCalledWith('cascade-123', 'hello', 1154);
    });

    it('matches the UI label to a config label even when the config has a quota suffix', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            getUserStatus: jest.fn().mockResolvedValue({
                userStatus: {
                    cascadeModelConfigData: {
                        clientModelConfigs: [
                            {
                                label: 'Claude Opus 4.6 (Thinking) 80% (3h 9m)',
                                modelOrAlias: { model: 1154 },
                            },
                        ],
                    },
                },
            }),
            sendMessage: jest.fn().mockResolvedValue({ ok: true, data: { accepted: true } }),
        };

        primeUiModel(service, 'Claude Opus 4.6 (Thinking)');
        jest.spyOn(service as any, 'ensureGrpcClient').mockResolvedValue(mockClient);
        service.setCachedCascadeId('cascade-456');

        await expect(service.injectMessage('hello again')).resolves.toMatchObject({
            ok: true,
            cascadeId: 'cascade-456',
        });

        expect(mockClient.sendMessage).toHaveBeenCalledWith('cascade-456', 'hello again', 1154);
    });

    it('passes through string model identifiers returned by newer GetUserStatus payloads', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            getUserStatus: jest.fn().mockResolvedValue({
                userStatus: {
                    cascadeModelConfigData: {
                        clientModelConfigs: [
                            {
                                label: 'Claude Opus 4.6 (Thinking)',
                                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M26' },
                            },
                        ],
                    },
                },
            }),
            sendMessage: jest.fn().mockResolvedValue({ ok: true, data: { accepted: true } }),
        };

        primeUiModel(service, 'Claude Opus 4.6 (Thinking)');
        jest.spyOn(service as any, 'ensureGrpcClient').mockResolvedValue(mockClient);
        service.setCachedCascadeId('cascade-789');

        await expect(service.injectMessage('hello string model')).resolves.toMatchObject({
            ok: true,
            cascadeId: 'cascade-789',
        });

        expect(mockClient.sendMessage).toHaveBeenCalledWith('cascade-789', 'hello string model', 'MODEL_PLACEHOLDER_M26');
        expect(service.getSelectedModelId()).toBe('MODEL_PLACEHOLDER_M26');
    });
});
