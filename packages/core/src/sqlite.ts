/**
 * SQLite implementation of SoulStore, using Node's built-in `node:sqlite`.
 * Zero npm dependencies on purpose: `npx soulbridge` must work offline.
 *
 * Schema versioning (ADR 0020): every open checks `schema_meta.schema_version`.
 * Older databases are upgraded in place after a one-off backup; a database
 * from a newer binary is refused instead of being silently written.
 */
import { copyFileSync, existsSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_EMOTION } from './types.ts';
import { FACT_STATUS, MEMORY_STATUS } from './config/status.ts';
import type { FactStatus } from './config/status.ts';
import { FACT_ROLES } from './config/domains.ts';
import type {
  AffectSignal,
  Correction,
  Emotion,
  Identity,
  Memory,
  PortableDump,
  QuerySpec,
  SessionSummary,
  TurnPair,
  TurnPairSpec,
  Entity,
  EntityQuery,
  EntitySpec,
  Fact,
  FactQuery,
  FactSlot,
  FactRole,
  FactSpec,
  Gap,
  GapSpec,
  TurnFindResult,
  TurnFindSpec,
  ThreadSpec,
  TurnThread,
  TurnSpec,
  SlotValue,
  TurnStep,
} from './types.ts';
import type { SoulStore } from './store.ts';
import { bm25, buildCorpusStats, tokenize } from './scoring.ts';

export const SCHEMA_VERSION = 12;
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

