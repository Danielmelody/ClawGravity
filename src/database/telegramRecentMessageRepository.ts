import Database from 'better-sqlite3';

export interface TelegramRecentMessageRecord {
    id: number;
    chatId: string;
    text: string;
    createdAt?: string;
}

export class TelegramRecentMessageRepository {
    private readonly db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
        this.initialize();
    }

    private initialize(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS telegram_recent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_telegram_recent_messages_chat_id_id
            ON telegram_recent_messages(chat_id, id DESC)
        `);
    }

    public addMessage(chatId: string, text: string): TelegramRecentMessageRecord {
        const normalized = text.trim();
        const result = this.db.prepare(`
            INSERT INTO telegram_recent_messages (chat_id, text)
            VALUES (?, ?)
        `).run(chatId, normalized);

        this.db.prepare(`
            DELETE FROM telegram_recent_messages
            WHERE chat_id = ?
              AND id NOT IN (
                  SELECT id
                  FROM telegram_recent_messages
                  WHERE chat_id = ?
                  ORDER BY id DESC
                  LIMIT 10
              )
        `).run(chatId, chatId);

        return {
            id: result.lastInsertRowid as number,
            chatId,
            text: normalized,
        };
    }

    public getRecentMessages(chatId: string, limit = 2): string[] {
        const rows = this.db.prepare(`
            SELECT text
            FROM telegram_recent_messages
            WHERE chat_id = ?
            ORDER BY id DESC
            LIMIT ?
        `).all(chatId, limit) as Array<{ text: string }>;

        return rows.reverse().map((row) => row.text);
    }
}
