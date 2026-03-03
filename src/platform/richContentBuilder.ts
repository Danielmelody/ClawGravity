/**
 * Immutable builder functions for RichContent.
 *
 * All functions return a new object — never mutate the input.
 */

import type { RichContent, RichContentField } from './types';

/** Create an empty RichContent. */
export function createRichContent(): RichContent {
    return {};
}

/** Set the title. */
export function withTitle(rc: RichContent, title: string): RichContent {
    return { ...rc, title };
}

/** Set the description. */
export function withDescription(rc: RichContent, description: string): RichContent {
    return { ...rc, description };
}

/** Set the color (numeric, e.g. 0x5865F2). */
export function withColor(rc: RichContent, color: number): RichContent {
    return { ...rc, color };
}

/** Add a field. Existing fields are preserved. */
export function addField(
    rc: RichContent,
    name: string,
    value: string,
    inline?: boolean,
): RichContent {
    const field: RichContentField = { name, value, inline };
    const fields = rc.fields ? [...rc.fields, field] : [field];
    return { ...rc, fields };
}

/** Replace all fields at once. */
export function withFields(rc: RichContent, fields: readonly RichContentField[]): RichContent {
    return { ...rc, fields: fields.map((field) => ({ ...field })) };
}

/** Set the footer text. */
export function withFooter(rc: RichContent, footer: string): RichContent {
    return { ...rc, footer };
}

/** Set the timestamp. */
export function withTimestamp(rc: RichContent, timestamp?: Date): RichContent {
    return { ...rc, timestamp: timestamp ?? new Date() };
}

/** Set the thumbnail URL. */
export function withThumbnail(rc: RichContent, thumbnailUrl: string): RichContent {
    return { ...rc, thumbnailUrl };
}

/** Set the image URL. */
export function withImage(rc: RichContent, imageUrl: string): RichContent {
    return { ...rc, imageUrl };
}

// ---------------------------------------------------------------------------
// Convenience: fluent-style chain helper
// ---------------------------------------------------------------------------

/**
 * Apply a sequence of transforms to a RichContent.
 * Each transform is a function `(rc: RichContent) => RichContent`.
 * Usage:
 *   pipe(
 *     createRichContent(),
 *     (rc) => withTitle(rc, 'Hello'),
 *     (rc) => withColor(rc, 0x00FF00),
 *   )
 */
export function pipe(
    initial: RichContent,
    ...transforms: ReadonlyArray<(rc: RichContent) => RichContent>
): RichContent {
    return transforms.reduce((acc, fn) => fn(acc), initial);
}
