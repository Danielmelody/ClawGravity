import { CdpService } from './cdpService';
import { logger } from '../utils/logger';

/** Session list item from the backend */
export interface SessionListItem {
    /** Conversation title */
    title: string;
    /** Whether this is the currently active session */
    isActive: boolean;
    /** The actual system ID of the cascade session */
    cascadeId?: string;
    /** Time of the last change, used for sorting */
    lastModifiedTime?: number;
}

/** Chat session information */
export interface ChatSessionInfo {
    /** Current chat title (if available) */
    title: string;
    /** Whether an active chat exists */
    hasActiveChat: boolean;
    cascadeId?: string;
}

export interface ConversationHistoryEntry {
    /** Speaker role in the conversation */
    role: 'user' | 'assistant';
    /** Plain-text message body */
    text: string;
}

/**
 * Service for managing chat sessions on Antigravity via LS API Backend.
 * Completely bypasses DOM to decouple the PC UI state from Telegram state.
 */
export class ChatSessionService {

    /**
     * List recent sessions purely from the language server backend.
     */
    async listAllSessions(cdpService: CdpService): Promise<SessionListItem[]> {
        try {
            const client = await cdpService.getLSClient();
            if (!client) return [];

            const activeId = await cdpService.getActiveCascadeId();
            const resp = await client.rawRPC('GetAllCascadeTrajectories', {}) as Record<string, unknown>;
            const summaries = (resp?.trajectorySummaries as Record<string, unknown>) || {};

            const list: SessionListItem[] = [];
            for (const [id, t] of Object.entries(summaries)) {
                if (!cdpService.isCascadeInWorkspace(t as Record<string, unknown>)) continue;

                const target = t as Record<string, unknown>;
                list.push({
                    title: (target.summary as string) || 'Untitled',
                    isActive: id === activeId,
                    cascadeId: id,
                    lastModifiedTime: target.lastModifiedTime ? new Date(target.lastModifiedTime as string | number | Date).getTime() : 0,
                });
            }

            // Sort by most recently modified
            list.sort((a, b) => (b.lastModifiedTime || 0) - (a.lastModifiedTime || 0));

            return list;
        } catch (err: unknown) {
            logger.error(`[ChatSessionService] Failed to list sessions:`, err);
            return [];
        }
    }

    /**
     * Retrieve conversation history for a specific cascade via Backend RPC.
     */
    async getConversationHistory(
        cdpService: CdpService,
        options?: {
            maxMessages?: number;
            maxScrollSteps?: number;
            cascadeId?: string;
        },
    ): Promise<{ messages: ConversationHistoryEntry[]; truncated: boolean }> {
        try {
            const client = await cdpService.getLSClient();
            if (!client) return { messages: [], truncated: false };

            const targetId = options?.cascadeId || await cdpService.getActiveCascadeId();
            if (!targetId) return { messages: [], truncated: false };

            const traj = await client.rawRPC('GetCascadeTrajectory', { cascadeId: targetId }) as Record<string, unknown>;
            const trajectory = traj?.trajectory as Record<string, unknown> | undefined;
            const steps = (trajectory?.steps as unknown[]) || [];

            const messages: ConversationHistoryEntry[] = [];
            for (const step of steps) {
                const stepObj = step as Record<string, unknown>;
                if (stepObj.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
                    const userInput = stepObj.userInput as Record<string, unknown> | undefined;
                    const text = (userInput?.userResponse as string) || '';
                    if (text) messages.push({ role: 'user', text });
                } else if (stepObj.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || stepObj.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                    const plannerResponse = stepObj.plannerResponse as Record<string, unknown> | undefined;
                    const assistantResponse = stepObj.assistantResponse as Record<string, unknown> | undefined;
                    const text = (plannerResponse?.response as string) || (assistantResponse?.text as string) || '';
                    if (text) messages.push({ role: 'assistant', text });
                }
            }

            // Truncate if requested
            let truncated = false;
            let finalMessages = messages;
            if (options?.maxMessages && messages.length > options.maxMessages) {
                finalMessages = messages.slice(messages.length - options.maxMessages);
                truncated = true;
            }

            return { messages: finalMessages, truncated };
        } catch (err: unknown) {
            logger.error(`[ChatSessionService] Failed to get conversation history:`, err);
            return { messages: [], truncated: false };
        }
    }

    /**
     * Start a new chat session using gRPC (no UI click).
     */
    async startNewChat(cdpService: CdpService): Promise<{ ok: boolean; error?: string }> {
        try {
            const client = await cdpService.getLSClient();
            if (!client) return { ok: false, error: 'LS client unavailable' };
            const newId = await client.createCascade();
            if (!newId) return { ok: false, error: 'Failed to create cascade via LS API' };
            cdpService.rememberCreatedCascade(newId);
            try {
                await client.focusCascade?.(newId);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`[ChatSessionService] SmartFocusConversation failed for ${newId.slice(0, 12)}...: ${message}`);
            }
            return { ok: true };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: message };
        }
    }

    /**
     * Get the current chat session information (from backend perspective).
     */
    async getCurrentSessionInfo(cdpService: CdpService): Promise<ChatSessionInfo> {
        try {
            const client = await cdpService.getLSClient();
            if (!client) return { title: '', hasActiveChat: false };

            const activeId = await cdpService.getActiveCascadeId();
            if (!activeId) return { title: '', hasActiveChat: false };

            const resp = await client.rawRPC('GetAllCascadeTrajectories', {}) as Record<string, unknown>;
            const summaries = (resp?.trajectorySummaries as Record<string, unknown>) || {};
            const item = summaries[activeId] as Record<string, unknown> | undefined;
            if (item && cdpService.isCascadeInWorkspace(item)) {
                return { title: (item.summary as string) || '(Untitled)', hasActiveChat: true, cascadeId: activeId };
            }
            return { title: '(Untitled)', hasActiveChat: true, cascadeId: activeId };
        } catch {
            return { title: '(Failed to retrieve)', hasActiveChat: false };
        }
    }

    /**
     * Activate an existing chat visually.
     * We don't really need to do this since we decoupled the backend and UI, 
     * but we provide realistic simulation if we DO want to focus via SmartFocusConversation.
     */
    async activateSessionByTitle(
        cdpService: CdpService,
        title: string,
    ): Promise<{ ok: boolean; error?: string }> {
        try {
            const client = await cdpService.getLSClient();
            if (!client) return { ok: false, error: 'LS client unavailable' };

            const sessions = await this.listAllSessions(cdpService);
            const selectedSession = sessions.find((session) => session.title === title);
            if (!selectedSession?.cascadeId) {
                return { ok: false, error: `Session not found: ${title}` };
            }

            await client.focusCascade?.(selectedSession.cascadeId);
            cdpService.setCachedCascadeId(selectedSession.cascadeId);
            return { ok: true };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`[ChatSessionService] Failed to activate session "${title}": ${message}`);
            return { ok: false, error: message };
        }
    }
}
