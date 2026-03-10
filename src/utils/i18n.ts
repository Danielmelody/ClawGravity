
type Language = 'en' | 'ja';

const currentLanguage: Language = 'en';
const translations: Record<string, Record<string, string>> = {};

export function t(key: string, variables?: Record<string, any>): string {
    const langDict = translations[currentLanguage] || translations['en'];
    let text = langDict?.[key] || translations['en']?.[key] || key;

    if (variables) {
        for (const [vKey, vValue] of Object.entries(variables)) {
            text = text.replace(new RegExp(`{{${vKey}}}`, 'g'), String(vValue));
        }
    }

    return text;
}
