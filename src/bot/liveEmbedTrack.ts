/**
 * LiveEmbedTrack — manages a track of live-updating Discord/Telegram messages.
 *
 * Replaces the duplicated upsertLiveResponseEmbeds / upsertLiveActivityEmbeds closures
 * with a reusable, testable class.
 */
import { EmbedBuilder } from 'discord.js';
import { formatForDiscord } from '../utils/discordFormatter';
import { splitPlainText } from '../utils/plainTextFormatter';
import type { OutputFormat } from '../database/userPreferenceRepository';

export interface LiveEmbedTrackOptions {
    /** Maximum description length for embed descriptions */
    maxDescriptionLen: number;
    /** Function to build description chunks from raw text */
    buildDescriptions: (text: string) => string[];
    /** Serial task queue for this track */
    enqueue: (task: () => Promise<void>, label?: string) => Promise<void>;
}

export class LiveEmbedTrack {
    private messages: any[] = [];
    private lastRenderKey = '';
    private _version = 0;

    constructor(private readonly opts: LiveEmbedTrackOptions) {}

    get version(): number {
        return this._version;
    }

    bumpVersion(): number {
        this._version += 1;
        return this._version;
    }

    async upsert(
        channel: any,
        outputFormat: OutputFormat,
        isFinalized: boolean,
        title: string,
        rawText: string,
        color: number,
        footerText: string,
        upsertOpts?: {
            source?: string;
            expectedVersion?: number;
            skipWhenFinalized?: boolean;
        },
    ): Promise<void> {
        return this.opts.enqueue(async () => {
            if (upsertOpts?.skipWhenFinalized && isFinalized) return;
            if (upsertOpts?.expectedVersion !== undefined && upsertOpts.expectedVersion !== this._version) return;
            if (!channel) return;

            if (outputFormat === 'plain') {
                const formatted = formatForDiscord((rawText || '').trim());
                const plainContent = `**${title}**\n${formatted}\n_${footerText}_`;
                const plainChunks = splitPlainText(plainContent);
                const renderKey = `${title}|plain|${footerText}|${plainChunks.join('\n<<<PAGE_BREAK>>>\n')}`;
                if (renderKey === this.lastRenderKey && this.messages.length > 0) return;
                this.lastRenderKey = renderKey;

                for (let i = 0; i < plainChunks.length; i++) {
                    if (!this.messages[i]) {
                        this.messages[i] = await channel.send({ content: plainChunks[i] }).catch(() => null);
                        continue;
                    }
                    await this.messages[i].edit({ content: plainChunks[i] }).catch(async () => {
                        this.messages[i] = await channel.send({ content: plainChunks[i] }).catch(() => null);
                    });
                }
                while (this.messages.length > plainChunks.length) {
                    const extra = this.messages.pop();
                    if (!extra) continue;
                    await extra.delete().catch(() => { });
                }
                return;
            }

            const descriptions = this.opts.buildDescriptions(rawText);
            const renderKey = `${title}|${color}|${footerText}|${descriptions.join('\n<<<PAGE_BREAK>>>\n')}`;
            if (renderKey === this.lastRenderKey && this.messages.length > 0) {
                return;
            }
            this.lastRenderKey = renderKey;

            for (let i = 0; i < descriptions.length; i++) {
                const embed = new EmbedBuilder()
                    .setTitle(descriptions.length > 1 ? `${title} (${i + 1}/${descriptions.length})` : title)
                    .setDescription(descriptions[i])
                    .setColor(color)
                    .setFooter({ text: footerText })
                    .setTimestamp();

                if (!this.messages[i]) {
                    this.messages[i] = await channel.send({ embeds: [embed] }).catch(() => null);
                    continue;
                }

                await this.messages[i].edit({ embeds: [embed] }).catch(async () => {
                    this.messages[i] = await channel.send({ embeds: [embed] }).catch(() => null);
                });
            }

            // Delete excess messages if page count decreased
            while (this.messages.length > descriptions.length) {
                const extra = this.messages.pop();
                if (!extra) continue;
                await extra.delete().catch(() => { });
            }
        }, `upsert:${upsertOpts?.source ?? 'unknown'}`);
    }
}
