/**
 * Helper to resolve the correct Antigravity CLI executable path based on the operating system
 * and environment variables.
 * 
 * Precedence:
 * 1. process.env.ANTIGRAVITY_PATH (Explicit override)
 * 2. OS-specific default paths (Mac: /Applications/..., Windows: %LOCALAPPDATA%\..., Linux: 'antigravity')
 */
export function getAntigravityCliPath(): string {
    // Allow user to set explicit path via ANTIGRAVITY_PATH (especially useful for Linux AppImages)
    if (process.env.ANTIGRAVITY_PATH) {
        return process.env.ANTIGRAVITY_PATH;
    }

    if (process.platform === 'darwin') {
        return '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity';
    }

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData) {
            // Use the CLI wrapper (bin/antigravity.cmd) instead of the raw Electron
            // executable (Antigravity.exe). The .exe doesn't understand VS Code CLI
            // arguments like --new-window, --folder-uri, or positional folder paths.
            // The .cmd wrapper sets ELECTRON_RUN_AS_NODE=1 and routes through cli.js.
            return `${localAppData}\\Programs\\Antigravity\\bin\\antigravity.cmd`;
        }
        return 'antigravity'; // Fallback — assume CLI is in system PATH
    }

    // Default for Linux or any unknown OS, assuming 'antigravity' is in the system PATH
    return 'antigravity';
}

/**
 * Helper to extract the project name from a full workspace path.
 * Handles both Windows (backslash) and POSIX (forward slash) paths.
 *
 * @param workspacePath The full path to the workspace directory
 * @returns The final folder name
 */
export function extractProjectNameFromPath(workspacePath: string): string {
    return workspacePath.split(/[/\\]/).filter(Boolean).pop() || '';
}

/**
 * Get a platform-appropriate hint for starting Antigravity with CDP.
 *
 * Used in user-facing messages (Discord embeds, CLI doctor, logs).
 */
export function getAntigravityCdpHint(port: number = 9222): string {
    const APP_NAME = 'Antigravity';
    switch (process.platform) {
        case 'darwin':
            return `open -a ${APP_NAME} --args --remote-debugging-port=${port}`;
        case 'win32':
            return `antigravity --remote-debugging-port=${port}`;
        default:
            return `${APP_NAME.toLowerCase()} --remote-debugging-port=${port}`;
    }
}
