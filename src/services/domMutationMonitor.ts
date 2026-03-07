/**
 * Event-Driven DOM Monitoring (Phase 4 of DOM Extraction Overhaul)
 *
 * Replaces polling-only detection with MutationObserver-based push notifications.
 * Uses CDP `Runtime.addBinding` to receive DOM mutation events in Node.js,
 * drastically reducing CDP call frequency and improving response latency.
 *
 * Architecture:
 *   1. Inject a binding name (`__cg_domEvent`) via Runtime.addBinding
 *   2. Inject a MutationObserver script that observes the Antigravity panel
 *   3. When mutations match relevant patterns, the observer calls the binding
 *   4. CDP sends `Runtime.bindingCalled` events to Node.js
 *   5. DomMutationMonitor emits typed events to subscribers
 *
 * This module is designed to be used ALONGSIDE polling (hybrid mode):
 *   - Polling interval is extended (e.g. 5s → 10s) as a safety net
 *   - Push events trigger immediate extraction for faster response
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import type { CdpService } from './cdpService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DomEventType =
    | 'content-change'    // Assistant message content changed
    | 'stop-button'       // Stop button appeared or disappeared
    | 'activity-update'   // Activity/process log node mutated
    | 'dialog-appeared'   // A dialog (approval, error popup) appeared
    | 'unknown';          // Catch-all for unclassified mutations

export interface DomMutationEvent {
    readonly type: DomEventType;
    readonly timestamp: number;
    /** Optional detail string from the injected observer */
    readonly detail?: string;
}

export interface DomMutationMonitorOptions {
    /** CDP service instance (must be connected) */
    cdpService: CdpService;
    /** Binding name used for CDP Runtime.addBinding. Default: '__cg_domEvent' */
    bindingName?: string;
    /** Debounce interval (ms) for high-frequency mutations. Default: 150 */
    debounceMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BINDING_NAME = '__cg_domEvent';
const DEFAULT_DEBOUNCE_MS = 150;

/**
 * JavaScript to inject into the Antigravity page.
 * Sets up a MutationObserver and calls the binding on relevant changes.
 */
function buildObserverScript(bindingName: string, debounceMs: number): string {
    return `(() => {
    // Guard: do not double-install
    if (window.__cg_observer_installed) return JSON.stringify({ ok: true, skipped: true });

    const BINDING = '${bindingName}';
    const DEBOUNCE_MS = ${debounceMs};

    // Resolve observation root
    const panel = document.querySelector('.antigravity-agent-side-panel') || document.body;

    // --- Classification helpers ---
    const isStopButton = (node) => {
        if (!node || !node.querySelector) return false;
        // tooltip-id based detection
        if (node.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]')) return true;
        // text-based detection
        const buttons = node.querySelectorAll ? node.querySelectorAll('button, [role="button"]') : [];
        for (const btn of buttons) {
            const label = (btn.textContent || '').trim().toLowerCase();
            if (/^stop(\\s|$)/i.test(label) || label === '停止' || label === '生成を停止') return true;
        }
        return false;
    };

    const isDialog = (node) => {
        if (!node || !node.matches) return false;
        return node.matches('[role="dialog"]') || node.closest?.('[role="dialog"]');
    };

    const isRenderedMarkdown = (node) => {
        if (!node || !node.matches) return false;
        return node.matches('.rendered-markdown, .prose, [class*="assistant-message"], [class*="message-content"], [class*="markdown-body"], .leading-relaxed.select-text')
            || node.closest?.('.rendered-markdown, .prose, [class*="assistant-message"], [class*="message-content"]');
    };

    // --- Debounced dispatcher ---
    let pendingTypes = new Set();
    let debounceTimer = null;

    function flush() {
        if (pendingTypes.size === 0) return;
        const types = Array.from(pendingTypes);
        pendingTypes.clear();
        debounceTimer = null;

        for (const type of types) {
            try {
                window[BINDING](JSON.stringify({ type, ts: Date.now() }));
            } catch (e) {
                // binding may not be available (page navigated, etc.)
            }
        }
    }

    function enqueue(type) {
        pendingTypes.add(type);
        if (!debounceTimer) {
            debounceTimer = setTimeout(flush, DEBOUNCE_MS);
        }
    }

    // --- MutationObserver ---
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            // Added nodes
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue; // Element nodes only

                if (isDialog(node)) {
                    enqueue('dialog-appeared');
                    continue;
                }
                if (isStopButton(node)) {
                    enqueue('stop-button');
                    continue;
                }
                if (isRenderedMarkdown(node)) {
                    enqueue('content-change');
                    continue;
                }

                // Check children (shallow) for stop button or content
                if (node.querySelector) {
                    if (node.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]')) {
                        enqueue('stop-button');
                    }
                    if (node.querySelector('.rendered-markdown, .prose, [class*="assistant-message"]')) {
                        enqueue('content-change');
                    }
                    if (node.querySelector('[role="dialog"]')) {
                        enqueue('dialog-appeared');
                    }
                }
            }

            // Removed nodes (stop button disappearing = generation complete signal)
            for (const node of mutation.removedNodes) {
                if (node.nodeType !== 1) continue;
                if (isStopButton(node)) {
                    enqueue('stop-button');
                }
            }

            // Character data changes in text content
            if (mutation.type === 'characterData') {
                const parent = mutation.target.parentElement;
                if (parent && isRenderedMarkdown(parent)) {
                    enqueue('content-change');
                }
            }
        }
    });

    observer.observe(panel, {
        childList: true,
        subtree: true,
        characterData: true,
    });

    window.__cg_observer_installed = true;
    window.__cg_observer_cleanup = () => {
        observer.disconnect();
        window.__cg_observer_installed = false;
        if (debounceTimer) clearTimeout(debounceTimer);
    };

    return JSON.stringify({ ok: true, root: panel.tagName, rootClasses: (panel.className || '').toString().slice(0, 80) });
})()`;
}

// ---------------------------------------------------------------------------
// DomMutationMonitor
// ---------------------------------------------------------------------------

export class DomMutationMonitor extends EventEmitter {
    private readonly cdpService: CdpService;
    private readonly bindingName: string;
    private readonly debounceMs: number;
    private isInstalled: boolean = false;
    private isListening: boolean = false;
    private bindingHandler: ((params: any) => void) | null = null;

