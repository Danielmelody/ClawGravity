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
        jest.spyOn(service, 'getLSClient').mockResolvedValue(mockClient as any);
        service.setCachedCascadeId('cascade-123');

        await expect(service.injectMessage('hello')).resolves.toMatchObject({
            ok: true,
            cascadeId: 'cascade-123',
        });

        expect(mockClient.sendMessage).toHaveBeenCalledWith('cascade-123', 'hello', 1154, undefined);
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
        jest.spyOn(service, 'getLSClient').mockResolvedValue(mockClient as any);
        service.setCachedCascadeId('cascade-456');

        await expect(service.injectMessage('hello again')).resolves.toMatchObject({
            ok: true,
            cascadeId: 'cascade-456',
        });

        expect(mockClient.sendMessage).toHaveBeenCalledWith('cascade-456', 'hello again', 1154, undefined);
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
        jest.spyOn(service, 'getLSClient').mockResolvedValue(mockClient as any);
        service.setCachedCascadeId('cascade-789');

        await expect(service.injectMessage('hello string model')).resolves.toMatchObject({
            ok: true,
            cascadeId: 'cascade-789',
        });

        expect(mockClient.sendMessage).toHaveBeenCalledWith('cascade-789', 'hello string model', 'MODEL_PLACEHOLDER_M26', undefined);
        expect(service.getSelectedModelId()).toBe('MODEL_PLACEHOLDER_M26');
    });

    it('extracts alias-style model identifiers from newer GetUserStatus payloads when creating a new cascade', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });
        const mockClient = {
            getUserStatus: jest.fn().mockResolvedValue({
                userStatus: {
                    cascadeModelConfigData: {
                        clientModelConfigs: [
                            {
                                label: 'Gemini 3.1 Pro (High)',
                                modelOrAlias: {
                                    choice: {
                                        case: 'alias',
                                        value: 'MODEL_PLACEHOLDER_GEMINI_PRO_HIGH',
                                    },
                                },
                            },
                        ],
                    },
                },
            }),
            createCascade: jest.fn().mockResolvedValue('cascade-gemini'),
        };

        primeUiModel(service, 'Gemini 3.1 Pro (High)');
        jest.spyOn(service, 'getLSClient').mockResolvedValue(mockClient as any);

        await expect(service.injectMessage('hello gemini')).resolves.toMatchObject({
            ok: true,
            cascadeId: 'cascade-gemini',
        });

        expect(mockClient.createCascade).toHaveBeenCalledWith('hello gemini', 'MODEL_PLACEHOLDER_GEMINI_PRO_HIGH');
        expect(service.getSelectedModelId()).toBe('MODEL_PLACEHOLDER_GEMINI_PRO_HIGH');
    });
});
