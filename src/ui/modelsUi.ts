import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

import { CdpService } from '../services/cdpService';
import type { MessagePayload, ComponentRow } from '../platform/types';
import {
    createRichContent,
    withTitle,
    withDescription,
    withColor,
    withFooter,
    withTimestamp,
} from '../platform/richContentBuilder';

export interface ModelsUiDeps {
    getCurrentCdp: () => CdpService | null;
    fetchQuota: () => Promise<any[]>;
}

export interface ModelsUiPayload {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
}

/** Normalize a model name for fuzzy matching. */
function normalizeModelName(s: string): string {
    return s.toLowerCase().replace(/[\s\-_]/g, '');
}

/** Resolved quota information for a model. */
interface QuotaResult {
    percent: number | null;
    timeStr: string;
}

/** Match a model name against quota data and compute display values. */
function resolveQuotaInfo(mName: string, quotaData: any[]): QuotaResult | null {
    const nName = normalizeModelName(mName);
    const q = quotaData.find(q => {
        const nLabel = normalizeModelName(q.label);
        const nModel = normalizeModelName(q.model || '');
        return nLabel === nName || nModel === nName
            || nName.includes(nLabel) || nLabel.includes(nName)
            || (nModel && (nName.includes(nModel) || nModel.includes(nName)));
    });
    if (!q || !q.quotaInfo) return null;

    const rem = q.quotaInfo.remainingFraction;
    const resetTime = q.quotaInfo.resetTime ? new Date(q.quotaInfo.resetTime) : null;
    const diffMs = resetTime ? resetTime.getTime() - Date.now() : 0;
    let timeStr = 'Ready';
    if (diffMs > 0) {
        const mins = Math.ceil(diffMs / 60000);
        if (mins < 60) timeStr = `${mins}m`;
        else timeStr = `${Math.floor(mins / 60)}h ${mins % 60}m`;
    }

    const percent = (rem !== undefined && rem !== null) ? Math.round(rem * 100) : null;
    return { percent, timeStr };
}

/** Format a model name with quota info for display. */
function formatQuota(
    mName: string,
    current: boolean,
    quotaData: any[],
    richIcons: boolean = false,
): string {
    if (!mName) return `${current ? '[x]' : '[ ]'} Unknown`;
    const prefix = current ? '[x]' : '[ ]';
    const qi = resolveQuotaInfo(mName, quotaData);
    if (!qi) return `${prefix} ${mName}`;
    if (qi.percent !== null) {
        if (richIcons) {
            let icon = '🟢';
            if (qi.percent <= 20) icon = '🔴';
            else if (qi.percent <= 50) icon = '🟡';
            return `${prefix} ${mName} ${icon} ${qi.percent}% (⏱️ ${qi.timeStr})`;
        }
        return `${prefix} ${mName} ${qi.percent}% (${qi.timeStr})`;
    }
    return richIcons
        ? `${prefix} ${mName} (⏱️ ${qi.timeStr})`
        : `${prefix} ${mName} (${qi.timeStr})`;
}

/**
 * Build a platform-agnostic MessagePayload for model selection UI.
 */
