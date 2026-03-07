import { CdpService } from './cdpService';

/** Session list item from the side panel */
export interface SessionListItem {
    /** Conversation title */
    title: string;
    /** Whether this is the currently active session */
    isActive: boolean;
}

/** Chat session information */
export interface ChatSessionInfo {
    /** Current chat title (if available) */
    title: string;
    /** Whether an active chat exists */
    hasActiveChat: boolean;
}

export interface ConversationHistoryEntry {
    /** Speaker role in the conversation */
    role: 'user' | 'assistant';
    /** Plain-text message body */
    text: string;
}

/** Script to get the state of the new chat button */
const GET_NEW_CHAT_BUTTON_SCRIPT = `(() => {
    const btn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
    if (!btn) return { found: false };
    const cursor = window.getComputedStyle(btn).cursor;
    const rect = btn.getBoundingClientRect();
    return {
        found: true,
        enabled: cursor === 'pointer',
        cursor,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
    };
})()`;

/**
 * Script to get the chat title from the Cascade panel header.
 * The title element is a div with the text-ellipsis class inside the header.
 */
const GET_CHAT_TITLE_SCRIPT = `(() => {
    const panel = document.querySelector('.antigravity-agent-side-panel');
    if (!panel) return { title: '', hasActiveChat: false };
    const header = panel.querySelector('div[class*="border-b"]');
    if (!header) return { title: '', hasActiveChat: false };
    const titleEl = header.querySelector('div[class*="text-ellipsis"]');
    const title = titleEl ? (titleEl.textContent || '').trim() : '';
    // "Agent" is the default empty chat title
    const hasActiveChat = title.length > 0 && title !== 'Agent';
    return { title: title || '(Untitled)', hasActiveChat };
})()`;

/**
 * Script to find the Past Conversations button and return its coordinates.
 * We use coordinates so that the actual click is done via CDP Input.dispatchMouseEvent,
 * which works reliably in Electron (DOM .click() can be ignored).
 *
 * Returns: { found: boolean, x: number, y: number }
 */
const FIND_PAST_CONVERSATIONS_BUTTON_SCRIPT = `(() => {
    const isVisible = (el) => !!el && el instanceof HTMLElement && el.offsetParent !== null;
    const getRect = (el) => {
        const rect = el.getBoundingClientRect();
        return { found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    };

    // Strategy 1 (primary): data-past-conversations-toggle attribute
    const toggle = document.querySelector('[data-past-conversations-toggle]');
    if (toggle && isVisible(toggle)) return getRect(toggle);

    // Strategy 2: data-tooltip-id containing "history"
    const tooltipEls = Array.from(document.querySelectorAll('[data-tooltip-id]'));
    for (const el of tooltipEls) {
        if (!isVisible(el)) continue;
        const tid = (el.getAttribute('data-tooltip-id') || '').toLowerCase();
        if (tid.includes('history') || tid.includes('past-conversations')) {
            return getRect(el);
        }
    }

    // Strategy 3: SVG with lucide-history class
    const icons = Array.from(document.querySelectorAll('svg.lucide-history, svg[class*="lucide-history"]'));
    for (const icon of icons) {
        const parent = icon.closest('a, button, [role="button"], div[class*="cursor-pointer"]');
        const target = parent instanceof HTMLElement && isVisible(parent) ? parent : icon;
        if (isVisible(target)) return getRect(target);
    }

    return { found: false, x: 0, y: 0 };
})()`;

/**
 * Script to scrape session items from the open Past Conversations panel.
 * Expects the panel to already be visible.
 *
 * Returns: { sessions: SessionListItem[] }
 */
const SCRAPE_PAST_CONVERSATIONS_SCRIPT = `(() => {
    const isVisible = (el) => !!el && el instanceof HTMLElement && el.offsetParent !== null;
    const normalize = (text) => (text || '').trim();

    // Past Conversations opens as a floating QuickInput dialog, not inside the side panel.
    // Try the visible QuickInput dialog first, then fall back to the side panel.
    const quickInputPanels = Array.from(document.querySelectorAll('div[class*="bg-quickinput-background"]'));
    const panel = quickInputPanels.find((el) => isVisible(el))
        || document.querySelector('.antigravity-agent-side-panel');
    if (!panel) return null;

    const items = [];
    const seen = new Set();

    // Detect the "Other Conversations" section boundary.
    // Sessions below this header belong to other projects and must be excluded.
    let boundaryTop = Infinity;
    const headerCandidates = panel.querySelectorAll('div[class*="text-xs"]');
    for (const el of headerCandidates) {
        if (!isVisible(el)) continue;
        const t = normalize(el.textContent || '');
        if (/^Other\\s+Conversations?$/i.test(t)) {
            boundaryTop = el.getBoundingClientRect().top;
            break;
        }
    }

    // Each session row is a div with cursor-pointer
    const rows = Array.from(panel.querySelectorAll('div[class*="cursor-pointer"]'));
    for (const row of rows) {
        if (!isVisible(row)) continue;
        if (!row.querySelector('span.text-sm')) continue;
        // Skip rows that are below the "Other Conversations" boundary
        if (row.getBoundingClientRect().top >= boundaryTop) continue;
        // Find the session title — nested span within the row
        const spans = Array.from(row.querySelectorAll('span.text-sm span, span.text-sm'));
        let title = '';
        for (const span of spans) {
            const t = normalize(span.textContent || '');
            // Skip timestamp labels like "1 hr ago", "7 mins ago"
            if (/^\\d+\\s+(min|hr|hour|day|sec|week|month|year)s?\\s+ago$/i.test(t)) continue;
            // Skip very short or action-like labels
            if (t.length < 2 || t.length > 200) continue;
            if (/^(show\\s+\\d+\\s+more|new|past|history|settings|close|menu|running\\s+in|recent\\s+in|other\\s+conversations?)\\b/i.test(t)) continue;
            title = t;
            break;
        }
        if (!title || seen.has(title)) continue;
        seen.add(title);
        // Detect if this is the active/current session (has focusBackground class)
        const isActive = /focusBackground/i.test(row.className || '');
        items.push({ title, isActive });
    }
    return { sessions: items };
})()`;

