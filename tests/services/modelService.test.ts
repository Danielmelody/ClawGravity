import { ModelService } from '../../src/services/modelService';

describe('ModelService', () => {
    let modelService: ModelService;

    beforeEach(() => {
        modelService = new ModelService();
    });

    describe('getCurrentModel - get current model', () => {
        it('returns empty string in the initial state (no hardcoded default)', () => {
            expect(modelService.getCurrentModel()).toBe('');
        });
    });

    describe('setModel - switch model', () => {
        it('switches the model when a valid model name is specified', () => {
            const result = modelService.setModel('claude-sonnet-4.6-thinking');
            expect(result.success).toBe(true);
            expect(result.model).toBe('claude-sonnet-4.6-thinking');
            expect(modelService.getCurrentModel()).toBe('claude-sonnet-4.6-thinking');
        });

        it('retains the last set model after multiple switches', () => {
            modelService.setModel('claude-sonnet-4.6-thinking');
            modelService.setModel('gemini-3.1-pro-high');
            expect(modelService.getCurrentModel()).toBe('gemini-3.1-pro-high');
        });

        it('accepts any model name (validation is at CDP layer)', () => {
            const result = modelService.setModel('brand-new-model-2026');
            expect(result.success).toBe(true);
            expect(result.model).toBe('brand-new-model-2026');
            expect(modelService.getCurrentModel()).toBe('brand-new-model-2026');
        });

        it('sets the model case-insensitively', () => {
            const result = modelService.setModel('SOME-MODEL');
            expect(result.success).toBe(true);
            expect(result.model).toBe('some-model');
        });

        it('returns an error when an empty string is specified', () => {
            const result = modelService.setModel('');
            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });

        it('can set any arbitrary model name', () => {
            const result = modelService.setModel('future-model-v5');
            expect(result.success).toBe(true);
            expect(result.model).toBe('future-model-v5');
        });

        it('sets pendingSync to true by default', () => {
            modelService.setModel('test-model');
            expect(modelService.isPendingSync()).toBe(true);
        });

        it('sets pendingSync to false when synced=true', () => {
            modelService.setModel('test-model', true);
            expect(modelService.isPendingSync()).toBe(false);
        });
    });

    describe('pendingSync', () => {
        it('is false initially', () => {
            expect(modelService.isPendingSync()).toBe(false);
        });

        it('becomes true after setModel without synced', () => {
            modelService.setModel('test-model');
            expect(modelService.isPendingSync()).toBe(true);
        });

        it('is cleared by markSynced', () => {
            modelService.setModel('test-model');
            modelService.markSynced();
            expect(modelService.isPendingSync()).toBe(false);
        });
    });

    describe('defaultModel', () => {
        it('is null initially', () => {
            expect(modelService.getDefaultModel()).toBeNull();
        });

        it('can be set to a free-text model name', () => {
            const result = modelService.setDefaultModel('any-model-name');
            expect(result.success).toBe(true);
            expect(result.defaultModel).toBe('any-model-name');
            expect(modelService.getDefaultModel()).toBe('any-model-name');
        });

        it('trims whitespace from model name', () => {
            modelService.setDefaultModel('  model-with-spaces  ');
            expect(modelService.getDefaultModel()).toBe('model-with-spaces');
        });

        it('can be cleared by passing null', () => {
            modelService.setDefaultModel('test-model');
            modelService.setDefaultModel(null);
            expect(modelService.getDefaultModel()).toBeNull();
        });

        it('can be cleared by passing empty string', () => {
            modelService.setDefaultModel('test-model');
            modelService.setDefaultModel('');
            expect(modelService.getDefaultModel()).toBeNull();
        });
    });

    describe('loadDefaultModel', () => {
        it('loads default when none is set', () => {
            modelService.loadDefaultModel('loaded-model');
            expect(modelService.getDefaultModel()).toBe('loaded-model');
        });

        it('does not overwrite existing default', () => {
            modelService.setDefaultModel('existing');
            modelService.loadDefaultModel('new-value');
            expect(modelService.getDefaultModel()).toBe('existing');
        });

        it('ignores null value', () => {
            modelService.loadDefaultModel(null);
            expect(modelService.getDefaultModel()).toBeNull();
        });
    });
});
