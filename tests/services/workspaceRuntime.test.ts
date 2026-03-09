import { CdpService } from '../../src/services/cdpService';
import { WorkspaceRuntime } from '../../src/services/workspaceRuntime';

jest.mock('../../src/services/cdpService');
jest.mock('../../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        phase: jest.fn(),
        done: jest.fn(),
        prompt: jest.fn(),
        divider: jest.fn(),
    },
}));

describe('WorkspaceRuntime', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('serializes exclusive operations onto a single workspace runtime', async () => {
        let resolveConnect!: () => void;
        const connectPromise = new Promise<void>((resolve) => {
            resolveConnect = resolve;
        });

        const mockCdp = {
            isConnected: jest.fn().mockReturnValue(false),
            discoverAndConnectForWorkspace: jest.fn().mockImplementation(async () => {
                await connectPromise;
            }),
            on: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
        };
        (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

        const runtime = new WorkspaceRuntime({
            projectName: 'ProjectA',
            workspacePath: '/path/to/ProjectA',
        });

        const order: string[] = [];
        const first = runtime.runExclusive(async () => {
            order.push('first:start');
            await new Promise((resolve) => setTimeout(resolve, 20));
            order.push('first:end');
        });
        const second = runtime.runExclusive(async () => {
            order.push('second:start');
            order.push('second:end');
        });

        resolveConnect();
        await Promise.all([first, second]);

        expect(CdpService).toHaveBeenCalledTimes(1);
        expect(order).toEqual([
            'first:start',
            'first:end',
            'second:start',
            'second:end',
        ]);
    });

    it('dispatches user messages to all registered sinks and isolates sink failures', async () => {
        const mockCdp = {
            isConnected: jest.fn().mockReturnValue(true),
            discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
        };
        (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

        const runtime = new WorkspaceRuntime({
            projectName: 'ProjectA',
            workspacePath: '/path/to/ProjectA',
        });

        const firstSink = jest.fn().mockRejectedValue(new Error('sink failed'));
        const secondSink = jest.fn().mockResolvedValue(undefined);

        runtime.addUserMessageSink('first', firstSink);
        runtime.addUserMessageSink('second', secondSink);

        await runtime.dispatchUserMessage({ text: 'hello', cascadeId: 'cascade-1' });

        expect(firstSink).toHaveBeenCalledWith({ text: 'hello', cascadeId: 'cascade-1' });
        expect(secondSink).toHaveBeenCalledWith({ text: 'hello', cascadeId: 'cascade-1' });
    });

    it('sends prompts through the runtime and primes echo/cascade state', async () => {
        const mockCdp = {
            isConnected: jest.fn().mockReturnValue(true),
            discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
            setCachedCascadeId: jest.fn(),
            injectMessage: jest.fn().mockResolvedValue({ ok: true, cascadeId: 'cascade-2' }),
        };
        (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

        const runtime = new WorkspaceRuntime({
            projectName: 'ProjectA',
            workspacePath: '/path/to/ProjectA',
        });

        const detector = { addEchoHash: jest.fn(), isActive: jest.fn().mockReturnValue(true), stop: jest.fn() } as any;
        runtime.registerUserMessageDetector(detector);

        const result = await runtime.sendPrompt({
            text: 'hello',
            overrideCascadeId: 'cascade-1',
        });

        expect(mockCdp.setCachedCascadeId).toHaveBeenCalledWith('cascade-1');
        expect(detector.addEchoHash).toHaveBeenCalledWith('hello');
        expect(mockCdp.injectMessage).toHaveBeenCalledWith('hello', 'cascade-1');
        expect(result).toEqual({ ok: true, cascadeId: 'cascade-2' });
        expect(runtime.getSelectedCascadeId()).toBe('cascade-2');
    });

    it('routes image prompts through injectMessageWithImageFiles', async () => {
        const mockCdp = {
            isConnected: jest.fn().mockReturnValue(true),
            discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
            setCachedCascadeId: jest.fn(),
            injectMessageWithImageFiles: jest.fn().mockResolvedValue({ ok: true }),
        };
        (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

        const runtime = new WorkspaceRuntime({
            projectName: 'ProjectA',
            workspacePath: '/path/to/ProjectA',
        });

        await runtime.sendPromptWithImages('review', ['a.png', 'b.png'], 'cascade-9');

        expect(mockCdp.injectMessageWithImageFiles).toHaveBeenCalledWith('review', ['a.png', 'b.png'], 'cascade-9');
        expect(runtime.getSelectedCascadeId()).toBe('cascade-9');
    });

    it('can return the monitoring target from the same serialized prompt send', async () => {
        const mockGrpcClient = { cancelCascade: jest.fn() };
        const mockCdp = {
            isConnected: jest.fn().mockReturnValue(true),
            discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
            setCachedCascadeId: jest.fn(),
            injectMessage: jest.fn().mockResolvedValue({ ok: true, cascadeId: 'cascade-22' }),
            getGrpcClient: jest.fn().mockResolvedValue(mockGrpcClient),
            getActiveCascadeId: jest.fn().mockResolvedValue('cascade-fallback'),
        };
        (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

        const runtime = new WorkspaceRuntime({
            projectName: 'ProjectA',
            workspacePath: '/path/to/ProjectA',
        });

        await expect(runtime.sendPromptWithMonitoringTarget({ text: 'hello' })).resolves.toEqual({
            injectResult: { ok: true, cascadeId: 'cascade-22' },
            monitoringTarget: {
                grpcClient: mockGrpcClient,
                cascadeId: 'cascade-22',
            },
        });
    });

    it('reuses the runtime-selected cascade when sending a later prompt without override', async () => {
        const mockCdp = {
            isConnected: jest.fn().mockReturnValue(true),
            discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
            setCachedCascadeId: jest.fn(),
            injectMessage: jest.fn().mockResolvedValue({ ok: true }),
        };
        (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

        const runtime = new WorkspaceRuntime({
            projectName: 'ProjectA',
            workspacePath: '/path/to/ProjectA',
        });

        await runtime.setActiveCascade('cascade-10');
        await runtime.sendPrompt({ text: 'follow up' });

        expect(runtime.hasSelectedCascade()).toBe(true);
        expect(runtime.getSelectedCascadeId()).toBe('cascade-10');
        expect(mockCdp.injectMessage).toHaveBeenCalledWith('follow up', 'cascade-10');
    });

    it('can clear the runtime-selected cascade state', async () => {
        const mockCdp = {
            isConnected: jest.fn().mockReturnValue(true),
            discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
            setCachedCascadeId: jest.fn(),
        };
        (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

        const runtime = new WorkspaceRuntime({
            projectName: 'ProjectA',
            workspacePath: '/path/to/ProjectA',
        });

        await runtime.setActiveCascade('cascade-10');
        await runtime.clearActiveCascade();

        expect(runtime.hasSelectedCascade()).toBe(false);
        expect(runtime.getSelectedCascadeId()).toBeNull();
        expect(mockCdp.setCachedCascadeId).toHaveBeenLastCalledWith(null);
    });

    it('creates a new chat through gRPC and remembers the selected cascade', async () => {
        const mockGrpcClient = {
            createCascade: jest.fn().mockResolvedValue('cascade-new'),
        };
        const mockCdp = {
            isConnected: jest.fn().mockReturnValue(true),
            discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
            getGrpcClient: jest.fn().mockResolvedValue(mockGrpcClient),
            setCachedCascadeId: jest.fn(),
        };
        (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

        const runtime = new WorkspaceRuntime({
            projectName: 'ProjectA',
            workspacePath: '/path/to/ProjectA',
        });

        const chatSessionService = {
            startNewChat: jest.fn(),
        } as any;

        await expect(runtime.startNewChat(chatSessionService)).resolves.toEqual({ ok: true });
        expect(mockGrpcClient.createCascade).toHaveBeenCalledTimes(1);
        expect(chatSessionService.startNewChat).not.toHaveBeenCalled();
        expect(mockCdp.setCachedCascadeId).toHaveBeenCalledWith('cascade-new');
        expect(runtime.getSelectedCascadeId()).toBe('cascade-new');
    });

    it('activates a session by title and updates runtime-selected cascade state', async () => {
        const mockCdp = {
            isConnected: jest.fn().mockReturnValue(true),
            discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
            setCachedCascadeId: jest.fn(),
        };
        (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

        const runtime = new WorkspaceRuntime({
            projectName: 'ProjectA',
            workspacePath: '/path/to/ProjectA',
        });

        const chatSessionService = {
            listAllSessions: jest.fn().mockResolvedValue([
                { title: 'Chat A', isActive: false, cascadeId: 'cascade-a' },
                { title: 'Chat B', isActive: true, cascadeId: 'cascade-b' },
            ]),
            activateSessionByTitle: jest.fn().mockResolvedValue({ ok: true }),
        } as any;

        await expect(runtime.activateSessionByTitle(chatSessionService, 'Chat A')).resolves.toEqual({ ok: true });
        expect(chatSessionService.activateSessionByTitle).toHaveBeenCalledWith(mockCdp, 'Chat A');
        expect(mockCdp.setCachedCascadeId).toHaveBeenCalledWith('cascade-a');
        expect(runtime.getSelectedCascadeId()).toBe('cascade-a');
    });

    it('prefers cached runtime session state before re-querying CDP', async () => {
        const mockCdp = {
            isConnected: jest.fn().mockReturnValue(true),
            discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
            getActiveSessionInfo: jest.fn()
                .mockResolvedValueOnce({ id: 'cascade-a', title: 'Chat A', summary: 'Summary A' })
                .mockResolvedValueOnce({ id: 'cascade-b', title: 'Chat B', summary: 'Summary B' }),
        };
        (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

        const runtime = new WorkspaceRuntime({
            projectName: 'ProjectA',
            workspacePath: '/path/to/ProjectA',
        });

        await expect(runtime.getActiveSessionInfo()).resolves.toEqual({
            id: 'cascade-a',
            title: 'Chat A',
            summary: 'Summary A',
        });
        await expect(runtime.getActiveSessionInfo()).resolves.toEqual({
            id: 'cascade-a',
            title: 'Chat A',
            summary: 'Summary A',
        });
        await expect(runtime.refreshActiveSessionInfo()).resolves.toEqual({
            id: 'cascade-b',
            title: 'Chat B',
            summary: 'Summary B',
        });
        await expect(runtime.getActiveCascadeId()).resolves.toBe('cascade-b');
        expect(mockCdp.getActiveSessionInfo).toHaveBeenCalledTimes(2);
    });

    it('exposes monitoring target and session operations without leaking raw cdp to callers', async () => {
        const mockGrpcClient = { cancelCascade: jest.fn() };
        const mockCdp = {
            isConnected: jest.fn().mockReturnValue(true),
            discoverAndConnectForWorkspace: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
            setCachedCascadeId: jest.fn(),
            getGrpcClient: jest.fn().mockResolvedValue(mockGrpcClient),
            getActiveCascadeId: jest.fn().mockResolvedValue('cascade-7'),
            getCurrentModel: jest.fn().mockResolvedValue('Claude'),
            getActiveSessionInfo: jest.fn().mockResolvedValue({ id: 'cascade-7', title: 'Chat', summary: 'Summary' }),
            setUiMode: jest.fn().mockResolvedValue({ ok: true, mode: 'fast' }),
            getUiModels: jest.fn().mockResolvedValue(['Claude', 'GPT']),
            setUiModel: jest.fn().mockResolvedValue({ ok: true, model: 'GPT' }),
        };
        (CdpService as jest.MockedClass<typeof CdpService>).mockImplementation(() => mockCdp as any);

        const runtime = new WorkspaceRuntime({
            projectName: 'ProjectA',
            workspacePath: '/path/to/ProjectA',
        });

        const chatSessionService = {
            startNewChat: jest.fn().mockResolvedValue({ ok: true }),
            activateSessionByTitle: jest.fn().mockResolvedValue({ ok: true }),
            listAllSessions: jest.fn().mockResolvedValue([{ title: 'Chat', isActive: true, cascadeId: 'cascade-7' }]),
            getConversationHistory: jest.fn().mockResolvedValue({
                messages: [{ role: 'user', text: 'hello' }],
                truncated: false,
            }),
        } as any;

        expect(await runtime.getMonitoringTarget()).toEqual({
            grpcClient: mockGrpcClient,
            cascadeId: 'cascade-7',
        });
        expect(await runtime.getCurrentModel()).toBe('Claude');
        expect(await runtime.getActiveSessionInfo()).toEqual({ id: 'cascade-7', title: 'Chat', summary: 'Summary' });
        expect(await runtime.syncUiMode('fast')).toEqual({ ok: true, mode: 'fast' });
        expect(await runtime.getUiModels()).toEqual(['Claude', 'GPT']);
        expect(await runtime.setUiModel('GPT')).toEqual({ ok: true, model: 'GPT' });
        expect(await runtime.startNewChat(chatSessionService)).toEqual({ ok: true });
        expect(await runtime.activateSessionByTitle(chatSessionService, 'Chat')).toEqual({ ok: true });
        expect(await runtime.listAllSessions(chatSessionService)).toEqual([{ title: 'Chat', isActive: true, cascadeId: 'cascade-7' }]);
        expect(await runtime.getConversationHistory(chatSessionService)).toEqual({
            messages: [{ role: 'user', text: 'hello' }],
            truncated: false,
        });

        expect(chatSessionService.startNewChat).toHaveBeenCalledWith(mockCdp);
        expect(chatSessionService.activateSessionByTitle).toHaveBeenCalledWith(mockCdp, 'Chat');
    });
});
