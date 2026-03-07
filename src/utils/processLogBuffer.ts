export interface ProcessLogBufferOptions {
    maxChars?: number;
    maxEntries?: number;
    maxEntryLength?: number;
}

const DEFAULT_MAX_CHARS = 3500;
const DEFAULT_MAX_ENTRIES = 120;
const DEFAULT_MAX_ENTRY_LENGTH = 260;

function collapseWhitespace(text: string): string {
    return (text || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

function stripUiChromeSuffix(text: string): string {
    return collapseWhitespace(text).replace(/\s*show details\s*$/i, '').trim();
}

/** Heuristic: does this line look like a standalone activity entry? */
function looksLikeStandaloneEntry(line: string): boolean {
    // Known activity verb prefixes (present or past tense)
    if (/^(?:analy[sz]|read|writ|run|search|think|thought|process|execut|test|debug|fetch|connect|creat|updat|delet|install|build|compil|deploy|check|scan|pars|resolv|download|upload|work|load|initiat|start)/i.test(line)) return true;
    // Tool call signature: foo / bar
    if (/^[a-z0-9._-]+\s*\/\s*[a-z0-9._-]+$/i.test(line)) return true;
    // MCP tool prefix
    if (/^mcp tool:/i.test(line)) return true;
    // Full output reference
    if (/^full output written to\b/i.test(line)) return true;
    return false;
}

/** Merge short consecutive fragments that look like streaming tokens into single entries. */
function coalesceFragments(lines: string[]): string[] {
    const FRAG_MAX = 40;
    const result: string[] = [];
    let pending: string[] = [];

    const flush = () => {
        if (pending.length > 0) {
            result.push(pending.join(' '));
            pending = [];
        }
    };

    for (const line of lines) {
        if (line.length > FRAG_MAX || looksLikeStandaloneEntry(line)) {
            flush();
            result.push(line);
        } else {
            pending.push(line);
        }
    }
    flush();

    return result;
}

function parseBlocks(raw: string): string[] {
    const normalized = (raw || '').replace(/\r/g, '').trim();
    if (!normalized) return [];

    const blocks = normalized
        .split(/\n{2,}/)
        .map((chunk) => collapseWhitespace(chunk))
        .filter((chunk) => chunk.length > 0);

    // When blank-line separated blocks exist (>1 block), use them directly.
    // When there's only one block but the raw text had single newlines,
    // fall through to line-by-line coalescing to avoid merging everything.
    if (blocks.length > 1) return blocks;

    const lines = normalized
        .split('\n')
        .map((line) => collapseWhitespace(line))
        .filter((line) => line.length > 0);

    if (lines.length <= 1) return blocks.length > 0 ? blocks : lines;

    return coalesceFragments(lines);
}

function pickEmoji(entry: string): string {
    const lower = entry.toLowerCase();
    if (/^thought for\b/.test(lower) || /^thinking\b/.test(lower)) return '🧠';
    if (/^initiating\b/.test(lower) || /^starting\b/.test(lower)) return '🚀';
    if (/^mcp tool:\s*[a-z0-9._-]+\s*\/\s*[a-z0-9._-]+$/i.test(entry)) return '🛠️';
    if (/^[a-z0-9._-]+\s*\/\s*[a-z0-9._-]+$/i.test(entry)) return '🛠️';
    if (/^(?:analy[sz]ed|read|wrote|created|updated|deleted|built|compiled|installed|resolved|downloaded|connected|fetched)\b/i.test(entry)) return '📄';
    if (/^(?:analy[sz]ing|reading|writing|running|searching|fetching|checking|scanning|creating|updating|deleting|building|compiling|deploying|parsing|resolving|downloading|uploading|connecting|installing|executing|testing|debugging|processing|working|loading)\b/i.test(entry)) return '🔍';
    if (/^title:\s/.test(lower) && /\surl:\s/.test(lower)) return '🔎';
    if (/^(json|javascript|typescript|python|bash|sh|html|css|xml|yaml|yml|toml|sql|graphql|markdown|text|plaintext|log)$/i.test(entry)) return '📦';
    return '•';
}

function toDisplayEntry(rawEntry: string, maxEntryLength: number): string {
    const trimmed = stripUiChromeSuffix(rawEntry);
    if (!trimmed) return '';
    const clipped =
        trimmed.length > maxEntryLength
            ? `${trimmed.slice(0, Math.max(0, maxEntryLength - 3))}...`
            : trimmed;
    return `${pickEmoji(clipped)} ${clipped}`;
}

export class ProcessLogBuffer {
    private readonly maxChars: number;
    private readonly maxEntries: number;
    private readonly maxEntryLength: number;
    private readonly entries: string[] = [];
    private readonly seen = new Set<string>();

    constructor(options: ProcessLogBufferOptions = {}) {
        this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
        this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this.maxEntryLength = options.maxEntryLength ?? DEFAULT_MAX_ENTRY_LENGTH;
    }

    append(raw: string): string {
        const blocks = parseBlocks(raw);
        for (const block of blocks) {
            const display = toDisplayEntry(block, this.maxEntryLength);
            if (!display) continue;
            const key = display.toLowerCase();
            if (this.seen.has(key)) continue;
            this.entries.push(display);
            this.seen.add(key);
        }

        this.trim();
        return this.snapshot();
    }

    snapshot(): string {
        return this.entries.join('\n');
    }

    private trim(): void {
        while (this.entries.length > this.maxEntries) {
            this.dropOldest();
        }

        while (this.entries.length > 1 && this.snapshot().length > this.maxChars) {
            this.dropOldest();
        }

        if (this.entries.length === 1 && this.entries[0].length > this.maxChars) {
            const only = this.entries[0];
            this.entries[0] = `${only.slice(0, Math.max(0, this.maxChars - 3))}...`;
            this.seen.clear();
            this.seen.add(this.entries[0].toLowerCase());
        }
    }

    private dropOldest(): void {
        const removed = this.entries.shift();
        if (!removed) return;
        this.seen.delete(removed.toLowerCase());
    }
}
