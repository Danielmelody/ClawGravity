import {
    renderStepsToTelegramHtml,
    markdownToTelegramHtml,
    escapeHtml,
} from '../../src/services/trajectoryStepRenderer';

describe('escapeHtml', () => {
    it('escapes HTML special characters', () => {
        expect(escapeHtml('<b>test</b>')).toBe('&lt;b&gt;test&lt;/b&gt;');
        expect(escapeHtml('a & b')).toBe('a &amp; b');
        expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
    });

    it('handles empty string', () => {
        expect(escapeHtml('')).toBe('');
    });
});

describe('markdownToTelegramHtml', () => {
    it('converts bold', () => {
        expect(markdownToTelegramHtml('**bold**')).toBe('<b>bold</b>');
        expect(markdownToTelegramHtml('__bold__')).toBe('<b>bold</b>');
    });

    it('converts italic', () => {
        expect(markdownToTelegramHtml('*italic*')).toBe('<i>italic</i>');
        expect(markdownToTelegramHtml('_italic_')).toBe('<i>italic</i>');
    });

    it('converts bold+italic', () => {
        expect(markdownToTelegramHtml('***bold italic***')).toBe('<b><i>bold italic</i></b>');
    });

    it('converts strikethrough', () => {
        expect(markdownToTelegramHtml('~~deleted~~')).toBe('<s>deleted</s>');
    });

    it('converts inline code', () => {
        const result = markdownToTelegramHtml('use `console.log()`');
        expect(result).toContain('<code>console.log()</code>');
    });

    it('converts fenced code blocks', () => {
        const md = '```javascript\nconst x = 1;\n```';
        const result = markdownToTelegramHtml(md);
        expect(result).toContain('<pre>');
        expect(result).toContain('const x = 1;');
        expect(result).toContain('</pre>');
    });

    it('converts links', () => {
        const result = markdownToTelegramHtml('[click](https://example.com)');
        expect(result).toBe('<a href="https://example.com">click</a>');
    });

    it('converts headers to bold', () => {
        expect(markdownToTelegramHtml('# Title')).toBe('<b>Title</b>');
        expect(markdownToTelegramHtml('## Subtitle')).toBe('<b>Subtitle</b>');
    });

    it('converts unordered list items', () => {
        expect(markdownToTelegramHtml('- item one')).toBe('• item one');
        expect(markdownToTelegramHtml('* item two')).toBe('• item two');
    });

    it('converts ordered list items', () => {
        expect(markdownToTelegramHtml('1. first')).toBe('1. first');
    });

    it('converts blockquotes', () => {
        const result = markdownToTelegramHtml('> quoted text');
        expect(result).toContain('<blockquote>');
        expect(result).toContain('quoted text');
    });

    it('converts horizontal rules', () => {
        expect(markdownToTelegramHtml('---')).toBe('—');
    });

    it('escapes HTML in non-code text', () => {
        const result = markdownToTelegramHtml('use <div> tag');
        expect(result).toContain('&lt;div&gt;');
    });

    it('does not double-escape code blocks', () => {
        const md = '```\n<html></html>\n```';
        const result = markdownToTelegramHtml(md);
        expect(result).toContain('&lt;html&gt;&lt;/html&gt;');
        // Should NOT have double-escaped
        expect(result).not.toContain('&amp;lt;');
    });

    it('handles empty string', () => {
        expect(markdownToTelegramHtml('')).toBe('');
    });
});