    constructor(options: DomMutationMonitorOptions) {
        super();
        this.cdpService = options.cdpService;
        this.bindingName = options.bindingName ?? DEFAULT_BINDING_NAME;
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    }

    /**
     * Install the MutationObserver and start listening for events.
     * Safe to call multiple times (idempotent).
     *
     * @returns true if installation succeeded
     */
    async install(): Promise<boolean> {
        if (this.isInstalled && this.isListening) return true;

        try {
            // Step 1: Add the binding so the page can call us
            await this.cdpService.call('Runtime.addBinding', {
                name: this.bindingName,
            });
            logger.debug(`[DomMutationMonitor] Binding '${this.bindingName}' added`);
        } catch (err: any) {
            // Binding may already exist from a previous install — that's OK
            if (!err?.message?.includes('already exists') && !err?.message?.includes('Binding already exists')) {
                logger.warn(`[DomMutationMonitor] Runtime.addBinding failed:`, err?.message || err);
                return false;
            }
        }

        // Step 2: Listen for binding calls from the page
        if (!this.isListening) {
            this.bindingHandler = (params: any) => {
                if (params?.name !== this.bindingName) return;
                this.handleBindingCall(params.payload);
            };
            this.cdpService.on('Runtime.bindingCalled', this.bindingHandler);
            this.isListening = true;
        }

        // Step 3: Inject the observer script
        try {
            const contextId = this.cdpService.getPrimaryContextId?.();
            const evalParams: Record<string, unknown> = {
                expression: buildObserverScript(this.bindingName, this.debounceMs),
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null && contextId !== undefined) {
                evalParams.contextId = contextId;
            }

            const result = await this.cdpService.call('Runtime.evaluate', evalParams);
            const value = result?.result?.value;

            if (value) {
                try {
                    const parsed = JSON.parse(value);
                    if (parsed.ok) {
                        this.isInstalled = true;
                        if (parsed.skipped) {
                            logger.debug('[DomMutationMonitor] Observer already installed (skipped)');
                        } else {
                            logger.info(`[DomMutationMonitor] Observer installed — root=${parsed.root} classes="${parsed.rootClasses}"`);
                        }
                        return true;
                    }
                } catch {
                    // Parse error — treat as failure
                }
            }

            logger.warn('[DomMutationMonitor] Observer injection returned unexpected value:', value);
            return false;
        } catch (err: any) {
            logger.error('[DomMutationMonitor] Observer injection failed:', err?.message || err);
            return false;
        }
    }

    /**
     * Uninstall the observer and stop listening.
     */
    async uninstall(): Promise<void> {
        // Remove CDP event listener
        if (this.bindingHandler) {
            this.cdpService.removeListener('Runtime.bindingCalled', this.bindingHandler);
            this.bindingHandler = null;
            this.isListening = false;
        }

        // Cleanup observer in the page
        if (this.isInstalled) {
            try {
                const contextId = this.cdpService.getPrimaryContextId?.();
                const evalParams: Record<string, unknown> = {
                    expression: `(() => {
                        if (typeof window.__cg_observer_cleanup === 'function') {
                            window.__cg_observer_cleanup();
                            return { ok: true };
                        }
                        return { ok: false, reason: 'no cleanup function' };
                    })()`,
                    returnByValue: true,
                };
                if (contextId !== null && contextId !== undefined) {
                    evalParams.contextId = contextId;
                }
                await this.cdpService.call('Runtime.evaluate', evalParams);
            } catch {
                // Best-effort cleanup
            }
            this.isInstalled = false;
        }

        // Remove the binding
        try {
            await this.cdpService.call('Runtime.removeBinding', {
                name: this.bindingName,
            });
        } catch {
            // Best-effort
        }

        this.removeAllListeners();
        logger.debug('[DomMutationMonitor] Uninstalled');
    }

    /** Whether the observer is currently installed and listening */
    get active(): boolean {
        return this.isInstalled && this.isListening;
    }

    /**
     * Re-install the observer (e.g. after page navigation or CDP reconnect).
     */
    async reinstall(): Promise<boolean> {
        this.isInstalled = false;
        return this.install();
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private handleBindingCall(payload: string): void {
        try {
            const event = JSON.parse(payload);
            const type: DomEventType = event.type || 'unknown';
            const mutationEvent: DomMutationEvent = {
                type,
                timestamp: event.ts || Date.now(),
                detail: event.detail,
            };

            this.emit('mutation', mutationEvent);
            this.emit(type, mutationEvent);
        } catch (err) {
            logger.warn('[DomMutationMonitor] Failed to parse binding payload:', payload);
        }
    }
}
