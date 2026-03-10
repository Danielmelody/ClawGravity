/**
 * Service for generating chat session titles.
 *
 * Uses pure text extraction from the user prompt.
 * No DOM/CDP dependency — fully backend-compatible.
 */
export class TitleGeneratorService {
    /**
     * Generate a short title from the user's prompt
     * @param prompt User's prompt
     * @param _cdpService Unused (kept for API compatibility)
     */
    async generateTitle(prompt: string,): Promise<string> {
        return this.extractTitleFromText(prompt);
    }

    /**
     * Extract a title from the prompt text
     */
    private extractTitleFromText(prompt: string): string {
        const cleanPrompt = this.stripWorkspacePrefix(prompt);
        const truncated = cleanPrompt.substring(0, 40).trim();
        return this.sanitizeForChannelName(truncated) || 'untitled';
    }

    /**
     * Strip the workspace prefix
     */
    private stripWorkspacePrefix(prompt: string): string {
        return prompt.replace(/^\[ワークスペース:.*?\]\n?/, '');
    }

    /**
     * Sanitize text into a format suitable for Discord channel names
     */
    public sanitizeForChannelName(text: string): string {
        const sanitized = text
            .toLowerCase()
            .replace(/\s+/g, '-')
            // Allowed in Discord channel names: alphanumeric, hyphen, underscore, CJK characters
            .replace(/[^a-z0-9\-_\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf]/g, '-')
            .replace(/-{2,}/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 80);

        return sanitized || 'untitled';
    }
}
