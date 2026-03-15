import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { prepareClawWorkspace } from '../../src/bot/clawWorkspaceSetup';

describe('clawWorkspaceSetup', () => {
    it('creates the claw workspace files without launching when no schedules are enabled', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-workspace-'));
        const clawWorkspacePath = path.join(tempRoot, '__claw__');

        try {
            await prepareClawWorkspace({
                clawWorkspacePath,
                enabledScheduleCount: 0,
            });

            expect(fs.existsSync(clawWorkspacePath)).toBe(true);
            expect(fs.readFileSync(path.join(clawWorkspacePath, 'GEMINI.md'), 'utf-8')).toContain(
                'ClawGravity Agent Instructions',
            );
            expect(fs.readFileSync(path.join(clawWorkspacePath, 'HEARTBEAT.md'), 'utf-8')).toContain(
                'HEARTBEAT_OK',
            );
            expect(fs.readFileSync(path.join(clawWorkspacePath, 'CLAW.md'), 'utf-8')).toContain(
                'Claw Agent Memory',
            );
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
