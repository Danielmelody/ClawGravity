/**
 * Model type — plain string. CDP is the sole source of truth
 * for valid model names; no hardcoded list is maintained.
 */
export type Model = string;

/** Default model set result type definition */
export interface DefaultModelSetResult {
    success: boolean;
    defaultModel: string | null;
}

/**
 * Service class for managing LLM model preferences.
 *
 * The **current** model is always read live from CdpService
 * (the Antigravity UI), so this service does NOT cache it.
 *
 * This service only manages the user's **default model**
 * preference, which is applied on startup via
 * `defaultModelApplicator`.
 */
export class ModelService {
    private defaultModel: string | null = null;

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
