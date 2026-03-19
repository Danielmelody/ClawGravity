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

            // The key behavior: sub-agent results should be injected back
            // into the active workspace as a notification prompt.
            expect(sendPrompt).toHaveBeenCalledTimes(1);
            expect(sendPrompt).toHaveBeenCalledWith({
                text: expect.stringContaining('worker summary'),
            });
        } finally {
            delegateTask.mockRestore();
            context.db.close();
        }
    });

    it('does not relay sub-agent results when no workspace is active', async () => {
        const delegateTask = jest.spyOn(AgentRouter.prototype, 'delegateTask').mockResolvedValue({
            ok: true,
            summary: 'some result',
            outputPath: 'C:/tmp/result.md',
            outputLength: 50,
        });

        const context = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        try {
            const sendPrompt = jest.fn();
            (context.bridge.pool as any).getOrCreateRuntime = jest.fn().mockReturnValue({
                sendPrompt,
            });
            // lastActiveWorkspace is left as null — no active workspace

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

            // With no active workspace, the result should NOT be injected
            expect(sendPrompt).not.toHaveBeenCalled();
        } finally {
            delegateTask.mockRestore();
            context.db.close();
        }
    });
});