describe('renderStepsToTelegramHtml', () => {
    it('returns empty string for empty steps', () => {
        expect(renderStepsToTelegramHtml([], null)).toBe('');
        expect(renderStepsToTelegramHtml([], 'RUNNING')).toBe('');
    });

    it('returns empty string for non-array input', () => {
        expect(renderStepsToTelegramHtml(null as any, null)).toBe('');
        expect(renderStepsToTelegramHtml(undefined as any, null)).toBe('');
    });

    it('renders thinking block', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                thinking: 'Let me think about this...',
                response: 'Here is the answer.',
            },
        }];
        const result = renderStepsToTelegramHtml(steps, null);
        expect(result).toContain('💭');
        expect(result).toContain('<blockquote expandable>');
        expect(result).toContain('Let me think about this...');
        expect(result).toContain('Here is the answer.');
    });

    it('truncates long thinking blocks', () => {
        const longThinking = 'A'.repeat(1000);
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                thinking: longThinking,
                response: 'Done.',
            },
        }];
        const result = renderStepsToTelegramHtml(steps, null, { maxThinkingChars: 50 });
        expect(result).toContain('A'.repeat(50) + '…');
        expect(result).not.toContain('A'.repeat(51));
    });

    it('hides thinking when disabled', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                thinking: 'secret thinking',
                response: 'visible response',
            },
        }];
        const result = renderStepsToTelegramHtml(steps, null, { showThinking: false });
        expect(result).not.toContain('secret thinking');
        expect(result).toContain('visible response');
    });

    it('renders tool calls with status icons', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                toolCalls: [
                    { name: 'view_file', status: 'completed', arguments: { AbsolutePath: '/tmp/test.ts' } },
                    { name: 'list_dir', status: 'error', arguments: { DirectoryPath: '/src' } },
                    { name: 'run_command' },
                ],
            },
        }];
        const result = renderStepsToTelegramHtml(steps, null, { showToolArgs: false, showToolResults: false });
        expect(result).toContain('✅');
        expect(result).toContain('❌');
        expect(result).toContain('⏳');
        // Compact labels instead of raw tool names
        expect(result).toContain('<b>Analyzed</b>');
        expect(result).toContain('<b>Listed</b>');
        expect(result).toContain('<b>Ran command</b>');
    });

    it('hides tool calls when disabled', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                toolCalls: [{ name: 'read_file', status: 'completed' }],
                response: 'read the file',
            },
        }];
        const result = renderStepsToTelegramHtml(steps, null, { showToolCalls: false });
        expect(result).not.toContain('read_file');
        expect(result).toContain('read the file');
    });

    it('renders compact tool call with result summary', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                toolCalls: [{
                    name: 'grep_search',
                    arguments: { Query: 'jscpd' },
                    status: 'completed',
                    result: 'Found 12 results',
                }],
            },
        }];
        const result = renderStepsToTelegramHtml(steps, null);
        expect(result).toContain('<b>Searched</b>');
        expect(result).toContain('<code>jscpd</code>');
        expect(result).toContain('<i>12 results</i>');
    });

    it('renders view_file as Analyzed with filename', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                toolCalls: [{
                    name: 'view_file',
                    arguments: { AbsolutePath: '/tmp/test.txt', StartLine: 1, EndLine: 26 },
                    status: 'completed',
                    result: 'content',
                }],
            },
        }];
        const result = renderStepsToTelegramHtml(steps, null);
        expect(result).toContain('<b>Analyzed</b>');
        expect(result).toContain('test.txt #L1-26');
    });

    it('renders run_command with expandable code preview', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                toolCalls: [{
                    name: 'run_command',
                    arguments: { CommandLine: 'npx jscpd src/ 2>&1' },
                    status: 'completed',
                    result: 'Found 0 clones.',
                }],
            },
        }];
        const result = renderStepsToTelegramHtml(steps, null);
        expect(result).toContain('<b>Ran command</b>');
        expect(result).toContain('<blockquote expandable>');
        expect(result).toContain('npx jscpd src/');
    });

    it('renders unknown tool names as-is in compact label', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                toolCalls: [{ name: 'custom_tool', status: 'completed', result: 'done' }],
            },
        }];
        const result = renderStepsToTelegramHtml(steps, null, { showToolArgs: false });
        expect(result).toContain('<b>custom_tool</b>');
    });

    it('hides subject when showToolArgs is false', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                toolCalls: [{
                    name: 'view_file',
                    arguments: { AbsolutePath: '/secret/path.txt' },
                    status: 'completed',
                }],
            },
        }];
        const result = renderStepsToTelegramHtml(steps, null, { showToolArgs: false });
        expect(result).not.toContain('path.txt');
    });

    it('renders response text with markdown', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: {
                response: '**Hello** world',
            },
        }];
        const result = renderStepsToTelegramHtml(steps, null);
        expect(result).toContain('<b>Hello</b>');
        expect(result).toContain('world');
    });

    it('appends running indicator when running', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: { response: 'Working...' },
        }];
        const resultRunning = renderStepsToTelegramHtml(steps, 'CASCADE_RUN_STATUS_RUNNING');
        expect(resultRunning).toContain('⏳');

        const resultIdle = renderStepsToTelegramHtml(steps, 'CASCADE_RUN_STATUS_IDLE');
        expect(resultIdle).not.toContain('⏳');
    });

    it('only renders steps after last user input', () => {
        const steps = [
            {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                plannerResponse: { response: 'old response' },
            },
            {
                type: 'CORTEX_STEP_TYPE_USER_INPUT',
                userInput: { items: [{ text: 'new question' }] },
            },
            {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                plannerResponse: { response: 'new response' },
            },
        ];
        const result = renderStepsToTelegramHtml(steps, null);
        expect(result).not.toContain('old response');
        expect(result).toContain('new response');
    });

    it('skips user input steps (already visible in chat)', () => {
        const steps = [{
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            userInput: { items: [{ text: 'user message' }] },
        }];
        const result = renderStepsToTelegramHtml(steps, null);
        expect(result).toBe('');
    });

    it('handles mixed step types', () => {
        const steps = [
            {
                type: 'CORTEX_STEP_TYPE_USER_INPUT',
                userInput: { items: [{ text: 'help me' }] },
            },
            {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                plannerResponse: {
                    thinking: 'Processing...',
                    toolCalls: [{ name: 'search', result: 'found it' }],
                    response: 'Here is what I found.',
                },
            },
        ];
        const result = renderStepsToTelegramHtml(steps, null, { showToolArgs: false });
        expect(result).toContain('💭');
        // Compact format: unknown tool 'search' renders label as-is
        expect(result).toContain('<b>search</b>');
        expect(result).toContain('Here is what I found.');
    });
});