-- v6: the model proper (spec/model.v0.md). A fact is a connection; slots are
-- its ends; gaps are the connections that have not happened yet.
CREATE TABLE IF NOT EXISTS entities (
  id                TEXT PRIMARY KEY,
  soul_id           TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  type              TEXT NOT NULL,
  name              TEXT NOT NULL,
  aliases           TEXT NOT NULL DEFAULT '[]',
  attrs             TEXT NOT NULL DEFAULT '{}',
  first_seen_at     INTEGER NOT NULL,
  last_mentioned_at INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name
  ON entities(soul_id, user_id, type, name);
CREATE INDEX IF NOT EXISTS idx_entities_recent
  ON entities(soul_id, user_id, last_mentioned_at DESC);

CREATE TABLE IF NOT EXISTS facts (
  id             TEXT PRIMARY KEY,
  soul_id        TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  statement      TEXT NOT NULL,
  type_name      TEXT,
  role           TEXT NOT NULL DEFAULT 'observation',
  holder         TEXT NOT NULL DEFAULT 'world',
  at             INTEGER,
  at_text        TEXT,
  at_end         INTEGER,
  at_precision   TEXT NOT NULL DEFAULT 'unknown',
  place_id       TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  confidence     REAL NOT NULL DEFAULT 1,
  source         TEXT NOT NULL DEFAULT 'experienced',
  source_turn_id TEXT,
  superseded_by  TEXT,
  created_at     INTEGER NOT NULL,
  recall_count   INTEGER NOT NULL DEFAULT 0,
  last_recalled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(soul_id, user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(soul_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(soul_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fact_slots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id     TEXT NOT NULL,
  slot        TEXT NOT NULL,
  value_type  TEXT NOT NULL,
  entity_id   TEXT,
  value_num   REAL,
  value_text  TEXT,
  ref_fact_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_fact_slots_fact ON fact_slots(fact_id);
CREATE INDEX IF NOT EXISTS idx_fact_slots_entity ON fact_slots(entity_id);

CREATE TABLE IF NOT EXISTS gaps (
  id                TEXT PRIMARY KEY,
  soul_id           TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  about_entity_id   TEXT,
  about_fact_id     TEXT,
  topic             TEXT NOT NULL,
  tension           REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'open',
  opened_at         INTEGER NOT NULL,
  closed_at         INTEGER,
  closed_by_fact_id TEXT,
  close_reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_gaps_open ON gaps(soul_id, user_id, status, tension DESC);

-- A topic is a thread, not a segment: its turns need not be adjacent, because a
-- conversation can interleave (A B A) and come back. Consolidation runs when a
-- thread closes, not when a batch of facts fills up.
CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  soul_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  topic       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER,
  last_turn_no INTEGER,
  summary_fact_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_threads_open ON threads(soul_id, user_id, status, opened_at DESC);
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

/** v6 → v7: turn threads (a topic's turns need not be adjacent) plus turns.thread_id. */
export function upgradeToV12(db: DatabaseSync): void {
  // A missing date is a property of the fact, not an open question. Existing gaps created by
  // that old rule are closed with the reason, so the remaining open gaps are the ones that
  // were worth asking about.
  ensureColumn(db, 'gaps', 'close_reason', 'TEXT');
  db.prepare(
    `UPDATE gaps SET status = 'closed', closed_at = ?, close_reason = 'time-unknown-not-a-gap'
      WHERE status = 'open' AND topic LIKE '日期不明：%'`,
  ).run(Date.now());
}

export function upgradeToV11(db: DatabaseSync): void {
  // 原则候选 stored a decision as a slot; it is role+status now. The row becomes a lesson
  // candidate — held and shown to the classifier, injected nowhere until it is placed.
  db.exec(`UPDATE facts SET role = 'lesson', status = 'candidate'
            WHERE id IN (SELECT fact_id FROM fact_slots WHERE slot = '原则候选' AND value_text = '是')`);
  db.exec("DELETE FROM fact_slots WHERE slot = '原则候选'");
  // One name for "this cites its sources": 来源 → 证据. Skip where the fact already cites
  // the same row under the new name, then drop what is left of the old spelling.
  db.exec(`UPDATE fact_slots SET slot = '证据'
            WHERE slot = '来源'
              AND NOT EXISTS (SELECT 1 FROM fact_slots x
                               WHERE x.fact_id = fact_slots.fact_id AND x.slot = '证据'
                                 AND x.ref_fact_id = fact_slots.ref_fact_id)`);
  db.exec("DELETE FROM fact_slots WHERE slot = '来源'");
}

export function upgradeToV10(db: DatabaseSync): void {
  // The four-state vocabulary (config/status.ts). Everything written under the old names
  // becomes one of the two states the code now reads; after this the fallbacks are gone.
  db.exec("UPDATE facts SET status = 'active' WHERE status IN ('none','open','kept')");
  db.exec("UPDATE facts SET status = 'retracted' WHERE status IN ('broken','superseded')");
}

export function upgradeToV9(db: DatabaseSync): void {
  // Time became locatability (ADR 0032): a fact may be known to exist without a
  // date, and that is a value — unknown — not a reason to discard it.
  ensureColumn(db, 'facts', 'at_precision', "TEXT NOT NULL DEFAULT 'unknown'");
  // What a fact is *for* (config/domains.ts FACT_ROLES). Backfill from the old type label so
  // rows written before this column still reach the right consumer.
  ensureColumn(db, 'facts', 'role', "TEXT NOT NULL DEFAULT 'observation'");
}

export function upgradeToV8(db: DatabaseSync): void {
  // What decays is the chance of being recalled, so the store has to know how
  // often and how recently that happened (0019).
  ensureColumn(db, 'facts', 'recall_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'facts', 'last_recalled_at', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(soul_id, user_id, created_at DESC)');
}

export function upgradeToV7(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    id          TEXT PRIMARY KEY,
    soul_id     TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    topic       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    opened_at   INTEGER NOT NULL,
    closed_at   INTEGER,
    last_turn_no INTEGER,
    summary_fact_id TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_threads_open ON threads(soul_id, user_id, status, opened_at DESC)');
  ensureColumn(db, 'turns', 'thread_id', 'TEXT');
}
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
    const inserted = insertTurn.run(
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
    // Only a freshly inserted turn gets a step. The migration can be re-run after an
    // interruption before the version bump, and steps has no unique key — writing it
    // unconditionally appended a second copy of the same reply on every retry.
    if (Number(inserted.changes) > 0 && assistant.length > 0) insertStep.run(id, assistant, Number(row.at));
  }
}

/**
 * Copy the database aside before a schema upgrade.
 *
 * The backup is the only way back from a bad migration, so it has to be *valid*,
 * not merely present. Two failures were possible before: a plain file copy after
 * `wal_checkpoint(TRUNCATE)` dropped the newest commits when another connection
 * pinned an old snapshot (the checkpoint returns busy and only partially flushes,
 * and that return value was ignored), and an existing backup file was trusted
 * forever even if it was the broken one from an earlier attempt.
 *
 * `VACUUM INTO` reads through the WAL and writes a consistent snapshot regardless
 * of other readers, so it is the primary path; a checkpoint+copy remains as the
 * fallback, and whatever it produces is opened and integrity-checked. A copy that
 * fails its own check is moved aside (kept for forensics) and the upgrade refuses
 * to run — a corrupt backup is worse than none, because it is the one thing we
 * would trust when everything else failed.
 *
 * Exported for the upgrade test.
 */
export function backupBeforeUpgrade(db: DatabaseSync, file: string, from: number): void {
  if (file === ':memory:' || !existsSync(file)) return;
  const backup = `${file}.bak-v${from}`;
  if (existsSync(backup)) {
    if (integrityOf(backup)) return;
    const corrupt = `${backup}.corrupt-${Date.now()}`;
    renameSync(backup, corrupt);
    throw new Error(`existing backup ${backup} is not readable; moved aside to ${corrupt}`);
  }
  try {
    // Quotes are escaped because the path is spliced into SQL; VACUUM INTO takes a
    // string expression, and binding it is not supported on every SQLite build.
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  } catch {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    copyFileSync(file, backup);
  }
  if (!integrityOf(backup)) {
    const corrupt = `${backup}.corrupt-${Date.now()}`;
    renameSync(backup, corrupt);
    throw new Error(`backup for schema v${from} failed its integrity check (kept at ${corrupt})`);
  }
}

/** Does this file open and report `integrity_check = ok`? */
function integrityOf(file: string): boolean {
  try {
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const row = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      return row.integrity_check === 'ok';
    } finally {
      copy.close();
    }
  } catch {
    return false;
  }
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
    // All upgrades and the version bump commit together. Before this, an interruption
    // left the version at the old value with half the migration applied, so the next
    // open re-ran it against its own output (v5 appended duplicate steps).
    // VACUUM INTO in the backup runs before the transaction: it cannot run inside one.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (version < 2) upgradeToV2(db);
      if (version < 3) upgradeToV3(db);
      if (version < 5) upgradeToV5(db);
      if (version < 7) upgradeToV7(db);
      if (version < 8) upgradeToV8(db);
      if (version < 12) upgradeToV12(db);
      // v6 adds tables only; SCHEMA creates them on every open, nothing to copy.
      setVersion(db, SCHEMA_VERSION);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the error below is the one worth reporting */
      }
      db.close();
      throw error;
    }
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
            `UPDATE memories SET status = '${MEMORY_STATUS.superseded}', superseded_by = ?, updated_at = ?
             WHERE id = ? AND status = '${MEMORY_STATUS.active}' AND deleted_at IS NULL`,
          )
          .run(newId, now, oldId),
      );
      return Number(result.changes ?? 0) > 0;
    },

    /**
     * Retire a legacy memory pointing at something outside this table.
     *
     * `supersede()` requires the replacement to be a memory, which is right while the
     * table is live. The migration replaces rows with facts, so it needs the same
     * bookkeeping without that check — the row stays for audit, the pointer is kept.
     */
    retireMemory(oldId: string, replacedBy?: string, now: number = Date.now()): boolean {
      const result = withRetry(() =>
        db
          .prepare(
            `UPDATE memories SET status = '${MEMORY_STATUS.superseded}', superseded_by = ?, updated_at = ?
             WHERE id = ? AND status = '${MEMORY_STATUS.active}' AND deleted_at IS NULL`,
          )
          .run(replacedBy ?? null, now, oldId),
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

    corrections(soulId: string, userId: string, limit = 100_000): Correction[] {
      return this.recentCorrections(soulId, userId, limit);
    },

    dump(soulId: string, userId: string): PortableDump {
      const facts = this.facts({ soulId, userId, limit: 100_000 });
      const entities = this.findEntities({ soulId, userId, limit: 100_000 });
      const threads = (db
        .prepare('SELECT * FROM threads WHERE soul_id = ? AND user_id = ? ORDER BY opened_at ASC')
        .all(soulId, userId) as Row[]).map(rowToThread);
      const gaps = (db
        .prepare('SELECT * FROM gaps WHERE soul_id = ? AND user_id = ? ORDER BY opened_at ASC')
        .all(soulId, userId) as Row[]).map(rowToGap);
      const turns = (db
        .prepare('SELECT * FROM turns WHERE soul_id = ? AND user_id = ? ORDER BY created_at ASC')
        .all(soulId, userId) as Row[]).map(rowToTurnPair);
      const steps = db
        .prepare(
          `SELECT s.* FROM steps s JOIN turns t ON t.id = s.turn_id
            WHERE t.soul_id = ? AND t.user_id = ? ORDER BY s.turn_id, s.idx`,
        )
        .all(soulId, userId) as Row[];
      return {
        entities,
        facts,
        threads,
        gaps,
        turns,
        steps: steps.map((row) => ({
          turnId: String(row.turn_id),
          idx: Number(row.idx),
          kind: row.kind as 'reasoning' | 'text' | 'tool',
          text: row.text == null ? undefined : String(row.text),
          toolName: row.tool_name == null ? undefined : String(row.tool_name),
          toolArgsChars: row.tool_args_chars == null ? undefined : Number(row.tool_args_chars),
          toolResultChars: row.tool_result_chars == null ? undefined : Number(row.tool_result_chars),
          ok: row.ok == null ? undefined : Boolean(row.ok),
          at: Number(row.at),
        })),
        corrections: this.recentCorrections(soulId, userId, 100_000),
      };
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

    findTurns(spec: TurnFindSpec): TurnFindResult {
      // Substring match, deliberately not the tokenizer: an exhaustive fetch is
      // a filter, and CJK bigrams would miss short needle text (eval-boundary-0027).
      const where = ['soul_id = ?', 'user_id = ?'];
      const args: Array<string | number> = [spec.soulId, spec.userId];
      if (spec.text) {
        const needle = `%${spec.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push("(user_text LIKE ? ESCAPE '\\' OR assistant_text LIKE ? ESCAPE '\\')");
        args.push(needle, needle);
      }
      if (spec.sessionId) {
        where.push('session_id = ?');
        args.push(spec.sessionId);
      }
      if (spec.since !== undefined) {
        where.push('started_at >= ?');
        args.push(spec.since);
      }
      if (spec.until !== undefined) {
        where.push('started_at <= ?');
        args.push(spec.until);
      }
      const clause = where.join(' AND ');
      const total = Number(
        (db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE ${clause}`).get(...args) as Row).n,
      );
      const limit = spec.limit ?? 200;
      const rows = db
        .prepare(`SELECT * FROM turns WHERE ${clause} ORDER BY started_at DESC LIMIT ?`)
        .all(...args, limit) as Row[];
      return { turns: rows.map(rowToTurnPair), total, truncated: total > limit };
    },

    /* ---------------- entities ---------------- */

    putEntity(spec: EntitySpec): Entity {
      const now = spec.seenAt ?? Date.now();
      const id = spec.id ?? `en_${spec.type}_${encodeURIComponent(spec.name)}`;
      // A refresh that only names the entity must not erase what is known about it.
      // The upsert used to write `excluded.aliases` unconditionally, so every
      // "just mention them again" call wiped the nickname and the attributes —
      // and `latestAbout` lost its alias match, meaning the person stopped being
      // recognized by anything but their full name.
      const existingRow = db
        .prepare('SELECT aliases, attrs FROM entities WHERE soul_id = ? AND user_id = ? AND type = ? AND name = ?')
        .get(spec.soulId, spec.userId, spec.type, spec.name) as { aliases?: string; attrs?: string } | undefined;
      const readJson = <T>(raw: string | undefined, fallback: T): T => {
        if (raw === undefined) return fallback;
        try {
          return JSON.parse(raw) as T;
        } catch {
          return fallback;
        }
      };
      const existingAliases = readJson<string[]>(existingRow?.aliases, []);
      const existingAttrs = readJson<Record<string, unknown>>(existingRow?.attrs, {});
      const aliases = spec.aliases === undefined ? existingAliases : [...new Set([...existingAliases, ...spec.aliases])];
      const attrs = spec.attrs === undefined ? existingAttrs : { ...existingAttrs, ...spec.attrs };
      withRetry(() =>
        db
          .prepare(
            `INSERT INTO entities
               (id, soul_id, user_id, type, name, aliases, attrs,
                first_seen_at, last_mentioned_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(soul_id, user_id, type, name) DO UPDATE SET
               last_mentioned_at = excluded.last_mentioned_at,
               aliases = excluded.aliases,
               attrs = excluded.attrs`,
          )
          .run(
            id,
            spec.soulId,
            spec.userId,
            spec.type,
            spec.name,
            JSON.stringify(aliases),
            JSON.stringify(attrs),
            now,
            now,
            now,
          ),
      );
      const row = db
        .prepare('SELECT * FROM entities WHERE soul_id = ? AND user_id = ? AND type = ? AND name = ?')
        .get(spec.soulId, spec.userId, spec.type, spec.name) as Row;
      return rowToEntity(row);
    },

    entity(id: string): Entity | null {
      const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as Row | undefined;
      return row ? rowToEntity(row) : null;
    },

    findEntities(query: EntityQuery): Entity[] {
      const where = ['soul_id = ?', 'user_id = ?'];
      const args: Array<string | number> = [query.soulId, query.userId];
      if (query.type) {
        where.push('type = ?');
        args.push(query.type);
      }
      if (query.name) {
        where.push("(name LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\')");
        const needle = `%${query.name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        args.push(needle, needle);
      }
      const rows = db
        .prepare(
          `SELECT * FROM entities WHERE ${where.join(' AND ')}
           ORDER BY last_mentioned_at DESC LIMIT ?`,
        )
        .all(...args, query.limit ?? 20) as Row[];
      return rows.map(rowToEntity);
    },

    /* ---------------- facts ---------------- */

    putFact(spec: FactSpec): Fact {
      const id = spec.id ?? `fc_${Date.now().toString(36)}_${(factSeq += 1).toString(36)}`;
      const createdAt = Date.now();
      // Only the caller decides the role. The writer's neutral default is observation — it
      // is the minimal claim — and it never guesses from `type_name`: that guess was the debt
      // the vocabulary rebuild removed. An unknown value is a caller bug, not a guess.
      if (spec.role !== undefined && !(FACT_ROLES as readonly string[]).includes(spec.role)) {
        throw new Error(`invalid fact role: ${spec.role}`);
      }
      const role = spec.role ?? 'observation';
      withRetry(() => {
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO facts
               (id, soul_id, user_id, statement, type_name, role, holder, at, at_text, at_end, at_precision,
                place_id, status, confidence, source, source_turn_id, superseded_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            spec.soulId,
            spec.userId,
            spec.statement,
            spec.typeName ?? null,
            role,
            spec.holder ?? 'world',
            spec.at ?? null,
            spec.atText ?? null,
            spec.atEnd ?? null,
            spec.atPrecision ?? 'unknown',
            spec.placeId ?? null,
            spec.status ?? 'active',
            spec.confidence ?? 1,
            spec.source ?? 'experienced',
            spec.sourceTurnId ?? null,
            spec.supersededBy ?? null,
            createdAt,
          );
        if (Number(inserted.changes) > 0) {
          const insertSlot = db.prepare(
            `INSERT INTO fact_slots (fact_id, slot, value_type, entity_id, value_num, value_text, ref_fact_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const s of spec.slots ?? []) {
            insertSlot.run(
              id,
              s.slot,
              s.value.kind,
              s.value.kind === 'entity' ? s.value.entityId : null,
              s.value.kind === 'number' ? s.value.value : null,
              s.value.kind === 'text' ? s.value.value : null,
              s.value.kind === 'fact' ? s.value.factId : null,
            );
          }
        }
      });
      const fact = this.fact(id);
      if (!fact) throw new Error(`fact ${id} disappeared right after writing`);
      return fact;
    },

    fact(id: string): Fact | null {
      const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Row | undefined;
      if (!row) return null;
      return rowToFact(row, slotsOfRows(db, [id]));
    },

    facts(query: FactQuery): Fact[] {
      const where = ['f.soul_id = ?', 'f.user_id = ?'];
      const args: Array<string | number> = [query.soulId, query.userId];
      if (query.entityId) {
        where.push('EXISTS (SELECT 1 FROM fact_slots s WHERE s.fact_id = f.id AND s.entity_id = ?)');
        args.push(query.entityId);
      }
      if (query.since !== undefined) {
        where.push('f.at >= ?');
        args.push(query.since);
      }
      if (query.until !== undefined) {
        where.push('f.at <= ?');
        args.push(query.until);
      }
      if (query.status) {
        where.push('f.status = ?');
        args.push(query.status);
      }
      if (query.holder) {
        where.push('f.holder = ?');
        args.push(query.holder);
      }
      const direction = query.order === 'asc' ? 'ASC' : 'DESC';
      const rows = db
        .prepare(
          `SELECT f.* FROM facts f WHERE ${where.join(' AND ')}
           ORDER BY COALESCE(f.at, f.created_at) ${direction} LIMIT ?`,
        )
        .all(...args, query.limit ?? 200) as Row[];
      const ids = rows.map((r) => String(r.id));
      const slots = slotsOfRows(db, ids);
      return rows.map((row) => rowToFact(row, slots));
    },

    supersedeFact(oldId: string, newId: string): void {
      withRetry(() =>
        db
          .prepare(`UPDATE facts SET status = '${FACT_STATUS.retracted}', superseded_by = ? WHERE id = ?`)
          .run(newId, oldId),
      );
    },
    /* ---------------- gaps ---------------- */

    putGap(spec: GapSpec): Gap {
      const id = spec.id ?? `gp_${Date.now().toString(36)}_${(gapSeq += 1).toString(36)}`;
      withRetry(() =>
        db
          .prepare(
            `INSERT OR IGNORE INTO gaps
               (id, soul_id, user_id, about_entity_id, about_fact_id, topic,
                tension, status, opened_at, closed_at, closed_by_fact_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            spec.soulId,
            spec.userId,
            spec.aboutEntityId ?? null,
            spec.aboutFactId ?? null,
            spec.topic,
            spec.tension ?? 0,
            spec.status ?? 'open',
            spec.openedAt ?? Date.now(),
            spec.closedAt ?? null,
            spec.closedByFactId ?? null,
          ),
      );
      const row = db.prepare('SELECT * FROM gaps WHERE id = ?').get(id) as Row;
      return rowToGap(row);
    },

    openGaps(soulId: string, userId: string, limit = 20): Gap[] {
      const rows = db
        .prepare(
          `SELECT * FROM gaps WHERE soul_id = ? AND user_id = ? AND status = 'open'
           ORDER BY tension DESC, opened_at ASC LIMIT ?`,
        )
        .all(soulId, userId, limit) as Row[];
      return rows.map(rowToGap);
    },

    closeGap(id: string, closedByFactId?: string, at = Date.now()): void {
      withRetry(() =>
        db
          .prepare(
            `UPDATE gaps SET status = 'closed', closed_at = ?, closed_by_fact_id = ?
             WHERE id = ?`,
          )
          .run(at, closedByFactId ?? null, id),
      );
    },

    closeStaleGaps(soulId: string, userId: string, beforeAt: number, reason: string): number {
      let changed = 0;
      withRetry(() => {
        const result = db
          .prepare(
            `UPDATE gaps SET status = 'closed', closed_at = ?, close_reason = ?
              WHERE soul_id = ? AND user_id = ? AND status = 'open' AND opened_at < ?`,
          )
          .run(Date.now(), reason, soulId, userId, beforeAt);
        changed = Number(result.changes);
      });
      return changed;
    },

    turn(id: string): TurnPair | null {
      const row = db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Row | undefined;
      return row ? rowToTurnPair(row) : null;
    },

    openThread(spec: ThreadSpec): TurnThread {
      const id = spec.id ?? `th_${spec.openedAt.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      withRetry(() =>
        db
          .prepare(
            `INSERT INTO threads (id, soul_id, user_id, session_id, topic, status, opened_at, last_turn_no)
             VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
          )
          .run(id, spec.soulId, spec.userId, spec.sessionId, spec.topic, spec.openedAt, spec.turnNo ?? null),
      );
      return {
        id,
        soulId: spec.soulId,
        userId: spec.userId,
        sessionId: spec.sessionId,
        topic: spec.topic,
        status: 'open',
        openedAt: spec.openedAt,
        lastTurnNo: spec.turnNo,
      };
    },

    attachTurn(turnId: string, threadId: string): void {
      withRetry(() => db.prepare('UPDATE turns SET thread_id = ? WHERE id = ?').run(threadId, turnId));
    },

    touchThread(id: string, turnNo: number): void {
      withRetry(() => db.prepare('UPDATE threads SET last_turn_no = ? WHERE id = ?').run(turnNo, id));
    },

    updateThreadTopic(id: string, topic: string): void {
      withRetry(() => db.prepare('UPDATE threads SET topic = ? WHERE id = ?').run(topic, id));
    },

    openThreads(soulId: string, userId: string, limit = 5): TurnThread[] {
      const rows = db
        .prepare(
          `SELECT * FROM threads WHERE soul_id = ? AND user_id = ? AND status = 'open'
           ORDER BY COALESCE(last_turn_no, 0) DESC, opened_at DESC LIMIT ?`,
        )
        .all(soulId, userId, limit) as Row[];
      return rows.map(rowToThread);
    },

    thread(id: string): TurnThread | null {
      const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Row | undefined;
      return row ? rowToThread(row) : null;
    },

    closeThread(id: string, at: number, summaryFactId?: string): void {
      withRetry(() =>
        db
          .prepare("UPDATE threads SET status = 'closed', closed_at = ?, summary_fact_id = ? WHERE id = ?")
          .run(at, summaryFactId ?? null, id),
      );
    },

    /**
     * Close topics the conversation has moved past.
     *
     * Three signals, ordered by how much they actually know:
     *
     *   - `archived`: the user put the session away. A declaration, not an
     *     inference — the strongest signal, so it wins even over recency.
     *   - `quiet-turns`: inside the running session, the conversation moved on N
     *     turns. Counted as **rows**, because the host's turn number is not a
     *     per-exchange counter (it jumps by 10–30 per message).
     *   - `quiet-time`: silence in another session. The weakest signal, kept only
     *     as a safety net, and deliberately long: closing early writes a partial
     *     conclusion into durable memory, while closing late only delays one.
     *
     * The reason is returned so the log can say which signal actually fired, and
     * so a threshold that fires too early is visible instead of silent.
     */
    closeIdleThreads(
      soulId: string,
      userId: string,
      sessionId: string,
      idleTurns: number,
      idleMs: number,
      archivedSessionIds: string[],
      at: number,
    ): Array<{ id: string; reason: 'archived' | 'quiet-turns' | 'quiet-time' }> {
      const archived = new Set(archivedSessionIds);
      const open = db
        .prepare(
          `SELECT t.id AS id, t.session_id AS session_id,
                  COALESCE((SELECT MAX(x.started_at) FROM turns x WHERE x.session_id = t.session_id),
                           t.opened_at) AS last_activity,
                  (SELECT COUNT(*) FROM turns x
                   WHERE x.session_id = t.session_id
                     AND x.turn_no > COALESCE(t.last_turn_no, 0)) AS quiet_turns
           FROM threads t
           WHERE t.soul_id = ? AND t.user_id = ? AND t.status = 'open'`,
        )
        .all(soulId, userId) as Row[];

      const cutoff = at - Math.max(60_000, idleMs);
      const closing: Array<{ id: string; reason: 'archived' | 'quiet-turns' | 'quiet-time' }> = [];
      for (const row of open) {
        const threadSession = String(row.session_id);
        if (threadSession === sessionId) {
          if (Number(row.quiet_turns) >= Math.max(1, idleTurns)) {
            closing.push({ id: String(row.id), reason: 'quiet-turns' });
          }
        } else if (archived.has(threadSession)) {
          closing.push({ id: String(row.id), reason: 'archived' });
        } else if (Number(row.last_activity) <= cutoff) {
          closing.push({ id: String(row.id), reason: 'quiet-time' });
        }
      }

      const close = db.prepare("UPDATE threads SET status = 'closed', closed_at = ? WHERE id = ?");
      for (const thread of closing) withRetry(() => close.run(at, thread.id));
      return closing;
    },
    threadTurns(threadId: string): TurnPair[] {
      const rows = db
        .prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY turn_no ASC')
        .all(threadId) as Row[];
      return rows.map(rowToTurnPair);
    },
    /**
     * The thread worth handing over: a finished topic that produced a conclusion.
     *
     * A one-message question also closes as a "thread", and handing that over tells
     * the next session nothing but noise ("we last talked about: who am I"). So a
     * summary comes first; otherwise a topic needs at least two turns to qualify.
     */
    lastClosedThread(soulId: string, userId: string): TurnThread | null {
      const summarised = db
        .prepare(
          `SELECT * FROM threads WHERE soul_id = ? AND user_id = ? AND status = 'closed'
             AND summary_fact_id IS NOT NULL
           ORDER BY COALESCE(closed_at, 0) DESC LIMIT 1`,
        )
        .get(soulId, userId) as Row | undefined;
      if (summarised) return rowToThread(summarised);
      const substantial = db
        .prepare(
          `SELECT t.* FROM threads t WHERE t.soul_id = ? AND t.user_id = ? AND t.status = 'closed'
             AND (SELECT COUNT(*) FROM turns x WHERE x.thread_id = t.id) >= 2
           ORDER BY COALESCE(t.closed_at, 0) DESC LIMIT 1`,
        )
        .get(soulId, userId) as Row | undefined;
      return substantial ? rowToThread(substantial) : null;
    },

    /** The thread the previous turn belonged to, if any — the cheapest continuity hint. */
    threadBefore(sessionId: string, turnNo: number): string | null {
      const row = db
        .prepare(
          `SELECT thread_id FROM turns
           WHERE session_id = ? AND turn_no < ? AND thread_id IS NOT NULL
           ORDER BY turn_no DESC LIMIT 1`,
        )
        .get(sessionId, turnNo) as Row | undefined;
      return row ? String(row.thread_id) : null;
    },
    previousTurnText(sessionId: string, turnNo: number): string | null {
      const row = db
        .prepare(
          `SELECT user_text FROM turns
           WHERE session_id = ? AND turn_no < ?
           ORDER BY turn_no DESC LIMIT 1`,
        )
        .get(sessionId, turnNo) as Row | undefined;
      const text = row ? String(row.user_text ?? '').trim() : '';
      return text === '' ? null : text;
    },
    factsByTurns(turnIds: string[], options: { includeCandidates?: boolean } = {}): Fact[] {
      if (turnIds.length === 0) return [];
      const placeholders = turnIds.map(() => '?').join(',');
      // Only live facts. A retracted statement must not become evidence for the next
      // consolidation; a candidate is held but unconfirmed, so it is evidence for nothing
      // except the promotion step that decides its role.
      const live = options.includeCandidates
        ? `f.status IN ('${FACT_STATUS.active}','${FACT_STATUS.candidate}')`
        : `f.status = '${FACT_STATUS.active}'`;
      const rows = db
        .prepare(
          `SELECT f.* FROM facts f WHERE f.source_turn_id IN (${placeholders})
             AND ${live} ORDER BY f.created_at ASC`,
        )
        .all(...turnIds) as Row[];
      const slots = slotsOfRows(db, rows.map((row) => String(row.id)));
      return rows.map((row) => rowToFact(row, slots));
    },
    /**
     * Append slots to an existing fact, skipping ones it already has.
     *
     * Used when a duplicate conclusion is merged into the held one: the holder
     * keeps its statement, and gains the new evidence so it gets stronger rather
     * than being restated.
     */
    addSlots(factId: string, slots: { slot: string; value: SlotValue }[]): number {
      const existing = new Set(
        (
          db
            .prepare("SELECT ref_fact_id, value_text, slot FROM fact_slots WHERE fact_id = ?")
            .all(factId) as Row[]
        ).map((row) => `${String(row.slot)}|${String(row.ref_fact_id ?? row.value_text ?? '')}`),
      );
      const insert = db.prepare(
        `INSERT INTO fact_slots (fact_id, slot, value_type, entity_id, value_num, value_text, ref_fact_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      let added = 0;
      for (const s of slots) {
        const key = `${s.slot}|${s.value.kind === 'fact' ? s.value.factId : s.value.kind === 'entity' ? s.value.entityId : s.value.kind === 'text' ? s.value.value : String(s.value.value)}`;
        if (existing.has(key)) continue;
        insert.run(
          factId,
          s.slot,
          s.value.kind,
          s.value.kind === 'entity' ? s.value.entityId : null,
          s.value.kind === 'number' ? s.value.value : null,
          s.value.kind === 'text' ? s.value.value : null,
          s.value.kind === 'fact' ? s.value.factId : null,
        );
        existing.add(key);
        added += 1;
      }
      return added;
    },

    /** Retag a fact, e.g. a lesson that turned out to be a rule (ADR 0033). */
    setFactTypeName(factId: string, typeName: string): void {
      withRetry(() => db.prepare('UPDATE facts SET type_name = ? WHERE id = ?').run(typeName, factId));
    },

    /** What the fact is for; the caller decides (config/domains.ts FACT_ROLES). */
    setFactRole(factId: string, role: FactRole): void {
      withRetry(() => db.prepare('UPDATE facts SET role = ? WHERE id = ?').run(role, factId));
    },

    /** Lifecycle state; code writes it, never the model (config/status.ts). */
    setFactStatus(factId: string, status: FactStatus): void {
      withRetry(() => db.prepare('UPDATE facts SET status = ? WHERE id = ?').run(status, factId));
    },

    setFactConfidence(factId: string, confidence: number): void {
      withRetry(() =>
        db.prepare('UPDATE facts SET confidence = ? WHERE id = ?').run(confidence, factId),
      );
    },

    /**
     * Count that retrieval surfaced these facts.
     *
     * This is the rehearsal in 0019: a memory used often decays more slowly, so the
     * counter is the mechanism, not a statistic.
     */
    recordRecalls(factIds: string[], at: number): void {
      if (factIds.length === 0) return;
      const stmt = db.prepare('UPDATE facts SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?');
      for (const id of factIds) withRetry(() => stmt.run(at, id));
    },

    /**
     * The entity timeline: facts about one person/thing, newest event first.
     *
     * This is the primitive behind "上次和 a 吃饭" — the subject decides what is
     * fetched, and `predicate` narrows within that subject's own facts. It must
     * never look outside the subject: answering about b when asked about a is the
     * one error worse than saying nothing.
     */
    /**
     * The entity timeline: facts about one person/thing, ranked.
     *
     * This is the primitive behind "上次和 a 吃饭". Recency alone is not enough — an
     * entity with a thousand facts would return its three most recent ones, which
     * answers "what happened to a lately", not "the meal". So the ranking is
     * relevance to the question × power-law recency × recall practice, the same
     * weights the relevance primitive uses (0019, 0020).
     *
     * It must never look outside the subject: answering about b when asked about a
     * is the one error worse than saying nothing.
     */
    latestAbout(
      soulId: string,
      userId: string,
      entityName: string,
      options: { predicate?: string; query?: string; limit?: number; now?: number } = {},
    ): Fact[] {
      const limit = Math.max(1, options.limit ?? 5);
      const predicate = options.predicate?.trim();
      // Bounded so a long-lived entity cannot make this unbounded.
      const CANDIDATES = 500;
      const rows = db
        .prepare(
          `SELECT DISTINCT f.* FROM facts f
           JOIN fact_slots s ON s.fact_id = f.id AND s.value_type = 'entity'
           JOIN entities e ON e.id = s.entity_id
           WHERE f.soul_id = ? AND f.user_id = ? AND f.status = '${FACT_STATUS.active}'
             AND (e.name = ? OR e.aliases LIKE ?)
             AND (? IS NULL OR f.statement LIKE ? OR COALESCE(f.type_name, '') LIKE ?)
           ORDER BY COALESCE(f.at, f.created_at) DESC
           LIMIT ?`,
        )
        .all(
          soulId,
          userId,
          entityName,
          `%${entityName}%`,
          predicate ?? null,
          predicate ? `%${predicate}%` : null,
          predicate ? `%${predicate}%` : null,
          CANDIDATES,
        ) as Row[];
      const slots = slotsOfRows(db, rows.map((row) => String(row.id)));
      const facts = rows.map((row) => rowToFact(row, slots));

      const query = options.query?.trim();
      if (!query) return facts.slice(0, limit);

      const now = options.now ?? Date.now();
      const queryTokens = tokenize(query);
      const stats = buildCorpusStats(facts.map((fact) => tokenize(fact.statement)));
      const scored = facts.map((fact) => {
        const relevanceScore = bm25(queryTokens, tokenize(fact.statement), stats);
        const ageDays = Math.max(0, (now - (fact.at ?? fact.createdAt)) / 86_400_000);
        // Power law, not exponential: the tail of a memory stays reachable (0019).
        const decay = 1 / Math.sqrt(1 + ageDays);
        const practice = 1 + 0.2 * Math.log(1 + fact.recallCount);
        return { fact, score: relevanceScore * decay * practice };
      });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((entry) => entry.fact);
    },

    turnByTurnNo(sessionId: string, turnNo: number): TurnPair | null {
      const row = db
        .prepare('SELECT * FROM turns WHERE session_id = ? AND turn_no = ? LIMIT 1')
        .get(sessionId, turnNo) as Row | undefined;
      return row ? rowToTurnPair(row) : null;
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
    putTurnPair(pair: TurnPair, steps?: TurnStep[]): void {
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
        // Adapters may hand over the real step list (reasoning, text, tool) so a
        // turn keeps its shape; otherwise the reply collapses into one text step.
        steps:
          steps && steps.length > 0
            ? steps
            : pair.assistantText
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


/** Id counters keep fact/gap ids unique within a process without extra deps. */
let factSeq = 0;
let gapSeq = 0;

function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    return raw ? (JSON.parse(String(raw)) as T) : fallback;
  } catch {
    return fallback;
  }
}

function rowToEntity(row: Row): Entity {
  return {
    id: String(row.id),
    soulId: String(row.soul_id),
    userId: String(row.user_id),
    type: String(row.type) as Entity['type'],
    name: String(row.name),
    aliases: parseJson<string[]>(row.aliases, []),
    attrs: parseJson<Record<string, unknown>>(row.attrs, {}),
    firstSeenAt: Number(row.first_seen_at),
    lastMentionedAt: Number(row.last_mentioned_at),
    createdAt: Number(row.created_at),
  };
}

/** Slots of many facts in one query, grouped by fact id. */
function slotsOfRows(db: DatabaseSync, factIds: string[]): Map<string, FactSlot[]> {
  const map = new Map<string, FactSlot[]>();
  if (factIds.length === 0) return map;
  const placeholders = factIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM fact_slots WHERE fact_id IN (${placeholders}) ORDER BY id ASC`)
    .all(...factIds) as Row[];
  for (const row of rows) {
    const factId = String(row.fact_id);
    const list = map.get(factId) ?? [];
    const valueType = String(row.value_type);
    const value: FactSlot['value'] =
      valueType === 'entity'
        ? { kind: 'entity', entityId: String(row.entity_id) }
        : valueType === 'number'
          ? { kind: 'number', value: Number(row.value_num) }
          : valueType === 'fact'
            ? { kind: 'fact', factId: String(row.ref_fact_id) }
            : { kind: 'text', value: String(row.value_text ?? '') };
    list.push({ slot: String(row.slot), value });
    map.set(factId, list);
  }
  return map;
}

function rowToFact(row: Row, slots: Map<string, FactSlot[]>): Fact {
  const id = String(row.id);
  return {
    id,
    soulId: String(row.soul_id),
    userId: String(row.user_id),
    statement: String(row.statement),
    typeName: row.type_name === null ? undefined : String(row.type_name),
    role: row.role === null || row.role === undefined ? undefined : (String(row.role) as Fact['role']),
    holder: String(row.holder),
    at: row.at === null ? undefined : Number(row.at),
    atText: row.at_text === null ? undefined : String(row.at_text),
    atEnd: row.at_end === null ? undefined : Number(row.at_end),
    atPrecision: (row.at_precision ?? 'unknown') as Fact['atPrecision'],
    placeId: row.place_id === null ? undefined : String(row.place_id),
    status: String(row.status) as Fact['status'],
    confidence: Number(row.confidence),
    source: String(row.source) as Fact['source'],
    sourceTurnId: row.source_turn_id === null ? undefined : String(row.source_turn_id),
    supersededBy: row.superseded_by === null ? undefined : String(row.superseded_by),
    createdAt: Number(row.created_at),
    recallCount: Number(row.recall_count ?? 0),
    lastRecalledAt: row.last_recalled_at === null || row.last_recalled_at === undefined ? undefined : Number(row.last_recalled_at),
    slots: slots.get(id) ?? [],
  };
}

function rowToThread(row: Row): TurnThread {
  return {
    id: String(row.id),
    soulId: String(row.soul_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    topic: String(row.topic),
    status: String(row.status) as TurnThread['status'],
    openedAt: Number(row.opened_at),
    closedAt: row.closed_at === null || row.closed_at === undefined ? undefined : Number(row.closed_at),
    lastTurnNo: row.last_turn_no === null || row.last_turn_no === undefined ? undefined : Number(row.last_turn_no),
    summaryFactId:
      row.summary_fact_id === null || row.summary_fact_id === undefined ? undefined : String(row.summary_fact_id),
  };
}
function rowToGap(row: Row): Gap {
  return {
    id: String(row.id),
    soulId: String(row.soul_id),
    userId: String(row.user_id),
    aboutEntityId: row.about_entity_id === null ? undefined : String(row.about_entity_id),
    aboutFactId: row.about_fact_id === null ? undefined : String(row.about_fact_id),
    topic: String(row.topic),
    tension: Number(row.tension),
    status: String(row.status) as Gap['status'],
    openedAt: Number(row.opened_at),
    closedAt: row.closed_at === null ? undefined : Number(row.closed_at),
    closedByFactId: row.closed_by_fact_id === null ? undefined : String(row.closed_by_fact_id),
  };
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