/**
 * Script to find the "Show N more..." link and return its coordinates.
 * Returns: { found: boolean, x: number, y: number }
 */
const FIND_SHOW_MORE_BUTTON_SCRIPT = `(() => {
    const isVisible = (el) => !!el && el instanceof HTMLElement && el.offsetParent !== null;
    const quickInputPanels = Array.from(document.querySelectorAll('div[class*="bg-quickinput-background"]'));
    const root = quickInputPanels.find((el) => isVisible(el))
        || document.querySelector('.antigravity-agent-side-panel')
        || document;
    const els = Array.from(root.querySelectorAll('div, span'));
    for (const el of els) {
        if (!isVisible(el)) continue;
        const text = (el.textContent || '').trim();
        if (/^Show\\s+\\d+\\s+more/i.test(text)) {
            const rect = el.getBoundingClientRect();
            return { found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        }
    }
    return { found: false, x: 0, y: 0 };
})()`;

/**
 * Scrape all currently loaded conversation messages from the active chat.
 * Returns chronological user/assistant messages from the Cascade panel.
 */
const SCRAPE_CONVERSATION_HISTORY_SCRIPT = `(() => {
    const panel = document.querySelector('.antigravity-agent-side-panel');
    const scope = panel || document;
    const isVisible = (el) => !!el && el instanceof HTMLElement && el.offsetParent !== null;
    const normalize = (text) => (text || '').replace(/\\r/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();
    const extractVisibleText = (el) => {
        if (!el || !(el instanceof HTMLElement)) return '';
        const clone = el.cloneNode(true);
        for (const style of Array.from(clone.querySelectorAll('style'))) {
            style.remove();
        }
        return normalize(clone.innerText || clone.textContent || '');
    };
    const shouldSkipAssistant = (el, text, selector) => {
        if (!text) return true;
        if (el.closest('details')) return true;
        if (el.closest('[class*="feedback"], footer')) return true;
        if (el.closest('.notify-user-container')) return true;
        if (el.closest('[role="dialog"]')) return true;
        if (el.querySelector(selector + ' ' + selector)) return true;
        if (el.querySelector(selector) && el.querySelector(selector) !== el) return true;
        const flat = text.toLowerCase().replace(/\\s+/g, ' ');
        if (flat.startsWith('/* copied from remark-github-blockquote-alert/alert.css */')) return true;
        if (flat === 'good bad' || flat === 'good' || flat === 'bad') return true;
        return false;
    };

    const entries = [];

    const userBubbles = Array.from(scope.querySelectorAll(
        '[class*="bg-gray-500/15"][class*="rounded-lg"][class*="select-text"]'
    )).filter((el) => isVisible(el) && !el.querySelector('[class*="bg-gray-500/15"][class*="select-text"]'));

    for (const bubble of userBubbles) {
        const textEl = bubble.querySelector('.whitespace-pre-wrap')
            || bubble.querySelector('[style*="word-break"]');
        const text = extractVisibleText(textEl instanceof HTMLElement ? textEl : bubble);
        if (!text) continue;
        entries.push({ node: bubble, role: 'user', text });
    }

    const assistantSelector = [
        '.rendered-markdown',
        '.leading-relaxed.select-text',
        '[data-message-author-role="assistant"]',
        '[data-message-role="assistant"]',
        '[class*="assistant-message"]',
        '[class*="message-content"]',
        '[class*="markdown-body"]',
        '.prose'
    ].join(', ');
    const assistantNodes = Array.from(scope.querySelectorAll(assistantSelector));

    for (const node of assistantNodes) {
        if (!isVisible(node)) continue;
        const text = extractVisibleText(node);
        if (shouldSkipAssistant(node, text, assistantSelector)) continue;
        entries.push({ node, role: 'assistant', text });
    }

    entries.sort((a, b) => {
        if (a.node === b.node) return 0;
        const pos = a.node.compareDocumentPosition(b.node);
        return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });

    return {
        messages: entries.map((entry) => ({
            role: entry.role,
            text: entry.text,
        })),
    };
})()`;

