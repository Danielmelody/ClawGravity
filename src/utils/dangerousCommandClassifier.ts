/**
 * Dangerous command classifier.
 *
 * Pure utility — no side effects, no I/O.
 * Identifies destructive shell commands that should bypass auto-accept
 * and always require manual approval via Telegram.
 */

/** Tokens whose presence as the first word of a sub-command makes it dangerous. */
const DANGEROUS_TOKENS: ReadonlySet<string> = new Set([
    // File / directory deletion
    'rm', 'rmdir', 'del', 'rd', 'shred', 'unlink',
    // Disk / partition
    'format', 'mkfs', 'fdisk', 'dd',
    // System control
    'shutdown', 'reboot', 'halt', 'poweroff',
    // Process killing
    'kill', 'pkill', 'killall',
]);

/**
 * Multi-word prefixes that are dangerous (checked against the first N tokens).
 * Each entry is an array of tokens that must appear in order at the start.
 */
const DANGEROUS_PREFIXES: readonly (readonly string[])[] = [
    ['git', 'clean'],
    ['git', 'reset', '--hard'],
];

/**
 * Split a compound command line into individual sub-commands.
 * Handles `&&`, `||`, `;`, and `|` as separators.
 */
function splitSubCommands(commandText: string): string[] {
    return commandText
        .split(/\s*(?:&&|\|\||[;|])\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/**
 * Tokenize a single sub-command into whitespace-separated words.
 * Strips surrounding quotes from each token.
 */
function tokenize(subCommand: string): string[] {
    return subCommand
        .split(/\s+/)
        .map((t) => t.replace(/^["']|["']$/g, ''))
        .filter((t) => t.length > 0);
}

/**
 * Check whether a single sub-command is dangerous.
 */
function isSubCommandDangerous(tokens: readonly string[]): boolean {
    if (tokens.length === 0) return false;

    const first = tokens[0].toLowerCase();

    // Direct token match (rm, del, rmdir, etc.)
    if (DANGEROUS_TOKENS.has(first)) return true;

    // Dotted variant match (e.g. mkfs.ext4, mkfs.xfs)
    const dotIdx = first.indexOf('.');
    if (dotIdx > 0 && DANGEROUS_TOKENS.has(first.substring(0, dotIdx))) return true;

    // Multi-word prefix match (git clean, git reset --hard, etc.)
    for (const prefix of DANGEROUS_PREFIXES) {
        if (tokens.length >= prefix.length) {
            const matches = prefix.every(
                (p, i) => tokens[i].toLowerCase() === p,
            );
            if (matches) return true;
        }
    }

    return false;
}

/**
 * Determine whether a command string contains any dangerous/destructive
 * operations that should skip auto-accept and require manual approval.
 *
 * @param commandText  The full command line (may contain `&&`, `||`, `;`, `|`)
 * @returns `true` if at least one sub-command is classified as dangerous
 */
export function isDangerousCommand(commandText: string): boolean {
    if (!commandText || commandText.trim().length === 0) return false;

    const subCommands = splitSubCommands(commandText);

    return subCommands.some((sub) => isSubCommandDangerous(tokenize(sub)));
}
