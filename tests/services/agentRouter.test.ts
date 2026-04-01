import { AgentRouter } from '../../src/services/agentRouter';
import { CdpConnectionPool } from '../../src/services/cdpConnectionPool';
import { WorkspaceService } from '../../src/services/workspaceService';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock dependencies
jest.mock('../../src/services/cdpConnectionPool');
jest.mock('../../src/services/chatSessionService');
jest.mock('../../src/services/workspaceService');
jest.mock('../../src/services/grpcResponseMonitor', () => ({
    GrpcResponseMonitor: jest.fn().mockImplementation((opts: any) => ({
        start: () => { setTimeout(() => opts.onComplete?.(''), 10); },
    })),
}));

describe('AgentRouter (Sub-Agent Pattern)', () => {
    let router: AgentRouter;
    let mockPool: jest.Mocked<CdpConnectionPool>;
    let mockWorkspace: jest.Mocked<WorkspaceService>;
    let tmpResponseDir: string;

    beforeEach(() => {
        mockPool = new CdpConnectionPool() as jest.Mocked<CdpConnectionPool>;
        mockWorkspace = new WorkspaceService('/base') as jest.Mocked<WorkspaceService>;

        tmpResponseDir = path.join(os.tmpdir(), `claw_agent_test_${Date.now()}`);
        mockWorkspace.getBaseDir.mockReturnValue(os.tmpdir());

        router = new AgentRouter({
            pool: mockPool,
            workspaceService: mockWorkspace,
            extractionMode: 'structured',
            responseDir: tmpResponseDir,
        });
    });

    afterEach(() => {
        if (fs.existsSync(tmpResponseDir)) {
            for (const f of fs.readdirSync(tmpResponseDir)) {
                fs.unlinkSync(path.join(tmpResponseDir, f));
            }
            fs.rmdirSync(tmpResponseDir);
        }
    });

    describe('listAgents()', () => {
        it('returns deduplicated and sorted workspace names', () => {
            mockPool.getActiveWorkspaceNames.mockReturnValue(['ProjectA']);
            mockWorkspace.scanWorkspaces.mockReturnValue(['ProjectA', 'ProjectC']);
            expect(router.listAgents()).toEqual(['ProjectA', 'ProjectC']);
        });

        it('handles scan failure gracefully', () => {
            mockPool.getActiveWorkspaceNames.mockReturnValue(['Active']);
            mockWorkspace.scanWorkspaces.mockImplementation(() => { throw new Error('ENOENT'); });
            expect(router.listAgents()).toEqual(['Active']);
        });
    });

    describe('buildTaskPrompt()', () => {
        it('includes Sub-Agent Task header and Summary instruction', () => {
            const prompt = router.buildTaskPrompt('Parent', 'Review the API changes');
            expect(prompt).toContain('[Sub-Agent Task — delegated by: Parent]');
            expect(prompt).toContain('Review the API changes');
            expect(prompt).toContain('## Summary');
            expect(prompt).toContain('relayed back to Parent');
        });
    });

    describe('extractSummary()', () => {
        it('extracts text after ## Summary marker', () => {
            const response = [
                'I reviewed the file and found 3 issues.',
                '',
                '## Summary',
                'Found 3 critical bugs in api.ts. Fixed input validation, null check, and race condition.',
            ].join('\n');

            const summary = router.extractSummary(response);
            expect(summary).toContain('Found 3 critical bugs');
            expect(summary).not.toContain('I reviewed the file');
        });

        it('handles ## Summary at end of long response', () => {
            const longBody = 'x'.repeat(5000);
            const response = `${longBody}\n\n## Summary\nDone. All tests pass.`;
            const summary = router.extractSummary(response);
            expect(summary).toBe('Done. All tests pass.');
        });

        it('stops at next ## heading', () => {
            const response = [
                '## Summary',
                'Task completed successfully.',
                '',
                '## Notes',
                'Some extra notes here.',
            ].join('\n');

            const summary = router.extractSummary(response);
            expect(summary).toBe('Task completed successfully.');
            expect(summary).not.toContain('extra notes');
        });

        it('truncates summaries over 1000 chars', () => {
            const longSummary = 'z'.repeat(2000);
            const response = `## Summary\n${longSummary}`;
            const summary = router.extractSummary(response);
            expect(summary.length).toBeLessThanOrEqual(1003); // 1000 + '...'
            expect(summary).toMatch(/\.\.\.$/);
        });

        it('returns an empty summary when no ## Summary is present', () => {
            const response = 'A'.repeat(100) + 'B'.repeat(500);
            const summary = router.extractSummary(response);
            expect(summary).toBe('');
        });
    });

    describe('delegateTask()', () => {
        it('returns error when workspace does not exist', async () => {
            mockWorkspace.getWorkspacePath.mockReturnValue('/base/NonExistent');
            mockWorkspace.exists.mockReturnValue(false);

            const result = await router.delegateTask({
                parentAgent: 'Parent', targetAgent: 'NonExistent', task: 'test',
            });

            expect(result.ok).toBe(false);
            expect(result.error).toContain('does not exist');
        });

        it('returns error when CDP connection fails', async () => {
            mockWorkspace.getWorkspacePath.mockReturnValue('/base/Target');
            mockWorkspace.exists.mockReturnValue(true);
            const mockRuntime = {
                ready: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
            };
            mockPool.getOrCreateRuntime.mockReturnValue(mockRuntime as any);

            const result = await router.delegateTask({
                parentAgent: 'Parent', targetAgent: 'Target', task: 'test',
            });

            expect(result.ok).toBe(false);
            expect(result.error).toContain('Cannot connect');
        });

        it('extracts summary and saves full output to file', async () => {
            mockWorkspace.getWorkspacePath.mockReturnValue('/base/Target');
            mockWorkspace.exists.mockReturnValue(true);

            const mockRuntime = {
                ready: jest.fn().mockResolvedValue(undefined),
                clearActiveCascade: jest.fn().mockResolvedValue(undefined),
                sendPrompt: jest.fn().mockResolvedValue({ ok: true, cascadeId: 'cascade-123' }),
                getMonitoringTarget: jest.fn().mockResolvedValue({
                    grpcClient: {},
                    cascadeId: 'cascade-123',
                }),
            };
            mockPool.getOrCreateRuntime.mockReturnValue(mockRuntime as any);

            const fullResponse = [
                'I analyzed the code and found issues in api.ts.',
                'Fixed validation, null checks, and added tests.',
                '',
                '## Summary',
                'Fixed 3 bugs in api.ts. All tests pass now.',
            ].join('\n');

            const { GrpcResponseMonitor } = require('../../src/services/grpcResponseMonitor');
            GrpcResponseMonitor.mockImplementation((opts: any) => ({
                start: () => { setTimeout(() => opts.onComplete?.(fullResponse), 10); },
            }));

            const result = await router.delegateTask({
                parentAgent: 'Parent', targetAgent: 'Target', task: 'Fix bugs in api.ts',
            });

            expect(result.ok).toBe(true);
            expect(mockRuntime.clearActiveCascade).toHaveBeenCalled();
            expect(mockRuntime.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
                text: expect.stringContaining('Fix bugs in api.ts'),
            }));
            expect(mockRuntime.getMonitoringTarget).toHaveBeenCalledWith('cascade-123');
            expect(result.summary).toBe('Fixed 3 bugs in api.ts. All tests pass now.');
            expect(result.outputPath).toBeDefined();
            expect(result.outputLength).toBe(fullResponse.length);

            // Verify file was written
            expect(fs.existsSync(result.outputPath!)).toBe(true);
            const content = fs.readFileSync(result.outputPath!, 'utf-8');
            expect(content).toContain('Fixed 3 bugs');
        });
    });
});
