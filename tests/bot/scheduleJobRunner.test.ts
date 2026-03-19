jest.mock('../../src/services/cdpBridgeManager', () => ({
    ensureWorkspaceRuntime: jest.fn(),
}));

jest.mock('../../src/services/grpcResponseMonitor', () => ({
    GrpcResponseMonitor: jest.fn().mockImplementation((options: {
        onComplete?: (text?: string) => Promise<void>;
        onTimeout?: (text?: string) => Promise<void>;
    }) => ({
        start: jest.fn(() => {
            void options.onComplete?.('final response');
        }),
    })),
}));

jest.mock('../../src/utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        divider: jest.fn(),
        done: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    },
}));

import { createScheduleJobCallback } from '../../src/bot/scheduleJobRunner';
import { ensureWorkspaceRuntime } from '../../src/services/cdpBridgeManager';

function createMockRuntime(overrides: Record<string, any> = {}) {
    return {
        cdp: {
            getGrpcClient: jest.fn().mockResolvedValue(null),
            getActiveCascadeId: jest.fn(),
        },
        projectName: '__claw__',
        runtime: {
            startNewChat: jest.fn().mockResolvedValue({ ok: true }),
            sendPrompt: jest.fn().mockResolvedValue({ ok: true, cascadeId: 'cascade-1' }),
            getMonitoringTarget: jest.fn().mockResolvedValue(null),
            ...overrides,
        },
    };
}

describe('scheduleJobRunner', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('notifies telegram when the gRPC monitor is unavailable', async () => {
        const notify = jest.fn().mockResolvedValue(undefined);

        (ensureWorkspaceRuntime as jest.Mock).mockResolvedValue(createMockRuntime());

        const scheduleJobCallback = createScheduleJobCallback({
            bridge: { lastActiveWorkspace: null } as any,
            chatSessionService: {} as any,
            clawWorkspacePath: 'C:/workspaces/__claw__',
            getTelegramNotify: () => notify,
            getClawInterceptor: () => null,
        });

        await scheduleJobCallback({ id: 1, prompt: 'run heartbeat' } as any);

        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('Schedule #1 failed'),
        );
    });

    it('broadcasts the completed schedule output via telegram', async () => {
        const notify = jest.fn().mockResolvedValue(undefined);

        (ensureWorkspaceRuntime as jest.Mock).mockResolvedValue(
            createMockRuntime({
                getMonitoringTarget: jest.fn().mockResolvedValue({
                    grpcClient: {},
                    cascadeId: 'cascade-2',
                }),
            }),
        );

        const scheduleJobCallback = createScheduleJobCallback({
            bridge: { lastActiveWorkspace: null } as any,
            chatSessionService: {} as any,
            clawWorkspacePath: 'C:/workspaces/__claw__',
            getTelegramNotify: () => notify,
            getClawInterceptor: () => null,
        });

        await scheduleJobCallback({ id: 2, prompt: 'summarize repo' } as any);
        await new Promise((resolve) => setImmediate(resolve));

        // The schedule ID and final response text should appear in the notification
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('Schedule #2'),
        );
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('final response'),
        );
    });

    it('does not crash when telegram notify is not configured', async () => {
        (ensureWorkspaceRuntime as jest.Mock).mockResolvedValue(createMockRuntime());

        const scheduleJobCallback = createScheduleJobCallback({
            bridge: { lastActiveWorkspace: null } as any,
            chatSessionService: {} as any,
            clawWorkspacePath: 'C:/workspaces/__claw__',
            getTelegramNotify: () => null,
            getClawInterceptor: () => null,
        });

        // Should complete without throwing even when there's no notify function
        await expect(
            scheduleJobCallback({ id: 3, prompt: 'no telegram' } as any),
        ).resolves.toBeUndefined();
    });

    it('opens a new chat session before sending the schedule prompt', async () => {
        const startNewChat = jest.fn().mockResolvedValue({ ok: true });
        const sendPrompt = jest.fn().mockResolvedValue({ ok: true, cascadeId: 'cascade-4' });

        (ensureWorkspaceRuntime as jest.Mock).mockResolvedValue(
            createMockRuntime({ startNewChat, sendPrompt }),
        );

        const scheduleJobCallback = createScheduleJobCallback({
            bridge: { lastActiveWorkspace: null } as any,
            chatSessionService: {} as any,
            clawWorkspacePath: 'C:/workspaces/__claw__',
            getTelegramNotify: () => null,
            getClawInterceptor: () => null,
        });

        await scheduleJobCallback({ id: 4, prompt: 'scheduled task' } as any);

        // Both should be called — a new chat is created, then the prompt is sent
        expect(startNewChat).toHaveBeenCalled();
        expect(sendPrompt).toHaveBeenCalledWith({ text: 'scheduled task' });
    });
});
