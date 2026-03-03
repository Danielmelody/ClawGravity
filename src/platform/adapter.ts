/**
 * Platform adapter interface.
 *
 * Each messaging platform (Discord, Telegram, etc.) implements this interface
 * to provide a unified event-driven API for the bot core.
 */

import type {
    PlatformType,
    PlatformChannel,
    PlatformMessage,
    PlatformButtonInteraction,
    PlatformSelectInteraction,
    PlatformCommandInteraction,
} from './types';

// ---------------------------------------------------------------------------
// Adapter events
// ---------------------------------------------------------------------------

export interface PlatformAdapterEvents {
    onReady?: () => void;
    onMessage?: (message: PlatformMessage) => Promise<void>;
    onButtonInteraction?: (interaction: PlatformButtonInteraction) => Promise<void>;
    onSelectInteraction?: (interaction: PlatformSelectInteraction) => Promise<void>;
    onCommandInteraction?: (interaction: PlatformCommandInteraction) => Promise<void>;
    onError?: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface PlatformAdapter {
    /** Which platform this adapter serves. */
    readonly platform: PlatformType;

    /** Start the adapter (connect, login, begin polling/listening). */
    start(events: PlatformAdapterEvents): Promise<void>;

    /** Stop the adapter (disconnect, cleanup). */
    stop(): Promise<void>;

    /** Retrieve a channel by its platform-native ID. Returns null if not found. */
    getChannel(channelId: string): Promise<PlatformChannel | null>;

    /** Return the bot's own user ID on this platform. */
    getBotUserId(): string;
}
