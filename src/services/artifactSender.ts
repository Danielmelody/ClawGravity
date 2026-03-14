/**
 * Artifact Sender — extracts artifact files from trajectory steps
 * and sends them as expandable inline messages in Telegram.
 *
 * Uses Telegram's `<blockquote expandable>` tag so users can tap
 * to expand and read the full content directly in chat — no external
 * viewer needed.
 *
 * For very large artifacts (>3500 chars), the content is truncated
 * with a note and the full file is also sent as a document attachment.
 *
 * Pure extraction + effectful send, cleanly separated.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { escapeHtml, markdownToTelegramHtml } from './trajectoryStepRenderer';
import { splitTelegramText } from '../platform/telegram/telegramDeliveryPipeline';
import type { PlatformChannel } from '../platform/types';
import type { TelegramBotLike } from '../platform/telegram/wrappers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedArtifact {
    /** Absolute file path on disk. */
    readonly filePath: string;
    /** Display name (file basename). */
    readonly name: string;
    /** Brief description from ArtifactMetadata.Summary, if available. */
    readonly summary: string;
    /** Artifact type from ArtifactMetadata.ArtifactType. */
    readonly artifactType: string;
}

/** Max chars for inline expandable content before falling back to document. */
const INLINE_MAX_CHARS = 3500;

// ---------------------------------------------------------------------------
// Pure extraction
// ---------------------------------------------------------------------------

/**
 * Extract artifact file paths from trajectory steps.
 *
 * Scans for `write_to_file` tool calls that have `IsArtifact: true`
 * in their arguments. Works with both:
 *   - CORTEX_STEP_TYPE_PLANNER_RESPONSE (toolCalls[].argumentsJson)
 *   - CORTEX_STEP_TYPE_CODE_ACTION (metadata.toolCall.argumentsJson)
 *
 * PURE FUNCTION — no side effects.
 */
function extractArtifactsFromSteps(steps: unknown[]): ExtractedArtifact[] {
    if (!Array.isArray(steps)) return [];

    const seen = new Set<string>();
    const artifacts: ExtractedArtifact[] = [];

    for (const step of steps) {
        // Path 1: PLANNER_RESPONSE with toolCalls array
        const toolCalls = step?.plannerResponse?.toolCalls;
        if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
                const artifact = extractFromToolCall(tc);
                if (artifact && !seen.has(artifact.filePath)) {
                    seen.add(artifact.filePath);
                    artifacts.push(artifact);
                }
            }
        }

        // Path 2: CODE_ACTION with metadata.toolCall
        const metaTc = step?.metadata?.toolCall;
        if (metaTc) {
            const artifact = extractFromToolCall(metaTc);
            if (artifact && !seen.has(artifact.filePath)) {
                seen.add(artifact.filePath);
                artifacts.push(artifact);
            }
        }
    }

    return artifacts;
}

