import { PipelineSession } from '../../src/utils/pipelineDebugLog';
import {
    planDelivery,
    splitTelegramText,
    type DeliveryPlan,
} from '../../src/platform/telegram/telegramDeliveryPipeline';
import type { DeliverySnapshot } from '../../src/platform/telegram/messageDeliveryState';

// Mock the trajectory renderer (HTML conversion) to pass through content
jest.mock('../../src/platform/telegram/trajectoryRenderer', () => ({
    markdownToTelegramHtmlViaUnified: (text: string) => text,
    rawHtmlToTelegramHtml: (html: string) => html,
}));

function testPipeline(): PipelineSession {
    return new PipelineSession('test-' + Date.now(), true);
}

function makeSnapshot(overrides: Partial<DeliverySnapshot> = {}): DeliverySnapshot {
    return {
        text: '',
        html: '',
        preferredFormat: 'text',
        finalText: '',
        textClock: 0,
        htmlClock: 0,
        ...overrides,
    };
}

describe('planDelivery', () => {
    it('returns empty mode when finalText is empty', () => {
        const plan = planDelivery(testPipeline(), makeSnapshot(), { renderOnlyOnComplete: true });
        expect(plan.mode).toBe('empty');
        expect(plan.chunks).toHaveLength(0);
    });

    it('returns text-to-html fallback when finalText exists but no rendered HTML is available', () => {
        const snapshot = makeSnapshot({ finalText: 'Hello world' });
        const plan = planDelivery(testPipeline(), snapshot, { renderOnlyOnComplete: false });
        // text-to-html fallback: converts finalText to HTML when renderer fails
        expect(plan.mode).toBe('text-to-html');
        expect(plan.chunks.length).toBeGreaterThan(0);
        expect(plan.deliveredText).toBeTruthy();
    });

    it('prefers text-to-html when both finalText and html are available', () => {
        const snapshot = makeSnapshot({
            finalText: 'Hello world',
            html: '<b>Hello world</b>',
            htmlClock: 1,
            preferredFormat: 'html',
        });
        const plan = planDelivery(testPipeline(), snapshot, { renderOnlyOnComplete: true });
        // text-to-html is now the primary path; rendered-html is the fallback
        expect(plan.mode).toBe('text-to-html');
        expect(plan.chunks.length).toBeGreaterThan(0);
    });

    it('returns text-to-html fallback when renderOnlyOnComplete=true but html is empty', () => {
        const snapshot = makeSnapshot({
            finalText: 'Some output text',
            html: '',
            htmlClock: 0,
            preferredFormat: 'text',
        });
        const plan = planDelivery(testPipeline(), snapshot, { renderOnlyOnComplete: true });
        // text-to-html fallback when renderer fails
        expect(plan.mode).toBe('text-to-html');
        expect(plan.chunks.length).toBeGreaterThan(0);
    });

    it('falls back to rendered-html when only HTML is available (no finalText)', () => {
        const longHtml = '<b>' + 'A'.repeat(5000) + '</b>';
        const snapshot = makeSnapshot({
            html: longHtml,
            htmlClock: 1,
            preferredFormat: 'html',
        });
        const plan = planDelivery(testPipeline(), snapshot, { renderOnlyOnComplete: true });
        // rendered-html is used as fallback when finalText is empty
        expect(plan.mode).toBe('rendered-html');
        expect(plan.chunks.length).toBeGreaterThan(1);
        for (const chunk of plan.chunks) {
            expect(chunk.length).toBeLessThanOrEqual(4096);
        }
    });

    it('returns deliveredText as null when finalText is whitespace-only', () => {
        const snapshot = makeSnapshot({ finalText: '   \n  ' });
        const plan = planDelivery(testPipeline(), snapshot, { renderOnlyOnComplete: false });
        expect(plan.mode).toBe('empty');
        expect(plan.deliveredText).toBeNull();
    });
});

describe('splitTelegramText', () => {
    it('returns single chunk for short text', () => {
        expect(splitTelegramText('Hello')).toEqual(['Hello']);
    });

    it('returns empty array for empty string', () => {
        expect(splitTelegramText('')).toEqual([]);
    });

    it('splits long text respecting 4096 limit', () => {
        const text = 'A'.repeat(5000);
        const chunks = splitTelegramText(text);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(4096);
        }
        expect(chunks.join('')).toBe(text);
    });

    it('preserves HTML tag integrity across chunks', () => {
        const text = `<b>${'X'.repeat(4090)}</b><b>${'Y'.repeat(4090)}</b>`;
        const chunks = splitTelegramText(text);
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(4096);
            // Each chunk should have balanced tags
            const openCount = (chunk.match(/<b>/g) || []).length;
            const closeCount = (chunk.match(/<\/b>/g) || []).length;
            expect(openCount).toBe(closeCount);
        }
    });
});
