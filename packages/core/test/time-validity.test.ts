import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, upgradeToV13, upgradeToV14 } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

const base = { soulId: 's1', userId: 'u1' };

test('validity: an event is valid until it is over; an undated claim stays open', () => {
  const store = openSqlite(':memory:');
  const event = store.putFact({ ...base, statement: '小林在 10-24 被裁员', at: 1000, source: 'told', confidence: 0.8 });
  const span = store.putFact({
    ...base,
    statement: '小林在 10 月住院一周',
    at: 1000,
    atEnd: 7000,
    source: 'told',
    confidence: 0.8,
  });
  const claim = store.putFact({ ...base, statement: '代码只做形态校验', source: 'told', confidence: 0.8 });
  assert.equal(event.validFrom, 1000);
  assert.equal(event.validUntil, 1000, 'an instantaneous event stops being current when it happens');
  assert.equal(span.validUntil, 7000, 'a ranged event stops when the range ends');
  assert.ok(claim.validFrom && claim.validFrom > 0, 'a timeless claim is valid from when it was recorded');
  assert.equal(claim.validUntil, undefined, 'a standing claim stays current until something replaces it');
  store.close();
});

test('validity: supersede ends the old claim at the moment the new one was recorded', () => {
  const store = openSqlite(':memory:');
  // A standing state, not an event: no date, so it is open until something replaces it.
  const oldFact = store.putFact({ ...base, statement: '小林在 A 公司', source: 'told', confidence: 0.8 });
  const newFact = store.putFact({ ...base, statement: '小林去了 B 公司', source: 'told', confidence: 0.8 });
  store.supersedeFact(oldFact.id, newFact.id);

  const retired = store.fact(oldFact.id);
  assert.equal(retired?.status, 'retracted');
  assert.equal(retired?.validUntil, newFact.createdAt, 'valid_until is the successor record time');
  assert.equal(retired?.validFrom, oldFact.validFrom, 'valid_from is untouched');
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

test('upgrade to v14: dated rows stop being current at the event, undated rows stay open', () => {
  const file = join(tmpdir(), `soulbridge-v14-${process.pid}-${Date.now()}.db`);
  openSqlite(file).close();

  const raw = new DatabaseSync(file);
  const insert = raw.prepare(
    `INSERT INTO facts (id, soul_id, user_id, statement, holder, status, confidence, source, at, at_end, created_at, valid_from)
     VALUES (?, 's1', 'u1', ?, 'world', 'active', 1, 'told', ?, ?, ?, ?)`,
  );
  insert.run('instant', '小林在 10-24 被裁员', 1000, null, 5000, 1000);
  insert.run('span', '小林住院一周', 1000, 7000, 5000, 1000);
  insert.run('claim', '代码只做形态校验', null, null, 5000, 5000);
  raw.close();

  const db = new DatabaseSync(file);
  upgradeToV14(db);
  const rows = db.prepare('SELECT id, valid_until FROM facts ORDER BY id').all() as Array<{
    id: string;
    valid_until: number | null;
  }>;
  db.close();

  assert.deepEqual(
    rows.map((row) => ({ id: row.id, until: row.valid_until })),
    [
      { id: 'claim', until: null },
      { id: 'instant', until: 1000 },
      { id: 'span', until: 7000 },
    ],
  );
});
