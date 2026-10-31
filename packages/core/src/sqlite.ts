/**
 * SQLite implementation of SoulStore, using Node's built-in `node:sqlite`.
 * Zero npm dependencies on purpose: `npx soulbridge` must work offline.
 *
 * Schema versioning (ADR 0020): every open checks `schema_meta.schema_version`.
 * Older databases are upgraded in place after a one-off backup; a database
 * from a newer binary is refused instead of being silently written.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_EMOTION } from './types.ts';
import type {
  AffectSignal,
  Correction,
  Emotion,
  Identity,
  Memory,
  QuerySpec,
  SessionSummary,
  TurnPair,
  TurnPairSpec,
  TurnSpec,
  TurnStep,
} from './types.ts';
import type { SoulStore } from './store.ts';
import { bm25, buildCorpusStats, tokenize } from './scoring.ts';

export const SCHEMA_VERSION = 5;
/** How many recent pairs are considered before scoring. Bounded so recall stays O(candidates). */
const RECALL_CANDIDATES = 500;
export const AFFECT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BUSY_TIMEOUT_MS = 5000;
const WRITE_ATTEMPTS = 3;

export class DbNewerThanBinaryError extends Error {
  readonly code = 'DB_NEWER_THAN_BINARY';
  readonly dbVersion: number;

