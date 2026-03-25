/**
 * Platform-agnostic error popup button action.
 *
 * Handles the Continue button press for error popup notifications.
 * When pressed, sends a "continue" message to the active cascade to retry.
 */

import type { ButtonAction } from './buttonHandler';
import type { CdpBridge } from '../services/cdpBridgeManager';
import { parseErrorPopupCustomId } from '../services/cdpBridgeManager';
import { logger } from '../utils/logger';
import { createButtonAction } from './buttonActionUtils';

export interface ErrorPopupButtonActionDeps {
    readonly bridge: CdpBridge;
}

export function createErrorPopupButtonAction(
    deps: ErrorPopupButtonActionDeps,
): ButtonAction {
    return createButtonAction({
        parseFn: parseErrorPopupCustomId,
        bridge: deps.bridge,
        getDetector: (pool, name) => pool.getErrorPopupDetector(name),
        label: 'ErrorPopupAction',
        resolveOpts: { skipDefer: true },
        async handler(interaction, _detector, action: string) {
            await interaction.deferUpdate().catch(() => { });

            if (action === 'continue') {
                try {
                    const projectName = interaction.customId?.split(':')[1];
                    if (!projectName) {
                        await interaction.reply({ text: 'Could not determine project.' }).catch(() => { });
                        return;
                    }
                    const runtime = deps.bridge.pool.getRuntime(projectName);
                    if (!runtime) {
                        await interaction.reply({ text: 'Workspace not connected.' }).catch(() => { });
                        return;
                    }
                    const result = await runtime.sendPrompt({ text: 'continue' });
                    if (result.ok) {
                        await interaction.update({ text: '▶️ Continuing...', components: [] }).catch(() => { });
                    } else {
                        await interaction.reply({ text: `Failed to continue: ${result.error || 'unknown'}` }).catch(() => { });
                    }
                } catch (err) {
                    logger.error('[ErrorPopupAction] Continue failed:', err);
                    await interaction.reply({ text: 'Continue failed.' }).catch(() => { });
                }
            } else {
                logger.warn(`[ErrorPopupAction] Unknown action: ${action}`);
            }
        },
    });
}
