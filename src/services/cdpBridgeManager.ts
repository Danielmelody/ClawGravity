import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import type { PlatformChannel, PlatformSentMessage, MessagePayload } from '../platform/types';
import {
    buildApprovalNotification,
    buildAutoApprovedNotification,
    buildPlanningNotification,
    buildErrorPopupNotification,
    buildRunCommandNotification,
    buildResolvedOverlay,
} from './notificationSender';
import { ApprovalDetector, ApprovalInfo } from './approvalDetector';
import { AutoAcceptService } from './autoAcceptService';
import { CdpConnectionPool } from './cdpConnectionPool';
import { CdpService } from './cdpService';
import { ErrorPopupDetector, ErrorPopupInfo } from './errorPopupDetector';
import { PlanningDetector, PlanningInfo } from './planningDetector';
import { RunCommandDetector, RunCommandInfo } from './runCommandDetector';
import { QuotaService } from './quotaService';
import { UserMessageDetector, UserMessageInfo } from './userMessageDetector';
import { TrajectoryStreamRouter } from './trajectoryStreamRouter';
import { WorkspaceRuntime } from './workspaceRuntime';

/** CDP connection state management */
export interface CdpBridge {
    pool: CdpConnectionPool;
    quota: QuotaService;
    autoAccept: AutoAcceptService;
    /** Directory name of the workspace that last sent a message */
    lastActiveWorkspace: string | null;
    /** Channel that last sent a message (destination for approval notifications) */
    lastActiveChannel: PlatformChannel | null;
    /** Workspace-level approval notification destination (workspace -> channel) */
    approvalChannelByWorkspace: Map<string, PlatformChannel>;
    /** Session-level approval notification destination (workspace+sessionTitle -> channel) */
    approvalChannelBySession: Map<string, PlatformChannel>;
}

import {
    APPROVE_ACTION_PREFIX,
    ALWAYS_ALLOW_ACTION_PREFIX,
    DENY_ACTION_PREFIX,
    PLANNING_OPEN_ACTION_PREFIX,
    PLANNING_PROCEED_ACTION_PREFIX,
    ERROR_POPUP_DISMISS_ACTION_PREFIX,
    ERROR_POPUP_COPY_DEBUG_ACTION_PREFIX,
    ERROR_POPUP_RETRY_ACTION_PREFIX,
    RUN_COMMAND_RUN_ACTION_PREFIX,
    RUN_COMMAND_REJECT_ACTION_PREFIX,
} from './actionPrefixes';

function normalizeSessionTitle(title: string): string {
    return title.trim().toLowerCase();
}

function buildSessionRouteKey(projectName: string, sessionTitle: string): string {
    return `${projectName}::${normalizeSessionTitle(sessionTitle)}`;
}

export async function getCurrentChatTitle(cdp: CdpService): Promise<string | null> {
    try {
        const client = await cdp.getGrpcClient();
        if (!client) return null;

        const summaries = await client.listCascades();
        if (summaries && typeof summaries === 'object') {
            let latestTitle: string | null = null;
            let latestTime = 0;

            for (const [, summary] of Object.entries(summaries)) {
                const s = summary as any;
                const modTime = s.lastModifiedTimestamp
                    ? new Date(s.lastModifiedTimestamp).getTime()
                    : 0;
                if (modTime > latestTime) {
                    latestTime = modTime;
                    latestTitle = s.name || s.title || null;
                }
            }

            if (latestTitle) return latestTitle;
        }
    } catch {
        return null;
    }

    return null;
}


export function registerApprovalWorkspaceChannel(
    bridge: CdpBridge,
    projectName: string,
    channel: PlatformChannel,
): void {
    bridge.approvalChannelByWorkspace.set(projectName, channel);
}

export function registerApprovalSessionChannel(
    bridge: CdpBridge,
    projectName: string,
    sessionTitle: string,
    channel: PlatformChannel,
): void {
    if (!sessionTitle || sessionTitle.trim().length === 0) return;
    bridge.approvalChannelBySession.set(buildSessionRouteKey(projectName, sessionTitle), channel);
    bridge.approvalChannelByWorkspace.set(projectName, channel);
}

