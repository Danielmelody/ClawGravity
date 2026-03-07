import { ChatSessionService } from '../../src/services/chatSessionService';
import { CdpService } from '../../src/services/cdpService';
import { readFileSync } from 'fs';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('ChatSessionService', () => {
    let service: ChatSessionService;
    let mockCdpService: jest.Mocked<CdpService>;

    beforeEach(() => {
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        mockCdpService.getContexts = jest.fn().mockReturnValue([
            { id: 42, name: 'Electron Isolated Context', url: '' },
        ]);
        mockCdpService.waitForCascadePanelReady = jest.fn().mockResolvedValue(false);
        service = new ChatSessionService();
    });

    describe('startNewChat()', () => {
        it('opens a new chat via coordinate click when the button is enabled', async () => {
            // 1st call: button enabled (cursor:pointer), 2nd call: button disabled (cursor:not-allowed)
            let callCount = 0;
            mockCdpService.call.mockImplementation(async (method: string) => {
                if (method === 'Runtime.evaluate') {
                    callCount++;
                    if (callCount === 1) {
                        // Get button state: enabled
                        return { result: { value: { found: true, enabled: true, x: 100, y: 50 } } };
                    }
                    // Verification after click: changed to disabled
                    return { result: { value: { found: true, enabled: false, x: 100, y: 50 } } };
                }
                // Input.dispatchMouseEvent succeeds
                return {};
            });

            const result = await service.startNewChat(mockCdpService);

            expect(result.ok).toBe(true);
            expect(mockCdpService.call).toHaveBeenCalledWith(
                'Input.dispatchMouseEvent',
                expect.objectContaining({ type: 'mousePressed', x: 100, y: 50 })
            );
        });

        it('returns success without action when the button is disabled (already empty chat)', async () => {
            mockCdpService.call.mockResolvedValue({
                result: { value: { found: true, enabled: false, cursor: 'not-allowed', x: 100, y: 50 } }
            });

            const result = await service.startNewChat(mockCdpService);

            expect(result.ok).toBe(true);
            // Verify Input.dispatchMouseEvent was not called
            expect(mockCdpService.call).not.toHaveBeenCalledWith(
                'Input.dispatchMouseEvent',
                expect.anything()
            );
        });

        it('returns ok: false when the button is not found', async () => {
            mockCdpService.call.mockResolvedValue({
                result: { value: { found: false } }
            });

            const result = await service.startNewChat(mockCdpService);

            expect(result.ok).toBe(false);
            expect(result.error).toContain('not found');
        }, 15000);

        it('returns ok: false when contexts are empty', async () => {
            mockCdpService.getContexts = jest.fn().mockReturnValue([]);
            mockCdpService.waitForCascadePanelReady = jest.fn().mockResolvedValue(false);

            const result = await service.startNewChat(mockCdpService);

            expect(result.ok).toBe(false);
            expect(result.error).toContain('No contexts available');
        });

        it('returns ok: false when a CDP call throws an exception', async () => {
            mockCdpService.call.mockRejectedValue(new Error('WebSocket切断'));

            const result = await service.startNewChat(mockCdpService);

            expect(result.ok).toBe(false);
            expect(result.error).toBeDefined();
        }, 15000);

        it('returns ok: false when button state does not change after click', async () => {
            // Button remains enabled throughout
            mockCdpService.call.mockImplementation(async (method: string) => {
                if (method === 'Runtime.evaluate') {
                    return { result: { value: { found: true, enabled: true, x: 100, y: 50 } } };
                }
                return {};
            });

            const result = await service.startNewChat(mockCdpService);

            expect(result.ok).toBe(false);
            expect(result.error).toContain('state did not change');
        });
    });

    describe('getCurrentSessionInfo()', () => {
        it('retrieves the chat title from the Cascade panel header', async () => {
            mockCdpService.call.mockResolvedValue({
                result: { value: { title: 'テストチャット', hasActiveChat: true } }
            });

            const info = await service.getCurrentSessionInfo(mockCdpService);

            expect(info.title).toBe('テストチャット');
            expect(info.hasActiveChat).toBe(true);
        });

        it('returns hasActiveChat: false when the title is "Agent" (default)', async () => {
            mockCdpService.call.mockResolvedValue({
                result: { value: { title: 'Agent', hasActiveChat: false } }
            });

            const info = await service.getCurrentSessionInfo(mockCdpService);

            expect(info.title).toBe('Agent');
            expect(info.hasActiveChat).toBe(false);
        });

        it('returns fallback values when a CDP call throws an exception', async () => {
            mockCdpService.call.mockRejectedValue(new Error('CDPエラー'));

            const info = await service.getCurrentSessionInfo(mockCdpService);

            expect(info.title).toBe('(Failed to retrieve)');
            expect(info.hasActiveChat).toBe(false);
        });

        it('returns fallback values when the result is null', async () => {
            mockCdpService.call.mockResolvedValue({
                result: { value: null }
            });

            const info = await service.getCurrentSessionInfo(mockCdpService);

            expect(info.title).toBe('(Failed to retrieve)');
            expect(info.hasActiveChat).toBe(false);
        });
    });

    describe('activateSessionByTitle()', () => {
        it('returns ok when already on the target session title', async () => {
            mockCdpService.call.mockResolvedValue({
                result: { value: { title: 'target-session', hasActiveChat: true } }
            });

            const result = await service.activateSessionByTitle(mockCdpService, 'target-session');
            expect(result).toEqual({ ok: true });
        });

        it('returns ok:false when switching succeeded but verification title mismatches', async () => {
            let evaluateCallCount = 0;
            mockCdpService.call.mockImplementation(async (method: string, params: any) => {
                if (method !== 'Runtime.evaluate') return {};
                evaluateCallCount++;
                if (evaluateCallCount === 1) {
                    return { result: { value: { title: 'old-session', hasActiveChat: true } } };
                }
                if (params?.expression?.includes('Chat title not found in side panel')) {
                    return { result: { value: { ok: true } } };
                }
                return { result: { value: { title: 'different-session', hasActiveChat: true } } };
            });

            const result = await service.activateSessionByTitle(mockCdpService, 'target-session');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('did not match target title');
        });

        it('falls back to Past Conversations flow when direct side-panel search cannot find the chat', async () => {
            let infoCallCount = 0;
            mockCdpService.call.mockImplementation(async (_method: string, params: any) => {
                const expression = String(params?.expression || '');

                if (expression.includes('const header = panel.querySelector(\'div[class*="border-b"]\');')) {
                    infoCallCount += 1;
                    if (infoCallCount === 1) {
                        return { result: { value: { title: 'current-session', hasActiveChat: true } } };
                    }
                    return { result: { value: { title: 'target-session', hasActiveChat: true } } };
                }

                if (expression.includes('Chat title not found in side panel')) {
                    return { result: { value: { ok: false, error: 'not found in side panel' } } };
                }

                if (expression.includes('Past Conversations button not found')) {
                    return { result: { value: { ok: true } } };
                }

                return { result: { value: null } };
            });

            const result = await service.activateSessionByTitle(mockCdpService, 'target-session');
            expect(result).toEqual({ ok: true });
        });

        it('retries activation while UI is still loading and eventually succeeds', async () => {
            let infoCallCount = 0;
            let directAttemptCount = 0;

            mockCdpService.call.mockImplementation(async (_method: string, params: any) => {
                const expression = String(params?.expression || '');

                if (expression.includes('const header = panel.querySelector(\'div[class*="border-b"]\');')) {
                    infoCallCount += 1;
                    if (infoCallCount === 1) {
                        return { result: { value: { title: 'current-session', hasActiveChat: true } } };
                    }
                    return { result: { value: { title: 'target-session', hasActiveChat: true } } };
                }

                if (expression.includes('Chat title not found in side panel')) {
                    directAttemptCount += 1;
                    if (directAttemptCount < 3) {
                        return { result: { value: { ok: false, error: 'side panel still loading' } } };
                    }
                    return { result: { value: { ok: true } } };
                }

                if (expression.includes('Past Conversations button not found')) {
                    return { result: { value: { ok: false, error: 'past conversations still loading' } } };
                }

                return { result: { value: null } };
            });

            const result = await service.activateSessionByTitle(
                mockCdpService,
                'target-session',
                { maxWaitMs: 100, retryIntervalMs: 1 },
            );
            expect(result).toEqual({ ok: true });
            expect(directAttemptCount).toBe(3);
        });

        it('returns ok:false for empty title', async () => {
            const result = await service.activateSessionByTitle(mockCdpService, '');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('empty');
        });
        it('returns direct and past errors when both activation paths fail', async () => {
            mockCdpService.call.mockImplementation(async (_method: string, params: any) => {
                const expression = String(params?.expression || '');

                if (expression.includes('const header = panel.querySelector(\'div[class*="border-b"]\');')) {
                    return { result: { value: { title: 'current-session', hasActiveChat: true } } };
                }
                if (expression.includes('Chat title not found in side panel')) {
                    return { result: { value: { ok: false, error: 'direct miss' } } };
                }
                if (expression.includes('Past Conversations button not found')) {
                    return { result: { value: { ok: false, error: 'past miss' } } };
                }
                return { result: { value: null } };
            });

            const result = await service.activateSessionByTitle(
                mockCdpService,
                'target-session',
                { maxWaitMs: 5, retryIntervalMs: 1 },
            );
            expect(result.ok).toBe(false);
            expect(result.error).toContain('direct:');
            expect(result.error).toContain('past: past miss');
            expect(result.error).toContain('after');
        });
    });

    describe('listAllSessions()', () => {
        /**
         * Helper to classify Runtime.evaluate calls by script content.
         * Returns a response based on the script type rather than call order,
         * so tests are resilient to the number of polling iterations.
         */
        function classifyExpression(expression: string): string {
            if (expression.includes('data-past-conversations-toggle')) return 'findButton';
            if (
                expression.includes('const rows = Array.from(panel.querySelectorAll')
                || expression.includes('rows.some((row)')
                || expression.includes('row.querySelector(\'span.text-sm\')')
            ) return 'panelReady';
            if (expression.includes('const items = []') || expression.includes('const seen = new Set()')) return 'scrape';
            if (expression.includes('Show\\s+\\d+\\s+more')) return 'showMore';
            return 'unknown';
        }

        it('opens Past Conversations via CDP mouse click and returns scraped sessions', async () => {
            const calls: string[] = [];
            let evalCount = 0;
            mockCdpService.call.mockImplementation(async (method: string, params?: any) => {
                calls.push(method);
                if (method === 'Runtime.evaluate') {
                    evalCount += 1;
                    if (evalCount === 1) {
                        return { result: { value: { found: true, x: 200, y: 30 } } };
                    }
                    if (evalCount === 2) {
                        return { result: { value: true } };
                    }
                    if (evalCount === 3) {
                        return {
                            result: {
                                value: {
                                    sessions: [
                                        { title: 'Fix login bug', isActive: true },
                                        { title: 'Refactor auth', isActive: false },
                                    ],
                                },
                            },
                        };
                    }
                    if (evalCount === 4) {
                        return { result: { value: { found: false, x: 0, y: 0 } } };
                    }
                }
                return {};
            });

            const sessions = await service.listAllSessions(mockCdpService);

            expect(sessions).toHaveLength(2);
            expect(sessions[0]).toEqual({ title: 'Fix login bug', isActive: true });
            // Verify CDP mouse click was used (not DOM .click())
            expect(calls).toContain('Input.dispatchMouseEvent');
        });

        it('clicks "Show more" when fewer than 10 sessions found initially', async () => {
            let scrapeCount = 0;
            let evalCount = 0;
            mockCdpService.call.mockImplementation(async (method: string, params?: any) => {
                if (method === 'Runtime.evaluate') {
                    evalCount += 1;
                    if (evalCount === 1) {
                        return { result: { value: { found: true, x: 200, y: 30 } } };
                    }
                    if (evalCount === 2) {
                        return { result: { value: true } };
                    }
                    if (evalCount === 3 || evalCount === 5) {
                        scrapeCount++;
                        if (scrapeCount === 1) {
                            return { result: { value: { sessions: [
                                { title: 'Session A', isActive: true },
                                { title: 'Session B', isActive: false },
                                { title: 'Session C', isActive: false },
                            ] } } };
                        }
                        return { result: { value: { sessions: [
                            { title: 'Session A', isActive: true },
                            { title: 'Session B', isActive: false },
                            { title: 'Session C', isActive: false },
                            { title: 'Session D', isActive: false },
                            { title: 'Session E', isActive: false },
                        ] } } };
                    }
                    if (evalCount === 4) {
                        return { result: { value: { found: true, x: 150, y: 300 } } };
                    }
                }
                return {};
            });

            const sessions = await service.listAllSessions(mockCdpService);

            expect(sessions).toHaveLength(5);
            expect(scrapeCount).toBe(2);
        });

        it('returns empty array when Past Conversations button not found', async () => {
            mockCdpService.call.mockResolvedValue({
                result: { value: { found: false, x: 0, y: 0 } },
            });

            const sessions = await service.listAllSessions(mockCdpService);

            expect(sessions).toEqual([]);
        });

        it('returns empty array when CDP call throws', async () => {
            mockCdpService.call.mockRejectedValue(new Error('WebSocket disconnected'));

            const sessions = await service.listAllSessions(mockCdpService);

            expect(sessions).toEqual([]);
        });

        it('closes panel with Escape key after scraping', async () => {
            const calls: Array<{ method: string; params?: any }> = [];
            mockCdpService.call.mockImplementation(async (method: string, params?: any) => {
                calls.push({ method, params });
                if (method === 'Runtime.evaluate') {
                    const type = classifyExpression(params?.expression || '');
                    if (type === 'findButton') return { result: { value: { found: true, x: 200, y: 30 } } };
                    if (type === 'panelReady') return { result: { value: true } };
                    return { result: { value: { sessions: Array.from({ length: 10 }, (_, i) => ({ title: `S${i}`, isActive: i === 0 })) } } };
                }
                return {};
            });

            await service.listAllSessions(mockCdpService);

            const escapeCall = calls.find(
                (c) => c.method === 'Input.dispatchKeyEvent' && c.params?.key === 'Escape',
            );
            expect(escapeCall).toBeDefined();
        });

        it('scrape returns empty sessions when side panel is not found', async () => {
            mockCdpService.call.mockImplementation(async (method: string, params?: any) => {
                if (method === 'Runtime.evaluate') {
                    const type = classifyExpression(params?.expression || '');
                    if (type === 'findButton') {
                        return { result: { value: { found: true, x: 200, y: 30 } } };
                    }
                    if (type === 'panelReady') {
                        // Panel never becomes ready (no side panel in DOM)
                        return { result: { value: false } };
                    }
                    if (type === 'scrape') {
                        // Scrape script returns empty because panel is missing
                        return { result: { value: { sessions: [] } } };
                    }
                }
                return {};
            });

            const sessions = await service.listAllSessions(mockCdpService);

            expect(sessions).toEqual([]);
        });

        it('scrape is scoped to QuickInput dialog or side panel and ignores file tabs outside', async () => {
            let evalCount = 0;
            mockCdpService.call.mockImplementation(async (method: string, params?: any) => {
                if (method === 'Runtime.evaluate') {
                    evalCount += 1;
                    if (evalCount === 1) {
                        return { result: { value: { found: true, x: 200, y: 30 } } };
                    }
                    if (evalCount === 2) {
                        return { result: { value: true } };
                    }
                    if (evalCount === 3) {
                        // Verify the scrape script checks QuickInput dialog first, then side panel
                        expect(params.expression).toContain('bg-quickinput-background');
                        expect(params.expression).toContain('.antigravity-agent-side-panel');
                        // Verify no bare document fallback (|| document;) but allow || document.querySelector(...)
                        expect(params.expression).not.toMatch(/\|\|\s*document\s*[;)]/);
                        return {
                            result: {
                                value: {
                                    sessions: [
                                        { title: 'Chat Session Only', isActive: true },
                                    ],
                                },
                            },
                        };
                    }
                    if (evalCount === 4) {
                        return { result: { value: { found: false, x: 0, y: 0 } } };
                    }
                }
                return {};
            });

            const sessions = await service.listAllSessions(mockCdpService);

            expect(sessions).toHaveLength(1);
            expect(sessions[0].title).toBe('Chat Session Only');
        });

        it('scrape script targets rows directly from the quick input root', () => {
            const source = readFileSync('src/services/chatSessionService.ts', 'utf8');
            const marker = 'const SCRAPE_PAST_CONVERSATIONS_SCRIPT = `';
            const start = source.indexOf(marker);
            const scriptStart = start + marker.length;
            const scriptEnd = source.indexOf('`;', scriptStart);
            const scrapeScript = source.slice(scriptStart, scriptEnd);
            expect(scrapeScript).toContain(`panel.querySelectorAll('div[class*="cursor-pointer"]')`);
            expect(scrapeScript).toContain(`row.querySelector('span.text-sm')`);
            expect(scrapeScript).toContain('Other\\\\s+Conversations?');
            expect(scrapeScript).not.toContain('const container = containers.find');
        });

        it('conversation history scrape removes injected style tags before reading assistant text', () => {
            const source = readFileSync('src/services/chatSessionService.ts', 'utf8');
            const marker = 'const SCRAPE_CONVERSATION_HISTORY_SCRIPT = `';
            const start = source.indexOf(marker);
            const scriptStart = start + marker.length;
            const scriptEnd = source.indexOf('`;', scriptStart);
            const scrapeScript = source.slice(scriptStart, scriptEnd);
            expect(scrapeScript).toContain("clone.querySelectorAll('style')");
            expect(scrapeScript).toContain('clone.innerText || clone.textContent');
            expect(scrapeScript).toContain('remark-github-blockquote-alert/alert.css');
        });
    });

    describe('getConversationHistory()', () => {
        it('waits for history nodes to become ready before the first scrape', async () => {
            let readyChecks = 0;
            mockCdpService.call.mockImplementation(async (_method: string, params?: any) => {
                const expression = String(params?.expression || '');
                if (expression.includes('assistantCount')) {
                    readyChecks += 1;
                    if (readyChecks === 1) {
                        return { result: { value: { ready: false, userCount: 0, assistantCount: 0 } } };
                    }
                    return { result: { value: { ready: true, userCount: 0, assistantCount: 7 } } };
                }
                if (expression.includes('messages: entries.map')) {
                    return {
                        result: {
                            value: {
                                messages: [
                                    { role: 'assistant', text: 'loaded after switch' },
                                ],
                            },
                        },
                    };
                }
                return { result: { value: { ok: false, error: 'scroll container not found' } } };
            });

            const history = await service.getConversationHistory(mockCdpService, {
                maxMessages: 20,
                maxScrollSteps: 0,
            });

            expect(readyChecks).toBeGreaterThanOrEqual(2);
            expect(history.messages).toEqual([
                { role: 'assistant', text: 'loaded after switch' },
            ]);
        });

        it('skips empty history results from earlier contexts and uses the first non-empty one', async () => {
            mockCdpService.getContexts = jest.fn().mockReturnValue([
                { id: 1, name: 'empty-context', url: '' },
                { id: 2, name: 'real-context', url: '' },
            ]);

            let scrapeCalls = 0;
            mockCdpService.call.mockImplementation(async (_method: string, params?: any) => {
                const expression = String(params?.expression || '');
                if (expression.includes('assistantCount')) {
                    return {
                        result: {
                            value: params?.contextId === 1
                                ? { ready: false, userCount: 0, assistantCount: 0 }
                                : { ready: true, userCount: 0, assistantCount: 2 },
                        },
                    };
                }
                if (!expression.includes('messages: entries.map')) {
                    return { result: { value: { ok: false, error: 'scroll container not found' } } };
                }

                scrapeCalls += 1;
                if (params?.contextId === 1) {
                    return { result: { value: { messages: [] } } };
                }
                return {
                    result: {
                        value: {
                            messages: [
                                { role: 'user', text: 'visible question' },
                                { role: 'assistant', text: 'visible answer' },
                            ],
                        },
                    },
                };
            });

            const history = await service.getConversationHistory(mockCdpService, {
                maxMessages: 20,
                maxScrollSteps: 0,
            });

            expect(scrapeCalls).toBe(2);
            expect(history.messages).toEqual([
                { role: 'user', text: 'visible question' },
                { role: 'assistant', text: 'visible answer' },
            ]);
        });

        it('skips failed scroll-state results from earlier contexts and keeps loading older history', async () => {
            mockCdpService.getContexts = jest.fn().mockReturnValue([
                { id: 1, name: 'bad-context', url: '' },
                { id: 2, name: 'real-context', url: '' },
            ]);

            let scrapeCount = 0;
            mockCdpService.call.mockImplementation(async (_method: string, params?: any) => {
                const expression = String(params?.expression || '');
                if (expression.includes('assistantCount')) {
                    return {
                        result: {
                            value: params?.contextId === 1
                                ? { ready: false, userCount: 0, assistantCount: 0 }
                                : { ready: true, userCount: 0, assistantCount: 2 },
                        },
                    };
                }
                if (expression.includes('messages: entries.map')) {
                    scrapeCount += 1;
                    if (scrapeCount === 1) {
                        return {
                            result: {
                                value: params?.contextId === 1
                                    ? { messages: [] }
                                    : { messages: [{ role: 'user', text: 'latest question' }] },
                            },
                        };
                    }
                    return {
                        result: {
                            value: params?.contextId === 1
                                ? { messages: [] }
                                : {
                                    messages: [
                                        { role: 'user', text: 'older question' },
                                        { role: 'assistant', text: 'older answer' },
                                        { role: 'user', text: 'latest question' },
                                    ],
                                },
                        },
                    };
                }
                if (expression.includes('scroll container not found')) {
                    return {
                        result: {
                            value: params?.contextId === 1
                                ? { ok: false, error: 'wrong context' }
                                : { ok: true, atTop: true, scrolled: true },
                        },
                    };
                }
                return { result: { value: null } };
            });

            const history = await service.getConversationHistory(mockCdpService, {
                maxMessages: 20,
                maxScrollSteps: 1,
            });

            expect(history.messages).toEqual([
                { role: 'user', text: 'older question' },
                { role: 'assistant', text: 'older answer' },
                { role: 'user', text: 'latest question' },
            ]);
        });

        it('returns scraped messages and scrolls upward until history stops growing', async () => {
            let scrapeCount = 0;
            mockCdpService.call.mockImplementation(async (_method: string, params?: any) => {
                const expression = String(params?.expression || '');
                if (expression.includes('assistantCount')) {
                    return { result: { value: { ready: true, userCount: 1, assistantCount: 1 } } };
                }
                if (expression.includes('messages: entries.map')) {
                    scrapeCount += 1;
                    if (scrapeCount === 1) {
                        return {
                            result: {
                                value: {
                                    messages: [
                                        { role: 'user', text: 'latest question' },
                                        { role: 'assistant', text: 'latest answer' },
                                    ],
                                },
                            },
                        };
                    }
                    return {
                        result: {
                            value: {
                                messages: [
                                    { role: 'user', text: 'older question' },
                                    { role: 'assistant', text: 'older answer' },
                                    { role: 'user', text: 'latest question' },
                                    { role: 'assistant', text: 'latest answer' },
                                ],
                            },
                        },
                    };
                }
                if (expression.includes('scroll container not found')) {
                    return { result: { value: { ok: true, atTop: true, scrolled: true } } };
                }
                return { result: { value: null } };
            });

            const history = await service.getConversationHistory(mockCdpService, {
                maxMessages: 20,
                maxScrollSteps: 3,
            });

            expect(history.truncated).toBe(false);
            expect(history.messages).toEqual([
                { role: 'user', text: 'older question' },
                { role: 'assistant', text: 'older answer' },
                { role: 'user', text: 'latest question' },
                { role: 'assistant', text: 'latest answer' },
            ]);
        });

        it('marks history as truncated when message count exceeds the configured limit', async () => {
            mockCdpService.call.mockImplementation(async (_method: string, params?: any) => {
                const expression = String(params?.expression || '');
                if (expression.includes('assistantCount')) {
                    return { result: { value: { ready: true, userCount: 1, assistantCount: 1 } } };
                }
                if (expression.includes('messages: entries.map')) {
                    return {
                        result: {
                            value: {
                                messages: [
                                    { role: 'user', text: 'm1' },
                                    { role: 'assistant', text: 'm2' },
                                    { role: 'user', text: 'm3' },
                                ],
                            },
                        },
                    };
                }
                return { result: { value: { ok: false, error: 'scroll container not found' } } };
            });

            const history = await service.getConversationHistory(mockCdpService, {
                maxMessages: 2,
                maxScrollSteps: 0,
            });

            expect(history.truncated).toBe(true);
            expect(history.messages).toEqual([
                { role: 'assistant', text: 'm2' },
                { role: 'user', text: 'm3' },
            ]);
        });

        it('history scrape script does not reject .leading-relaxed.select-text nodes just because they match the selector themselves', () => {
            const source = readFileSync('src/services/chatSessionService.ts', 'utf8');
            const marker = 'const SCRAPE_CONVERSATION_HISTORY_SCRIPT = `';
            const start = source.indexOf(marker);
            const scriptStart = start + marker.length;
            const scriptEnd = source.indexOf('`;', scriptStart);
            const scrapeScript = source.slice(scriptStart, scriptEnd);

            expect(scrapeScript).toContain(".leading-relaxed.select-text");
            expect(scrapeScript).not.toContain("if (el.querySelector(selector)) return true;");
        });
    });
});
