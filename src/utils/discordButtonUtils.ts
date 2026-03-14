import { ActionRowBuilder, ButtonBuilder, APIButtonComponent } from 'discord.js';

/**
 * Disable all buttons in message component rows.
 * Shared utility used by interaction handlers and detector callbacks.
 */
interface ComponentLike {
    type?: number;
    data?: { type?: number };
    toJSON?: () => Record<string, unknown>;
}

interface RowLike {
    components?: ComponentLike[];
}

export function disableAllButtons(components: readonly unknown[]): ActionRowBuilder<ButtonBuilder>[] {
    return components
        .map((row) => {
            const rowAny = row as RowLike;
            if (!Array.isArray(rowAny.components)) return null;

            const nextRow = new ActionRowBuilder<ButtonBuilder>();
            const disabledButtons = rowAny.components
                .map((component: ComponentLike) => {
                    const componentType = component?.type ?? component?.data?.type;
                    if (componentType !== 2) return null;
                    const payload = (typeof component?.toJSON === 'function'
                        ? component.toJSON()
                        : component) as APIButtonComponent;
                    return ButtonBuilder.from(payload).setDisabled(true);
                })
                .filter((button: ButtonBuilder | null): button is ButtonBuilder => button !== null);
            if (disabledButtons.length === 0) return null;
            nextRow.addComponents(...disabledButtons);
            return nextRow;
        })
        .filter((row): row is ActionRowBuilder<ButtonBuilder> => row !== null);
}
