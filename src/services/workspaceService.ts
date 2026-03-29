import fs from 'fs';
import { resolveSafePath } from '../utils/sanitize';

/**
 * Service for workspace filesystem operations and path validation.
 * Manages directories under WORKSPACE_BASE_DIR.
 */
export class WorkspaceService {
    private readonly baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = baseDir;
    }

    /**
     * Ensure the base directory exists, creating it if necessary
     */
    public ensureBaseDir(): void {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    /**
     * Return a list of subdirectories in the base directory
     */
    public scanWorkspaces(): string[] {
        this.ensureBaseDir();

        const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
        return entries
            .filter((entry) => {
                if (entry.name.startsWith('.')) return false;
                // Follow symlinks: isDirectory() returns false for symlinks,
                // so use statSync (which follows symlinks) to check the target
                if (entry.isDirectory()) return true;
                if (entry.isSymbolicLink()) {
                    try {
                        return fs.statSync(`${this.baseDir}/${entry.name}`).isDirectory();
                    } catch { return false; }
                }
                return false;
            })
            .map((entry) => entry.name)
            .sort();
    }

    /**
     * Validate a relative path and return a safe absolute path
     * @throws On path traversal detection
     */
    public validatePath(relativePath: string): string {
        return resolveSafePath(relativePath, this.baseDir);
    }

    /**
     * Get the base directory path
     */
    public getBaseDir(): string {
        return this.baseDir;
    }

    /**
     * Return the absolute path of the specified workspace
     */
    public getWorkspacePath(workspaceName: string): string {
        return this.validatePath(workspaceName);
    }

    /**
     * Check if the specified workspace exists
     */
    public exists(workspaceName: string): boolean {
        const fullPath = this.validatePath(workspaceName);
        return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
    }
}
