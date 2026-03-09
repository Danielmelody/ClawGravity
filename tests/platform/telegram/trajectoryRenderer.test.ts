import { markdownToTelegramHtmlViaUnified } from '../../../src/platform/telegram/trajectoryRenderer';

describe('markdownToTelegramHtmlViaUnified', () => {
    // ── Basic Markdown ───────────────────────────────────────────────
    it('converts bold and italic', () => {
        const result = markdownToTelegramHtmlViaUnified('**bold** and *italic*');
        expect(result).toContain('<b>bold</b>');
        expect(result).toContain('<i>italic</i>');
    });

    it('converts inline code', () => {
        const result = markdownToTelegramHtmlViaUnified('Use `processData()` here');
        expect(result).toContain('<code>processData()</code>');
    });

    it('converts code blocks', () => {
        const result = markdownToTelegramHtmlViaUnified('```typescript\nconst x = 1;\n```');
        expect(result).toContain('<pre><code>');
        expect(result).toContain('const x = 1;');
        expect(result).toContain('</code></pre>');
    });

    it('converts headings to bold', () => {
        const result = markdownToTelegramHtmlViaUnified('# Title\n## Subtitle');
        expect(result).toContain('<b>Title</b>');
        expect(result).toContain('<b>Subtitle</b>');
    });

    it('converts links', () => {
        const result = markdownToTelegramHtmlViaUnified('[Google](https://google.com)');
        expect(result).toContain('<a href="https://google.com">Google</a>');
    });

    it('converts blockquotes', () => {
        const result = markdownToTelegramHtmlViaUnified('> This is a quote');
        expect(result).toContain('<blockquote>');
        expect(result).toContain('This is a quote');
    });

    it('converts unordered lists', () => {
        const result = markdownToTelegramHtmlViaUnified('- item one\n- item two');
        expect(result).toContain('• item one');
        expect(result).toContain('• item two');
    });

    it('converts ordered lists (rendered as bullets by telegramFormatter)', () => {
        const result = markdownToTelegramHtmlViaUnified('1. first\n2. second');
        // telegramFormatter treats all lists as bullet points
        expect(result).toContain('• first');
        expect(result).toContain('• second');
    });

    // ── Complex Markdown (typical AI response) ──────────────────────
    it('handles a typical AI response with mixed formatting', () => {
        const markdown = `# Analysis Results

The code has **3 issues**:

- Missing error handling in \`processData()\`
- Unused import on \`line 5\`
- Performance issue in the loop

\`\`\`typescript
function fix() {
    return true;
}
\`\`\`

> Note: These are suggestions, not critical bugs.`;

        const result = markdownToTelegramHtmlViaUnified(markdown);

        expect(result).toContain('<b>Analysis Results</b>');
        expect(result).toContain('<b>3 issues</b>');
        expect(result).toContain('• Missing error handling');
        // Inline code in list items preserved as backtick notation by telegramFormatter
        expect(result).toMatch(/processData\(\)/);
        expect(result).toContain('<pre><code>');
        expect(result).toContain('<blockquote>');
    });

    // ── Edge cases ───────────────────────────────────────────────────
    it('returns empty for empty input', () => {
        expect(markdownToTelegramHtmlViaUnified('')).toBe('');
        expect(markdownToTelegramHtmlViaUnified('   ')).toBe('');
    });

    it('returns empty for null/undefined', () => {
        expect(markdownToTelegramHtmlViaUnified(null as any)).toBe('');
        expect(markdownToTelegramHtmlViaUnified(undefined as any)).toBe('');
    });

    it('passes through plain text with no Markdown', () => {
        const result = markdownToTelegramHtmlViaUnified('Hello world');
        expect(result).toContain('Hello world');
        // Should not have any unsupported tags
        expect(result).not.toMatch(/<div/);
        expect(result).not.toMatch(/<span/);
    });

    it('preserves strikethrough', () => {
        const result = markdownToTelegramHtmlViaUnified('~~deleted~~');
        expect(result).toContain('<s>deleted</s>');
    });

    it('handles horizontal rules', () => {
        const result = markdownToTelegramHtmlViaUnified('above\n\n---\n\nbelow');
        expect(result).toContain('—');
    });

    // ── No Telegram-unsupported tags leak through ────────────────────
    it('never produces div, span, or class attributes', () => {
        const complexMarkdown = `# Title
**bold** *italic* \`code\`

- list item

\`\`\`js
code
\`\`\`

| col1 | col2 |
|------|------|
| a    | b    |`;

        const result = markdownToTelegramHtmlViaUnified(complexMarkdown);
        expect(result).not.toMatch(/<div/i);
        expect(result).not.toMatch(/<span/i);
        expect(result).not.toMatch(/class="/i);
    });
});