export function resolveApprovalChannelForCurrentChat(
    bridge: CdpBridge,
    projectName: string,
    currentChatTitle: string | null,
): PlatformChannel | null {
    // Try session-level match first (most precise routing)
    if (currentChatTitle && currentChatTitle.trim().length > 0) {
        const key = buildSessionRouteKey(projectName, currentChatTitle);
        const sessionChannel = bridge.approvalChannelBySession.get(key);
        if (sessionChannel) return sessionChannel;
    }
    // Fall back to workspace-level routing
    return bridge.approvalChannelByWorkspace.get(projectName) ?? null;
}

// ---------------------------------------------------------------------------
// Generic custom-ID build / parse helpers
// ---------------------------------------------------------------------------

/** Map of action name → prefix for all button interaction types */
type ActionPrefixMap<A extends string> = Record<A, string>;

/** Parsed result from a custom ID */
interface ParsedCustomId<A extends string> {
    action: A;
    projectName: string | null;
    channelId: string | null;
}

/**
 * Build a custom ID string from an action, project name, and optional channel ID.
 * Format: `<prefix>` or `<prefix>:<projectName>` or `<prefix>:<projectName>:<channelId>`
 */
function buildCustomId<A extends string>(
    prefixMap: ActionPrefixMap<A>,
    action: A,
    projectName: string,
    channelId?: string,
): string {
    const prefix = prefixMap[action];
    if (channelId && channelId.trim().length > 0) {
        return `${prefix}:${projectName}:${channelId}`;
    }
    return `${prefix}:${projectName}`;
}

/**
 * Parse a custom ID string back into its action, project name, and channel ID.
 * Returns null if the custom ID doesn't match any known prefix.
 */
