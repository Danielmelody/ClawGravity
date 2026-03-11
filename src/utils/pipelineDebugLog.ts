/**
 * Pipeline Debug Logger — writes per-step I/O snapshots to a JSONL file.
 *
 * Each pipeline session (one message delivery) creates a sequence of steps.
 * Every step records: stepName, input, output, timestamp, durationMs.
 *
 * Log files are written to `~/.claw-gravity/pipeline-logs/` as JSONL
 * (one JSON object per line), named by session ID.
 *
 * Enabled by env var PIPELINE_DEBUG=true or PIPELINE_DEBUG=1.
 * In production this has zero overhead when disabled.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineStepRecord {
    readonly sessionId: string;
    readonly stepIndex: number;
    readonly stepName: string;
    readonly timestamp: string;
    readonly durationMs: number;
    readonly input: Record<string, unknown>;
    readonly output: Record<string, unknown>;
    readonly meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LOG_DIR = path.join(os.homedir(), '.claw-gravity', 'pipeline-logs');
const MAX_LOG_FILES = 50; // Keep at most this many session logs

function isEnabled(): boolean {
    const val = process.env.PIPELINE_DEBUG;
    return val === 'true' || val === '1';
}

// ---------------------------------------------------------------------------
// Session Logger
// ---------------------------------------------------------------------------

export class PipelineSession {
    private stepIndex = 0;
    private readonly records: PipelineStepRecord[] = [];

    constructor(
        readonly sessionId: string,
        private readonly enabled: boolean = isEnabled(),
    ) { }

    private recordStep(
        stepName: string,
        input: Record<string, unknown>,
        result: unknown,
        startedAtMs: number,
        meta?: Record<string, unknown>,
    ): void {
        this.records.push({
            sessionId: this.sessionId,
            stepIndex: this.stepIndex++,
            stepName,
            timestamp: new Date(startedAtMs).toISOString(),
            durationMs: Date.now() - startedAtMs,
            input: truncateValues(input),
            output: truncateValues({ result }),
            meta,
        });
    }

    /**
     * Run a pure function as a named pipeline step.
     * Logs the input, output, and duration to the session log.
     *
     * @param stepName  Human-readable name, e.g. "splitOutputAndLogs"
     * @param input     Key-value snapshot of inputs (will be truncated for large strings)
     * @param fn        The pure function to execute
     * @param meta      Optional extra metadata (e.g. config flags)
     */
    step<T>(
        stepName: string,
        input: Record<string, unknown>,
        fn: () => T,
        meta?: Record<string, unknown>,
    ): T {
        if (!this.enabled) return fn();

        const t0 = Date.now();
        const result = fn();
        this.recordStep(stepName, input, result, t0, meta);
        return result;
    }

    /**
     * Run an async pure function as a named pipeline step.
     */
    async stepAsync<T>(
        stepName: string,
        input: Record<string, unknown>,
        fn: () => Promise<T>,
        meta?: Record<string, unknown>,
    ): Promise<T> {
        if (!this.enabled) return fn();

        const t0 = Date.now();
        const result = await fn();
        this.recordStep(stepName, input, result, t0, meta);
        return result;
    }

    /**
     * Record a custom observation (no function to run).
     */
    observe(stepName: string, data: Record<string, unknown>): void {
        if (!this.enabled) return;
        this.records.push({
            sessionId: this.sessionId,
            stepIndex: this.stepIndex++,
            stepName,
            timestamp: new Date().toISOString(),
            durationMs: 0,
            input: truncateValues(data),
            output: {},
        });
    }

    /**
     * Flush all recorded steps to disk.
     * Call this at the end of the pipeline (onComplete / onTimeout).
     */
    flush(): void {
        if (!this.enabled || this.records.length === 0) return;

        try {
            if (!fs.existsSync(LOG_DIR)) {
                fs.mkdirSync(LOG_DIR, { recursive: true });
            }

            const filename = `${this.sessionId}.jsonl`;
            const filePath = path.join(LOG_DIR, filename);
            const lines = this.records.map((r) => JSON.stringify(r)).join('\n') + '\n';
            fs.writeFileSync(filePath, lines, 'utf-8');

            pruneOldLogs();
        } catch {
            // Pipeline logging should never crash the app
        }
    }

    /** Number of recorded steps so far. */
    get length(): number {
        return this.records.length;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_STRING_LEN = 2000;
const MAX_DEPTH = 3;

function truncateValues(obj: Record<string, unknown>, depth = 0): Record<string, unknown> {
    if (depth > MAX_DEPTH) return { _truncated: '(max depth)' };

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        out[key] = truncateValue(value, depth);
    }
    return out;
}

function truncateValue(value: unknown, depth: number): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        return value.length > MAX_STRING_LEN
            ? { _string: value.slice(0, MAX_STRING_LEN), _totalLength: value.length }
            : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        if (depth > MAX_DEPTH) return { _array: true, length: value.length };
        return value.slice(0, 10).map((v) => truncateValue(v, depth + 1));
    }
    if (typeof value === 'object') {
        return truncateValues(value as Record<string, unknown>, depth + 1);
    }
    return String(value);
}

function pruneOldLogs(): void {
    try {
        const files = fs.readdirSync(LOG_DIR)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => ({
                name: f,
                mtime: fs.statSync(path.join(LOG_DIR, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);

        for (const file of files.slice(MAX_LOG_FILES)) {
            fs.unlinkSync(path.join(LOG_DIR, file.name));
        }
    } catch {
        // best-effort cleanup
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let sessionCounter = 0;

/**
 * Create a new pipeline session for one message delivery.
 * Use a descriptive prefix like "tg-deliver" or "tg-passive".
 */
export function createPipelineSession(prefix = 'pipeline'): PipelineSession {
    const id = `${prefix}-${Date.now()}-${++sessionCounter}`;
    return new PipelineSession(id);
}
