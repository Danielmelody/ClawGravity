/**
 * Platform-agnostic run command button action.
 *
 * Handles Run / Reject button presses for the "Run command?"
 * dialog from both Discord and Telegram using the ButtonAction interface.
 */

import type { ButtonAction } from './buttonHandler';
import type { CdpBridge } from '../services/cdpBridgeManager';
import { parseRunCommandCustomId } from '../services/cdpBridgeManager';
import { createButtonAction, executeDetectorClick } from './buttonActionUtils';

export interface RunCommandButtonActionDeps {
    readonly bridge: CdpBridge;
}

export function createRunCommandButtonAction(
    deps: RunCommandButtonActionDeps,
): ButtonAction {
    return createButtonAction({
        parseFn: parseRunCommandCustomId,
        bridge: deps.bridge,
        getDetector: (pool, name) => pool.getRunCommandDetector(name),
        label: 'RunCommandAction',
        async handler(interaction, detector, action) {
            const clickFn = action === 'run'
                ? () => detector.runButton()
                : () => detector.rejectButton();
            const actionLabel = action === 'run' ? 'Run' : 'Reject';

            await executeDetectorClick(
                interaction,
                clickFn,
                { text: `${action === 'run' ? '▶️' : '⛔'} ${actionLabel} completed` },
                'Run command button not found.',
                'RunCommandAction',
            );
        },
    });
}
