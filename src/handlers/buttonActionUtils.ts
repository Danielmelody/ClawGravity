/**
 * Shared utilities for platform-agnostic button actions.
 *
 * Eliminates boilerplate duplicated across approval, planning,
 * error popup, and run command button action handlers.
 */

import type { PlatformButtonInteraction } from '../platform/types';
import type { CdpBridge } from '../services/cdpBridgeManager';
import { logger } from '../utils/logger';

/** The shape returned by all parse*CustomId helpers. */
interface ParsedAction {
    action: string;
    projectName?: string | null;
    channelId?: string | null;
}

/**
 * Build a standard `match` function for a button action.
 *
 * @param parseFn A function like `parseApprovalCustomId` that extracts
 *                typed action data from a Discord/Telegram custom ID.
 */
function buildMatcher(
    parseFn: (customId: string) => ParsedAction | null,
): (customId: string) => Record<string, string> | null {
    return (customId: string) => {
        const parsed = parseFn(customId);
        if (!parsed) return null;
        return {
            action: parsed.action,
            projectName: parsed.projectName ?? '',
            channelId: parsed.channelId ?? '',
        };
    };
}

/**
 * Standard pre-flight for a button action execute: defer, channel check,
 * resolve detector.
 *
 * Returns the detector or null (after replying with an error where needed).
 */
async function resolveDetector<T>(
    interaction: PlatformButtonInteraction,
    params: Record<string, string>,
    bridge: CdpBridge,
    getDetector: (pool: CdpBridge['pool'], projectName: string) => T | undefined,
    detectorLabel: string,
    opts?: { skipDefer?: boolean },
): Promise<T | null> {
    const { channelId } = params;

    if (!opts?.skipDefer) {
        await interaction.deferUpdate().catch(() => { });
    }

    if (channelId && channelId !== interaction.channel.id) {
        await interaction
            .reply({ text: `This ${detectorLabel} action is linked to a different session channel.` })
            .catch(() => { });
        return null;
    }

    const projectName = params.projectName || bridge.lastActiveWorkspace;
    const detector = projectName
        ? getDetector(bridge.pool, projectName)
        : undefined;

    if (!detector) {
        logger.warn(`[${detectorLabel}] No detector for project=${projectName}`);
        await interaction
            .reply({ text: `${detectorLabel} detector not found.` })
            .catch(() => { });
        return null;
    }

    return detector;
}

/**
 * Execute a detector click, handling errors uniformly.
 */
export async function executeDetectorClick(
    interaction: PlatformButtonInteraction,
    clickFn: () => Promise<boolean>,
    successPayload: { text: string },
    notFoundText: string,
    label: string,
): Promise<void> {
    let clicked: boolean;
    try {
        clicked = await clickFn();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[${label}] CDP click failed: ${msg}`);
        await interaction.reply({ text: `${label} failed: ${msg}` }).catch(() => { });
        return;
    }

    if (clicked) {
        await interaction
            .update({ ...successPayload, components: [] as any[] })
            .catch((err) => {
                logger.warn(`[${label}] update failed:`, err);
            });
    } else {
        await interaction
            .reply({ text: notFoundText })
            .catch(() => { });
    }
}

/**
 * Extract content with retry, waiting for DOM to update between attempts.
 *
 * Used by planning "Open" to extract plan content after a button click.
 */
export async function extractWithRetry(
    extractFn: () => Promise<string | null>,
    { attempts = 3, delayMs = 500 } = {},
): Promise<string | null> {
    for (let i = 0; i < attempts; i++) {
        const content = await extractFn();
        if (content) return content;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return null;
}

/**
 * Factory for creating a standard ButtonAction with the common
 * match + resolveDetector preamble.
 *
 * Eliminates the duplicated execute method structure across
 * approval, planning, error popup, and run command button actions.
 */
export function createButtonAction<T>(opts: {
    parseFn: (customId: string) => ParsedAction | null;
    bridge: CdpBridge;
    getDetector: (pool: CdpBridge['pool'], name: string) => T | undefined;
    label: string;
    resolveOpts?: { skipDefer?: boolean };
    handler: (
        interaction: PlatformButtonInteraction,
        detector: T,
        action: string,
        params: Record<string, string>,
    ) => Promise<void>;
}): import('./buttonHandler').ButtonAction {
    return {
        match: buildMatcher(opts.parseFn),
        async execute(
            interaction: PlatformButtonInteraction,
            params: Record<string, string>,
        ): Promise<void> {
            const { action } = params;
            const detector = await resolveDetector(
                interaction, params, opts.bridge,
                opts.getDetector, opts.label, opts.resolveOpts,
            );
            if (!detector) return;
            await opts.handler(interaction, detector, action, params);
        },
    };
}
