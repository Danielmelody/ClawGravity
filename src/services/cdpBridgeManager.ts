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
import { isDangerousCommand } from '../utils/dangerousCommandClassifier';

import {
    APPROVE_ACTION_PREFIX, ALWAYS_ALLOW_ACTION_PREFIX, DENY_ACTION_PREFIX,
    PLANNING_OPEN_ACTION_PREFIX, PLANNING_PROCEED_ACTION_PREFIX,
    ERROR_POPUP_DISMISS_ACTION_PREFIX, ERROR_POPUP_COPY_DEBUG_ACTION_PREFIX, ERROR_POPUP_RETRY_ACTION_PREFIX,
    RUN_COMMAND_RUN_ACTION_PREFIX, RUN_COMMAND_REJECT_ACTION_PREFIX,
} from './actionPrefixes';

// ─── CDP Bridge State ──────────────────────────────────────────────────

export interface CdpBridge {
    pool: CdpConnectionPool;
    quota: QuotaService;
    autoAccept: AutoAcceptService;
    lastActiveWorkspace: string | null;
    lastActiveChannel: PlatformChannel | null;
    approvalChannelByWorkspace: Map<string, PlatformChannel>;
    approvalChannelBySession: Map<string, PlatformChannel>;
}

// ─── Generic Custom-ID Helpers ─────────────────────────────────────────

type ActionPrefixMap<A extends string> = Record<A, string>;
interface ParsedCustomId<A extends string> { action: A; projectName: string | null; channelId: string | null; }

function buildCustomId<A extends string>(m: ActionPrefixMap<A>, action: A, projectName: string, channelId?: string): string {
    const p = m[action];
    return channelId?.trim() ? `${p}:${projectName}:${channelId}` : `${p}:${projectName}`;
}

function parseCustomId<A extends string>(m: ActionPrefixMap<A>, customId: string): ParsedCustomId<A> | null {
    for (const [action, prefix] of Object.entries(m)) {
        if (customId === prefix) return { action: action as A, projectName: null, channelId: null };
        if (customId.startsWith(`${prefix}:`)) {
            const rest = customId.substring((prefix as string).length + 1);
            const [projectName, channelId] = rest.split(':');
            return { action: action as A, projectName: projectName || null, channelId: channelId || null };
        }
    }
    return null;
}

// ─── Domain Custom-ID Wrappers ─────────────────────────────────────────

const APPROVAL_PREFIX_MAP = { approve: APPROVE_ACTION_PREFIX, always_allow: ALWAYS_ALLOW_ACTION_PREFIX, deny: DENY_ACTION_PREFIX } as const;
const PLANNING_PREFIX_MAP = { open: PLANNING_OPEN_ACTION_PREFIX, proceed: PLANNING_PROCEED_ACTION_PREFIX } as const;
const ERROR_POPUP_PREFIX_MAP = { dismiss: ERROR_POPUP_DISMISS_ACTION_PREFIX, copy_debug: ERROR_POPUP_COPY_DEBUG_ACTION_PREFIX, retry: ERROR_POPUP_RETRY_ACTION_PREFIX } as const;
const RUN_COMMAND_PREFIX_MAP = { run: RUN_COMMAND_RUN_ACTION_PREFIX, reject: RUN_COMMAND_REJECT_ACTION_PREFIX } as const;

export function buildApprovalCustomId(action: 'approve' | 'always_allow' | 'deny', projectName: string, channelId?: string): string { return buildCustomId(APPROVAL_PREFIX_MAP, action, projectName, channelId); }
export function parseApprovalCustomId(customId: string) { return parseCustomId(APPROVAL_PREFIX_MAP, customId); }
export function buildPlanningCustomId(action: 'open' | 'proceed', projectName: string, channelId?: string): string { return buildCustomId(PLANNING_PREFIX_MAP, action, projectName, channelId); }
export function parsePlanningCustomId(customId: string) { return parseCustomId(PLANNING_PREFIX_MAP, customId); }
export function parseErrorPopupCustomId(customId: string) { return parseCustomId(ERROR_POPUP_PREFIX_MAP, customId); }
export function buildRunCommandCustomId(action: 'run' | 'reject', projectName: string, channelId?: string): string { return buildCustomId(RUN_COMMAND_PREFIX_MAP, action, projectName, channelId); }
export function parseRunCommandCustomId(customId: string) { return parseCustomId(RUN_COMMAND_PREFIX_MAP, customId); }