function parseCustomId<A extends string>(
    prefixMap: ActionPrefixMap<A>,
    customId: string,
): ParsedCustomId<A> | null {
    for (const [action, prefix] of Object.entries(prefixMap)) {
        if (customId === prefix) {
            return { action: action as A, projectName: null, channelId: null };
        }
        if (customId.startsWith(`${prefix}:`)) {
            const rest = customId.substring((prefix as string).length + 1);
            const [projectName, channelId] = rest.split(':');
            return {
                action: action as A,
                projectName: projectName || null,
                channelId: channelId || null,
            };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Domain-specific wrappers (backward-compatible public API)
// ---------------------------------------------------------------------------

const APPROVAL_PREFIX_MAP = {
    approve: APPROVE_ACTION_PREFIX,
    always_allow: ALWAYS_ALLOW_ACTION_PREFIX,
    deny: DENY_ACTION_PREFIX,
} as const;

export function buildApprovalCustomId(
    action: 'approve' | 'always_allow' | 'deny',
    projectName: string,
    channelId?: string,
): string {
    return buildCustomId(APPROVAL_PREFIX_MAP, action, projectName, channelId);
}

export function parseApprovalCustomId(customId: string): ParsedCustomId<'approve' | 'always_allow' | 'deny'> | null {
    return parseCustomId(APPROVAL_PREFIX_MAP, customId);
}

const PLANNING_PREFIX_MAP = {
    open: PLANNING_OPEN_ACTION_PREFIX,
    proceed: PLANNING_PROCEED_ACTION_PREFIX,
} as const;

export function buildPlanningCustomId(
    action: 'open' | 'proceed',
    projectName: string,
    channelId?: string,
): string {
    return buildCustomId(PLANNING_PREFIX_MAP, action, projectName, channelId);
}

export function parsePlanningCustomId(customId: string): ParsedCustomId<'open' | 'proceed'> | null {
    return parseCustomId(PLANNING_PREFIX_MAP, customId);
}

const ERROR_POPUP_PREFIX_MAP = {
    dismiss: ERROR_POPUP_DISMISS_ACTION_PREFIX,
    copy_debug: ERROR_POPUP_COPY_DEBUG_ACTION_PREFIX,
    retry: ERROR_POPUP_RETRY_ACTION_PREFIX,
} as const;

function buildErrorPopupCustomId(
    action: 'dismiss' | 'copy_debug' | 'retry',
    projectName: string,
    channelId?: string,
): string {
    return buildCustomId(ERROR_POPUP_PREFIX_MAP, action, projectName, channelId);
}

export function parseErrorPopupCustomId(customId: string): ParsedCustomId<'dismiss' | 'copy_debug' | 'retry'> | null {
    return parseCustomId(ERROR_POPUP_PREFIX_MAP, customId);
}

const RUN_COMMAND_PREFIX_MAP = {
    run: RUN_COMMAND_RUN_ACTION_PREFIX,
    reject: RUN_COMMAND_REJECT_ACTION_PREFIX,
} as const;

export function buildRunCommandCustomId(
    action: 'run' | 'reject',
    projectName: string,
    channelId?: string,
): string {
    return buildCustomId(RUN_COMMAND_PREFIX_MAP, action, projectName, channelId);
}

export function parseRunCommandCustomId(customId: string): ParsedCustomId<'run' | 'reject'> | null {
    return parseCustomId(RUN_COMMAND_PREFIX_MAP, customId);
}

/** Initialize the CDP bridge (lazy connection: pool creation only) */
export function initCdpBridge(autoApproveDefault: boolean): CdpBridge {
    const pool = new CdpConnectionPool({
        cdpCallTimeout: 15000,
        // Keep CDP reconnection lazy: do not reopen windows in background.
        // Reconnection is triggered when the next chat/template message is sent.
        maxReconnectAttempts: 0,
        reconnectDelayMs: 3000,
    });

    const quota = new QuotaService();
    const autoAccept = new AutoAcceptService(autoApproveDefault);

    return {
        pool,
        quota,
        autoAccept,
        lastActiveWorkspace: null,
        lastActiveChannel: null,
        approvalChannelByWorkspace: new Map(),
        approvalChannelBySession: new Map(),
    };
}

/**
 * Helper to get the currently active CdpService from lastActiveWorkspace.
 * Used in contexts where the workspace path is not explicitly provided,
 * such as button interactions and model/mode switching.
 */
export function getCurrentCdp(bridge: CdpBridge): CdpService | null {
    if (!bridge.lastActiveWorkspace) return null;
    return bridge.pool.getConnected(bridge.lastActiveWorkspace);
}

/* ─── Shared helpers for detector notification tracking ─── */

/** Mutable state container used by all detector onResolved/send callbacks. */
interface DetectorNotificationState {
    lastNotification: { sent: PlatformSentMessage; payload: MessagePayload } | null;
}

/** Create an onResolved callback that disables the last notification message. */
function createResolvedHandler(state: DetectorNotificationState): () => void {
    return () => {
        if (!state.lastNotification) return;
        const { sent, payload } = state.lastNotification;
        state.lastNotification = null;
        const resolved = buildResolvedOverlay(payload, t('Resolved in Antigravity'));
        sent.edit(resolved).catch(logger.error);
    };
}

/** Resolve the target channel for a detector notification. Returns null if no channel is linked. */
async function resolveDetectorChannel(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
    detectorLabel: string,
): Promise<{ channel: PlatformChannel; channelId: string } | null> {
    const currentChatTitle = await getCurrentChatTitle(cdp);
    const targetChannel = resolveApprovalChannelForCurrentChat(bridge, projectName, currentChatTitle);
    const targetChannelId = targetChannel ? targetChannel.id : '';

    if (!targetChannel || !targetChannelId) {
        logger.warn(
            `[${detectorLabel}:${projectName}] Skipped notification because chat is not linked to a session` +
            `${currentChatTitle ? ` (title="${currentChatTitle}")` : ''}`,
        );
        return null;
    }

    return { channel: targetChannel, channelId: targetChannelId };
}

/** Send a notification and track it in state for auto-disable. */
async function sendAndTrackNotification(
    state: DetectorNotificationState,
    channel: PlatformChannel,
    payload: MessagePayload,
): Promise<void> {
    const sent = await channel.send(payload).catch((err: any) => {
        logger.error(err);
        return null;
    });
    if (sent) {
        state.lastNotification = { sent, payload };
    }
}

/**
 * Helper to start an approval detector for each workspace.
 * Does nothing if a detector for the same workspace is already running.
 */
function ensureApprovalDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
): void {
    const existing = bridge.pool.getApprovalDetector(projectName);
    if (existing && existing.isActive()) return;

    // Track the most recent notification for auto-disable on resolve.
    // Only the latest is tracked; if a new detection fires before the previous
    // is resolved, the older reference is overwritten. This is acceptable because
    // the detector's lastDetectedKey deduplication prevents rapid successive notifications.
    const notifState: DetectorNotificationState = { lastNotification: null };

    const detector = new ApprovalDetector({
        cdpService: cdp,
        onResolved: createResolvedHandler(notifState),
        onApprovalRequired: async (info: ApprovalInfo) => {
            logger.debug(`[ApprovalDetector:${projectName}] Approval button detected (allow="${info.approveText}", deny="${info.denyText}")`);

            const target = await resolveDetectorChannel(bridge, cdp, projectName, 'ApprovalDetector');
            if (!target) return;

            if (bridge.autoAccept.isEnabled()) {
                const accepted = await detector.alwaysAllowButton() || await detector.approveButton();

                const autoPayload = buildAutoApprovedNotification({
                    accepted,
                    projectName,
                    description: info.description ?? undefined,
                    approveText: info.approveText ?? undefined,
                });
                await target.channel.send(autoPayload).catch(logger.error);

                if (accepted) {
                    return;
                }
            }

            const payload = buildApprovalNotification({
                title: t('Approval Required'),
                description: info.description || t('Antigravity is requesting approval for an action'),
                projectName,
                channelId: target.channelId,
                extraFields: [
                    { name: t('Allow button'), value: info.approveText, inline: true },
                    { name: t('Allow Chat button'), value: info.alwaysAllowText || t('In Dropdown'), inline: true },
                    { name: t('Deny button'), value: info.denyText || t('(None)'), inline: true },
                ],
            });

            await sendAndTrackNotification(notifState, target.channel, payload);
        },
    });

    detector.start();
    bridge.pool.registerApprovalDetector(projectName, detector);
    logger.debug(`[ApprovalDetector:${projectName}] Started approval button detection`);
}

/**
 * Helper to start a planning detector for each workspace.
 * Does nothing if a detector for the same workspace is already running.
 */
function ensurePlanningDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
): void {
    const existing = bridge.pool.getPlanningDetector(projectName);
    if (existing && existing.isActive()) return;

    // Track the most recent planning notification for auto-disable on resolve.
    // See ensureApprovalDetector comment for tracking limitation rationale.
    const notifState: DetectorNotificationState = { lastNotification: null };

    const detector = new PlanningDetector({
        cdpService: cdp,
        onResolved: createResolvedHandler(notifState),
        onPlanningRequired: async (info: PlanningInfo) => {
            logger.debug(`[PlanningDetector:${projectName}] Planning buttons detected (title="${info.planTitle}")`);

            const target = await resolveDetectorChannel(bridge, cdp, projectName, 'PlanningDetector');
            if (!target) return;

            const descriptionText = info.description || info.planSummary || t('A plan has been generated and is awaiting your review.');

            const extraFields: { name: string; value: string; inline?: boolean }[] = [
                { name: t('Plan'), value: info.planTitle || t('Implementation Plan'), inline: true },
                { name: t('Workspace'), value: projectName, inline: true },
            ];
            if (info.planSummary && info.description) {
                extraFields.push({ name: t('Summary'), value: info.planSummary.substring(0, 1024), inline: false });
            }

            const payload = buildPlanningNotification({
                title: t('Planning Mode'),
                description: descriptionText,
                projectName,
                channelId: target.channelId,
                extraFields,
            });

            await sendAndTrackNotification(notifState, target.channel, payload);
        },
    });

    detector.start();
    bridge.pool.registerPlanningDetector(projectName, detector);
    logger.debug(`[PlanningDetector:${projectName}] Started planning button detection`);
}

/**
 * Helper to start an error popup detector for each workspace.
 * Does nothing if a detector for the same workspace is already running.
 */
function ensureErrorPopupDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
): void {
    const existing = bridge.pool.getErrorPopupDetector(projectName);
    if (existing && existing.isActive()) return;

    // Track the most recent error notification for auto-disable on resolve.
    // See ensureApprovalDetector comment for tracking limitation rationale.
    const notifState: DetectorNotificationState = { lastNotification: null };

    const detector = new ErrorPopupDetector({
        cdpService: cdp,
        onResolved: createResolvedHandler(notifState),
        onErrorPopup: async (info: ErrorPopupInfo) => {
            logger.debug(`[ErrorPopupDetector:${projectName}] Error popup detected (title="${info.title}")`);

            const target = await resolveDetectorChannel(bridge, cdp, projectName, 'ErrorPopupDetector');
            if (!target) return;

            const bodyText = info.body || t('An error occurred in the Antigravity agent.');
            const supportsActions = info.buttons.some((label) => {
                const normalized = label.trim().toLowerCase();
                return normalized === 'dismiss' || normalized === 'copy debug info' || normalized === 'retry';
            });

            const payload = buildErrorPopupNotification({
                title: info.title || t('Agent Error'),
                errorMessage: bodyText.substring(0, 4096),
                projectName,
                channelId: target.channelId,
                includeActions: supportsActions,
                extraFields: [
                    { name: t('Buttons'), value: info.buttons.join(', ') || t('(None)'), inline: true },
                    { name: t('Workspace'), value: projectName, inline: true },
                ],
            });

            await sendAndTrackNotification(notifState, target.channel, payload);
        },
    });

    detector.start();
    bridge.pool.registerErrorPopupDetector(projectName, detector);
    logger.debug(`[ErrorPopupDetector:${projectName}] Started error popup detection`);
}

