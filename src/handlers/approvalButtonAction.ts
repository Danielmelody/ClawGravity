/**
 * Platform-agnostic approval button action.
 *
 * Handles Allow / Always Allow / Deny button presses from both Discord
 * and Telegram using the ButtonAction interface.
 */

import type { ButtonAction } from './buttonHandler';
import type { CdpBridge } from '../services/cdpBridgeManager';
import { parseApprovalCustomId } from '../services/cdpBridgeManager';
import { logger } from '../utils/logger';
import { createButtonAction, executeDetectorClick } from './buttonActionUtils';

export interface ApprovalButtonActionDeps {
    readonly bridge: CdpBridge;
}

export function createApprovalButtonAction(
    deps: ApprovalButtonActionDeps,
): ButtonAction {
    return createButtonAction({
        parseFn: parseApprovalCustomId,
        bridge: deps.bridge,
        getDetector: (pool, name) => pool.getApprovalDetector(name),
        label: 'ApprovalAction',
        async handler(interaction, detector, action) {
            const lastInfo = detector.getLastDetectedInfo();
            logger.debug(`[ApprovalAction] lastDetectedInfo: ${lastInfo ? JSON.stringify(lastInfo) : 'null'}`);

            let clickFn: () => Promise<boolean>;
            let actionLabel: string;
            if (action === 'approve') {
                clickFn = () => detector.approveButton();
                actionLabel = 'Allow';
            } else if (action === 'always_allow') {
                clickFn = () => detector.alwaysAllowButton();
                actionLabel = 'Allow Chat';
            } else {
                clickFn = () => detector.denyButton();
                actionLabel = 'Deny';
            }

            await executeDetectorClick(
                interaction,
                clickFn,
                { text: `✅ ${actionLabel} completed` },
                'Approval button not found.',
                'ApprovalAction',
            );
        },
    });
}