/** Parse a single tool call and return an ExtractedArtifact if it's an artifact write. */
function extractFromToolCall(tc: unknown): ExtractedArtifact | null {
    const name = (tc?.name || tc?.toolName || tc?.function?.name || '').toLowerCase();
    if (name !== 'write_to_file' && name !== 'writetofile') return null;

    const args = parseToolArgs(tc);
    if (!args) return null;

    // Must have IsArtifact flag set to true
    if (!args.IsArtifact && !args.isArtifact) return null;

    const targetFile = args.TargetFile || args.targetFile;
    if (!targetFile || typeof targetFile !== 'string') return null;

    // Normalize file URI to path (file:///c:/... → c:/...)
    const filePath = targetFile.startsWith('file:///')
        ? targetFile.slice(8).replace(/\//g, path.sep)
        : targetFile;

    const metadata = args.ArtifactMetadata || args.artifactMetadata || {};

    return {
        filePath,
        name: path.basename(filePath),
        summary: typeof metadata.Summary === 'string' ? metadata.Summary : '',
        artifactType: typeof metadata.ArtifactType === 'string' ? metadata.ArtifactType : 'other',
    };
}

/** Parse tool call arguments from JSON string or object. */
function parseToolArgs(tc: unknown): Record<string, unknown> | null {
    const direct = tc?.arguments || tc?.function?.arguments || tc?.input;
    if (direct && typeof direct === 'object') return direct;
    if (typeof direct === 'string' && direct.trim()) {
        try { return JSON.parse(direct); } catch { return null; }
    }
    const json = tc?.argumentsJson;
    if (typeof json === 'string' && json.trim()) {
        try { return JSON.parse(json); } catch { return null; }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Effectful send
// ---------------------------------------------------------------------------

/**
 * Send extracted artifacts as expandable inline messages in Telegram.
 *
 * Strategy:
 *   1. Read the artifact file content from disk
 *   2. Convert markdown → Telegram HTML
 *   3. Wrap in `<blockquote expandable>` so users can tap to expand
 *   4. If content exceeds Telegram's limits, truncate inline + send
 *      full file as document attachment
 */
export async function sendArtifactsToTelegram(
    steps: unknown[],
    channel: PlatformChannel,
    botApi?: TelegramBotLike['api'],
): Promise<void> {
    const artifacts = extractArtifactsFromSteps(steps);
    if (artifacts.length === 0) return;

    const chatId = Number(channel.id);
    if (isNaN(chatId)) return;

    for (const artifact of artifacts) {
        try {
            // Validate file exists
            if (!fs.existsSync(artifact.filePath)) {
                logger.debug(`[ArtifactSender] File not found, skipping: ${artifact.filePath}`);
                continue;
            }

            const stat = fs.statSync(artifact.filePath);
            if (stat.size === 0) {
                logger.debug(`[ArtifactSender] Empty file, skipping: ${artifact.name}`);
                continue;
            }

            // Read file content
            const rawContent = fs.readFileSync(artifact.filePath, 'utf-8');

            // Artifact type icon
            const icon = artifact.artifactType === 'implementation_plan' ? '📋'
                : artifact.artifactType === 'walkthrough' ? '📝'
                : artifact.artifactType === 'task' ? '✅'
                : '📄';

            // Build inline message with expandable blockquote
            const isShort = rawContent.length <= INLINE_MAX_CHARS;
            const displayContent = isShort
                ? rawContent
                : rawContent.slice(0, INLINE_MAX_CHARS) + '\n\n…(truncated)';

            const contentHtml = markdownToTelegramHtml(displayContent);
            const header = `${icon} <b>${escapeHtml(artifact.name)}</b>`;
            const message = `${header}\n<blockquote expandable>${contentHtml}</blockquote>`;

            // Send inline expandable message (may need splitting)
            const chunks = splitTelegramText(message);
            for (const chunk of chunks) {
                await channel.send({ text: chunk }).catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.warn(`[ArtifactSender] Failed to send inline chunk: ${msg}`);
                });
            }

            // For long artifacts, also send the full file as a document
            if (!isShort && botApi?.sendDocument) {
                try {
                    const fileBuffer = fs.readFileSync(artifact.filePath);
                    const { InputFile } = await import('grammy');
                    const inputFile = new InputFile(fileBuffer, artifact.name);
                    await botApi.sendDocument(chatId, inputFile, {
                        caption: `${icon} ${artifact.name} (full document)`,
                    });
                } catch (docErr: unknown) {
                    const msg = docErr instanceof Error ? docErr.message : String(docErr);
                    logger.warn(`[ArtifactSender] Failed to send document fallback: ${msg}`);
                }
            }

            logger.info(`[ArtifactSender] Sent artifact: ${artifact.name} → chat ${chatId} (inline=${isShort})`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[ArtifactSender] Failed to send artifact ${artifact.name}: ${msg}`);
        }
    }
}