/**
 * Check whether the active chat has conversation content loaded yet.
 * Used after switching to a history session so scraping does not run too early.
 */
const CONVERSATION_HISTORY_READY_SCRIPT = `(() => {
    const panel = document.querySelector('.antigravity-agent-side-panel');
    const scope = panel || document;
    const isVisible = (el) => !!el && el instanceof HTMLElement && el.offsetParent !== null;
    const userCount = Array.from(scope.querySelectorAll('[class*="bg-gray-500/15"][class*="select-text"]'))
        .filter((el) => isVisible(el)).length;
    const assistantCount = Array.from(scope.querySelectorAll('.leading-relaxed.select-text, .rendered-markdown, [data-message-role="assistant"], [data-message-author-role="assistant"]'))
        .filter((el) => isVisible(el)).length;
    return {
        ready: userCount > 0 || assistantCount > 0,
        userCount,
        assistantCount,
    };
})()`;

/**
 * Scroll the active conversation upward to load older messages.
 * Returns whether a scroll container was found and whether it can still scroll.
 */
const LOAD_OLDER_CONVERSATION_HISTORY_SCRIPT = `(() => {
    const panel = document.querySelector('.antigravity-agent-side-panel');
    const scope = panel || document;
    const candidates = [];
    const seen = new Set();
    const consider = (el) => {
        if (!el || !(el instanceof HTMLElement) || seen.has(el)) return;
        seen.add(el);
        if (el.scrollHeight > el.clientHeight + 20) {
            candidates.push(el);
        }
    };

    const anchors = Array.from(scope.querySelectorAll(
        '[class*="bg-gray-500/15"][class*="select-text"], .rendered-markdown, [data-message-role="assistant"], [data-message-author-role="assistant"]'
    ));

    for (const anchor of anchors) {
        let current = anchor instanceof HTMLElement ? anchor : null;
        let depth = 0;
        while (current && depth < 8) {
            consider(current);
            current = current.parentElement;
            depth += 1;
        }
    }
    consider(panel);
    consider(document.scrollingElement);
    consider(document.documentElement);
    consider(document.body);

    if (candidates.length === 0) {
        return { ok: false, error: 'scroll container not found', atTop: true, scrolled: false };
    }

    candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
    const container = candidates[0];
    const before = container.scrollTop;
    const delta = Math.max(Math.round(container.clientHeight * 0.9), 400);
    container.scrollTop = Math.max(0, before - delta);
    container.dispatchEvent(new Event('scroll', { bubbles: true }));

    return {
        ok: true,
        atTop: container.scrollTop <= 0,
        scrolled: container.scrollTop !== before,
    };
})()`;

/**
 * Build a script that activates an existing chat in the side panel by its title.
 * Uses broad selector fallbacks because Antigravity's DOM structure can vary across versions.
 */
function buildActivateChatByTitleScript(title: string): string {
    const safeTitle = JSON.stringify(title);
    return `(() => {
        const wantedRaw = ${safeTitle};
        const wanted = (wantedRaw || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        if (!wanted) return { ok: false, error: 'Empty target title' };

        const panel = document.querySelector('.antigravity-agent-side-panel') || document;
        const normalize = (text) => (text || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => !!el && el instanceof HTMLElement && el.offsetParent !== null;
        const clickTarget = (el) => {
            const clickable = el.closest('button, [role="button"], a, li, [data-testid*="conversation"]') || el;
            if (!(clickable instanceof HTMLElement)) return false;
            clickable.click();
            return true;
        };

        const nodes = Array.from(panel.querySelectorAll('button, [role="button"], a, li, div, span'))
            .filter(isVisible);

        const exact = [];
        const includes = [];
        for (const node of nodes) {
            const text = normalize(node.textContent || '');
            if (!text) continue;
            if (text === wanted) {
                exact.push({ node, textLength: text.length });
            } else if (text.includes(wanted)) {
                includes.push({ node, textLength: text.length });
            }
        }

        const pick = (list) => {
            if (list.length === 0) return null;
            list.sort((a, b) => a.textLength - b.textLength);
            return list[0].node;
        };

        const target = pick(exact) || pick(includes);
        if (!target) return { ok: false, error: 'Chat title not found in side panel' };
        if (!clickTarget(target)) return { ok: false, error: 'Matched element is not clickable' };
        return { ok: true };
    })()`;
}

/**
 * Build a script that opens Past Conversations and selects a conversation by title.
 * This path is required for older chats that are not visible in the current side panel.
 */
