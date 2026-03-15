jest.mock('../../src/services/cdpBridgeManager', () => ({
    ensureWorkspaceRuntime: jest.fn(),
}));

jest.mock('../../src/services/grpcResponseMonitor', () => ({
    GrpcResponseMonitor: jest.fn().mockImplementation((options: {
        onComplete?: (text?: string) => Promise<void>;
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

describe('scheduleJobRunner', () => {
    it('notifies telegram when the gRPC monitor is unavailable', async () => {
        const notify = jest.fn().mockResolvedValue(undefined);

        (ensureWorkspaceRuntime as jest.Mock).mockResolvedValue({
            cdp: {
                getGrpcClient: jest.fn().mockResolvedValue(null),
                getActiveCascadeId: jest.fn(),
            },
            projectName: '__claw__',
            runtime: {
                startNewChat: jest.fn().mockResolvedValue({ ok: true }),
                sendPrompt: jest.fn().mockResolvedValue({ ok: true, cascadeId: 'cascade-1' }),
                getMonitoringTarget: jest.fn().mockResolvedValue(null),
            },
        });

        const scheduleJobCallback = createScheduleJobCallback({
            bridge: { lastActiveWorkspace: null } as any,
            chatSessionService: {} as any,
            clawWorkspacePath: 'C:/workspaces/__claw__',
            getTelegramNotify: () => notify,
            getClawInterceptor: () => null,
        });

        await scheduleJobCallback({
            id: 1,
            prompt: 'run heartbeat',
        } as any);

        expect(notify).toHaveBeenCalledWith('🦞 Schedule #1 failed: gRPC monitor unavailable.');
    });

    it('broadcasts the completed schedule output', async () => {
        const notify = jest.fn().mockResolvedValue(undefined);

        (ensureWorkspaceRuntime as jest.Mock).mockResolvedValue({
            cdp: {
                getGrpcClient: jest.fn().mockResolvedValue(null),
                getActiveCascadeId: jest.fn(),
            },
            projectName: '__claw__',
            runtime: {
                startNewChat: jest.fn().mockResolvedValue({ ok: true }),
                sendPrompt: jest.fn().mockResolvedValue({ ok: true, cascadeId: 'cascade-2' }),
                getMonitoringTarget: jest.fn().mockResolvedValue({
                    grpcClient: {},
                    cascadeId: 'cascade-2',
                }),
            },
        });

        const scheduleJobCallback = createScheduleJobCallback({
            bridge: { lastActiveWorkspace: null } as any,
            chatSessionService: {} as any,
            clawWorkspacePath: 'C:/workspaces/__claw__',
            getTelegramNotify: () => notify,
            getClawInterceptor: () => null,
        });

        await scheduleJobCallback({
            id: 2,
            prompt: 'summarize repo',
        } as any);
        await new Promise((resolve) => setImmediate(resolve));

        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('🦞 <b>Schedule #2</b>'),
        );
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('final response'),
        );
    });
});
