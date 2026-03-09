import { ChatSessionService } from '../../src/services/chatSessionService';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('ChatSessionService', () => {
    let service: ChatSessionService;
    let mockCdpService: jest.Mocked<CdpService>;
    let mockGrpcClient: {
        rawRPC: jest.Mock;
        createCascade: jest.Mock;
        focusCascade: jest.Mock;
    };

    beforeEach(() => {
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        mockGrpcClient = {
            rawRPC: jest.fn(),
            createCascade: jest.fn(),
            focusCascade: jest.fn(),
        };
        (mockCdpService as any).getGrpcClient = jest.fn().mockResolvedValue(mockGrpcClient);
        (mockCdpService as any).getActiveCascadeId = jest.fn().mockResolvedValue('cascade-123');
        (mockCdpService as any).isCascadeInWorkspace = jest.fn().mockReturnValue(true);
        (mockCdpService as any).setCachedCascadeId = jest.fn();
        (mockCdpService as any).rememberCreatedCascade = jest.fn();
        service = new ChatSessionService();
    });

    // -----------------------------------------------------------------------
    // startNewChat()
    // -----------------------------------------------------------------------

    describe('startNewChat()', () => {
        it('creates a new cascade via gRPC and caches the ID', async () => {
            mockGrpcClient.createCascade.mockResolvedValue('new-cascade-456');

            const result = await service.startNewChat(mockCdpService);

            expect(result.ok).toBe(true);
            expect(mockGrpcClient.createCascade).toHaveBeenCalled();
            expect(mockCdpService.rememberCreatedCascade).toHaveBeenCalledWith('new-cascade-456');
            expect(mockGrpcClient.focusCascade).toHaveBeenCalledWith('new-cascade-456');
        });

        it('returns ok:false when gRPC client is unavailable', async () => {
            (mockCdpService as any).getGrpcClient.mockResolvedValue(null);

            const result = await service.startNewChat(mockCdpService);

            expect(result.ok).toBe(false);
            expect(result.error).toContain('gRPC client unavailable');
        });

        it('returns ok:false when createCascade returns null', async () => {
            mockGrpcClient.createCascade.mockResolvedValue(null);

            const result = await service.startNewChat(mockCdpService);

            expect(result.ok).toBe(false);
            expect(result.error).toContain('Failed to create cascade');
        });

        it('returns ok: false when a CDP call throws an exception', async () => {
            (mockCdpService as any).getGrpcClient.mockRejectedValue(new Error('WebSocket切断'));

            const result = await service.startNewChat(mockCdpService);

            expect(result.ok).toBe(false);
            expect(result.error).toBeDefined();
        });
    });

    // -----------------------------------------------------------------------
    // getCurrentSessionInfo()
    // -----------------------------------------------------------------------

    describe('getCurrentSessionInfo()', () => {
        it('retrieves the chat title from trajectory summaries', async () => {
            mockGrpcClient.rawRPC.mockResolvedValue({
                trajectorySummaries: {
                    'cascade-123': { summary: 'テストチャット' },
                },
            });

            const info = await service.getCurrentSessionInfo(mockCdpService);

            expect(info.title).toBe('テストチャット');
            expect(info.hasActiveChat).toBe(true);
            expect(info.cascadeId).toBe('cascade-123');
        });

        it('returns hasActiveChat: false when gRPC client is unavailable', async () => {
            (mockCdpService as any).getGrpcClient.mockResolvedValue(null);

            const info = await service.getCurrentSessionInfo(mockCdpService);

            expect(info.title).toBe('');
            expect(info.hasActiveChat).toBe(false);
        });

        it('returns (Untitled) when no summary exists for the cascade', async () => {
            mockGrpcClient.rawRPC.mockResolvedValue({
                trajectorySummaries: {},
            });

            const info = await service.getCurrentSessionInfo(mockCdpService);

            expect(info.title).toBe('(Untitled)');
            expect(info.hasActiveChat).toBe(true);
        });

        it('returns fallback values when a gRPC call throws an exception', async () => {
            mockGrpcClient.rawRPC.mockRejectedValue(new Error('gRPCエラー'));

            const info = await service.getCurrentSessionInfo(mockCdpService);

            expect(info.title).toBe('(Failed to retrieve)');
            expect(info.hasActiveChat).toBe(false);
        });

        it('returns hasActiveChat: false when no active cascade ID', async () => {
            (mockCdpService as any).getActiveCascadeId.mockResolvedValue(null);

            const info = await service.getCurrentSessionInfo(mockCdpService);

            expect(info.title).toBe('');
            expect(info.hasActiveChat).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // activateSessionByTitle()
    // -----------------------------------------------------------------------

    describe('activateSessionByTitle()', () => {
        it('focuses the matching session by cascade id', async () => {
            mockGrpcClient.rawRPC.mockResolvedValue({
                trajectorySummaries: {
                    'cascade-a': { summary: 'target-session' },
                    'cascade-b': { summary: 'other-session' },
                },
            });

            const result = await service.activateSessionByTitle(mockCdpService, 'target-session');

            expect(result).toEqual({ ok: true });
            expect(mockGrpcClient.focusCascade).toHaveBeenCalledWith('cascade-a');
            expect(mockCdpService.setCachedCascadeId).toHaveBeenCalledWith('cascade-a');
        });

        it('returns ok:false when the title cannot be found', async () => {
            mockGrpcClient.rawRPC.mockResolvedValue({
                trajectorySummaries: {
                    'cascade-a': { summary: 'other-session' },
                },
            });

            const result = await service.activateSessionByTitle(mockCdpService, '');
            expect(result.ok).toBe(false);
        });

        it('returns ok:false when gRPC is unavailable', async () => {
            (mockCdpService as any).getGrpcClient.mockResolvedValue(null);
            const result = await service.activateSessionByTitle(
                mockCdpService,
                'target-session',
            );
            expect(result.ok).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // listAllSessions()
    // -----------------------------------------------------------------------

    describe('listAllSessions()', () => {
        it('returns sessions from GetAllCascadeTrajectories', async () => {
            mockGrpcClient.rawRPC.mockResolvedValue({
                trajectorySummaries: {
                    'c-1': { summary: 'Fix login bug', lastModifiedTime: '2024-01-02T00:00:00Z' },
                    'c-2': { summary: 'Refactor auth', lastModifiedTime: '2024-01-01T00:00:00Z' },
                },
            });

            const sessions = await service.listAllSessions(mockCdpService);

            expect(sessions).toHaveLength(2);
            expect(sessions[0]).toEqual(expect.objectContaining({ title: 'Fix login bug', cascadeId: 'c-1' }));
            expect(sessions[1]).toEqual(expect.objectContaining({ title: 'Refactor auth', cascadeId: 'c-2' }));
        });

        it('marks the active cascade session as isActive', async () => {
            (mockCdpService as any).getActiveCascadeId.mockResolvedValue('c-2');
            mockGrpcClient.rawRPC.mockResolvedValue({
                trajectorySummaries: {
                    'c-1': { summary: 'Session A' },
                    'c-2': { summary: 'Session B' },
                },
            });

            const sessions = await service.listAllSessions(mockCdpService);

            const active = sessions.find(s => s.isActive);
            expect(active?.title).toBe('Session B');
        });

        it('returns empty array when gRPC client is unavailable', async () => {
            (mockCdpService as any).getGrpcClient.mockResolvedValue(null);

            const sessions = await service.listAllSessions(mockCdpService);

            expect(sessions).toEqual([]);
        });

        it('returns empty array when gRPC call throws', async () => {
            mockGrpcClient.rawRPC.mockRejectedValue(new Error('WebSocket disconnected'));

            const sessions = await service.listAllSessions(mockCdpService);

            expect(sessions).toEqual([]);
        });

        it('uses "Untitled" for sessions without a summary', async () => {
            mockGrpcClient.rawRPC.mockResolvedValue({
                trajectorySummaries: {
                    'c-1': {},
                },
            });

            const sessions = await service.listAllSessions(mockCdpService);

            expect(sessions[0].title).toBe('Untitled');
        });
    });

    // -----------------------------------------------------------------------
    // getConversationHistory()
    // -----------------------------------------------------------------------

    describe('getConversationHistory()', () => {
        it('returns messages from trajectory steps', async () => {
            mockGrpcClient.rawRPC.mockResolvedValue({
                trajectory: {
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hello' } },
                        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'hi there' } },
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'latest question' } },
                    ],
                },
            });

            const history = await service.getConversationHistory(mockCdpService);

            expect(history.messages).toEqual([
                { role: 'user', text: 'hello' },
                { role: 'assistant', text: 'hi there' },
                { role: 'user', text: 'latest question' },
            ]);
            expect(history.truncated).toBe(false);
        });

        it('marks history as truncated when message count exceeds the configured limit', async () => {
            mockGrpcClient.rawRPC.mockResolvedValue({
                trajectory: {
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'm1' } },
                        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'm2' } },
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'm3' } },
                    ],
                },
            });

            const history = await service.getConversationHistory(mockCdpService, {
                maxMessages: 2,
            });

            expect(history.truncated).toBe(true);
            expect(history.messages).toEqual([
                { role: 'assistant', text: 'm2' },
                { role: 'user', text: 'm3' },
            ]);
        });

        it('returns empty messages when gRPC client is unavailable', async () => {
            (mockCdpService as any).getGrpcClient.mockResolvedValue(null);

            const history = await service.getConversationHistory(mockCdpService);

            expect(history.messages).toEqual([]);
            expect(history.truncated).toBe(false);
        });

        it('returns empty messages when no active cascade ID', async () => {
            (mockCdpService as any).getActiveCascadeId.mockResolvedValue(null);

            const history = await service.getConversationHistory(mockCdpService);

            expect(history.messages).toEqual([]);
        });

        it('returns empty messages when gRPC call throws', async () => {
            mockGrpcClient.rawRPC.mockRejectedValue(new Error('connection lost'));

            const history = await service.getConversationHistory(mockCdpService);

            expect(history.messages).toEqual([]);
            expect(history.truncated).toBe(false);
        });

        it('uses a specific cascade ID when provided in options', async () => {
            mockGrpcClient.rawRPC.mockResolvedValue({
                trajectory: {
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'specific' } },
                    ],
                },
            });

            const history = await service.getConversationHistory(mockCdpService, {
                cascadeId: 'specific-cascade',
            });

            expect(mockGrpcClient.rawRPC).toHaveBeenCalledWith('GetCascadeTrajectory', { cascadeId: 'specific-cascade' });
            expect(history.messages).toEqual([{ role: 'user', text: 'specific' }]);
        });

        it('skips steps with empty text', async () => {
            mockGrpcClient.rawRPC.mockResolvedValue({
                trajectory: {
                    steps: [
                        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: '' } },
                        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'answer' } },
                    ],
                },
            });

            const history = await service.getConversationHistory(mockCdpService);

            expect(history.messages).toEqual([
                { role: 'assistant', text: 'answer' },
            ]);
        });
    });
});
