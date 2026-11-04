import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, upgradeToV13 } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

const base = { soulId: 's1', userId: 'u1' };

test('validity: valid_from follows the event time, or the record time when there is none', () => {
  const store = openSqlite(':memory:');
  const event = store.putFact({ ...base, statement: '小林在 10-24 被裁员', at: 1000, source: 'told', confidence: 0.8 });
  const claim = store.putFact({ ...base, statement: '代码只做形态校验', source: 'told', confidence: 0.8 });
  assert.equal(event.validFrom, 1000);
  assert.ok(claim.validFrom && claim.validFrom > 0, 'a timeless claim is valid from when it was recorded');
  assert.equal(event.validUntil, undefined, 'a historical event never stops being true');
  store.close();
});

test('validity: supersede ends the old claim at the moment the new one was recorded', () => {
  const store = openSqlite(':memory:');
  const oldFact = store.putFact({ ...base, statement: '小林在 A 公司', at: 1000, source: 'told', confidence: 0.8 });
  const newFact = store.putFact({ ...base, statement: '小林去了 B 公司', at: 2000, source: 'told', confidence: 0.8 });
  store.supersedeFact(oldFact.id, newFact.id);

  const retired = store.fact(oldFact.id);
  assert.equal(retired?.status, 'retracted');
  assert.equal(retired?.validUntil, newFact.createdAt, 'valid_until is the successor record time');
  assert.equal(retired?.validFrom, 1000, 'valid_from is untouched');
  assert.equal(store.fact(newFact.id)?.validUntil, undefined);
  store.close();
});

test('upgrade to v13: existing rows get a validity interval', () => {
  const file = join(tmpdir(), `soulbridge-v13-${process.pid}-${Date.now()}.db`);
  openSqlite(file).close();

  const raw = new DatabaseSync(file);
  const insert = raw.prepare(
    `INSERT INTO facts (id, soul_id, user_id, statement, holder, status, confidence, source, at, created_at)
     VALUES (?, 's1', 'u1', ?, 'world', ?, 1, 'told', ?, ?)`,
  );
  insert.run('old', '小林在 A 公司', 'retracted', 1000, 5000);
  insert.run('new', '小林去了 B 公司', 'active', 2000, 6000);
  raw.prepare("UPDATE facts SET superseded_by = 'new' WHERE id = 'old'").run();
  raw.close();

  const db = new DatabaseSync(file);
  upgradeToV13(db);
  const rows = db.prepare('SELECT id, valid_from, valid_until FROM facts ORDER BY id').all() as Array<{
    id: string;
    valid_from: number;
    valid_until: number | null;
  }>;
  db.close();

  assert.deepEqual(
    rows.map((row) => ({ id: row.id, from: row.valid_from, until: row.valid_until })),
    [
      { id: 'new', from: 2000, until: null },
      { id: 'old', from: 1000, until: 6000 },
    ],
  );
});