// ─── Channel Routing ───────────────────────────────────────────────────

function normalizeSessionTitle(title: string): string { return title.trim().toLowerCase(); }
function buildSessionRouteKey(projectName: string, sessionTitle: string): string { return `${projectName}::${normalizeSessionTitle(sessionTitle)}`; }

export function registerApprovalWorkspaceChannel(bridge: CdpBridge, projectName: string, channel: PlatformChannel): void {
    bridge.approvalChannelByWorkspace.set(projectName, channel);
}

export function registerApprovalSessionChannel(bridge: CdpBridge, projectName: string, sessionTitle: string, channel: PlatformChannel): void {
    if (!sessionTitle?.trim()) return;
    bridge.approvalChannelBySession.set(buildSessionRouteKey(projectName, sessionTitle), channel);
    bridge.approvalChannelByWorkspace.set(projectName, channel);
}

export function resolveApprovalChannelForCurrentChat(bridge: CdpBridge, projectName: string, currentChatTitle: string | null): PlatformChannel | null {
    if (currentChatTitle?.trim()) {
        const sessionChannel = bridge.approvalChannelBySession.get(buildSessionRouteKey(projectName, currentChatTitle));
        if (sessionChannel) return sessionChannel;
    }
    return bridge.approvalChannelByWorkspace.get(projectName) ?? null;
}

export async function getCurrentChatTitle(cdp: CdpService): Promise<string | null> {
    try {
        const client = await cdp.getLSClient();
        if (!client) return null;
        const summaries = await client.listCascades();
        if (!summaries || typeof summaries !== 'object') return null;

        let latestTitle: string | null = null, latestTime = 0;
        for (const [, summary] of Object.entries(summaries)) {
            const s = summary as Record<string, unknown>;
            const modTime = s.lastModifiedTimestamp ? new Date(s.lastModifiedTimestamp as string | number | Date).getTime() : 0;
            if (modTime > latestTime) { latestTime = modTime; latestTitle = (s.name as string) || (s.title as string) || null; }
        }
        return latestTitle;
    } catch { return null; }
}

// ─── Bridge Init ───────────────────────────────────────────────────────

export function getCurrentCdp(bridge: CdpBridge): CdpService | null {
    return bridge.lastActiveWorkspace ? bridge.pool.getConnected(bridge.lastActiveWorkspace) : null;
}

export function initCdpBridge(autoApproveDefault: boolean): CdpBridge {
    const pool = new CdpConnectionPool({ cdpCallTimeout: 15000, maxReconnectAttempts: 0, reconnectDelayMs: 3000 });
    const quota = new QuotaService();
    const autoAccept = new AutoAcceptService(autoApproveDefault);

    const bridge: CdpBridge = {
        pool, quota, autoAccept,
        lastActiveWorkspace: null, lastActiveChannel: null,
        approvalChannelByWorkspace: new Map(), approvalChannelBySession: new Map(),
    };

    quota.setRPCResolver(async () => {
        const cdp = getCurrentCdp(bridge);
        if (!cdp) return null;
        const client = await cdp.getLSClient();
        return client ? (method: string, payload: unknown) => client.rawRPC(method, payload) : null;
    });

    return bridge;
}

// ─── Shared Notification Helpers ───────────────────────────────────────

interface DetectorNotificationState {
    lastNotification: { sent: PlatformSentMessage; payload: MessagePayload } | null;
}

function createResolvedHandler(state: DetectorNotificationState): () => void {
    return () => {
        if (!state.lastNotification) return;
        const { sent, payload } = state.lastNotification;
        state.lastNotification = null;
        sent.edit(buildResolvedOverlay(payload, t('Resolved in Antigravity'))).catch(logger.error);
    };
}

async function resolveDetectorChannel(bridge: CdpBridge, cdp: CdpService, projectName: string, label: string) {
    const currentChatTitle = await getCurrentChatTitle(cdp);
    const targetChannel = resolveApprovalChannelForCurrentChat(bridge, projectName, currentChatTitle);
    const targetChannelId = targetChannel?.id ?? '';
    if (!targetChannel || !targetChannelId) {
        logger.warn(`[${label}:${projectName}] Skipped notification — chat not linked${currentChatTitle ? ` (title="${currentChatTitle}")` : ''}`);
        return null;
    }
    return { channel: targetChannel, channelId: targetChannelId };
}

