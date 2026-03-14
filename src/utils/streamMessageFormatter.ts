import { splitPlainText } from './plainTextFormatter';

/**
 * Generate mode/model lines for initial status display.
 * Consolidates into a single line if Fast and Plan models are the same.
 */
export function buildModeModelLines(modeName: string, fastModel: string, planModel: string): string[] {
    if (fastModel.trim().toLowerCase() === planModel.trim().toLowerCase()) {
        return [`${modeName} | ${fastModel}`];
    }

    // Only show the model for the current mode
    const isPlan = /plan/i.test(modeName);
    return [`${modeName} | ${isPlan ? planModel : fastModel}`];
}

/**
 * Filter out activity logs that tend to be noise in Discord display.
 */
export function shouldSkipActivityLog(activity: string, modeName: string, modelName: string): boolean {
    const normalized = activity.trim().toLowerCase();
    if (!normalized) return true;

    const modeLower = modeName.trim().toLowerCase();
    const modelLower = modelName.trim().toLowerCase();
    if (normalized === modeLower || normalized === modelLower) return true;

    if (/^(?:fast|planning|plan|generating\.*|thinking\.*|processing\.*|working\.*)$/.test(normalized)) {
        return true;
    }

    // Single-word logs that tend to be noise (create / ready / pull. / TELEGRAM / we're etc.)
    if (/^[a-z][a-z0-9'_-]{0,24}[.:,;!…]?$/i.test(normalized)) {
        return true;
    }

    // Detailed trace for file reading operations (Analyzed....)
    if (/^analyzed/.test(normalized)) {
        return true;
    }

    return false;
}

/**
 * Split text into multiple chunks for Embed description.
 */
export function splitForEmbedDescription(text: string, maxLength: number = 3500): string[] {
    return splitPlainText(text, maxLength);
}

/**
 * Fit text within the limit for a single Embed description.
 * When exceeding the limit, truncate the beginning and prioritize displaying the tail (most recent part).
 */
export function fitForSingleEmbedDescription(text: string, maxLength: number = 3500): string {
    if (text.length <= maxLength) return text;
    const prefix = '... (beginning truncated)\n';
    const tailLength = Math.max(0, maxLength - prefix.length);
    return `${prefix}${text.slice(-tailLength)}`;
}
