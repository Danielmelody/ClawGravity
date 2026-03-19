import {
    initialDeliveryState,
    deliveryReducer,
    resolvePreferredFormat,
    createDeliverySnapshot,
    type MessageDeliveryState,
} from '../../src/platform/telegram/messageDeliveryState';

describe('MessageDeliveryState CRDT', () => {
    describe('initialDeliveryState', () => {
        it('starts with empty registers and completed=false', () => {
            const state = initialDeliveryState();
            expect(state.text.value).toBe('');
            expect(state.text.clock).toBe(0);
            expect(state.html.value).toBe('');
            expect(state.html.clock).toBe(0);
            expect(state.completed).toBe(false);
            expect(state.finalText).toBeNull();
        });
    });

    describe('deliveryReducer', () => {
        it('increments text clock on TEXT_UPDATE', () => {
            let state = initialDeliveryState();
            state = deliveryReducer(state, { type: 'TEXT_UPDATE', text: 'hello' });
            expect(state.text.value).toBe('hello');
            expect(state.text.clock).toBe(1);
            expect(state.html.clock).toBe(0);
        });

        it('increments html clock on HTML_UPDATE', () => {
            let state = initialDeliveryState();
            state = deliveryReducer(state, { type: 'HTML_UPDATE', html: '<b>bold</b>' });
            expect(state.html.value).toBe('<b>bold</b>');
            expect(state.html.clock).toBe(1);
            expect(state.text.clock).toBe(0);
        });

        it('sets completed=true and finalText on COMPLETE', () => {
            let state = initialDeliveryState();
            state = deliveryReducer(state, { type: 'COMPLETE', finalText: 'done' });
            expect(state.completed).toBe(true);
            expect(state.finalText).toBe('done');
        });

        it('COMPLETE is monotonic — second dispatch is no-op', () => {
            let state = initialDeliveryState();
            state = deliveryReducer(state, { type: 'COMPLETE', finalText: 'first' });
            const stateAfterSecond = deliveryReducer(state, { type: 'COMPLETE', finalText: 'second' });
            expect(stateAfterSecond).toBe(state); // same reference — no mutation
            expect(stateAfterSecond.finalText).toBe('first');
        });

        it('never mutates input state', () => {
            const state = initialDeliveryState();
            const next = deliveryReducer(state, { type: 'TEXT_UPDATE', text: 'x' });
            expect(state.text.value).toBe('');
            expect(next.text.value).toBe('x');
        });
    });

    describe('resolvePreferredFormat', () => {
        it('returns text when html clock is 0', () => {
            const state = initialDeliveryState();
            expect(resolvePreferredFormat(state)).toBe('text');
        });

        it('returns steps when stepsData has content and clock > 0', () => {
            let state = initialDeliveryState();
            state = deliveryReducer(state, {
                type: 'STEPS_UPDATE',
                stepsData: { steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' }], runStatus: null },
            });
            expect(resolvePreferredFormat(state)).toBe('steps');
        });

        it('returns html when html is the freshest non-empty preview', () => {
            let state = initialDeliveryState();
            state = deliveryReducer(state, { type: 'TEXT_UPDATE', text: 'plain text' });
            state = deliveryReducer(state, { type: 'HTML_UPDATE', html: '<b>preview</b>' });
            expect(resolvePreferredFormat(state)).toBe('html');
        });

        it('returns text when html clock > 0 but value is whitespace', () => {
            let state = initialDeliveryState();
            state = deliveryReducer(state, { type: 'HTML_UPDATE', html: '   ' });
            expect(resolvePreferredFormat(state)).toBe('text');
        });
    });

    describe('createDeliverySnapshot', () => {
        it('freezes current state into a snapshot', () => {
            let state = initialDeliveryState();
            state = deliveryReducer(state, { type: 'TEXT_UPDATE', text: 'hello' });
            state = deliveryReducer(state, { type: 'HTML_UPDATE', html: '<b>hi</b>' });
            state = deliveryReducer(state, { type: 'COMPLETE', finalText: 'final' });

            const snap = createDeliverySnapshot(state);
            expect(snap.text).toBe('hello');
            expect(snap.html).toBe('<b>hi</b>');
            expect(snap.preferredFormat).toBe('html');
            expect(snap.finalText).toBe('final');
            expect(snap.textClock).toBe(1);
            expect(snap.htmlClock).toBe(1);
        });

        it('snapshot is independent of subsequent state changes', () => {
            let state = initialDeliveryState();
            state = deliveryReducer(state, { type: 'TEXT_UPDATE', text: 'v1' });
            const snap = createDeliverySnapshot(state);

            state = deliveryReducer(state, { type: 'TEXT_UPDATE', text: 'v2' });
            expect(snap.text).toBe('v1'); // snapshot unaffected
        });
    });
});
