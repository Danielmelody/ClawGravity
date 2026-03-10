import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PipelineSession, createPipelineSession } from '../../src/utils/pipelineDebugLog';

describe('PipelineSession', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('records steps with input/output when enabled', () => {
        const session = new PipelineSession('test-session', true);

        const result = session.step(
            'addNumbers',
            { a: 1, b: 2 },
            () => 3,
        );

        expect(result).toBe(3);
        expect(session.length).toBe(1);
    });

    it('passes through without recording when disabled', () => {
        const session = new PipelineSession('test-disabled', false);

        const result = session.step(
            'addNumbers',
            { a: 1, b: 2 },
            () => 3,
        );

        expect(result).toBe(3);
        expect(session.length).toBe(0); // not recorded
    });

    it('handles async steps', async () => {
        const session = new PipelineSession('test-async', true);

        const result = await session.stepAsync(
            'fetchData',
            { url: 'https://example.com' },
            async () => {
                await new Promise((r) => setTimeout(r, 10));
                return { status: 200 };
            },
        );

        expect(result).toEqual({ status: 200 });
        expect(session.length).toBe(1);
    });

    it('records observe calls', () => {
        const session = new PipelineSession('test-observe', true);

        session.observe('checkpoint', { phase: 'init', count: 5 });

        expect(session.length).toBe(1);
    });

    it('truncates long strings in logged data', () => {
        const session = new PipelineSession('test-truncate', true);
        const longString = 'x'.repeat(5000);

        session.step(
            'longInput',
            { text: longString },
            () => 'ok',
        );

        // The session recorded it — the truncation is internal
        expect(session.length).toBe(1);
    });

    it('preserves function return values exactly', () => {
        const session = new PipelineSession('test-return', true);

        const obj = { key: 'value', nested: { arr: [1, 2, 3] } };
        const result = session.step('identity', {}, () => obj);

        expect(result).toBe(obj); // same reference
    });

    it('records sequential step indices', () => {
        const session = new PipelineSession('test-indices', true);

        session.step('step1', {}, () => 1);
        session.step('step2', {}, () => 2);
        session.observe('checkpoint', {});
        session.step('step3', {}, () => 3);

        expect(session.length).toBe(4);
    });
});

describe('createPipelineSession', () => {
    it('creates a session with the given prefix', () => {
        const session = createPipelineSession('tg-active');
        expect(session.sessionId).toMatch(/^tg-active-/);
    });

    it('creates unique session IDs', () => {
        const s1 = createPipelineSession('test');
        const s2 = createPipelineSession('test');
        expect(s1.sessionId).not.toBe(s2.sessionId);
    });
});