function buildActivateViaPastConversationsScript(title: string): string {
    const safeTitle = JSON.stringify(title);
    return `(() => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const wantedRaw = ${safeTitle};
        const normalize = (text) => (text || '')
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[\\u2018\\u2019\\u201C\\u201D'"\`]/g, '')
            .replace(/\\s+/g, ' ')
            .trim();
        const normalizeLoose = (text) => normalize(text).replace(/[^a-z0-9\\u3040-\\u30ff\\u4e00-\\u9faf\\s]/g, '').replace(/\\s+/g, ' ').trim();

        const wanted = normalize(wantedRaw || '');
        const wantedLoose = normalizeLoose(wantedRaw || '');
        if (!wanted) return { ok: false, error: 'Empty target title' };

        const isVisible = (el) => !!el && el instanceof HTMLElement && el.offsetParent !== null;
        const asArray = (nodeList) => Array.from(nodeList || []);
        const getLabelText = (el) => {
            if (!el || !(el instanceof Element)) return '';
            const parts = [
                el.textContent || '',
                el.getAttribute('aria-label') || '',
                el.getAttribute('title') || '',
                el.getAttribute('placeholder') || '',
                el.getAttribute('data-tooltip-content') || '',
                el.getAttribute('data-testid') || '',
            ];
            return parts.filter(Boolean).join(' ');
        };
        const getClickable = (el) => {
            if (!el || !(el instanceof Element)) return null;
            const clickable = el.closest('button, [role="button"], a, li, [role="option"], [data-testid*="conversation"]');
            return clickable instanceof HTMLElement ? clickable : (el instanceof HTMLElement ? el : null);
        };
        const pickBest = (elements, patterns) => {
            const matched = [];
            for (const el of elements) {
                if (!isVisible(el)) continue;
                const text = normalize(getLabelText(el));
                const textLoose = normalizeLoose(getLabelText(el));
                if (!text) continue;
                for (const pattern of patterns) {
                    if (!pattern) continue;
                    const p = normalize(pattern);
                    const pLoose = normalizeLoose(pattern);
                    if (
                        text === p ||
                        text.includes(p) ||
                        (pLoose && (textLoose === pLoose || textLoose.includes(pLoose)))
                    ) {
                        matched.push({ el, score: Math.abs(text.length - pattern.length) });
                        break;
                    }
                }
            }
            if (matched.length === 0) return null;
            matched.sort((a, b) => a.score - b.score);
            return matched[0].el;
        };
        const clickByPatterns = (patterns, selector) => {
            const nodes = asArray(document.querySelectorAll('button, [role="button"], a, li, div, span'));
            const scopedNodes = selector ? asArray(document.querySelectorAll(selector)) : [];
            const source = scopedNodes.length > 0 ? scopedNodes : nodes;
            const target = pickBest(source, patterns);
            const clickable = getClickable(target);
            if (!clickable) return false;
            clickable.click();
            return true;
        };
        const setInputValue = (el, value) => {
            if (!el) return false;
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                el.focus();
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
            if (el instanceof HTMLElement) {
                el.focus();
                if (el.isContentEditable) {
                    el.textContent = value;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                }
            }
            return false;
        };
        const clickIconHistoryButton = () => {
            const iconTargets = asArray(document.querySelectorAll('svg, i, span, div'));
            const patterns = ['history', 'clock', 'conversation', 'past'];
            for (const icon of iconTargets) {
                const descriptor = normalize([
                    icon.getAttribute?.('class') || '',
                    icon.getAttribute?.('data-testid') || '',
                    icon.getAttribute?.('data-icon') || '',
                    icon.getAttribute?.('aria-label') || '',
                    icon.getAttribute?.('title') || '',
                    icon.getAttribute?.('data-tooltip-id') || '',
                ].join(' '));
                if (!descriptor) continue;
                if (!patterns.some((p) => descriptor.includes(p))) continue;
                const clickable = getClickable(icon);
                if (clickable && isVisible(clickable)) {
                    clickable.click();
                    return true;
                }
            }
            return false;
        };
        const openMenuThenClickPast = async () => {
            const openedMenu = clickByPatterns(
                ['more', 'options', 'menu', 'actions', '...', 'ellipsis', '設定', '操作'],
                'button[aria-haspopup], [role="button"][aria-haspopup], button, [role="button"]',
            );
            if (!openedMenu) return false;
            await wait(180);
            return clickByPatterns([
                'past conversations',
                'past conversation',
                'conversation history',
                'past chats',
                '過去の会話',
                'chat history',
            ], '[role="menuitem"], [role="option"], button, [role="button"], li, div, span');
        };
        const pressEnter = (el) => {
            if (!(el instanceof HTMLElement)) return;
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        };
        const findSearchInput = () => {
            const inputs = asArray(document.querySelectorAll('input, textarea, [role="combobox"], [role="searchbox"], [contenteditable="true"]'));
            const strongPatterns = ['select a conversation', 'search conversation', 'search chats', 'search'];
            const placeholders = [];
            for (const el of inputs) {
                if (!isVisible(el)) continue;
                const placeholder = normalize(el.getAttribute('placeholder') || '');
                const ariaLabel = normalize(el.getAttribute('aria-label') || '');
                const text = normalize(getLabelText(el));
                const combined = [placeholder, ariaLabel, text].filter(Boolean).join(' ');
                placeholders.push({ el, combined });
            }
            for (const p of strongPatterns) {
                const found = placeholders.find((x) => x.combined.includes(p));
                if (found) return found.el;
            }
            return placeholders[0]?.el || null;
        };

        return (async () => {
            // Primary: click via data-past-conversations-toggle attribute
            let opened = false;
            const toggleBtn = document.querySelector('[data-past-conversations-toggle]');
            if (toggleBtn && isVisible(toggleBtn)) {
                const clickable = getClickable(toggleBtn);
                if (clickable) { clickable.click(); opened = true; }
            }
            if (!opened) {
                // Fallback: data-tooltip-id containing "history"
                const tooltipEls = asArray(document.querySelectorAll('[data-tooltip-id]'));
                for (const el of tooltipEls) {
                    if (!isVisible(el)) continue;
                    const tid = normalize(el.getAttribute('data-tooltip-id') || '');
                    if (tid.includes('history') || tid.includes('past-conversations')) {
                        const cl = getClickable(el);
                        if (cl) { cl.click(); opened = true; break; }
                    }
                }
            }
            if (!opened) {
                opened = clickByPatterns([
                    'past conversations',
                    'past conversation',
                    'conversation history',
                    'past chats',
                    '過去の会話',
                    'chat history',
                ]);
            }
            if (!opened) {
                opened = clickIconHistoryButton();
            }
            if (!opened) {
                opened = await openMenuThenClickPast();
            }
            if (!opened) {
                return { ok: false, error: 'Past Conversations button not found' };
            }

            await wait(320);

            // In some UI states "Select a conversation" itself is a trigger.
            clickByPatterns(['select a conversation', 'select conversation', 'conversation'], '[role="button"], button, [aria-haspopup], [data-testid*="conversation"]');
            await wait(220);

            const input = findSearchInput();
            if (input) {
                setInputValue(input, wantedRaw);
                await wait(260);
            }

            let selected = clickByPatterns([wanted, wantedLoose], '[role="option"], li, button, [data-testid*="conversation"]');
            if (!selected && input) {
                pressEnter(input);
                await wait(220);
                selected = true;
            }
            if (!selected) {
                return { ok: false, error: 'Conversation not found in Past Conversations' };
            }
            return { ok: true };
        })();
    })()`;
}

