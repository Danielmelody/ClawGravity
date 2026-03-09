/**
 * Platform-agnostic planning button action.
 *
 * Handles Open / Proceed button presses for the planning mode dialog
 * from both Discord and Telegram using the ButtonAction interface.
 */

import type { ButtonAction } from './buttonHandler';
import type { CdpBridge } from '../services/cdpBridgeManager';
import { parsePlanningCustomId } from '../services/cdpBridgeManager';
import { logger } from '../utils/logger';
import { createButtonAction, executeDetectorClick, extractWithRetry } from './buttonActionUtils';

export interface PlanningButtonActionDeps {
    readonly bridge: CdpBridge;
}

const MAX_PLAN_CONTENT = 4096;

export function createPlanningButtonAction(
    deps: PlanningButtonActionDeps,
): ButtonAction {
    return createButtonAction({
        parseFn: parsePlanningCustomId,
        bridge: deps.bridge,
        getDetector: (pool, name) => pool.getPlanningDetector(name),
        label: 'PlanningAction',
        async handler(interaction, detector, action) {
            if (action === 'open') {
                const clicked = await detector.clickOpenButton();
                if (!clicked) {
                    await interaction
                        .reply({ text: 'Open button not found.' })
                        .catch(() => { });
                    return;
                }

                // Wait for DOM to update after Open click
                await new Promise((resolve) => setTimeout(resolve, 500));

                // Extract plan content with retry
                const planContent = await extractWithRetry(
                    () => detector.extractPlanContent(),
                );

                await interaction
                    .update({
                        text: '📋 Plan opened',
                        components: [],
                    })
                    .catch((err) => {
                        logger.warn('[PlanningAction] update failed:', err);
                    });

                if (planContent) {
                    const truncated = planContent.length > MAX_PLAN_CONTENT
                        ? planContent.substring(0, MAX_PLAN_CONTENT - 15) + '\n\n(truncated)'
                        : planContent;
                    await interaction
                        .followUp({ text: truncated })
                        .catch((err) => {
                            logger.warn('[PlanningAction] followUp failed:', err);
                        });
                } else {
                    await interaction
                        .followUp({ text: 'Could not extract plan content from the editor.' })
                        .catch(() => { });
                }
            } else {
                // Proceed action
                await executeDetectorClick(
                    interaction,
                    () => detector.clickProceedButton(),
                    { text: '▶️ Proceed started' },
                    'Proceed button not found.',
                    'PlanningAction',
                );
            }
        },
    });
}
