import { Database } from "bun:sqlite";

export interface Sticky {
    channelId: string;
    content: string;
    messageId: string | null;
    nonce: string;
    dirty: number;
    retiring: number;
}

export interface PendingAudit {
    id: string;
    payload: string;
}

const nonce = () => crypto.randomUUID().replaceAll("-", "").slice(0, 25);
const columns = "channel_id AS channelId, content, message_id AS messageId, nonce, dirty, retiring";

export class Store {
    private readonly db: Database;

    constructor(path: string) {
        this.db = new Database(path, { create: true, strict: true });
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS sticky_messages (
                channel_id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                message_id TEXT,
                nonce TEXT NOT NULL,
                dirty INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1)),
                retiring INTEGER NOT NULL DEFAULT 0 CHECK (retiring IN (0, 1))
            ) STRICT;
            CREATE TABLE IF NOT EXISTS audit_outbox (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            ) STRICT;
        `);
    }

    getState(key: string): string | null {
        return (
            this.db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key)
                ?.value ?? null
        );
    }

    setState(key: string, value: string): void {
        this.db
            .query(
                "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .run(key, value);
    }

    getSticky(channelId: string): Sticky | null {
        return this.db
            .query<Sticky, [string]>(`SELECT ${columns} FROM sticky_messages WHERE channel_id = ?`)
            .get(channelId);
    }

    listSticky(): Sticky[] {
        return this.db.query<Sticky, []>(`SELECT ${columns} FROM sticky_messages`).all();
    }

    setSticky(channelId: string, content: string): void {
        this.db
            .query(
                `INSERT INTO sticky_messages (channel_id, content, nonce) VALUES (?, ?, ?)
            ON CONFLICT(channel_id) DO UPDATE SET content = excluded.content, dirty = 1, retiring = 0`,
            )
            .run(channelId, content, nonce());
    }

    markStickyDirty(channelId: string): void {
        this.db
            .query("UPDATE sticky_messages SET dirty = 1 WHERE channel_id = ? AND dirty = 0 AND retiring = 0")
            .run(channelId);
    }

    beginStickySend(channelId: string): void {
        this.db.query("UPDATE sticky_messages SET dirty = 0 WHERE channel_id = ?").run(channelId);
    }

    setStickyMessage(channelId: string, messageId: string): void {
        this.db
            .query("UPDATE sticky_messages SET message_id = ? WHERE channel_id = ?")
            .run(messageId, channelId);
    }

    clearStickyMessage(channelId: string): void {
        this.db
            .query("UPDATE sticky_messages SET message_id = NULL, nonce = ? WHERE channel_id = ?")
            .run(nonce(), channelId);
    }

    retireSticky(channelId: string): void {
        this.db
            .query("UPDATE sticky_messages SET retiring = 1, dirty = 1 WHERE channel_id = ?")
            .run(channelId);
    }

    removeSticky(channelId: string): void {
        this.db.query("DELETE FROM sticky_messages WHERE channel_id = ?").run(channelId);
    }

    enqueueAudit(payloads: string[]): void {
        const insert = this.db.query("INSERT INTO audit_outbox (id, payload) VALUES (?, ?)");
        this.db.transaction(() => {
            for (const payload of payloads) insert.run(nonce(), payload);
        })();
    }

    pendingAudit(limit = 10): PendingAudit[] {
        return this.db
            .query<PendingAudit, [number]>("SELECT id, payload FROM audit_outbox ORDER BY rowid LIMIT ?")
            .all(limit);
    }

    removeAudit(id: string): void {
        this.db.query("DELETE FROM audit_outbox WHERE id = ?").run(id);
    }

    close() {
        this.db.close();
    }
}
