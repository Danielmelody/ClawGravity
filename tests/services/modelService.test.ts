import { ModelService } from '../../src/services/modelService';

describe('ModelService', () => {
    let modelService: ModelService;

    beforeEach(() => {
        modelService = new ModelService();
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
