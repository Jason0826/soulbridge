/**
 * A migration must survive being interrupted (review finding: v5 re-run).
 *
 * Two holes: the migrations and the version bump did not share a transaction, so an
 * interruption left the old version with part of the work applied; and v5 inserted a
 * step for every legacy turn unconditionally, while `steps` has no unique key — so
 * the retry appended a second copy of the same reply to every turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite } from '../src/sqlite.ts';

function v4Database(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, soul_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL,
      content TEXT NOT NULL, importance REAL NOT NULL, vividness REAL NOT NULL,
      recall_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, visibility TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_recalled_at INTEGER,
      valid_from INTEGER, valid_until INTEGER, superseded_by TEXT, updated_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE turn_pairs (
      id TEXT PRIMARY KEY, soul_id TEXT NOT NULL, user_id TEXT NOT NULL,
      session_id TEXT NOT NULL, turn INTEGER NOT NULL, at INTEGER NOT NULL,
      user_text TEXT NOT NULL, assistant_text TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
    INSERT INTO schema_meta (k, v) VALUES ('schema_version', '4');
    INSERT INTO turn_pairs VALUES ('tp1', 'xiaoling', 'u1', 's1', 1, 1000, '你好', '你好呀', '{}', 1000);
    INSERT INTO turn_pairs VALUES ('tp2', 'xiaoling', 'u1', 's1', 2, 2000, '空回复', '', '{}', 2000);
  `);
  db.close();
}

function stepsOf(file: string, turnId: string): string[] {
  const db = new DatabaseSync(file);
  const rows = db.prepare('SELECT text FROM steps WHERE turn_id = ? ORDER BY idx').all(turnId) as Array<{ text: string }>;
  db.close();
  return rows.map((row) => row.text);
}

test('migration: re-running v5 does not append a second step', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soulbridge-migrate-'));
  const file = join(dir, 'v4.db');
  v4Database(file);

  const store = openSqlite(file);
  store.close();
  assert.deepEqual(stepsOf(file, 'tp1'), ['你好呀'], '首次迁移写入一条 step');
  assert.deepEqual(stepsOf(file, 'tp2'), [], '空回复不写 step');

  // Interrupted after the data was written but before the version bump: the next
  // open sees version 4 again and re-runs the migration.
  const reset = new DatabaseSync(file);
  reset.exec("UPDATE schema_meta SET v = '4' WHERE k = 'schema_version'");
  reset.close();

  const again = openSqlite(file);
  again.close();
  assert.deepEqual(stepsOf(file, 'tp1'), ['你好呀'], '重跑不能再插一条');
  rmSync(dir, { recursive: true, force: true });
});
