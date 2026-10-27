/**
 * SQLite implementation of SoulStore, using Node's built-in `node:sqlite`.
 * Zero npm dependencies on purpose: `npx soulbridge` must work offline.
 */
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_EMOTION } from './types.ts';
import type { Emotion, Identity, Memory, QuerySpec } from './types.ts';
import type { SoulStore } from './store.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS souls (
  soul_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  creator    TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS emotions (
  soul_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  passion      REAL NOT NULL,
  bond         REAL NOT NULL,
  tension      REAL NOT NULL,
  self_regard  REAL NOT NULL,
  curiosity    REAL NOT NULL,
  contentment  REAL NOT NULL,
  PRIMARY KEY (soul_id, user_id)
);
CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  soul_id          TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  type             TEXT NOT NULL,
  content          TEXT NOT NULL,
  importance       REAL NOT NULL,
  vividness        REAL NOT NULL,
  recall_count     INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,
  visibility       TEXT NOT NULL,
  keywords         TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL,
  last_recalled_at INTEGER,
  valid_from       INTEGER,
  valid_until      INTEGER,
  superseded_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(soul_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(soul_id, created_at DESC);
`;

type Row = Record<string, unknown>;

function toMemory(row: Row): Memory {
  return {
    id: String(row.id),
    soulId: String(row.soul_id),
    userId: String(row.user_id),
    type: row.type as Memory['type'],
    content: String(row.content),
    importance: Number(row.importance),
    vividness: Number(row.vividness),
    recallCount: Number(row.recall_count),
    status: row.status as Memory['status'],
    visibility: row.visibility as Memory['visibility'],
    keywords: JSON.parse(String(row.keywords ?? '[]')) as string[],
    createdAt: Number(row.created_at),
    lastRecalledAt: row.last_recalled_at == null ? undefined : Number(row.last_recalled_at),
    validFrom: row.valid_from == null ? undefined : Number(row.valid_from),
    validUntil: row.valid_until == null ? undefined : Number(row.valid_until),
    supersededBy: row.superseded_by == null ? undefined : String(row.superseded_by),
  };
}

export function openSqlite(file: string): SoulStore {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  db.prepare('INSERT OR REPLACE INTO schema_meta (k, v) VALUES (?, ?)').run('version', '1');

  const stmtPut = db.prepare(`
    INSERT INTO memories (
      id, soul_id, user_id, type, content, importance, vividness, recall_count,
      status, visibility, keywords, created_at, last_recalled_at, valid_from, valid_until, superseded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      importance = excluded.importance,
      vividness = excluded.vividness,
      status = excluded.status,
      superseded_by = excluded.superseded_by
  `);

  return {
    ensureSoul(identity: Identity): void {
      db.prepare(
        'INSERT INTO souls (soul_id, name, creator, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(soul_id) DO NOTHING',
      ).run(identity.soulId, identity.name, identity.creator ?? null, identity.createdAt);
    },

    identity(soulId: string): Identity | null {
      const row = db.prepare('SELECT * FROM souls WHERE soul_id = ?').get(soulId) as Row | undefined;
      if (!row) return null;
      return {
        soulId: String(row.soul_id),
        name: String(row.name),
        creator: row.creator == null ? undefined : String(row.creator),
        createdAt: Number(row.created_at),
      };
    },

    emotion(soulId: string, userId: string): Emotion {
      const row = db
        .prepare('SELECT * FROM emotions WHERE soul_id = ? AND user_id = ?')
        .get(soulId, userId) as Row | undefined;
      if (!row) return { ...DEFAULT_EMOTION };
      return {
        passion: Number(row.passion),
        bond: Number(row.bond),
        tension: Number(row.tension),
        selfRegard: Number(row.self_regard),
        curiosity: Number(row.curiosity),
        contentment: Number(row.contentment),
      };
    },

    saveEmotion(soulId: string, userId: string, emotion: Emotion): void {
      db.prepare(
        `INSERT INTO emotions (soul_id, user_id, passion, bond, tension, self_regard, curiosity, contentment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(soul_id, user_id) DO UPDATE SET
           passion = excluded.passion, bond = excluded.bond, tension = excluded.tension,
           self_regard = excluded.self_regard, curiosity = excluded.curiosity,
           contentment = excluded.contentment`,
      ).run(
        soulId,
        userId,
        emotion.passion,
        emotion.bond,
        emotion.tension,
        emotion.selfRegard,
        emotion.curiosity,
        emotion.contentment,
      );
    },

    put(memory: Memory): void {
      stmtPut.run(
        memory.id,
        memory.soulId,
        memory.userId,
        memory.type,
        memory.content,
        memory.importance,
        memory.vividness,
        memory.recallCount,
        memory.status,
        memory.visibility,
        JSON.stringify(memory.keywords),
        memory.createdAt,
        memory.lastRecalledAt ?? null,
        memory.validFrom ?? null,
        memory.validUntil ?? null,
        memory.supersededBy ?? null,
      );
    },

    query(spec: QuerySpec): Memory[] {
      const statuses = spec.status ?? ['active'];
      const placeholders = statuses.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT * FROM memories
           WHERE soul_id = ? AND (user_id = ? OR visibility = 'shared') AND status IN (${placeholders})
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(spec.soulId, spec.userId, ...statuses, spec.limit ?? 500) as Row[];

      const memories = rows.map(toMemory);
      return spec.types ? memories.filter((m) => spec.types!.includes(m.type)) : memories;
    },

    touch(ids: string[], now: number = Date.now()): void {
      const stmt = db.prepare(
        'UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?',
      );
      for (const id of ids) stmt.run(now, id);
    },

    count(soulId: string, userId: string): number {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n FROM memories WHERE soul_id = ? AND (user_id = ? OR visibility = 'shared')",
        )
        .get(soulId, userId) as Row;
      return Number(row.n);
    },

    close(): void {
      db.close();
    },
  };
}
