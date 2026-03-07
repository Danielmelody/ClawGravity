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
 * Service for managing chat sessions on Antigravity via gRPC Backend.
 * Completely bypasses DOM to decouple the PC UI state from Telegram state.
 */
export class ChatSessionService {

    /**
     * List recent sessions purely from the language server backend.
     */
    async listAllSessions(cdpService: CdpService): Promise<SessionListItem[]> {
        try {
            const client = await cdpService.getGrpcClient();
            if (!client) return [];

            const activeId = await cdpService.getActiveCascadeId();
            const resp = await client.rawRPC('GetAllCascadeTrajectories', {});
            const summaries = resp?.trajectorySummaries || {};

            const list: SessionListItem[] = [];
            for (const [id, t] of Object.entries(summaries)) {
                const target = t as any;
                list.push({
                    title: target.summary || 'Untitled',
                    isActive: id === activeId,
                    cascadeId: id,
                    lastModifiedTime: target.lastModifiedTime ? new Date(target.lastModifiedTime).getTime() : 0,
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
            const client = await cdpService.getGrpcClient();
            if (!client) return { messages: [], truncated: false };

            const targetId = options?.cascadeId || await cdpService.getActiveCascadeId();
            if (!targetId) return { messages: [], truncated: false };

            const traj = await client.rawRPC('GetCascadeTrajectory', { cascadeId: targetId });
            const steps = traj?.trajectory?.steps || [];

            const messages: ConversationHistoryEntry[] = [];
            for (const step of steps) {
                if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
                    const text = step.userInput?.userResponse || '';
                    if (text) messages.push({ role: 'user', text });
                } else if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || step.type === 'CORTEX_STEP_TYPE_RESPONSE') {
                    const text = step.plannerResponse?.response || step.assistantResponse?.text || '';
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
            const client = await cdpService.getGrpcClient();
            if (!client) return { ok: false, error: 'gRPC client unavailable' };
            const newId = await client.createCascade();
            if (!newId) return { ok: false, error: 'Failed to create cascade via gRPC' };
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
            const client = await cdpService.getGrpcClient();
            if (!client) return { title: '', hasActiveChat: false };

            const activeId = await cdpService.getActiveCascadeId();
            if (!activeId) return { title: '', hasActiveChat: false };

            const resp = await client.rawRPC('GetAllCascadeTrajectories', {});
            const summaries = resp?.trajectorySummaries || {};
            const item = summaries[activeId];
            if (item) {
                return { title: item.summary || '(Untitled)', hasActiveChat: true, cascadeId: activeId };
            }
            return { title: '(Untitled)', hasActiveChat: true, cascadeId: activeId };
        } catch (error) {
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
        // Since we are decoupled, we just return true.
        // Telegram now handles focusing purely in its own state store via cascadeId.
        return { ok: true };
    }
}