/**
 * Helper to start a run command detector for each workspace.
 * Detects "Run command?" confirmation dialogs and forwards them to Discord.
 * Does nothing if a detector for the same workspace is already running.
 */
function ensureRunCommandDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
): void {
    const existing = bridge.pool.getRunCommandDetector(projectName);
    if (existing && existing.isActive()) return;

    const notifState: DetectorNotificationState = { lastNotification: null };

    const detector = new RunCommandDetector({
        cdpService: cdp,
        onResolved: createResolvedHandler(notifState),
        onRunCommandRequired: async (info: RunCommandInfo) => {
            logger.debug(`[RunCommandDetector:${projectName}] Run command detected`);

            const target = await resolveDetectorChannel(bridge, cdp, projectName, 'RunCommandDetector');
            if (!target) return;

            if (bridge.autoAccept.isEnabled()) {
                const accepted = await detector.runButton();

                const autoPayload = buildAutoApprovedNotification({
                    accepted,
                    projectName,
                    description: `Run: ${info.commandText}`,
                    approveText: info.runText ?? 'Run',
                });
                await target.channel.send(autoPayload).catch(logger.error);

                if (accepted) {
                    return;
                }
            }

            const payload = buildRunCommandNotification({
                title: t('Run Command?'),
                commandText: info.commandText,
                workingDirectory: info.workingDirectory,
                projectName,
                channelId: target.channelId,
                extraFields: [
                    { name: t('Run button'), value: info.runText, inline: true },
                    { name: t('Reject button'), value: info.rejectText, inline: true },
                ],
            });

            await sendAndTrackNotification(notifState, target.channel, payload);
        },
    });

    detector.start();
    bridge.pool.registerRunCommandDetector(projectName, detector);
    logger.debug(`[RunCommandDetector:${projectName}] Started run command detection`);
}