export function buildModelsPayload(
    models: string[],
    currentModel: string | null,
    quotaData: any[],
    defaultModel: string | null = null,
): MessagePayload | null {
    if (models.length === 0) return null;

    const currentModelFormatted = currentModel ? formatQuota(currentModel, true, quotaData) : 'Unknown';
    const defaultLine = defaultModel
        ? `\n**Default:** ⭐ ${defaultModel}`
        : '\n**Default:** Not set';

    const modelLines = models.map(m => {
        const isCurrent = m === currentModel;
        const isDefault = defaultModel != null && m.toLowerCase() === defaultModel.toLowerCase();
        const star = isDefault ? ' ⭐' : '';
        return `${formatQuota(m, isCurrent, quotaData)}${star}`;
    }).join('\n');

    const rc = withTimestamp(
        withFooter(
            withDescription(
                withColor(
                    withTitle(createRichContent(), 'Model Management'),
                    0x5865F2,
                ),
                `**Current Model:**\n${currentModelFormatted}${defaultLine}\n\n` +
                `**Available Models (${models.length})**\n` +
                modelLines,
            ),
            'Latest quota information retrieved',
        ),
    );

    // Use 1 button per row so model names are fully readable on Telegram.
    // Telegram inline keyboard buttons are narrow; 5-per-row truncates names.
    const rows: ComponentRow[] = [];

    for (const mName of models.slice(0, 24)) {
        const safeName = mName.length > 80 ? mName.substring(0, 77) + '...' : mName;
        const isDefault = defaultModel != null && mName.toLowerCase() === defaultModel.toLowerCase();
        const prefix = mName === currentModel ? '✓ ' : '';
        const suffix = isDefault ? ' ⭐' : '';
        rows.push({
            components: [{
                type: 'button',
                customId: `model_btn_${mName}`,
                label: `${prefix}${safeName}${suffix}`,
                style: mName === currentModel ? 'success' : 'secondary',
            }],
        });
    }

    // Default model action buttons
    const defaultBtnRow: ComponentRow = {
        components: defaultModel
            ? [{
                type: 'button',
                customId: 'model_clear_default_btn',
                label: 'Clear Default',
                style: 'danger',
            }]
            : [{
                type: 'button',
                customId: 'model_set_default_btn',
                label: 'Set Current as Default',
                style: 'primary',
            }],
    };
    rows.push(defaultBtnRow);

    rows.push({
        components: [{
            type: 'button',
            customId: 'model_refresh_btn',
            label: 'Refresh',
            style: 'primary',
        }],
    });

    return { richContent: rc, components: rows };
}

/**
 * Build the embed + button components for the models UI.
 * Returns null when CDP is unavailable or no models are found.
 */
export async function buildModelsUI(
    cdp: CdpService,
    fetchQuota: () => Promise<any[]>,
): Promise<ModelsUiPayload | null> {
    const models = await cdp.getUiModels();
    const currentModel = await cdp.getCurrentModel();
    const quotaData = await fetchQuota();

    if (models.length === 0) return null;

    const currentModelFormatted = currentModel ? formatQuota(currentModel, true, quotaData, true) : 'Unknown';

    const embed = new EmbedBuilder()
        .setTitle('Model Management')
        .setColor(0x5865F2)
        .setDescription(`**Current Model:**\n${currentModelFormatted}\n\n` +
            `**Available Models (${models.length})**\n` +
            models.map(m => formatQuota(m, m === currentModel, quotaData, true)).join('\n'),
        )
        .setFooter({ text: 'Latest quota information retrieved' })
        .setTimestamp();

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let currentRow = new ActionRowBuilder<ButtonBuilder>();

    for (const mName of models.slice(0, 24)) {
        if (currentRow.components.length === 5) {
            rows.push(currentRow);
            currentRow = new ActionRowBuilder<ButtonBuilder>();
        }
        const safeName = mName.length > 80 ? mName.substring(0, 77) + '...' : mName;
        currentRow.addComponents(new ButtonBuilder()
            .setCustomId(`model_btn_${mName}`)
            .setLabel(safeName)
            .setStyle(mName === currentModel ? ButtonStyle.Success : ButtonStyle.Secondary),
        );
    }

    if (currentRow.components.length < 5) {
        currentRow.addComponents(new ButtonBuilder()
            .setCustomId('model_refresh_btn')
            .setLabel('Refresh')
            .setStyle(ButtonStyle.Primary),
        );
        rows.push(currentRow);
    } else {
        rows.push(currentRow);
        if (rows.length < 5) {
            const refreshRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId('model_refresh_btn')
                    .setLabel('Refresh')
                    .setStyle(ButtonStyle.Primary),
            );
            rows.push(refreshRow);
        }
    }

    return { embeds: [embed], components: rows };
}

/**
 * Build and send the interactive UI for the /models command
 */
export async function sendModelsUI(
    target: { editReply: (opts: any) => Promise<any> },
    deps: ModelsUiDeps,
): Promise<void> {
    const cdp = deps.getCurrentCdp();
    if (!cdp) {
        await target.editReply({ content: 'Not connected to CDP.' });
        return;
    }

    const payload = await buildModelsUI(cdp, deps.fetchQuota);
    if (!payload) {
        await target.editReply({ content: 'Failed to retrieve model list from Antigravity.' });
        return;
    }

    await target.editReply({ content: '', ...payload });
}
