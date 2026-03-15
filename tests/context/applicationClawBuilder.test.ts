import { buildApplicationContext } from '../../src/context/applicationContextBuilder';
import { buildClawRuntimeArtifacts } from '../../src/context/applicationClawBuilder';
import type { AppConfig } from '../../src/utils/config';
import { AgentRouter } from '../../src/services/agentRouter';

describe('applicationClawBuilder', () => {
    const config: AppConfig = {
        allowedUserIds: ['123'],
        workspaceBaseDir: process.cwd(),
        autoApproveFileEdits: false,
        logLevel: 'info',
        extractionMode: 'structured',
        platforms: ['discord'],
    };

    it('builds claw runtime artifacts from the shared application context', async () => {
        const context = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        try {
            const artifacts = await buildClawRuntimeArtifacts(context, {
                extractionMode: config.extractionMode,
                clawWorkspacePath: `${process.cwd()}\\__claw__`,
                getTelegramNotify: () => null,
            });

            expect(typeof artifacts.scheduleJobCallback).toBe('function');
            expect(artifacts.clawInterceptor).toBeDefined();
            expect(artifacts.agentRouter).toBeInstanceOf(AgentRouter);
        } finally {
            context.db.close();
        }
    });

    it('relays sub-agent summaries back into the active workspace runtime', async () => {
        const delegateTask = jest.spyOn(AgentRouter.prototype, 'delegateTask').mockResolvedValue({
            ok: true,
            summary: 'worker summary',
            outputPath: 'C:/tmp/result.md',
            outputLength: 123,
        });

        const context = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        try {
            const sendPrompt = jest.fn().mockResolvedValue({ ok: true });
            context.bridge.lastActiveWorkspace = 'proj-a';
            (context.bridge.pool as any).getOrCreateRuntime = jest.fn().mockReturnValue({
                sendPrompt,
            });

            const artifacts = await buildClawRuntimeArtifacts(context, {
                extractionMode: config.extractionMode,
                clawWorkspacePath: `${process.cwd()}\\__claw__`,
                getTelegramNotify: () => null,
            });

            await artifacts.clawInterceptor.execute([
                '```@claw',
                'action: agent_send',
                'to: proj-b',
                'message: inspect',
                '```',
            ].join('\n'));

            expect(sendPrompt).toHaveBeenCalledWith({
                text: expect.stringContaining('worker summary'),
            });
        } finally {
            delegateTask.mockRestore();
            context.db.close();
        }
    });
});
