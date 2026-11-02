/** Talk conversations (GH #409), kept on this Mac only, in SQLite: `<userData>/talk/talk.db`.
 *
 *  - conversations: one row each (title, scope, what it follows, its running memory).
 *  - turns: one row per message, ordered by `seq`, the full turn as JSON. Nothing is trimmed:
 *    the owner can scroll back through every chat. Full-text search (FTS5) covers every turn.
 *  - snapshot: the last project contexts seen, so Talk can draw the board at once on launch.
 *  The old `conversations.json` (before the database) is imported once, then renamed.
 *  Electron's built-in `node:sqlite`; writes are synchronous and fast (WAL). */
import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { TalkConversation, TalkSearchHit, TalkSummary, TalkTurn } from '../shared/talk'

export const MAX_CONVERSATIONS = 500
/** turns loaded with a conversation (older ones stay in the database and in search) */
export const MAX_TURNS = 2000

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  scope TEXT,
  watching TEXT NOT NULL DEFAULT '[]',
  memory TEXT,
  memory_upto TEXT
);
CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at DESC);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  who TEXT NOT NULL,
  text TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(text, content='turns', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE OF text ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO turns_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TABLE IF NOT EXISTS snapshot (key TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);
`

interface ConvRow {
  id: string
  title: string
  created_at: string
  updated_at: string
  scope: string | null
  watching: string
  memory: string | null
  memory_upto: string | null
}

function isTurn(t: unknown): t is TalkTurn {
  const r = t as TalkTurn
  return !!r && typeof r.id === 'string' && (r.who === 'you' || r.who === 'orcha') && typeof r.text === 'string'
}

function parse<T>(s: string | null | undefined, d: T): T {
  if (!s) return d
  try {
    return JSON.parse(s) as T
  } catch {
    return d
  }
}

export function summarize(c: TalkConversation): TalkSummary {
  const last = c.turns[c.turns.length - 1]
  return { id: c.id, title: c.title, updatedAt: c.updatedAt, preview: last ? last.text.slice(0, 120) : '' }
}

/** The owner's words → an FTS5 query: every word as a prefix, all required. */
export function ftsQuery(q: string): string | null {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 8)
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null
}

export class TalkStore {
  private db: DatabaseSync

  /** `dir` = `<userData>/talk` (or ':memory:' in tests) */
  constructor(dir: string) {
    if (dir === ':memory:') this.db = new DatabaseSync(':memory:')
    else {
      mkdirSync(dir, { recursive: true })
      this.db = new DatabaseSync(path.join(dir, 'talk.db'))
    }
    this.db.exec(SCHEMA)
    if (dir !== ':memory:') this.importJson(path.join(dir, 'conversations.json'))
  }

  close(): void {
    this.db.close()
  }

  async list(): Promise<TalkSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.updated_at, c.scope,
                (SELECT t.text FROM turns t WHERE t.conversation_id = c.id ORDER BY t.seq DESC LIMIT 1) AS last
           FROM conversations c ORDER BY c.updated_at DESC LIMIT ?`
      )
      .all(MAX_CONVERSATIONS) as { id: string; title: string; updated_at: string; scope: string | null; last: string | null }[]
    return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at, preview: (r.last ?? '').slice(0, 120), scope: r.scope }))
  }

  async get(id: string): Promise<TalkConversation | null> {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConvRow | undefined
    return row ? this.hydrate(row) : null
  }

  private hydrate(row: ConvRow): TalkConversation {
    const turns = (
      this.db
        .prepare('SELECT data FROM (SELECT data, seq FROM turns WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq')
        .all(row.id, MAX_TURNS) as { data: string }[]
    )
      .map((r) => parse<unknown>(r.data, null))
      .filter(isTurn)
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      scope: row.scope,
      watching: parse(row.watching, []),
      memory: row.memory ? { text: row.memory, upto: row.memory_upto ?? '' } : undefined,
      turns
    }
  }

  async put(c: TalkConversation): Promise<TalkConversation> {
    return this.putSync(c)
  }

  private putSync(c: TalkConversation): TalkConversation {
    const db = this.db
    db.exec('BEGIN')
    try {
      db.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, scope, watching, memory, memory_upto)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, scope = excluded.scope,
           watching = excluded.watching, memory = excluded.memory, memory_upto = excluded.memory_upto`
      ).run(c.id, c.title, c.createdAt, c.updatedAt, c.scope, JSON.stringify(c.watching ?? []), c.memory?.text ?? null, c.memory?.upto ?? null)
      const known = new Map(
        (db.prepare('SELECT id, data FROM turns WHERE conversation_id = ?').all(c.id) as { id: string; data: string }[]).map((r) => [r.id, r.data])
      )
      let seq = ((db.prepare('SELECT MAX(seq) AS m FROM turns WHERE conversation_id = ?').get(c.id) as { m: number | null }).m ?? -1) + 1
      const insert = db.prepare('INSERT INTO turns (id, conversation_id, seq, at, who, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      const update = db.prepare('UPDATE turns SET text = ?, data = ? WHERE id = ?')
      for (const t of c.turns) {
        const data = JSON.stringify(t)
        const had = known.get(t.id)
        if (had === undefined) insert.run(t.id, c.id, seq++, t.at, t.who, t.text, data)
        else if (had !== data) update.run(t.text, data, t.id)
      }
      this.trim()
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return c
  }

  /** Keep the newest MAX_CONVERSATIONS (turns go with them). */
  private trim(): void {
    this.db
      .prepare('DELETE FROM conversations WHERE id NOT IN (SELECT id FROM conversations ORDER BY updated_at DESC LIMIT ?)')
      .run(MAX_CONVERSATIONS)
  }

  /** Every conversation that follows work (the watcher reads them). */
  async all(): Promise<TalkConversation[]> {
    return (this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as unknown as ConvRow[]).map((r) => this.hydrate(r))
  }

  /** Conversations that follow at least one task (cheap: no turns). */
  async watchingIds(): Promise<string[]> {
    return (this.db.prepare("SELECT id FROM conversations WHERE watching != '[]'").all() as { id: string }[]).map((r) => r.id)
  }

  /** Forget chats that never got a message (a fresh "New chat" replaces them). */
  async dropEmpty(): Promise<void> {
    this.db.prepare('DELETE FROM conversations WHERE NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id = conversations.id)').run()
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  /** Every message in every chat, newest first. */
  async search(q: string, limit = 40): Promise<TalkSearchHit[]> {
    const fts = ftsQuery(q)
    if (!fts) return []
    const rows = this.db
      .prepare(
        `SELECT t.id AS turn_id, t.conversation_id, t.at, t.who, c.title,
                snippet(turns_fts, 0, char(1), char(2), '…', 14) AS snip
           FROM turns_fts JOIN turns t ON t.rowid = turns_fts.rowid JOIN conversations c ON c.id = t.conversation_id
          WHERE turns_fts MATCH ? ORDER BY t.at DESC LIMIT ?`
      )
      .all(fts, limit) as { turn_id: string; conversation_id: string; at: string; who: string; title: string; snip: string }[]
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      turnId: r.turn_id,
      title: r.title,
      at: r.at,
      who: r.who === 'you' ? 'you' : 'orcha',
      snippet: r.snip
    }))
  }

  snapshot<T>(key: string): { at: number; data: T } | null {
    const r = this.db.prepare('SELECT at, data FROM snapshot WHERE key = ?').get(key) as { at: number; data: string } | undefined
    return r ? { at: r.at, data: parse<T>(r.data, null as T) } : null
  }

  saveSnapshot(key: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO snapshot (key, at, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, data = excluded.data')
      .run(key, Date.now(), JSON.stringify(data))
  }

  /** Conversations from before the database: imported once, the file kept as `.imported`. */
  private importJson(file: string): void {
    if (!existsSync(file)) return
    try {
      const list = (JSON.parse(readFileSync(file, 'utf8')) as { conversations?: unknown }).conversations
      if (Array.isArray(list)) {
        for (const c of list as TalkConversation[]) {
          if (!c || typeof c.id !== 'string' || !Array.isArray(c.turns)) continue
          this.putSync({
            id: c.id,
            title: typeof c.title === 'string' ? c.title : 'New chat',
            createdAt: String(c.createdAt ?? ''),
            updatedAt: String(c.updatedAt ?? c.createdAt ?? ''),
            scope: typeof c.scope === 'string' ? c.scope : null,
            watching: Array.isArray(c.watching) ? c.watching : [],
            turns: c.turns.filter(isTurn)
          })
        }
      }
      renameSync(file, `${file}.imported`)
    } catch (e) {
      console.warn('[orcha-desktop] talk: could not import conversations.json:', e instanceof Error ? e.message : e)
    }
  }
}
