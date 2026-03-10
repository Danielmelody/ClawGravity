import {
    ActionRowBuilder,
    EmbedBuilder,
    StringSelectMenuBuilder,
} from 'discord.js';

import { t } from '../utils/i18n';
import { SessionListItem } from '../services/chatSessionService';

/** Format a timestamp into a concise relative-time string (e.g. "3m ago", "2h ago"). */
function formatRelativeTime(timestampMs: number): string {
    if (!timestampMs) return '';
    const diffMs = Date.now() - timestampMs;
    if (diffMs < 0) return 'just now';
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
}

/** Select menu custom ID for session picker */
export const SESSION_SELECT_ID = 'session_select';

/** Maximum items per select menu (Discord limit) */
const MAX_SELECT_OPTIONS = 25;

/**
 * Check if a customId belongs to the session select menu.
 */
export function isSessionSelectId(customId: string): boolean {
    return customId === SESSION_SELECT_ID;
}

/**
 * Build the session picker UI with a select menu.
 *
 * @param sessions - List of sessions from the side panel
 * @returns Object with embeds and components arrays ready for Discord reply
 */
export function buildSessionPickerUI(
    sessions: SessionListItem[],
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
    const embed = new EmbedBuilder()
        .setTitle(t('🔗 Join Session'))
        .setColor(0x5865F2)
        .setTimestamp();

    if (sessions.length === 0) {
        embed.setDescription(t('No sessions found in the Antigravity side panel.'));
        return { embeds: [embed], components: [] };
    }

    embed.setDescription(t('Select a session to join ({{count}} found)', { count: sessions.length }));

    const pageItems = sessions.slice(0, MAX_SELECT_OPTIONS);

    const options = pageItems.map((session) => {
        const timeStr = session.lastModifiedTime ? formatRelativeTime(session.lastModifiedTime) : '';
        const parts = [
            session.isActive ? t('Current') : '',
            timeStr,
        ].filter(Boolean);
        return {
            label: session.title.slice(0, 100),
            value: session.title.slice(0, 100),
            description: parts.length > 0 ? parts.join(' · ') : undefined,
        };
    });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(SESSION_SELECT_ID)
        .setPlaceholder(t('Select a session...'))
        .addOptions(options);

    const components: ActionRowBuilder<any>[] = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
    ];

    return { embeds: [embed], components };
}