async function sendAndTrackNotification(state: DetectorNotificationState, channel: PlatformChannel, payload: MessagePayload): Promise<void> {
    const sent = await channel.send(payload).catch((err: unknown) => { logger.error(err); return null; });
    if (sent) state.lastNotification = { sent, payload };
}

// ─── Ensure Detectors (consolidated pattern) ──────────────────────────

function ensureApprovalDetector(bridge: CdpBridge, cdp: CdpService, projectName: string): void {
    const existing = bridge.pool.getApprovalDetector(projectName);
    if (existing?.isActive()) return;

    const notifState: DetectorNotificationState = { lastNotification: null };
    const detector = new ApprovalDetector({
        cdpService: cdp,
        onResolved: createResolvedHandler(notifState),
        onApprovalRequired: async (info: ApprovalInfo) => {
            logger.debug(`[ApprovalDetector:${projectName}] Approval detected`);
            const target = await resolveDetectorChannel(bridge, cdp, projectName, 'ApprovalDetector');
            if (!target) return;

            if (bridge.autoAccept.isEnabled()) {
                const accepted = await detector.alwaysAllowButton() || await detector.approveButton();
                await target.channel.send(buildAutoApprovedNotification({ accepted, projectName, description: info.description, approveText: info.approveText })).catch(logger.error);
                if (accepted) return;
            }

            await sendAndTrackNotification(notifState, target.channel, buildApprovalNotification({
                title: t('Approval Required'),
                description: info.description || t('Antigravity is requesting approval for an action'),
                projectName, channelId: target.channelId,
                extraFields: [
                    { name: t('Allow button'), value: info.approveText, inline: true },
                    { name: t('Allow Chat button'), value: info.alwaysAllowText || t('In Dropdown'), inline: true },
                    { name: t('Deny button'), value: info.denyText || t('(None)'), inline: true },
                ],
            }));
        },
    });
    detector.start();
    bridge.pool.registerApprovalDetector(projectName, detector);
}

function ensurePlanningDetector(bridge: CdpBridge, cdp: CdpService, projectName: string): void {
    const existing = bridge.pool.getPlanningDetector(projectName);
    if (existing?.isActive()) return;

    const notifState: DetectorNotificationState = { lastNotification: null };
    const detector = new PlanningDetector({
        cdpService: cdp,
        onResolved: createResolvedHandler(notifState),
        onPlanningRequired: async (info: PlanningInfo) => {
            const target = await resolveDetectorChannel(bridge, cdp, projectName, 'PlanningDetector');
            if (!target) return;

            const extraFields: { name: string; value: string; inline?: boolean }[] = [
                { name: t('Plan'), value: info.planTitle || t('Implementation Plan'), inline: true },
                { name: t('Workspace'), value: projectName, inline: true },
            ];
            if (info.planSummary && info.description) extraFields.push({ name: t('Summary'), value: info.planSummary.substring(0, 1024), inline: false });

            await sendAndTrackNotification(notifState, target.channel, buildPlanningNotification({
                title: t('Planning Mode'),
                description: info.description || info.planSummary || t('A plan has been generated and is awaiting your review.'),
                projectName, channelId: target.channelId, extraFields,
            }));
        },
    });
    detector.start();
    bridge.pool.registerPlanningDetector(projectName, detector);
}

function ensureErrorPopupDetector(bridge: CdpBridge, cdp: CdpService, projectName: string): void {
    const existing = bridge.pool.getErrorPopupDetector(projectName);
    if (existing?.isActive()) return;

    const notifState: DetectorNotificationState = { lastNotification: null };
    const detector = new ErrorPopupDetector({
        cdpService: cdp,
        onResolved: createResolvedHandler(notifState),
        onErrorPopup: async (info: ErrorPopupInfo) => {
            const target = await resolveDetectorChannel(bridge, cdp, projectName, 'ErrorPopupDetector');
            if (!target) return;

            const supportsActions = info.buttons.some((l) => ['dismiss', 'copy debug info', 'retry'].includes(l.trim().toLowerCase()));
            await sendAndTrackNotification(notifState, target.channel, buildErrorPopupNotification({
                title: info.title || t('Agent Error'),
                errorMessage: (info.body || t('An error occurred in the Antigravity agent.')).substring(0, 4096),
                projectName, channelId: target.channelId, includeActions: supportsActions,
                extraFields: [
                    { name: t('Buttons'), value: info.buttons.join(', ') || t('(None)'), inline: true },
                    { name: t('Workspace'), value: projectName, inline: true },
                ],
            }));
        },
    });
    detector.start();
    bridge.pool.registerErrorPopupDetector(projectName, detector);
}

