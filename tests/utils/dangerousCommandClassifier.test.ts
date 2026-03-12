import { isDangerousCommand } from '../../src/utils/dangerousCommandClassifier';

describe('isDangerousCommand', () => {
    describe('dangerous commands', () => {
        it.each([
            ['rm file.txt', 'rm single file'],
            ['rm -rf /some/path', 'rm recursive force'],
            ['rm -r dir/', 'rm recursive'],
            ['rmdir src/middleware', 'rmdir'],
            ['rm src/middleware/auth.ts src/middleware/sanitize.ts && rmdir src/middleware', 'rm + rmdir chained'],
            ['del file.txt', 'Windows del'],
            ['rd /s /q folder', 'Windows rd'],
            ['shred secret.key', 'shred'],
            ['unlink symlink', 'unlink'],
            ['dd if=/dev/zero of=/dev/sda', 'dd disk write'],
            ['format C:', 'format disk'],
            ['mkfs.ext4 /dev/sdb1', 'mkfs'],
            ['git clean -fd', 'git clean'],
            ['git reset --hard HEAD~3', 'git reset --hard'],
            ['shutdown -h now', 'shutdown'],
            ['reboot', 'reboot'],
            ['kill -9 1234', 'kill'],
            ['pkill node', 'pkill'],
            ['killall nginx', 'killall'],
            ['echo done && rm -rf build/', 'safe + dangerous chained'],
            ['npm test ; rm output.log', 'safe then dangerous with semicolon'],
            ['cat file | rm -f target', 'pipe into dangerous'],
        ])('"%s" (%s) → true', (cmd) => {
            expect(isDangerousCommand(cmd)).toBe(true);
        });
    });

    describe('safe commands', () => {
        it.each([
            ['npm install', 'npm install'],
            ['npm run dev', 'npm run dev'],
            ['npm test', 'npm test'],
            ['echo hello', 'echo'],
            ['python3 -m http.server 8000', 'python server'],
            ['cat file.txt | grep something', 'cat + grep'],
            ['ls -la', 'ls'],
            ['git status', 'git status'],
            ['git log -5', 'git log'],
            ['git add .', 'git add'],
            ['git commit -m "fix"', 'git commit'],
            ['git push origin main', 'git push'],
            ['git reset --soft HEAD~1', 'git reset soft (not hard)'],
            ['mkdir -p new/dir', 'mkdir'],
            ['cp file1 file2', 'cp'],
            ['mv old new', 'mv'],
            ['node script.js', 'node'],
            ['npx jest', 'npx jest'],
            ['tsc --noEmit', 'tsc'],
        ])('"%s" (%s) → false', (cmd) => {
            expect(isDangerousCommand(cmd)).toBe(false);
        });
    });

    describe('edge cases', () => {
        it('returns false for empty string', () => {
            expect(isDangerousCommand('')).toBe(false);
        });

        it('returns false for whitespace-only string', () => {
            expect(isDangerousCommand('   ')).toBe(false);
        });

        it('handles quoted tokens', () => {
            expect(isDangerousCommand('"rm" file.txt')).toBe(true);
        });

        it('is case-insensitive for dangerous tokens', () => {
            expect(isDangerousCommand('RM -rf /')).toBe(true);
            expect(isDangerousCommand('DEL file.txt')).toBe(true);
        });
    });
});
