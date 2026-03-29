import Database from 'better-sqlite3';

export interface TelegramSessionRoutingRecord {
    chatId: string;
    cascadeId: string;
    threadId: string | null;
}

export class TelegramSessionRoutingRepository {
    private readonly db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
        this.initialize();
    }

    private initialize(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS telegram_session_routing (
                chat_id TEXT NOT NULL,
                cascade_id TEXT NOT NULL,
                thread_id TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (chat_id, cascade_id)
            )
        `);
    }

    public putRouting(chatId: string, cascadeId: string, threadId: string | null): void {
        const stmt = this.db.prepare(`
            INSERT INTO telegram_session_routing (chat_id, cascade_id, thread_id, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(chat_id, cascade_id) DO UPDATE SET
                thread_id = excluded.thread_id,
                updated_at = excluded.updated_at
        `);
        stmt.run(chatId, cascadeId, threadId);
    }

    public getRouting(chatId: string, cascadeId: string): string | null {
        const row = this.db.prepare(
            'SELECT thread_id FROM telegram_session_routing WHERE chat_id = ? AND cascade_id = ?'
        ).get(chatId, cascadeId) as { thread_id: string | null } | undefined;
        return row ? row.thread_id : null;
    }
    
    public getAllRoutings(): TelegramSessionRoutingRecord[] {
        const rows = this.db.prepare(
            'SELECT chat_id, cascade_id, thread_id FROM telegram_session_routing'
        ).all() as { chat_id: string; cascade_id: string; thread_id: string | null; }[];
        return rows.map(r => ({ chatId: r.chat_id, cascadeId: r.cascade_id, threadId: r.thread_id }));
    }
}