function ensureRunCommandDetector(bridge: CdpBridge, cdp: CdpService, projectName: string): void {
    const existing = bridge.pool.getRunCommandDetector(projectName);
    if (existing?.isActive()) return;

    const notifState: DetectorNotificationState = { lastNotification: null };
    const detector = new RunCommandDetector({
        cdpService: cdp,
        onResolved: createResolvedHandler(notifState),
        onRunCommandRequired: async (info: RunCommandInfo) => {
            const target = await resolveDetectorChannel(bridge, cdp, projectName, 'RunCommandDetector');
            if (!target) return;

            if (bridge.autoAccept.isEnabled()) {
                if (isDangerousCommand(info.commandText)) {
                    logger.info(`[RunCommandDetector:${projectName}] Dangerous command, skipping auto-accept: ${info.commandText}`);
                } else {
                    const accepted = await detector.runButton();
                    await target.channel.send(buildAutoApprovedNotification({ accepted, projectName, description: `Run: ${info.commandText}`, approveText: info.runText ?? 'Run' })).catch(logger.error);
                    if (accepted) return;
                }
            }

            await sendAndTrackNotification(notifState, target.channel, buildRunCommandNotification({
                title: t('Run Command?'), commandText: info.commandText, workingDirectory: info.workingDirectory,
                projectName, channelId: target.channelId,
                extraFields: [
                    { name: t('Run button'), value: info.runText, inline: true },
                    { name: t('Reject button'), value: info.rejectText, inline: true },
                ],
            }));
        },
    });
    detector.start();
    bridge.pool.registerRunCommandDetector(projectName, detector);
}

function ensureUserMessageDetector(bridge: CdpBridge, cdp: CdpService, projectName: string, onUserMessage: (info: UserMessageInfo) => void): void {
    const existing = bridge.pool.getUserMessageDetector(projectName);
    if (existing?.isActive()) return;
    const detector = new UserMessageDetector({ cdpService: cdp, onUserMessage });
    detector.start();
    bridge.pool.registerUserMessageDetector(projectName, detector);
}

function ensureStreamRouter(bridge: CdpBridge, cdp: CdpService, projectName: string): void {
    const existing = bridge.pool.getStreamRouter(projectName);
    if (existing?.isActive()) return;

    const router = new TrajectoryStreamRouter({ cdpService: cdp, projectName });

    // Wire up all registered detectors
    const detectorTypes = [
        ['approval', 'registerApprovalDetector'],
        ['errorPopup', 'registerErrorPopupDetector'],
        ['planning', 'registerPlanningDetector'],
        ['runCommand', 'registerRunCommandDetector'],
        ['userMessage', 'registerUserMessageDetector'],
    ] as const;

    for (const [type, registerMethod] of detectorTypes) {
        const det = bridge.pool.getDetector(type, projectName);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (det) (router as any)[registerMethod](det);
    }

    router.start();
    bridge.pool.registerStreamRouter(projectName, router);
    logger.info(`[StreamRouter:${projectName}] Registered (idle — will connect when a cascade is active)`);
}

// ─── Main Entry Point ──────────────────────────────────────────────────

export interface EnsureWorkspaceRuntimeOptions {
    readonly enableActionDetectors?: boolean;
    readonly onUserMessage?: (info: UserMessageInfo) => void;
    readonly userMessageSinkKey?: string;
}

export async function ensureWorkspaceRuntime(
    bridge: CdpBridge, workspacePath: string,
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
            runtime.addUserMessageSink(options.userMessageSinkKey ?? 'default', options.onUserMessage);
        }
        if (runtime.hasUserMessageSinks()) {
            ensureUserMessageDetector(bridge, runtimeCdp, projectName, (info: UserMessageInfo) => { void runtime.dispatchUserMessage(info); });
        }
        if (options.enableActionDetectors || runtime.hasUserMessageSinks()) {
            await runtimeCdp.getLSClient();
            ensureStreamRouter(bridge, runtimeCdp, projectName);
        }
        return runtimeCdp;
    });
    return { runtime, cdp, projectName: runtime.getProjectName() };
}