  constructor(dbVersion: number) {
    super(`database schema v${dbVersion} is newer than this binary (v${SCHEMA_VERSION})`);
    this.name = 'DbNewerThanBinaryError';
    this.dbVersion = dbVersion;
  }
}

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
CREATE TABLE IF NOT EXISTS affect_samples (
  soul_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  at         INTEGER NOT NULL,
  analyzer   TEXT NOT NULL,
  dominant   TEXT,
  intensity  REAL NOT NULL,
  valence    REAL NOT NULL,
  arousal    REAL NOT NULL,
  confidence REAL NOT NULL,
  payload    TEXT NOT NULL,
  device_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_affect ON affect_samples(soul_id, user_id, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_affect_unique ON affect_samples(soul_id, user_id, at, analyzer);
CREATE TABLE IF NOT EXISTS corrections (
  id             TEXT PRIMARY KEY,
  soul_id        TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  at             INTEGER NOT NULL,
  user_text      TEXT NOT NULL,
  assistant_text TEXT,
  rule           TEXT,
  device_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_corrections ON corrections(soul_id, user_id, at DESC);
CREATE TABLE IF NOT EXISTS turn_pairs (
  id             TEXT PRIMARY KEY,
  soul_id        TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  turn           INTEGER NOT NULL,
  at             INTEGER NOT NULL,
  user_text      TEXT NOT NULL,
  assistant_text TEXT NOT NULL,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_pairs_scope ON turn_pairs(soul_id, user_id, at DESC);
-- Idempotency: one exchange per (session, turn). A repeat is ignored, not merged.
CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_pairs_turn
  ON turn_pairs(soul_id, user_id, session_id, turn);

-- v5: a turn is the unit of memory; its steps are the shape (briefs/0014).
-- assistant_text stays denormalized so recall keeps one row per turn.
CREATE TABLE IF NOT EXISTS turns (
  id             TEXT PRIMARY KEY,
  soul_id        TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  turn_no        INTEGER NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  user_text      TEXT NOT NULL,
  assistant_text TEXT NOT NULL DEFAULT '',
  outcome        TEXT,
  status         TEXT NOT NULL DEFAULT 'closed',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_scope ON turns(soul_id, user_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_turn
  ON turns(soul_id, user_id, session_id, turn_no);

CREATE TABLE IF NOT EXISTS steps (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id           TEXT NOT NULL,
  idx               INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  text              TEXT,
  tool_name         TEXT,
  tool_args_chars   INTEGER,
  tool_result_chars INTEGER,
  ok                INTEGER,
  at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_turn ON steps(turn_id, idx);
`;

type Row = Record<string, unknown>;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function withRetry<T>(fn: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/locked|busy/i.test(message)) throw error;
      if (attempt < WRITE_ATTEMPTS - 1) sleepSync(50 * 3 ** attempt);
    }
  }
  throw lastError;
}

function readVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT v FROM schema_meta WHERE k = 'schema_version'").get() as Row | undefined;
  if (!row) return 1;
  const version = Number(row.v);
  return Number.isFinite(version) ? version : 1;
}

function setVersion(db: DatabaseSync, version: number): void {
  db.prepare('INSERT OR REPLACE INTO schema_meta (k, v) VALUES (?, ?)').run('schema_version', String(version));
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  return rows.some((row) => String(row.name) === column);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/** v1 → v2: sync-ready columns (updated_at / deleted_at / device_id). */
function upgradeToV2(db: DatabaseSync): void {
  ensureColumn(db, 'memories', 'updated_at', 'INTEGER');
  ensureColumn(db, 'memories', 'deleted_at', 'INTEGER');
  ensureColumn(db, 'emotions', 'updated_at', 'INTEGER');
  db.exec('UPDATE memories SET updated_at = created_at WHERE updated_at IS NULL');
  db.exec('UPDATE emotions SET updated_at = 0 WHERE updated_at IS NULL');
}

/** v2 → v3: corrections evidence table (RFC 0003 phase A). */
function upgradeToV3(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS corrections (
    id             TEXT PRIMARY KEY,
    soul_id        TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    at             INTEGER NOT NULL,
    user_text      TEXT NOT NULL,
    assistant_text TEXT,
    rule           TEXT,
    device_id      TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_corrections ON corrections(soul_id, user_id, at DESC)');
}

/**
 * v3/v4 → v5: turns become the unit of memory (briefs/0014). Existing exchanges
 * are copied across as turns with a single text step, so nothing is lost; the
 * old table stays as a read-only legacy copy.
 */
export function upgradeToV5(db: DatabaseSync): void {
  const hasLegacy = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_pairs'")
    .get() as Row | undefined;
  if (!hasLegacy) return;
  const rows = db.prepare('SELECT * FROM turn_pairs').all() as Row[];
  const insertTurn = db.prepare(
    `INSERT OR IGNORE INTO turns
       (id, soul_id, user_id, session_id, turn_no, started_at, ended_at,
        user_text, assistant_text, outcome, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'closed', ?)`,
  );
  const insertStep = db.prepare(
    "INSERT INTO steps (turn_id, idx, kind, text, at) VALUES (?, 0, 'text', ?, ?)",
  );
  for (const row of rows) {
    const id = String(row.id);
    const assistant = String(row.assistant_text ?? '');
    insertTurn.run(
      id,
      String(row.soul_id),
      String(row.user_id),
      String(row.session_id),
      Number(row.turn),
      Number(row.at),
      Number(row.at),
      String(row.user_text),
      assistant,
      Number(row.created_at),
    );
    if (assistant.length > 0) insertStep.run(id, assistant, Number(row.at));
  }
}

/**
 * Copy the database aside before a schema upgrade.
 *
 * In WAL mode the most recent commits can live in the `-wal` sidecar, so a copy
 * of the main file alone can be missing data exactly when it matters. Checkpoint
 * first (TRUNCATE moves the WAL back into the main file and empties it), then
 * copy. Exported for the upgrade test.
 */
export function backupBeforeUpgrade(db: DatabaseSync, file: string, from: number): void {
  if (file === ':memory:' || !existsSync(file)) return;
  const backup = `${file}.bak-v${from}`;
  if (existsSync(backup)) return;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  copyFileSync(file, backup);
}

export function openSqlite(file: string): SoulStore {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  db.exec(SCHEMA);

  const version = readVersion(db);
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new DbNewerThanBinaryError(version);
  }
  if (version < SCHEMA_VERSION) {
    backupBeforeUpgrade(db, file, version);
    if (version < 2) upgradeToV2(db);
    if (version < 3) upgradeToV3(db);
    if (version < 5) upgradeToV5(db);
    setVersion(db, SCHEMA_VERSION);
  }

  const stmtPut = db.prepare(`
    INSERT INTO memories (
      id, soul_id, user_id, type, content, importance, vividness, recall_count,
      status, visibility, keywords, created_at, last_recalled_at, valid_from, valid_until,
      superseded_by, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      importance = excluded.importance,
      vividness = excluded.vividness,
      status = excluded.status,
      superseded_by = excluded.superseded_by,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at
  `);

  return {
    ensureSoul(identity: Identity): void {
      withRetry(() =>
        db
          .prepare(
            'INSERT INTO souls (soul_id, name, creator, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(soul_id) DO NOTHING',
          )
          .run(identity.soulId, identity.name, identity.creator ?? null, identity.createdAt),
      );
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

    saveEmotion(soulId: string, userId: string, emotion: Emotion, now: number = Date.now()): void {
      withRetry(() =>
        db
          .prepare(
            `INSERT INTO emotions (soul_id, user_id, passion, bond, tension, self_regard, curiosity, contentment, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(soul_id, user_id) DO UPDATE SET
               passion = excluded.passion, bond = excluded.bond, tension = excluded.tension,
               self_regard = excluded.self_regard, curiosity = excluded.curiosity,
               contentment = excluded.contentment, updated_at = excluded.updated_at`,
          )
          .run(
            soulId,
            userId,
            emotion.passion,
            emotion.bond,
            emotion.tension,
            emotion.selfRegard,
            emotion.curiosity,
            emotion.contentment,
            now,
          ),
      );
    },

    put(memory: Memory): void {
      withRetry(() =>
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
          memory.updatedAt ?? memory.createdAt,
          memory.deletedAt ?? null,
        ),
      );
    },

    query(spec: QuerySpec): Memory[] {
      const statuses = spec.status ?? ['active'];
      const placeholders = statuses.map(() => '?').join(', ');
      const now = spec.now ?? Date.now();
      // Expiry is a filter, not a deletion: audit views can still see the row.
      const expiry = spec.includeExpired ? '' : 'AND (valid_until IS NULL OR valid_until > ?)';
      const rows = db
        .prepare(
          `SELECT * FROM memories
           WHERE soul_id = ? AND (user_id = ? OR visibility = 'shared')
             AND status IN (${placeholders}) AND deleted_at IS NULL ${expiry}
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(
          spec.soulId,
          spec.userId,
          ...statuses,
          ...(spec.includeExpired ? [] : [now]),
          spec.limit ?? 500,
        ) as Row[];

      const memories = rows.map(rowToMemory);
      return spec.types ? memories.filter((m) => spec.types!.includes(m.type)) : memories;
    },

    touch(ids: string[], now: number = Date.now()): void {
      const stmt = db.prepare(
        'UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?',
      );
      withRetry(() => {
        for (const id of ids) stmt.run(now, id);
      });
    },

    forget(id: string, now: number = Date.now()): boolean {
      const result = withRetry(() =>
        db
          .prepare('UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
          .run(now, now, id),
      );
      return Number(result.changes ?? 0) > 0;
    },

    /** Mark `oldId` as replaced by `newId`. Neither row is deleted. */
    supersede(oldId: string, newId: string, now: number = Date.now()): boolean {
      const replacement = db
        .prepare('SELECT id FROM memories WHERE id = ? AND deleted_at IS NULL')
        .get(newId) as Row | undefined;
      if (!replacement) return false;
      const result = withRetry(() =>
        db
          .prepare(
            `UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ?
             WHERE id = ? AND status = 'active' AND deleted_at IS NULL`,
          )
          .run(newId, now, oldId),
      );
      return Number(result.changes ?? 0) > 0;
    },

    saveAffect(soulId: string, userId: string, signal: AffectSignal, at: number, deviceId?: string): void {
      withRetry(() => {
        db.prepare(
          `INSERT OR IGNORE INTO affect_samples
             (soul_id, user_id, at, analyzer, dominant, intensity, valence, arousal, confidence, payload, device_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          soulId,
          userId,
          at,
          signal.analyzer,
          signal.dominant ?? null,
          signal.intensity,
          signal.valence,
          signal.arousal,
          signal.confidence,
          JSON.stringify({ ...signal, at }),
          deviceId ?? null,
        );
        db.prepare('DELETE FROM affect_samples WHERE at < ?').run(at - AFFECT_RETENTION_MS);
      });
    },

    recentAffect(soulId: string, userId: string, sinceMs: number): AffectSignal[] {
      const rows = db
        .prepare(
          `SELECT payload FROM affect_samples
           WHERE soul_id = ? AND user_id = ? AND at >= ?
           ORDER BY at DESC LIMIT 1000`,
        )
        .all(soulId, userId, sinceMs) as Row[];
      return rows
        .map((row) => {
          try {
            return JSON.parse(String(row.payload)) as AffectSignal;
          } catch {
            return null;
          }
        })
        .filter((signal): signal is AffectSignal => signal !== null);
    },

    purgeAffect(beforeMs: number): number {
      const result = withRetry(() => db.prepare('DELETE FROM affect_samples WHERE at < ?').run(beforeMs));
      return Number(result.changes ?? 0);
    },

    saveCorrection(correction: Correction): void {
      withRetry(() =>
        db
          .prepare(
            `INSERT INTO corrections (id, soul_id, user_id, at, user_text, assistant_text, rule, device_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            correction.id,
            correction.soulId,
            correction.userId,
            correction.at,
            correction.userText,
            correction.assistantText ?? null,
            correction.rule ?? null,
            correction.deviceId ?? null,
          ),
      );
    },

    recentCorrections(soulId: string, userId: string, limit: number): Correction[] {
      const rows = db
        .prepare(
          `SELECT * FROM corrections WHERE soul_id = ? AND user_id = ?
           ORDER BY at DESC LIMIT ?`,
        )
        .all(soulId, userId, limit) as Row[];
      return rows.map((row) => ({
        id: String(row.id),
        soulId: String(row.soul_id),
        userId: String(row.user_id),
        at: Number(row.at),
        userText: String(row.user_text),
        assistantText: row.assistant_text == null ? undefined : String(row.assistant_text),
        rule: row.rule == null ? undefined : String(row.rule),
        deviceId: row.device_id == null ? undefined : String(row.device_id),
      }));
    },

    countCorrections(soulId: string, userId: string): number {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM corrections WHERE soul_id = ? AND user_id = ?')
        .get(soulId, userId) as Row;
      return Number(row.n);
    },

    count(soulId: string, userId: string): number {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM memories
           WHERE soul_id = ? AND (user_id = ? OR visibility = 'shared') AND deleted_at IS NULL`,
        )
        .get(soulId, userId) as Row;
      return Number(row.n);
    },

    putTurn(spec: TurnSpec): void {
      // INSERT OR IGNORE + the unique index is the whole idempotency story:
      // one turn per (session, turn_no); repeats are dropped, never merged.
      const id = spec.id ?? `tn_${spec.sessionId}_${spec.turnNo}`;
      const createdAt = spec.createdAt ?? spec.startedAt;
      const assistantText = spec.steps
        .filter((step) => step.kind === 'text' && typeof step.text === 'string')
        .map((step) => step.text as string)
        .join('\n');
      withRetry(() => {
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO turns
               (id, soul_id, user_id, session_id, turn_no, started_at, ended_at,
                user_text, assistant_text, outcome, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            spec.soulId,
            spec.userId,
            spec.sessionId,
            spec.turnNo,
            spec.startedAt,
            spec.endedAt ?? spec.startedAt,
            spec.userText,
            assistantText,
            spec.outcome ?? null,
            spec.status ?? 'closed',
            createdAt,
          );
        // Steps are rewritten whenever the turn is written, so a retry after a
        // partial write converges on the same shape instead of duplicating.
        if (Number(inserted.changes) > 0) {
          const insertStep = db.prepare(
            `INSERT INTO steps (turn_id, idx, kind, text, tool_name, tool_args_chars,
                                tool_result_chars, ok, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const step of spec.steps) {
            insertStep.run(
              id,
              step.idx,
              step.kind,
              step.text ?? null,
              step.toolName ?? null,
              step.toolArgsChars ?? null,
              step.toolResultChars ?? null,
              step.ok === undefined ? null : step.ok ? 1 : 0,
              step.at,
            );
          }
        }
      });
    },

    stepsOf(turnId: string): TurnStep[] {
      const rows = db
        .prepare('SELECT * FROM steps WHERE turn_id = ? ORDER BY idx ASC')
        .all(turnId) as Row[];
      return rows.map((row) => ({
        idx: Number(row.idx),
        kind: String(row.kind) as TurnStep['kind'],
        text: row.text === null ? undefined : String(row.text),
        toolName: row.tool_name === null ? undefined : String(row.tool_name),
        toolArgsChars: row.tool_args_chars === null ? undefined : Number(row.tool_args_chars),
        toolResultChars: row.tool_result_chars === null ? undefined : Number(row.tool_result_chars),
        ok: row.ok === null ? undefined : Number(row.ok) === 1,
        at: Number(row.at),
      }));
    },
    putTurnPair(pair: TurnPair): void {
      this.putTurn({
        id: pair.id,
        soulId: pair.soulId,
        userId: pair.userId,
        sessionId: pair.sessionId,
        turnNo: pair.turn,
        startedAt: pair.at,
        endedAt: pair.at,
        userText: pair.userText,
        status: 'closed',
        createdAt: pair.createdAt,
        steps: pair.assistantText
          ? [{ idx: 0, kind: 'text', text: pair.assistantText, at: pair.at }]
          : [],
      });
    },

    recallTurnPairs(spec: TurnPairSpec): TurnPair[] {
      // No cap by default: every related exchange is returned (bounded only by
      // RECALL_CANDIDATES, which limits rows read, not rows injected).
      const limit = spec.limit ?? RECALL_CANDIDATES;
      const rows = db
        .prepare(
          `SELECT * FROM turns
           WHERE soul_id = ? AND user_id = ? AND started_at >= ?
           ORDER BY started_at DESC LIMIT ?`,
        )
        .all(spec.soulId, spec.userId, spec.since ?? 0, Math.max(limit, RECALL_CANDIDATES)) as Row[];
      const pairs = rows.map(rowToTurnPair);

      const query = spec.query?.trim();
      if (!query) return pairs.slice(0, limit);
      const qTokens = tokenize(query);
      if (qTokens.length === 0) return pairs.slice(0, limit);

      const docTokens = pairs.map(pairTokens);
      const stats = buildCorpusStats(docTokens);
      return pairs
        .map((pair, i) => ({ pair, score: bm25(qTokens, docTokens[i], stats) }))
        .filter((scored) => scored.score > 0)
        .sort((a, b) => b.score - a.score || b.pair.at - a.pair.at)
        .slice(0, limit)
        .map((scored) => scored.pair);
    },

    countTurnPairs(soulId: string, userId: string, sessionId?: string): number {
      const row = sessionId
        ? (db
            .prepare('SELECT COUNT(*) AS n FROM turns WHERE soul_id = ? AND user_id = ? AND session_id = ?')
            .get(soulId, userId, sessionId) as Row)
        : (db
            .prepare('SELECT COUNT(*) AS n FROM turns WHERE soul_id = ? AND user_id = ?')
            .get(soulId, userId) as Row);
      return Number(row.n);
    },

    listSessions(soulId: string, userId: string, limit: number): SessionSummary[] {
      const rows = db
        .prepare(
          `SELECT session_id, MIN(started_at) AS start, MAX(started_at) AS end, COUNT(*) AS turns
           FROM turns WHERE soul_id = ? AND user_id = ?
           GROUP BY session_id ORDER BY MAX(started_at) DESC LIMIT ?`,
        )
        .all(soulId, userId, limit) as Row[];
      return rows.map((row) => ({
        sessionId: String(row.session_id),
        start: Number(row.start),
        end: Number(row.end),
        turns: Number(row.turns),
      }));
    },

    sessionPairs(sessionId: string, soulId: string, userId: string, limit: number): TurnPair[] {
      const rows = db
        .prepare(
          `SELECT * FROM turns
           WHERE soul_id = ? AND user_id = ? AND session_id = ?
           ORDER BY started_at ASC LIMIT ?`,
        )
        .all(soulId, userId, sessionId, limit) as Row[];
      return rows.map(rowToTurnPair);
    },

    sessionTail(sessionId: string, soulId: string, userId: string, limit: number): TurnPair[] {
      const rows = db
        .prepare(
          `SELECT * FROM turns
           WHERE soul_id = ? AND user_id = ? AND session_id = ?
           ORDER BY started_at DESC LIMIT ?`,
        )
        .all(soulId, userId, sessionId, limit) as Row[];
      return rows.map(rowToTurnPair).reverse();
    },

    close(): void {
      db.close();
    },
  };
}

/** Tokens of one exchange. Both sides are searchable; neither is weighted. */
function pairTokens(pair: TurnPair): string[] {
  return [...tokenize(pair.userText), ...tokenize(pair.assistantText)];
}

function rowToTurnPair(row: Row): TurnPair {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(String(row.metadata_json ?? '{}')) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    id: String(row.id),
    soulId: String(row.soul_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    turn: Number(row.turn ?? row.turn_no),
    at: Number(row.at ?? row.started_at),
    userText: String(row.user_text),
    assistantText: String(row.assistant_text),
    metadata,
    createdAt: Number(row.created_at),
  };
}

function rowToMemory(row: Row): Memory {
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
    updatedAt: row.updated_at == null ? undefined : Number(row.updated_at),
    deletedAt: row.deleted_at == null ? undefined : Number(row.deleted_at),
  };
}