/**
 * Helper to start a user message detector for a workspace.
 * Detects messages typed directly in the Antigravity UI (e.g., from a PC)
 * and mirrors them to a Discord channel.
 * Does nothing if a detector for the same workspace is already running.
 */
function ensureUserMessageDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
    onUserMessage: (info: UserMessageInfo) => void,
): void {
    const existing = bridge.pool.getUserMessageDetector(projectName);
    if (existing && existing.isActive()) return;

    const detector = new UserMessageDetector({
        cdpService: cdp,
        onUserMessage,
    });

    detector.start();
    bridge.pool.registerUserMessageDetector(projectName, detector);
    logger.debug(`[UserMessageDetector:${projectName}] Started user message detection`);
}

/**
 * Ensure a TrajectoryStreamRouter is running for the workspace.
 * The router subscribes to the gRPC reactive stream and dispatches
 * trajectory updates to all registered passive detectors.
 *
 * Call this AFTER all detectors have been created and registered.
 */
function ensureStreamRouter(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
): void {
    const existing = bridge.pool.getStreamRouter(projectName);
    if (existing && existing.isActive()) return;

    const router = new TrajectoryStreamRouter({
        cdpService: cdp,
        projectName,
    });

    // Wire up all detectors that have been registered for this workspace
    const approval = bridge.pool.getApprovalDetector(projectName);
    if (approval) router.registerApprovalDetector(approval);

    const errorPopup = bridge.pool.getErrorPopupDetector(projectName);
    if (errorPopup) router.registerErrorPopupDetector(errorPopup);

    const planning = bridge.pool.getPlanningDetector(projectName);
    if (planning) router.registerPlanningDetector(planning);

    const runCmd = bridge.pool.getRunCommandDetector(projectName);
    if (runCmd) router.registerRunCommandDetector(runCmd);

    const userMsg = bridge.pool.getUserMessageDetector(projectName);
    if (userMsg) router.registerUserMessageDetector(userMsg);

    router.start();
    bridge.pool.registerStreamRouter(projectName, router);
    logger.info(`[StreamRouter:${projectName}] Started event-driven trajectory routing`);
}

