import {
    createRichContent,
    withTitle,
    withDescription,
    withColor,
    addField,
    withFields,
    withFooter,
    withTimestamp,
    withThumbnail,
    withImage,
    pipe,
} from '../../src/platform/richContentBuilder';
import type { RichContent } from '../../src/platform/types';

describe('richContentBuilder', () => {
    describe('createRichContent', () => {
        it('returns an empty object', () => {
            expect(createRichContent()).toEqual({});
        });
    });

    describe('immutability', () => {
        it('withTitle does not mutate the original', () => {
            const original = createRichContent();
            const updated = withTitle(original, 'Hello');
            expect(original).toEqual({});
            expect(updated).toEqual({ title: 'Hello' });
        });

        it('withDescription does not mutate the original', () => {
            const original = withTitle(createRichContent(), 'T');
            const updated = withDescription(original, 'desc');
            expect(original.description).toBeUndefined();
            expect(updated.description).toBe('desc');
            expect(updated.title).toBe('T');
        });

        it('withColor does not mutate the original', () => {
            const original = createRichContent();
            const updated = withColor(original, 0xFF0000);
            expect(original).toEqual({});
            expect(updated.color).toBe(0xFF0000);
        });

        it('addField does not mutate the original', () => {
            const original = createRichContent();
            const updated = addField(original, 'key', 'val');
            expect(original.fields).toBeUndefined();
            expect(updated.fields).toHaveLength(1);
            expect(updated.fields![0]).toEqual({ name: 'key', value: 'val', inline: undefined });
        });

        it('addField preserves existing fields', () => {
            const rc1 = addField(createRichContent(), 'a', '1');
            const rc2 = addField(rc1, 'b', '2', true);
            expect(rc1.fields).toHaveLength(1);
            expect(rc2.fields).toHaveLength(2);
            expect(rc2.fields![1]).toEqual({ name: 'b', value: '2', inline: true });
        });

        it('withFields replaces all fields without mutating', () => {
            const rc = addField(createRichContent(), 'old', 'val');
            const newFields = [{ name: 'new', value: 'val2' }];
            const updated = withFields(rc, newFields);
            expect(rc.fields).toHaveLength(1);
            expect(rc.fields![0].name).toBe('old');
            expect(updated.fields).toHaveLength(1);
            expect(updated.fields![0].name).toBe('new');
            // Verify the array was copied (not same reference)
            newFields.push({ name: 'extra', value: '' });
            expect(updated.fields).toHaveLength(1);
        });

        it('withFooter does not mutate the original', () => {
            const original = createRichContent();
            const updated = withFooter(original, 'foot');
            expect(original).toEqual({});
            expect(updated.footer).toBe('foot');
        });

        it('withTimestamp does not mutate the original', () => {
            const original = createRichContent();
            const ts = new Date('2024-01-01T00:00:00Z');
            const updated = withTimestamp(original, ts);
            expect(original.timestamp).toBeUndefined();
            expect(updated.timestamp).toBe(ts);
        });

        it('withTimestamp defaults to current date', () => {
            const before = Date.now();
            const updated = withTimestamp(createRichContent());
            const after = Date.now();
            expect(updated.timestamp).toBeDefined();
            expect(updated.timestamp!.getTime()).toBeGreaterThanOrEqual(before);
            expect(updated.timestamp!.getTime()).toBeLessThanOrEqual(after);
        });
    });

    describe('withThumbnail', () => {
        it('sets thumbnailUrl', () => {
            const rc = withThumbnail(createRichContent(), 'https://example.com/img.png');
            expect(rc.thumbnailUrl).toBe('https://example.com/img.png');
        });
    });

    describe('withImage', () => {
        it('sets imageUrl', () => {
            const rc = withImage(createRichContent(), 'https://example.com/big.png');
            expect(rc.imageUrl).toBe('https://example.com/big.png');
        });
    });

    describe('pipe', () => {
        it('applies transforms left to right', () => {
            const rc = pipe(
                createRichContent(),
                (r) => withTitle(r, 'Title'),
                (r) => withDescription(r, 'Desc'),
                (r) => withColor(r, 0x00FF00),
                (r) => addField(r, 'F1', 'V1'),
                (r) => withFooter(r, 'Footer'),
            );

            expect(rc).toEqual({
                title: 'Title',
                description: 'Desc',
                color: 0x00FF00,
                fields: [{ name: 'F1', value: 'V1', inline: undefined }],
                footer: 'Footer',
            });
        });

        it('returns the initial value when no transforms', () => {
            const rc = pipe(createRichContent());
            expect(rc).toEqual({});
        });

        it('does not mutate intermediate results', () => {
            const base: RichContent = { title: 'Base' };
            const result = pipe(
                base,
                (r) => withColor(r, 0xFF0000),
                (r) => withDescription(r, 'D'),
            );
            expect(base).toEqual({ title: 'Base' });
            expect(result.color).toBe(0xFF0000);
            expect(result.description).toBe('D');
        });
    });
});
