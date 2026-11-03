import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, upgradeToV10 } from '../src/sqlite.ts';

test('upgrade to v10: the old status spellings become active and retracted', () => {
  const file = join(tmpdir(), `soulbridge-v10-${process.pid}-${Date.now()}.db`);
  openSqlite(file).close();

  const raw = new DatabaseSync(file);
  const insert = raw.prepare(
    `INSERT INTO facts (id, soul_id, user_id, statement, holder, status, confidence, source, created_at)
     VALUES (?, 's1', 'u1', ?, 'world', ?, 1, 'told', 1)`,
  );
  for (const status of ['none', 'open', 'kept', 'broken', 'superseded']) {
    insert.run(`f_${status}`, `statement ${status}`, status);
  }
  raw.close();

  const db = new DatabaseSync(file);
  upgradeToV10(db);
  const rows = db.prepare('SELECT id, status FROM facts ORDER BY id').all() as Array<{ id: string; status: string }>;
  db.close();

  const status = new Map(rows.map((row) => [row.id, row.status]));
  assert.equal(status.get('f_none'), 'active');
  assert.equal(status.get('f_open'), 'active');
  assert.equal(status.get('f_kept'), 'active');
  assert.equal(status.get('f_broken'), 'retracted');
  assert.equal(status.get('f_superseded'), 'retracted');
});
