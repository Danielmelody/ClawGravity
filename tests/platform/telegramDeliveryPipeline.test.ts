import { PipelineSession } from '../../src/utils/pipelineDebugLog';
import {
    planDelivery,
    splitTelegramText,
    type DeliveryPlan,
} from '../../src/platform/telegram/telegramDeliveryPipeline';
import type { DeliverySnapshot } from '../../src/platform/telegram/messageDeliveryState';

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

/** Helper: create a steps snapshot with assistant response steps */
function makeStepsSnapshot(responseTexts: string[], runStatus: string | null = null): DeliverySnapshot {
    const steps = responseTexts.map(text => ({
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        plannerResponse: { response: text },
    }));
    return makeSnapshot({
        stepsData: { steps, runStatus },
        stepsClock: 1,
        preferredFormat: 'steps',
    });
}

describe('planDelivery', () => {
    it('returns empty mode when no step data available', () => {
        const plan = planDelivery(testPipeline(), makeSnapshot(), { renderOnlyOnComplete: true });
        expect(plan.mode).toBe('empty');
        expect(plan.chunks).toHaveLength(0);
    });

    it('returns step-rendered when step data is available', () => {
        const snapshot = makeStepsSnapshot(['Hello **world**']);
        const plan = planDelivery(testPipeline(), snapshot, { renderOnlyOnComplete: true });
        expect(plan.mode).toBe('step-rendered');
        expect(plan.telegramHtml).toContain('Hello');
        expect(plan.deliveredText).toBeTruthy();
    });

    it('splits long step-rendered content into chunks', () => {
        const longText = 'A'.repeat(5000);
        const snapshot = makeStepsSnapshot([longText]);
        const plan = planDelivery(testPipeline(), snapshot, { renderOnlyOnComplete: true });
        expect(plan.mode).toBe('step-rendered');
        expect(plan.chunks.length).toBeGreaterThan(1);
        for (const chunk of plan.chunks) {
            expect(chunk.length).toBeLessThanOrEqual(4096);
        }
        expect(plan.deliveredText).toBeTruthy();
    });

    it('returns deliveredText as null when no steps available', () => {
        const snapshot = makeSnapshot({ html: '   \n  ' });
        const plan = planDelivery(testPipeline(), snapshot, { renderOnlyOnComplete: false });
        expect(plan.mode).toBe('empty');
        expect(plan.deliveredText).toBeNull();
    });

    it('returns empty mode when stepsData has empty steps array', () => {
        const snapshot = makeSnapshot({
            stepsData: { steps: [], runStatus: null },
            stepsClock: 1,
        });
        const plan = planDelivery(testPipeline(), snapshot, { renderOnlyOnComplete: true });
        expect(plan.mode).toBe('empty');
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
