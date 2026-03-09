import { htmlToTelegramHtml } from '../../../src/platform/telegram/htmlToTelegramHtml';

describe('htmlToTelegramHtml', () => {
    // ── Basic tag preservation ────────────────────────────────────────
    it('preserves Telegram-allowed tags', () => {
        const input = '<b>bold</b> <i>italic</i> <u>underline</u> <s>strike</s>';
        const result = htmlToTelegramHtml(input);
        expect(result).toContain('<b>bold</b>');
        expect(result).toContain('<i>italic</i>');
        expect(result).toContain('<u>underline</u>');
        expect(result).toContain('<s>strike</s>');
    });

    it('preserves <code> and <pre> tags (strips attributes)', () => {
        const input = '<pre class="language-ts"><code class="language-typescript">const x = 1;</code></pre>';
        const result = htmlToTelegramHtml(input);
        expect(result).toContain('<pre><code>const x = 1;</code></pre>');
        expect(result).not.toContain('class=');
    });

    it('preserves <a> tags with href', () => {
        const input = '<a href="https://example.com" target="_blank" rel="noopener">link</a>';
        const result = htmlToTelegramHtml(input);
        expect(result).toContain('<a href="https://example.com">link</a>');
        expect(result).not.toContain('target=');
    });

    it('preserves <blockquote> tags', () => {
        const input = '<blockquote>quoted text</blockquote>';
        const result = htmlToTelegramHtml(input);
        expect(result).toContain('<blockquote>quoted text</blockquote>');
    });

    // ── Tag aliases ──────────────────────────────────────────────────
    it('maps <strong> to <b>', () => {
        expect(htmlToTelegramHtml('<strong>text</strong>')).toContain('<b>text</b>');
    });

    it('maps <em> to <i>', () => {
        expect(htmlToTelegramHtml('<em>text</em>')).toContain('<i>text</i>');
    });

    it('maps <del> to <s>', () => {
        expect(htmlToTelegramHtml('<del>text</del>')).toContain('<s>text</s>');
    });

    // ── Semantic conversions ─────────────────────────────────────────
    it('converts headings to bold', () => {
        const result = htmlToTelegramHtml('<h1>Title</h1><h2>Subtitle</h2>');
        expect(result).toContain('<b>Title</b>');
        expect(result).toContain('<b>Subtitle</b>');
    });

    it('converts paragraphs to text with newlines', () => {
        const result = htmlToTelegramHtml('<p>First paragraph</p><p>Second paragraph</p>');
        expect(result).toContain('First paragraph');
        expect(result).toContain('Second paragraph');
        // Should have separation between paragraphs
        expect(result).toMatch(/First paragraph\n\n.*Second paragraph/s);
    });

    it('converts <br> to newlines', () => {
        const result = htmlToTelegramHtml('line1<br>line2<br/>line3');
        expect(result).toBe('line1\nline2\nline3');
    });

    it('converts <hr> to em-dash', () => {
        const result = htmlToTelegramHtml('above<hr>below');
        expect(result).toContain('—');
    });

    // ── Lists ────────────────────────────────────────────────────────
    it('converts unordered lists to bullet points', () => {
        const input = '<ul><li>item one</li><li>item two</li></ul>';
        const result = htmlToTelegramHtml(input);
        expect(result).toContain('• item one');
        expect(result).toContain('• item two');
    });

    it('converts ordered lists to numbered items', () => {
        const input = '<ol><li>first</li><li>second</li><li>third</li></ol>';
        const result = htmlToTelegramHtml(input);
        expect(result).toContain('1. first');
        expect(result).toContain('2. second');
        expect(result).toContain('3. third');
    });

    it('handles task list checkboxes', () => {
        const input = '<ul><li><input type="checkbox" checked> Done task</li><li><input type="checkbox"> Todo task</li></ul>';
        const result = htmlToTelegramHtml(input);
        expect(result).toContain('✅');
        expect(result).toContain('☐');
    });

    // ── Void content removal ─────────────────────────────────────────
    it('removes <style> blocks entirely', () => {
        const input = '<style>.foo { color: red; }</style><b>visible</b>';
        const result = htmlToTelegramHtml(input);
        expect(result).not.toContain('color');
        expect(result).not.toContain('.foo');
        expect(result).toContain('<b>visible</b>');
    });

    it('removes <script> blocks entirely', () => {
        const input = '<script>alert("xss")</script><b>safe</b>';
        const result = htmlToTelegramHtml(input);
        expect(result).not.toContain('alert');
        expect(result).toContain('<b>safe</b>');
    });

    it('removes <svg> blocks entirely', () => {
        const input = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M12 0"/></svg><b>text</b>';
        const result = htmlToTelegramHtml(input);
        expect(result).not.toContain('svg');
        expect(result).not.toContain('path');
        expect(result).toContain('<b>text</b>');
    });

    // ── Tag stripping (unwrap) ───────────────────────────────────────
    it('strips unsupported div/span tags but keeps text', () => {
        const input = '<div class="flex flex-col"><span class="text-sm">hello world</span></div>';
        const result = htmlToTelegramHtml(input);
        expect(result).toContain('hello world');
        expect(result).not.toContain('<div');
        expect(result).not.toContain('flex');
    });

    it('strips complex Tailwind wrapper divs', () => {
        const input = '<div class="leading-relaxed select-text text-sm flex flex-col"><b>Important</b> content here</div>';
        const result = htmlToTelegramHtml(input);
        expect(result).toContain('<b>Important</b>');
        expect(result).toContain('content here');
        expect(result).not.toContain('leading-relaxed');
    });

    // ── HTML entity handling ─────────────────────────────────────────
    it('properly escapes angle brackets in text', () => {
        const input = '<p>Use Array&lt;string&gt; for type safety</p>';
        const result = htmlToTelegramHtml(input);
        expect(result).toContain('&lt;string&gt;');
    });

    it('handles &amp; entities', () => {
        const input = '<p>Tom &amp; Jerry</p>';
        const result = htmlToTelegramHtml(input);
        expect(result).toContain('Tom &amp; Jerry');
    });

    // ── Edge cases ───────────────────────────────────────────────────
    it('returns empty string for empty input', () => {
        expect(htmlToTelegramHtml('')).toBe('');
    });

    it('returns empty string for null/undefined', () => {
        expect(htmlToTelegramHtml(null as any)).toBe('');
        expect(htmlToTelegramHtml(undefined as any)).toBe('');
    });

    it('handles plain text without tags', () => {
        expect(htmlToTelegramHtml('just plain text')).toBe('just plain text');
    });

    it('collapses excessive newlines', () => {
        const input = '<p>one</p>\n\n\n\n<p>two</p>';
        const result = htmlToTelegramHtml(input);
        expect(result).not.toMatch(/\n{3,}/);
    });

    // ── Real-world Antigravity HTML ──────────────────────────────────
    it('handles real Antigravity response HTML with style tag and Tailwind', () => {
        const input = `<div class="leading-relaxed select-text text-sm flex flex-col">
            <style>/* remark-github-blockquote-alert/alert.css */ .markdown-alert { color: red; }</style>
            <h2>Analysis Results</h2>
            <p>The code has <b>3 issues</b>:</p>
            <ul>
                <li>Missing error handling in <code>processData()</code></li>
                <li>Unused import on line 5</li>
            </ul>
            <pre><code class="language-typescript">function fix() { return true; }</code></pre>
        </div>`;
        const result = htmlToTelegramHtml(input);

        expect(result).toContain('<b>Analysis Results</b>');
        expect(result).toContain('<b>3 issues</b>');
        expect(result).toContain('• Missing error handling');
        expect(result).toContain('<code>processData()</code>');
        expect(result).toContain('<pre><code>function fix()');
        expect(result).not.toContain('alert.css');
        expect(result).not.toContain('leading-relaxed');
        expect(result).not.toContain('class=');
    });

    it('preserves analyzed file rows from Antigravity HTML timelines', () => {
        const input = `
            <details class="timeline-group">
                <summary>
                    <span>Thought for &lt;1s</span>
                </summary>
                <div class="timeline-body">
                    <p>好，我来审查这次所有改动的文件。</p>
                    <div class="analyzed-row">
                        <label class="row-label">
                            <input type="checkbox" checked />
                            <span>Analyzed</span>
                            <a href="file:///workspace/package.json">
                                <img alt="js" src="/icons/js.svg" />
                                <span>package.json</span>
                                <span>#L1-88</span>
                            </a>
                        </label>
                    </div>
                    <div class="analyzed-row">
                        <label class="row-label">
                            <input type="checkbox" checked />
                            <span>Analyzed</span>
                            <a href="file:///workspace/.jscpd.json" data-file-path=".jscpd.json" data-line-number="1" data-end-line-number="26">
                                <img alt="json" src="/icons/json.svg" />
                            </a>
                        </label>
                    </div>
                </div>
            </details>
        `;

        const result = htmlToTelegramHtml(input);

        expect(result).toContain('<b>Thought for &lt;1s</b>');
        expect(result).toContain('好，我来审查这次所有改动的文件。');
        expect(result).toMatch(/✅\s*Analyzed\s*<a href="file:\/\/\/workspace\/package\.json">[\s\S]*package\.json[\s\S]*#L1-88[\s\S]*<\/a>/);
        expect(result).toMatch(/✅\s*Analyzed\s*<a href="file:\/\/\/workspace\/\.jscpd\.json">[\s\S]*\.jscpd\.json[\s\S]*#L1-26[\s\S]*json[\s\S]*<\/a>/);
        expect(result).toMatch(/package\.json[\s\S]*\n✅[\s\S]*\.jscpd\.json/);
    });

    it('does not leak orphan closing span tags from nested Antigravity wrappers', () => {
        const input = `
            <div class="timeline-row">
                <span class="outer">
                    <span class="label">Analyzed</span>
                    <span class="meta">
                        <a href="file:///workspace/force-distribute.ts">
                            <span>force-distribute.ts</span>
                            <span>#L2-69</span>
                        </a>
                    </span>
                </span>
            </div>
        `;

        const result = htmlToTelegramHtml(input);

        expect(result).toContain('Analyzed');
        expect(result).toContain('force-distribute.ts');
        expect(result).toContain('#L2-69');
        expect(result).not.toContain('<span');
        expect(result).not.toContain('</span>');
    });
});
