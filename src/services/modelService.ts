import { t } from "../utils/i18n";

/**
 * Fallback model list used when CDP is not connected.
 * NOT used for validation — CDP is the sole source of truth
 * for available models. This list may become stale after
 * Antigravity updates.
 */
export const AVAILABLE_MODELS = [
    'gemini-3.1-pro-high',
    'gemini-3.1-pro-low',
    'gemini-3-flash',
    'claude-sonnet-4.6-thinking',
    'claude-opus-4.6-thinking',
    'gpt-oss-120b-medium'
] as const;

/** Default LLM model (initial value before CDP connects) */
export const DEFAULT_MODEL = 'gemini-3-flash';

/**
 * Model type — plain string. CDP is the source of truth for
 * valid model names; we do not restrict to AVAILABLE_MODELS.
 */
export type Model = string;

/** Model set result type definition */
export interface ModelSetResult {
    success: boolean;
    model?: string;
    error?: string;
}

/** Default model set result type definition */
export interface DefaultModelSetResult {
    success: boolean;
    defaultModel: string | null;
}

/**
 * Service class for managing LLM models.
 * Handles model switching via the /model command.
 *
 * Model validation is intentionally NOT performed here.
 * The actual model list is dynamic (fetched from CDP via
 * cdp.getUiModels()), so setModel() accepts any string.
 */
export class ModelService {
    private currentModel: string = DEFAULT_MODEL;
    private defaultModel: string | null = null;
    private pendingSync: boolean = false;

    /**
     * Get the current LLM model
     */
    public getCurrentModel(): string {
        return this.currentModel;
    }

    /**
     * Check if the current model is pending sync to Antigravity
     */
    public isPendingSync(): boolean {
        return this.pendingSync;
    }

    /**
     * Mark the pending model as synced (clears pendingSync flag)
     */
    public markSynced(): void {
        this.pendingSync = false;
    }

    /**
     * Switch LLM model.
     * Accepts any model name — validation happens at the CDP layer
     * (cdp.setUiModel) against the live model list.
     *
     * @param modelName Model name to set (case-insensitive)
     * @param synced Whether the model has been synced to Antigravity (default: false)
     */
    public setModel(modelName: string, synced: boolean = false): ModelSetResult {
        if (!modelName || modelName.trim() === '') {
            return {
                success: false,
                error: t('⚠️ Model name not specified.'),
            };
        }

        this.currentModel = modelName.trim().toLowerCase();
        this.pendingSync = !synced;
        return {
            success: true,
            model: this.currentModel,
        };
    }

    /**
     * Get the fallback list of available models.
     * Prefer cdp.getUiModels() when CDP is connected.
     */
    public getAvailableModels(): readonly string[] {
        return AVAILABLE_MODELS;
    }

    /**
     * Get the default model name (free-text, may not match current CDP models)
     */
    public getDefaultModel(): string | null {
        return this.defaultModel;
    }

    /**
     * Set the default model name (free-text, persisted via DB separately)
     * @param name Model name or null to clear
     */
    public setDefaultModel(name: string | null): DefaultModelSetResult {
        this.defaultModel = name ? name.trim() : null;
        return { success: true, defaultModel: this.defaultModel };
    }

    /**
     * Load the default model from an external source (e.g. DB).
     * Only sets the in-memory value if not already set.
     */
    public loadDefaultModel(name: string | null): void {
        if (this.defaultModel === null && name) {
            this.defaultModel = name.trim();
        }
    }
}
