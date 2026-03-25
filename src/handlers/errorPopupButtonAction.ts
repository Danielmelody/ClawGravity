/**
 * Platform-agnostic error popup button action.
 *
 * Handles Dismiss / Copy Debug / Retry button presses for the error
 * popup dialog from both Discord and Telegram using the ButtonAction interface.
 */

import type { ButtonAction } from './buttonHandler';
import type { CdpBridge } from '../services/cdpBridgeManager';
import { parseErrorPopupCustomId } from '../services/cdpBridgeManager';
import { logger } from '../utils/logger';
import { createButtonAction, executeDetectorClick } from './buttonActionUtils';

export interface ErrorPopupButtonActionDeps {
    readonly bridge: CdpBridge;
}

const MAX_DEBUG_CONTENT = 4096;

export function createErrorPopupButtonAction(
    deps: ErrorPopupButtonActionDeps,
): ButtonAction {
    return createButtonAction({
        parseFn: parseErrorPopupCustomId,
        bridge: deps.bridge,
        getDetector: (pool, name) => pool.getErrorPopupDetector(name),
        label: 'ErrorPopupAction',
        resolveOpts: { skipDefer: true },
        async handler(interaction, detector, action: string) {
            // Acknowledge immediately so Telegram doesn't time out
            await interaction.deferUpdate().catch(() => { });

            if (action === 'dismiss') {
                await executeDetectorClick(
                    interaction,
                    () => detector.clickDismissButton(),
                    { text: '🗑️ Dismissed' },
                    'Dismiss button not found.',
                    'ErrorPopupAction',
                );
            } else if (action === 'copy_debug') {
                const clicked = await detector.clickCopyDebugInfoButton();
                if (!clicked) {
                    await interaction
                        .reply({ text: 'Copy debug info button not found.' })
                        .catch(() => { });
                    return;
                }

                // Wait for clipboard to be populated
                await new Promise((resolve) => setTimeout(resolve, 300));

                const clipboardContent = await detector.readClipboard();

                await interaction
                    .update({
                        text: '📋 Debug info copied',
                        components: [],
                    })
                    .catch((err) => {
                        logger.warn('[ErrorPopupAction] update failed:', err);
                    });

                if (clipboardContent) {
                    const truncated = clipboardContent.length > MAX_DEBUG_CONTENT
                        ? clipboardContent.substring(0, MAX_DEBUG_CONTENT - 15) + '\n\n(truncated)'
                        : clipboardContent;
                    await interaction
                        .followUp({ text: truncated })
                        .catch((err) => {
                            logger.warn('[ErrorPopupAction] followUp failed:', err);
                        });
                } else {
                    await interaction
                        .followUp({ text: 'Could not read debug info from clipboard.' })
                        .catch(() => { });
                }
            } else if (action === 'retry') {
                // Retry action
                await executeDetectorClick(
                    interaction,
                    () => detector.clickRetryButton(),
                    { text: '🔄 Retry initiated' },
                    'Retry button not found.',
                    'ErrorPopupAction',
                );
            } else if (action.startsWith('dynamic_')) {
                const label = action.substring('dynamic_'.length);
                await executeDetectorClick(
                    interaction,
                    () => detector.clickDynamicButton(label),
                    { text: `🖱️ Clicked: ${label}` },
                    `Button '${label}' not found or no longer active.`,
                    'ErrorPopupAction'
                );
            } else {
                logger.warn(`[ErrorPopupAction] Unknown action: ${action}`);
            }
        },
    });
}
