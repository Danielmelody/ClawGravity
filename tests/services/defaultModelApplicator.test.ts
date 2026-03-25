import { applyDefaultModel } from '../../src/services/defaultModelApplicator';
import { ModelService } from '../../src/services/modelService';

jest.mock('../../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function createMockCdp(overrides: {
    currentModel?: string | null;
    availableModels?: string[];
    setUiModelResult?: { ok: boolean; model?: string; error?: string };
} = {}) {
    return {
        getCurrentModel: jest.fn().mockResolvedValue(overrides.currentModel ?? null),
        getUiModels: jest.fn().mockResolvedValue(overrides.availableModels ?? []),
        setUiModel: jest.fn().mockResolvedValue(overrides.setUiModelResult ?? { ok: true, model: 'test' }),
    };
}

describe('applyDefaultModel', () => {
    let modelService: ModelService;

    beforeEach(() => {
        modelService = new ModelService();
    });

    it('skips when no default model is set', async () => {
        const cdp = createMockCdp();
        const result = await applyDefaultModel(cdp as any, modelService);

        expect(result.applied).toBe(false);
        expect(result.modelName).toBeNull();
        expect(result.stale).toBe(false);
        expect(cdp.getCurrentModel).not.toHaveBeenCalled();
    });

    it('skips when current model already matches the default', async () => {
        modelService.setDefaultModel('gemini-3-flash');
        const cdp = createMockCdp({ currentModel: 'gemini-3-flash' });

        const result = await applyDefaultModel(cdp as any, modelService);

        expect(result.applied).toBe(true);
        expect(result.stale).toBe(false);
        expect(cdp.setUiModel).not.toHaveBeenCalled();
    });

    it('matches case-insensitively when current model matches', async () => {
        modelService.setDefaultModel('Gemini-3-Flash');
        const cdp = createMockCdp({ currentModel: 'gemini-3-flash' });

        const result = await applyDefaultModel(cdp as any, modelService);

        expect(result.applied).toBe(true);
        expect(result.stale).toBe(false);
    });

    it('applies the default model when exact match is found in available models', async () => {
        modelService.setDefaultModel('claude-sonnet-4.6-thinking');
        const cdp = createMockCdp({
            currentModel: 'gemini-3-flash',
            availableModels: ['gemini-3-flash', 'claude-sonnet-4.6-thinking'],
            setUiModelResult: { ok: true, model: 'claude-sonnet-4.6-thinking' },
        });

        const result = await applyDefaultModel(cdp as any, modelService);

        expect(result.applied).toBe(true);
        expect(result.stale).toBe(false);
        expect(cdp.setUiModel).toHaveBeenCalledWith('claude-sonnet-4.6-thinking');
    });

    it('marks the result as stale when no exact match is found', async () => {
        modelService.setDefaultModel('old-model-name');
        const cdp = createMockCdp({
            currentModel: 'gemini-3-flash',
            availableModels: ['gemini-3-flash', 'claude-sonnet-4.6-thinking'],
        });

        const result = await applyDefaultModel(cdp as any, modelService);

        expect(result.applied).toBe(false);
        expect(result.stale).toBe(true);
        expect(result.staleMessage).toContain('old-model-name');
        expect(result.staleMessage).toContain('gemini-3-flash');
    });

    it('returns not applied when setUiModel fails', async () => {
        modelService.setDefaultModel('claude-sonnet-4.6-thinking');
        const cdp = createMockCdp({
            currentModel: 'gemini-3-flash',
            availableModels: ['claude-sonnet-4.6-thinking'],
            setUiModelResult: { ok: false, error: 'CDP timeout' },
        });

        const result = await applyDefaultModel(cdp as any, modelService);

        expect(result.applied).toBe(false);
        expect(result.stale).toBe(false);
    });
});