/**
 * Service for managing chat sessions on Antigravity via CDP.
 *
 * CDP dependencies are received as method arguments (connection pool compatible).
 */
export class ChatSessionService {
    private static readonly ACTIVATE_SESSION_MAX_WAIT_MS = 30000;
    private static readonly ACTIVATE_SESSION_RETRY_INTERVAL_MS = 800;
    private static readonly LIST_SESSIONS_TARGET = 20;
    private static readonly DEFAULT_HISTORY_MAX_MESSAGES = 500;
    private static readonly DEFAULT_HISTORY_MAX_SCROLL_STEPS = 40;

    /**
     * List recent sessions by opening the Past Conversations panel.
     *
     * Flow (all clicks via CDP Input.dispatchMouseEvent for Electron compatibility):
     *   1. Find Past Conversations button coordinates
     *   2. Click it via CDP mouse events
     *   3. Wait for panel to render
     *   4. Scrape visible sessions
     *   5. If < TARGET sessions, find & click "Show N more..."
     *   6. Re-scrape
     *   7. Close panel with Escape key
     *
     * @param cdpService CdpService instance to use
     * @returns Array of session list items (empty array on failure)
     */
    async listAllSessions(cdpService: CdpService): Promise<SessionListItem[]> {
        let panelOpened = false;
        try {
            // Step 1: Find Past Conversations button
            const btnState = await this.evaluateOnAnyContext(
                cdpService, FIND_PAST_CONVERSATIONS_BUTTON_SCRIPT, false,
            );
            if (!btnState?.found) {
                return [];
            }

            // Step 2: Click via CDP mouse events (reliable in Electron)
            await this.cdpMouseClick(cdpService, btnState.x, btnState.y);
            panelOpened = true;

            // Step 3: Wait for panel to render (poll for content, up to 3s)
            const PANEL_READY_CHECK = `(() => {
                const isVisible = (el) => !!el && el instanceof HTMLElement && el.offsetParent !== null;
                const quickInputPanels = Array.from(document.querySelectorAll('div[class*="bg-quickinput-background"]'));
                const panel = quickInputPanels.find((el) => isVisible(el))
                    || document.querySelector('.antigravity-agent-side-panel');
                if (!panel) return false;
                const rows = Array.from(panel.querySelectorAll('div[class*="cursor-pointer"]'));
                return rows.some((row) =>
                    isVisible(row) && row.querySelector('span.text-sm')
                );
            })()`;
            let panelReady = false;
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                panelReady = Boolean(
                    await this.evaluateOnAnyContext(cdpService, PANEL_READY_CHECK, false),
                );
                if (panelReady) break;
                await new Promise((r) => setTimeout(r, 200));
            }
            if (!panelReady) {
                return [];
            }

            // Step 4: Scrape sessions
            let scrapeResult = await this.evaluateOnAnyContext(
                cdpService, SCRAPE_PAST_CONVERSATIONS_SCRIPT, false,
            );
            let sessions: SessionListItem[] = scrapeResult?.sessions ?? [];

            // Step 5: If fewer than TARGET, click "Show N more..."
            if (sessions.length < ChatSessionService.LIST_SESSIONS_TARGET) {
                const showMoreState = await this.evaluateOnAnyContext(
                    cdpService, FIND_SHOW_MORE_BUTTON_SCRIPT, false,
                );
                if (showMoreState?.found) {
                    await this.cdpMouseClick(cdpService, showMoreState.x, showMoreState.y);
                    await new Promise((r) => setTimeout(r, 500));

                    // Step 6: Re-scrape
                    const expandedScrapeResult = await this.evaluateOnAnyContext(
                        cdpService, SCRAPE_PAST_CONVERSATIONS_SCRIPT, false,
                    );
                    if (Array.isArray(expandedScrapeResult?.sessions) && expandedScrapeResult.sessions.length > 0) {
                        sessions = expandedScrapeResult.sessions;
                    }
                }
            }

            return sessions.slice(0, ChatSessionService.LIST_SESSIONS_TARGET);
        } catch (_) {
            return [];
        } finally {
            if (panelOpened) {
                await this.closePanelWithEscape(cdpService);
            }
        }
    }

    /**
     * Load the active conversation history by repeatedly scrolling upward until
     * no older messages can be discovered or the configured limits are reached.
     */
    async getConversationHistory(
        cdpService: CdpService,
        options?: {
            maxMessages?: number;
            maxScrollSteps?: number;
        },
    ): Promise<{ messages: ConversationHistoryEntry[]; truncated: boolean }> {
        const maxMessages = Math.max(1, options?.maxMessages ?? ChatSessionService.DEFAULT_HISTORY_MAX_MESSAGES);
        const maxScrollSteps = Math.max(0, options?.maxScrollSteps ?? ChatSessionService.DEFAULT_HISTORY_MAX_SCROLL_STEPS);

        await this.waitForConversationHistoryReady(cdpService);
        let messages = await this.scrapeConversationHistory(cdpService);
        let previousCount = messages.length;
        let stagnantSteps = 0;
        let truncated = messages.length >= maxMessages;

        for (let step = 0; step < maxScrollSteps && !truncated; step += 1) {
            const scrollState = await this.evaluateOnAnyContext(
                cdpService,
                LOAD_OLDER_CONVERSATION_HISTORY_SCRIPT,
                false,
            );
            if (!scrollState?.ok) {
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, 350));
            await this.waitForConversationHistoryReady(cdpService, 1500, 150);
            const refreshed = await this.scrapeConversationHistory(cdpService);
            if (refreshed.length > previousCount) {
                messages = refreshed;
                previousCount = refreshed.length;
                stagnantSteps = 0;
                truncated = messages.length >= maxMessages;
                continue;
            }

            stagnantSteps += 1;
            if (scrollState.atTop || stagnantSteps >= 2 || !scrollState.scrolled) {
                break;
            }
        }

        if (messages.length > maxMessages) {
            messages = messages.slice(messages.length - maxMessages);
            truncated = true;
        }

        return { messages, truncated };
    }

    /**
     * Close the Past Conversations panel by sending Escape key events.
     */
    private async closePanelWithEscape(cdpService: CdpService): Promise<void> {
        try {
            await cdpService.call('Input.dispatchKeyEvent', {
                type: 'keyDown', key: 'Escape', code: 'Escape',
                windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
            });
            await cdpService.call('Input.dispatchKeyEvent', {
                type: 'keyUp', key: 'Escape', code: 'Escape',
                windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
            });
        } catch (_) { /* best-effort cleanup */ }
    }

    private async scrapeConversationHistory(
        cdpService: CdpService,
    ): Promise<ConversationHistoryEntry[]> {
        try {
            const result = await this.evaluateOnAnyContext(
                cdpService,
                SCRAPE_CONVERSATION_HISTORY_SCRIPT,
                false,
            );
            if (!Array.isArray(result?.messages)) {
                return [];
            }
            return result.messages.filter((message: any) =>
                (message?.role === 'user' || message?.role === 'assistant')
                && typeof message?.text === 'string'
                && message.text.trim().length > 0,
            );
        } catch (_) {
            return [];
        }
    }

    private async waitForConversationHistoryReady(
        cdpService: CdpService,
        maxWaitMs = 4000,
        pollIntervalMs = 200,
    ): Promise<void> {
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
            const state = await this.evaluateOnAnyContext(
                cdpService,
                CONVERSATION_HISTORY_READY_SCRIPT,
                false,
            );
            if (state?.ready) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
    }

    /**
     * Evaluate a script on the first context that returns a truthy value.
     */
    private async evaluateOnAnyContext(
        cdpService: CdpService,
        expression: string,
        awaitPromise: boolean,
    ): Promise<any> {
        const contexts = cdpService.getContexts();
        for (const ctx of contexts) {
            try {
                const result = await cdpService.call('Runtime.evaluate', {
                    expression, returnByValue: true, awaitPromise, contextId: ctx.id,
                });
                const value = result?.result?.value;
                if (value === undefined || value === null || value === false) continue;
                if (typeof value === 'object' && value !== null) {
                    if ('found' in value && !value.found) continue;
                    if ('ok' in value && !value.ok) continue;
                    if ('ready' in value && !value.ready) continue;
                    if ('messages' in value && Array.isArray(value.messages) && value.messages.length === 0) continue;
                    if ('sessions' in value && Array.isArray(value.sessions) && value.sessions.length === 0) continue;
                }
                return value;
            } catch (_) { /* try next context */ }
        }
        return null;
    }

    /**
     * Click at coordinates via CDP Input.dispatchMouseEvent.
     */
    private async cdpMouseClick(cdpService: CdpService, x: number, y: number): Promise<void> {
        await cdpService.call('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x, y,
        });
        await cdpService.call('Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: 'left', clickCount: 1,
        });
        await cdpService.call('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
        });
    }

    /**
     * Start a new chat session in the Antigravity UI.
     *
     * Strategy:
     *   1. Check the state of the new chat button
     *   2. cursor: not-allowed -> already an empty chat (do nothing)
     *   3. cursor: pointer -> click via Input.dispatchMouseEvent coordinates
     *   4. Button not found -> error
     *
     * @param cdpService CdpService instance to use
     * @returns { ok: true } on success, { ok: false, error: string } on failure
     */
    async startNewChat(cdpService: CdpService): Promise<{ ok: boolean; error?: string }> {
        try {
            // Contexts may be empty right after Antigravity starts.
            // Wait up to 10 seconds for the cascade-panel to become ready.
            let contexts = cdpService.getContexts();
            if (contexts.length === 0) {
                const ready = await cdpService.waitForCascadePanelReady(10000, 500);
                if (!ready) {
                    return { ok: false, error: 'No contexts available (timed out)' };
                }
                contexts = cdpService.getContexts();
            }

            // Get button state (retry waiting for DOM load: up to 5 times, 1 second interval)
            let btnState = await this.getNewChatButtonState(cdpService, contexts);

            if (!btnState.found) {
                const maxRetries = 5;
                for (let i = 0; i < maxRetries && !btnState.found; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    contexts = cdpService.getContexts();
                    btnState = await this.getNewChatButtonState(cdpService, contexts);
                }
            }

            if (!btnState.found) {
                return { ok: false, error: 'New chat button not found' };
            }

            // cursor: not-allowed -> already an empty chat (no need to create new)
            if (!btnState.enabled) {
                return { ok: true };
            }

            // cursor: pointer -> click via CDP Input API coordinates
            await cdpService.call('Input.dispatchMouseEvent', {
                type: 'mouseMoved', x: btnState.x, y: btnState.y,
            });
            await cdpService.call('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: btnState.x, y: btnState.y,
                button: 'left', clickCount: 1,
            });
            await cdpService.call('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: btnState.x, y: btnState.y,
                button: 'left', clickCount: 1,
            });

            // Wait for UI to update after click
            await new Promise(r => setTimeout(r, 1500));

            // Check if button changed to not-allowed (evidence that a new chat was opened)
            const afterState = await this.getNewChatButtonState(cdpService, contexts);
            if (afterState.found && !afterState.enabled) {
                return { ok: true };
            }

            // Button still enabled -> click may not have worked
            return { ok: false, error: 'Clicked new chat button but state did not change' };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: message };
        }
    }

    /**
     * Get the current chat session information.
     * @param cdpService CdpService instance to use
     * @returns Chat session information
     */
    async getCurrentSessionInfo(cdpService: CdpService): Promise<ChatSessionInfo> {
        try {
            const contexts = cdpService.getContexts();
            for (const ctx of contexts) {
                try {
                    const result = await cdpService.call('Runtime.evaluate', {
                        expression: GET_CHAT_TITLE_SCRIPT,
                        returnByValue: true,
                        contextId: ctx.id,
                    });
                    const value = result?.result?.value;
                    if (value && value.title) {
                        return {
                            title: value.title,
                            hasActiveChat: value.hasActiveChat ?? false,
                        };
                    }
                } catch (_) { /* try next context */ }
            }
            return { title: '(Failed to retrieve)', hasActiveChat: false };
        } catch (error) {
            return { title: '(Failed to retrieve)', hasActiveChat: false };
        }
    }

    /**
     * Activate an existing chat by title.
     * Returns ok:false if the target chat cannot be located or verified.
     */
    async activateSessionByTitle(
        cdpService: CdpService,
        title: string,
        options?: {
            maxWaitMs?: number;
            retryIntervalMs?: number;
        },
    ): Promise<{ ok: boolean; error?: string }> {
        if (!title || title.trim().length === 0) {
            return { ok: false, error: 'Session title is empty' };
        }

        const current = await this.getCurrentSessionInfo(cdpService);
        if (current.title.trim() === title.trim()) {
            return { ok: true };
        }

        const maxWaitMs = options?.maxWaitMs ?? ChatSessionService.ACTIVATE_SESSION_MAX_WAIT_MS;
        const retryIntervalMs = options?.retryIntervalMs ?? ChatSessionService.ACTIVATE_SESSION_RETRY_INTERVAL_MS;

        let usedPastConversations = false;
        let directResult: { ok: boolean; error?: string } = { ok: false, error: 'not attempted' };
        let pastResult: { ok: boolean; error?: string } | null = null;
        let clicked = false;
        const startedAt = Date.now();
        let attempts = 0;

        while (Date.now() - startedAt <= maxWaitMs) {
            attempts += 1;
            directResult = await this.tryActivateByDirectSidePanel(cdpService, title);
            clicked = directResult.ok;

            if (!clicked) {
                pastResult = await this.tryActivateByPastConversations(cdpService, title);
                clicked = pastResult.ok;
                usedPastConversations = pastResult.ok;
            }

            if (clicked) {
                break;
            }

            if (Date.now() - startedAt <= maxWaitMs) {
                await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
            }
        }

        if (!clicked) {
            return {
                ok: false,
                error:
                    `Failed to activate session "${title}" ` +
                    `after ${attempts} attempt(s) ` +
                    `(direct: ${directResult.error || 'direct search failed'}; ` +
                    `past: ${pastResult?.error || 'past conversations search failed'})`,
            };
        }

        // Wait briefly for DOM state transition and verify destination chat.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const after = await this.getCurrentSessionInfo(cdpService);
        if (after.title.trim() === title.trim()) {
            return { ok: true };
        }

        // If direct side-panel activation hit the wrong row, try the explicit Past Conversations flow.
        if (!usedPastConversations) {
            const viaPast = await this.tryActivateByPastConversations(cdpService, title);
            if (viaPast.ok) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                const afterPast = await this.getCurrentSessionInfo(cdpService);
                if (afterPast.title.trim() === title.trim()) {
                    return { ok: true };
                }
                return {
                    ok: false,
                    error: `Past Conversations selected a different chat (expected="${title}", actual="${afterPast.title}")`,
                };
            }
            return {
                ok: false,
                error:
                    `Activated chat did not match target title (expected="${title}", actual="${after.title}") ` +
                    `and Past Conversations fallback failed (${viaPast.error || 'unknown'})`,
            };
        }

        return {
            ok: false,
            error: `Activated chat did not match target title (expected="${title}", actual="${after.title}")`,
        };
    }

    private async tryActivateByDirectSidePanel(
        cdpService: CdpService,
        title: string,
    ): Promise<{ ok: boolean; error?: string }> {
        return this.tryActivateWithScript(cdpService, buildActivateChatByTitleScript(title), false);
    }

    private async tryActivateByPastConversations(
        cdpService: CdpService,
        title: string,
    ): Promise<{ ok: boolean; error?: string }> {
        return this.tryActivateWithScript(cdpService, buildActivateViaPastConversationsScript(title), true);
    }

    private async tryActivateWithScript(
        cdpService: CdpService,
        script: string,
        awaitPromise: boolean,
    ): Promise<{ ok: boolean; error?: string }> {
        const contexts = cdpService.getContexts();
        let lastError = 'Activation script returned no match';
        for (const ctx of contexts) {
            try {
                const result = await cdpService.call('Runtime.evaluate', {
                    expression: script,
                    returnByValue: true,
                    awaitPromise,
                    contextId: ctx.id,
                });
                const value = result?.result?.value;
                if (value?.ok) {
                    return { ok: true };
                }
                if (value?.error && typeof value.error === 'string') {
                    lastError = value.error;
                }
            } catch (error: unknown) {
                lastError = error instanceof Error ? error.message : String(error);
            }
        }
        return { ok: false, error: lastError };
    }

    /**
     * Get the state (enabled/disabled, coordinates) of the new chat button.
     */
    private async getNewChatButtonState(
        cdpService: CdpService,
        contexts: { id: number; name: string; url: string }[],
    ): Promise<{ found: boolean; enabled: boolean; x: number; y: number }> {
        for (const ctx of contexts) {
            try {
                const res = await cdpService.call('Runtime.evaluate', {
                    expression: GET_NEW_CHAT_BUTTON_SCRIPT,
                    returnByValue: true,
                    contextId: ctx.id,
                });
                const value = res?.result?.value;
                if (value?.found) {
                    return { found: true, enabled: value.enabled, x: value.x, y: value.y };
                }
            } catch (_) { /* try next context */ }
        }
        return { found: false, enabled: false, x: 0, y: 0 };
    }
}
