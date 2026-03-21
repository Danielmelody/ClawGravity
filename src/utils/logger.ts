import { logBuffer } from './logBuffer';

export const COLORS = {
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    magenta: '\x1b[35m',
    boldYellow: '\x1b[1;33m',
    dim: '\x1b[2m',
    reset: '\x1b[0m',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    none: 4,
};

export type ErrorHookFn = (formattedMessage: string) => void | Promise<void>;

export interface Logger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    phase(...args: unknown[]): void;
    done(...args: unknown[]): void;
    prompt(text: string): void;
    divider(label?: string): void;
    setLogLevel(level: LogLevel): void;
    getLogLevel(): LogLevel;
    /**
     * Register a hook that fires (fire-and-forget) on every `error()` call.
     * Errors are batched with a 10 s debounce window to avoid flooding.
     * Pass `null` to remove the hook.
     */
    setErrorHook(fn: ErrorHookFn | null): void;
}

const getTimestamp = () => {
    const now = new Date();
    const timeString = now.toLocaleTimeString('ja-JP', { hour12: false });
    return `${COLORS.dim}[${timeString}]${COLORS.reset}`;
};

/** Max errors batched before force-flush. */
const ERROR_HOOK_MAX_BATCH = 10;
/** Debounce window in ms — errors within this window are batched. */
const ERROR_HOOK_DEBOUNCE_MS = 10_000;

export function createLogger(initialLevel: LogLevel = 'info'): Logger {
    let currentLevel: LogLevel = initialLevel;
    let errorHook: ErrorHookFn | null = null;
    let errorHookQueue: string[] = [];
    let errorHookTimer: ReturnType<typeof setTimeout> | null = null;

    function shouldLog(methodLevel: LogLevel): boolean {
        return LEVEL_PRIORITY[methodLevel] >= LEVEL_PRIORITY[currentLevel];
    }

    /** Deduplicate identical messages, preserving insertion order. */
    function dedup(batch: readonly string[]): { msg: string; count: number }[] {
        const map = new Map<string, number>();
        const order: string[] = [];
        for (const m of batch) {
            const prev = map.get(m);
            if (prev !== undefined) {
                map.set(m, prev + 1);
            } else {
                map.set(m, 1);
                order.push(m);
            }
        }
        return order.map((msg) => ({ msg, count: map.get(msg)! }));
    }

    function flushErrorHook(): void {
        if (errorHookTimer) {
            clearTimeout(errorHookTimer);
            errorHookTimer = null;
        }
        if (!errorHook || errorHookQueue.length === 0) return;
        const batch = errorHookQueue.splice(0);
        const unique = dedup(batch);
        const totalCount = batch.length;

        let text: string;
        if (unique.length === 1 && unique[0].count === 1) {
            text = `⚠️ <b>Error</b>\n<pre>${unique[0].msg}</pre>`;
        } else {
            const lines = unique.map((e, i) => {
                const suffix = e.count > 1 ? ` (×${e.count})` : '';
                return `<pre>${i + 1}. ${e.msg}${suffix}</pre>`;
            });
            text = `⚠️ <b>${totalCount} Errors</b>\n` + lines.join('\n');
        }

        try {
            const result = errorHook(text);
            if (result && typeof (result as Promise<void>).catch === 'function') {
                (result as Promise<void>).catch(() => { /* swallow */ });
            }
        } catch { /* swallow — hook must never crash the logger */ }
    }

    function enqueueErrorHook(message: string): void {
        if (!errorHook) return;
        errorHookQueue.push(message.slice(0, 1000));
        if (errorHookQueue.length >= ERROR_HOOK_MAX_BATCH) {
            flushErrorHook();
            return;
        }
        if (!errorHookTimer) {
            errorHookTimer = setTimeout(flushErrorHook, ERROR_HOOK_DEBOUNCE_MS);
        }
    }

    return {
        info(...args: unknown[]) {
            if (shouldLog('info')) {
                const formatted = `${getTimestamp()} ${COLORS.cyan}[INFO]${COLORS.reset}`;
                console.info(formatted, ...args);
                logBuffer.append('info', `[INFO] ${args.join(' ')}`);
            }
        },
        warn(...args: unknown[]) {
            if (shouldLog('warn')) {
                const formatted = `${getTimestamp()} ${COLORS.yellow}[WARN]${COLORS.reset}`;
                console.warn(formatted, ...args);
                logBuffer.append('warn', `[WARN] ${args.join(' ')}`);
            }
        },
        error(...args: unknown[]) {
            if (shouldLog('error')) {
                const formatted = `${getTimestamp()} ${COLORS.red}[ERROR]${COLORS.reset}`;
                console.error(formatted, ...args);
                const plain = `[ERROR] ${args.join(' ')}`;
                logBuffer.append('error', plain);
                enqueueErrorHook(plain);
            }
        },
        debug(...args: unknown[]) {
            if (shouldLog('debug')) {
                const formatted = `${getTimestamp()} ${COLORS.dim}[DEBUG]${COLORS.reset}`;
                console.debug(formatted, ...args);
                logBuffer.append('debug', `[DEBUG] ${args.join(' ')}`);
            }
        },
        /** Important state transitions - stands out in logs */
        phase(...args: unknown[]) {
            if (shouldLog('info')) {
                const formatted = `${getTimestamp()} ${COLORS.magenta}[PHASE]${COLORS.reset}`;
                console.info(formatted, ...args);
                logBuffer.append('info', `[PHASE] ${args.join(' ')}`);
            }
        },
        /** Completion-related events - green for success */
        done(...args: unknown[]) {
            if (shouldLog('info')) {
                const formatted = `${getTimestamp()} ${COLORS.green}[DONE]${COLORS.reset}`;
                console.info(formatted, ...args);
                logBuffer.append('info', `[DONE] ${args.join(' ')}`);
            }
        },
        /** User prompt text - always visible regardless of log level */
        prompt(text: string) {
            const formatted = `${getTimestamp()} ${COLORS.boldYellow}[PROMPT]${COLORS.reset} ${COLORS.boldYellow}${text}${COLORS.reset}`;
            console.info(formatted);
            logBuffer.append('info', `[PROMPT] ${text}`);
        },
        /** Section divider with optional label for structured output */
        divider(label?: string) {
            if (shouldLog('info')) {
                if (label) {
                    const pad = Math.max(4, 50 - label.length - 4);
                    console.info(`${COLORS.green}[DONE]${COLORS.reset} ${COLORS.dim}── ${label} ${'─'.repeat(pad)}${COLORS.reset}`);
                } else {
                    console.info(`${COLORS.green}[DONE]${COLORS.reset} ${COLORS.dim}${'─'.repeat(50)}${COLORS.reset}`);
                }
            }
        },
        setLogLevel(level: LogLevel) {
            currentLevel = level;
        },
        getLogLevel(): LogLevel {
            return currentLevel;
        },
        setErrorHook(fn: ErrorHookFn | null) {
            errorHook = fn;
            if (!fn) {
                errorHookQueue = [];
                if (errorHookTimer) {
                    clearTimeout(errorHookTimer);
                    errorHookTimer = null;
                }
            }
        },
    };
}

export const logger = createLogger('info');