export interface EnsureWorkspaceRuntimeOptions {
    readonly enableActionDetectors?: boolean;
    readonly onUserMessage?: (info: UserMessageInfo) => void;
    readonly userMessageSinkKey?: string;
}

/**
 * Ensure the workspace runtime is connected and that its passive services are
 * initialized in a serialized order. This prevents message-send paths from
 * racing stream-router / gRPC startup for the same workspace.
 */
export async function ensureWorkspaceRuntime(
    bridge: CdpBridge,
    workspacePath: string,
    options: EnsureWorkspaceRuntimeOptions = {},
): Promise<{ runtime: WorkspaceRuntime; cdp: CdpService; projectName: string }> {
    const runtime = bridge.pool.getOrCreateRuntime(workspacePath);
    const cdp = await runtime.runExclusive(async (runtimeCdp) => {
        const projectName = runtime.getProjectName();
        if (options.enableActionDetectors) {
            ensureApprovalDetector(bridge, runtimeCdp, projectName);
            ensureErrorPopupDetector(bridge, runtimeCdp, projectName);
            ensurePlanningDetector(bridge, runtimeCdp, projectName);
            ensureRunCommandDetector(bridge, runtimeCdp, projectName);
        }

        if (options.onUserMessage) {
            runtime.addUserMessageSink(
                options.userMessageSinkKey ?? 'default',
                options.onUserMessage,
            );
        }

        if (runtime.hasUserMessageSinks()) {
            ensureUserMessageDetector(bridge, runtimeCdp, projectName, (info: UserMessageInfo) => {
                void runtime.dispatchUserMessage(info);
            });
        }

        if (options.enableActionDetectors || runtime.hasUserMessageSinks()) {
            await runtimeCdp.getGrpcClient();
            ensureStreamRouter(bridge, runtimeCdp, projectName);
        }
        return runtimeCdp;
    });

    return { runtime, cdp, projectName: runtime.getProjectName() };
}
