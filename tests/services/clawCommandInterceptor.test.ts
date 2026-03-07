import { ClawCommandInterceptor, parseClawCommands, hasClawCommands } from '../../src/services/clawCommandInterceptor';
import type { AgentRouter } from '../../src/services/agentRouter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('ClawCommandInterceptor – agent commands', () => {

    describe('parseClawCommands() — agent actions', () => {
        it('parses agent_list block', () => {
            const cmds = parseClawCommands('```@claw\naction: agent_list\n```');
            expect(cmds).toHaveLength(1);
            expect(cmds[0].action).toBe('agent_list');
        });

        it('parses agent_send block', () => {
            const text = '```@claw\naction: agent_send\nto: MyProject\nmessage: Review the API\n```';
            const cmds = parseClawCommands(text);
            expect(cmds[0].action).toBe('agent_send');
            expect(cmds[0].params.to).toBe('MyProject');
            expect(cmds[0].params.message).toBe('Review the API');
        });

        it('parses agent_read block', () => {
            const cmds = parseClawCommands('```@claw\naction: agent_read\nfile: /tmp/out.md\n```');
            expect(cmds[0].action).toBe('agent_read');
            expect(cmds[0].params.file).toBe('/tmp/out.md');
        });
    });

    describe('execute() — agent_list', () => {
        it('returns available agents', async () => {
            const mockRouter = { listAgents: jest.fn().mockReturnValue(['A', 'B']) } as Partial<AgentRouter>;
            const interceptor = new ClawCommandInterceptor({
                scheduleService: { addSchedule: jest.fn(), listSchedules: jest.fn(), removeSchedule: jest.fn() } as any,
                jobCallback: jest.fn(),
                clawWorkspacePath: '/ws/__claw__',
                agentRouter: mockRouter as AgentRouter,
            });

            const results = await interceptor.execute('```@claw\naction: agent_list\n```');
            expect(results[0].success).toBe(true);
            expect(results[0].message).toContain('A');
        });

        it('fails when no agentRouter configured', async () => {
            const interceptor = new ClawCommandInterceptor({
                scheduleService: { addSchedule: jest.fn(), listSchedules: jest.fn(), removeSchedule: jest.fn() } as any,
                jobCallback: jest.fn(),
                clawWorkspacePath: '/ws/__claw__',
            });
            const results = await interceptor.execute('```@claw\naction: agent_list\n```');
            expect(results[0].success).toBe(false);
        });
    });

    describe('execute() — agent_send (sub-agent delegation)', () => {
        it('delegates task and returns summary', async () => {
            const mockRouter = {
                delegateTask: jest.fn().mockResolvedValue({
                    ok: true,
                    summary: 'Fixed 3 bugs. All tests pass.',
                    outputPath: '/tmp/output.md',
                    outputLength: 5000,
                }),
            } as Partial<AgentRouter>;

            const onAgentResponse = jest.fn();
            const interceptor = new ClawCommandInterceptor({
                scheduleService: { addSchedule: jest.fn(), listSchedules: jest.fn(), removeSchedule: jest.fn() } as any,
                jobCallback: jest.fn(),
                clawWorkspacePath: '/ws/__claw__',
                agentRouter: mockRouter as AgentRouter,
                onAgentResponse,
            });

            const text = '```@claw\naction: agent_send\nto: ProjectX\nmessage: Fix bugs in api.ts\n```';
            const results = await interceptor.execute(text);

            expect(results[0].success).toBe(true);
            expect(results[0].message).toContain('Task completed by ProjectX');
            expect(results[0].message).toContain('Fixed 3 bugs');
            expect(results[0].message).toContain('5000 chars');

            // Verify delegateTask was called correctly
            expect(mockRouter.delegateTask).toHaveBeenCalledWith({
                parentAgent: '__claw__',
                targetAgent: 'ProjectX',
                task: 'Fix bugs in api.ts',
            });

            // Verify summary relayed via callback
            expect(onAgentResponse).toHaveBeenCalledWith(
                'ProjectX', 'Fixed 3 bugs. All tests pass.', '/tmp/output.md',
            );
        });

        it('returns error on missing params', async () => {
            const mockRouter = { delegateTask: jest.fn() } as Partial<AgentRouter>;
            const interceptor = new ClawCommandInterceptor({
                scheduleService: { addSchedule: jest.fn(), listSchedules: jest.fn(), removeSchedule: jest.fn() } as any,
                jobCallback: jest.fn(),
                clawWorkspacePath: '/ws/__claw__',
                agentRouter: mockRouter as AgentRouter,
            });

            const results = await interceptor.execute('```@claw\naction: agent_send\nto: X\n```');
            expect(results[0].success).toBe(false);
            expect(results[0].message).toContain('Missing');
        });

        it('returns error when sub-agent fails', async () => {
            const mockRouter = {
                delegateTask: jest.fn().mockResolvedValue({ ok: false, error: 'Connection refused' }),
            } as Partial<AgentRouter>;
            const interceptor = new ClawCommandInterceptor({
                scheduleService: { addSchedule: jest.fn(), listSchedules: jest.fn(), removeSchedule: jest.fn() } as any,
                jobCallback: jest.fn(),
                clawWorkspacePath: '/ws/__claw__',
                agentRouter: mockRouter as AgentRouter,
            });

            const results = await interceptor.execute('```@claw\naction: agent_send\nto: X\nmessage: hi\n```');
            expect(results[0].success).toBe(false);
            expect(results[0].message).toContain('Connection refused');
        });
    });

    describe('execute() — agent_read', () => {
        let tmpFile: string;
        beforeEach(() => {
            tmpFile = path.join(os.tmpdir(), `claw_test_${Date.now()}.md`);
            fs.writeFileSync(tmpFile, '# Test\nHello from sub-agent', 'utf-8');
        });
        afterEach(() => { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); });

        it('reads saved output file', async () => {
            const interceptor = new ClawCommandInterceptor({
                scheduleService: { addSchedule: jest.fn(), listSchedules: jest.fn(), removeSchedule: jest.fn() } as any,
                jobCallback: jest.fn(),
                clawWorkspacePath: '/ws/__claw__',
            });
            const results = await interceptor.execute(`\`\`\`@claw\naction: agent_read\nfile: ${tmpFile}\n\`\`\``);
            expect(results[0].success).toBe(true);
            expect(results[0].message).toContain('Hello from sub-agent');
        });

        it('returns error for non-existent file', async () => {
            const interceptor = new ClawCommandInterceptor({
                scheduleService: { addSchedule: jest.fn(), listSchedules: jest.fn(), removeSchedule: jest.fn() } as any,
                jobCallback: jest.fn(),
                clawWorkspacePath: '/ws/__claw__',
            });
            const results = await interceptor.execute('```@claw\naction: agent_read\nfile: /nope.md\n```');
            expect(results[0].success).toBe(false);
        });
    });

    describe('backward compatibility', () => {
        it('schedule_list still works', async () => {
            const interceptor = new ClawCommandInterceptor({
                scheduleService: { addSchedule: jest.fn(), listSchedules: jest.fn().mockReturnValue([]), removeSchedule: jest.fn() } as any,
                jobCallback: jest.fn(),
                clawWorkspacePath: '/ws/__claw__',
            });
            const results = await interceptor.execute('```@claw\naction: schedule_list\n```');
            expect(results[0].success).toBe(true);
        });
    });
});
