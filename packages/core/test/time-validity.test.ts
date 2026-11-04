import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, upgradeToV15 } from '../src/sqlite.ts';

const base = { soulId: 's1', userId: 'u1' };

/**
 * Brief 0027: the model decides both ends of a fact's validity; the writer only carries
 * them. What it must never do again is derive one end from the other — the v14 rule
 * "a dated row stops being current the day it has a date" marked 236 living facts as
 * expired on their own record date.
 */
test('validity: both ends come from the caller, and neither is invented', () => {
  const store = openSqlite(':memory:');
  const event = store.putFact({ ...base, statement: '小林在 10-24 被裁员', validFrom: 1000, source: 'told', confidence: 0.8 });
  const span = store.putFact({
    ...base,
    statement: '小林在 10 月住院一周',
    validFrom: 1000,
    validTo: 7000,
    source: 'told',
    confidence: 0.8,
  });
  const claim = store.putFact({ ...base, statement: '代码只做形态校验', source: 'told', confidence: 0.8 });

  assert.equal(event.validFrom, 1000);
  assert.equal(event.validTo, undefined, 'an event does not expire; it happened');
  assert.equal(span.validTo, 7000, 'an explicit range end is stored as given');
  assert.equal(claim.validFrom, undefined, 'the writer does not fill a time the model did not give');
  assert.equal(claim.validTo, undefined, 'and certainly does not derive one');
  store.close();
});

test('supersede: the old fact ends at the successor valid_from, not at the record time', () => {
  const store = openSqlite(':memory:');
  const layoff = Date.parse('2026-10-24T00:00:00+08:00');
  // The state has no date of its own: it holds until the layoff ends it.
  const atWork = store.putFact({ ...base, statement: '小林在 A 公司', source: 'told', confidence: 0.8 });
  const event = store.putFact({
    ...base,
    statement: '小林在 10-24 被裁员',
    validFrom: layoff,
    validFromText: '10-24',
    source: 'told',
    confidence: 0.8,
  });
  store.supersedeFact(atWork.id, event.id);

  const retired = store.fact(atWork.id);
  assert.equal(retired?.status, 'retracted');
  assert.equal(retired?.validTo, layoff, 'the state ends when the event happened, not when we recorded it');
  assert.equal(retired?.validFrom, atWork.validFrom, 'valid_from is untouched');
  const written = store.fact(event.id);
  assert.equal(written?.validTo, undefined, 'the event itself never stops being true');
  store.close();
});

test('upgrade to v15: one time axis, and the guessed expiry is dropped', () => {
  const file = join(tmpdir(), `soulbridge-v15-${process.pid}-${Date.now()}.db`);

  // The shape a database had before 0027: two names for "when it starts", plus the
  // v14 guess `valid_until = at` on every dated row.
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE facts (
      id TEXT PRIMARY KEY, soul_id TEXT NOT NULL, user_id TEXT NOT NULL, statement TEXT NOT NULL,
      type_name TEXT, role TEXT NOT NULL DEFAULT 'observation', holder TEXT NOT NULL DEFAULT 'world',
      at INTEGER, at_text TEXT, at_end INTEGER, at_precision TEXT NOT NULL DEFAULT 'unknown',
      valid_from INTEGER, valid_until INTEGER, place_id TEXT, status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'experienced',
      source_turn_id TEXT, superseded_by TEXT, created_at INTEGER NOT NULL,
      recall_count INTEGER NOT NULL DEFAULT 0, last_recalled_at INTEGER
    );
  `);
  raw.prepare("INSERT INTO schema_meta (k, v) VALUES ('schema_version', '14')").run();
  const insert = raw.prepare(
    `INSERT INTO facts (id, soul_id, user_id, statement, holder, status, confidence, source, at, at_text, at_end, valid_from, valid_until, created_at, superseded_by)
     VALUES (?, 's1', 'u1', ?, 'world', ?, 1, 'told', ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run('instant', '小林在 10-24 被裁员', 'active', 1000, '10-24', null, 1000, 1000, 5000, null);
  insert.run('span', '小林住院一周', 'active', 1000, '那周', 7000, 1000, 1000, 5000, null);
  insert.run('claim', '代码只做形态校验', 'active', null, null, null, 5000, null, 5000, null);
  insert.run('old', '小林在 A 公司', 'retracted', null, null, null, 5000, null, 6000, 'instant');
  upgradeToV15(raw);

  const rows = raw.prepare('SELECT id, valid_from, valid_from_text, valid_to FROM facts ORDER BY id').all() as Array<{
    id: string;
    valid_from: number | null;
    valid_from_text: string | null;
    valid_to: number | null;
  }>;
  const columns = raw.prepare('PRAGMA table_info(facts)').all() as Array<{ name: string }>;
  raw.close();

  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get('instant')?.valid_from, 1000);
  assert.equal(byId.get('instant')?.valid_from_text, '10-24');
  assert.equal(byId.get('instant')?.valid_to, null, 'the v14 guess is gone: the event does not expire');
  assert.equal(byId.get('span')?.valid_to, 7000, 'an explicit range end survives');
  assert.equal(byId.get('claim')?.valid_from, 5000, 'an undated claim starts when it was recorded');
  assert.equal(byId.get('claim')?.valid_to, null);
  assert.equal(byId.get('old')?.valid_to, 1000, 'a superseded fact ends at its successor valid_from');

  const names = columns.map((column) => column.name);
  for (const gone of ['at', 'at_text', 'at_end', 'at_precision', 'valid_until']) {
    assert.ok(!names.includes(gone), `${gone} is retired, not merely unused`);
  }
  for (const added of ['valid_from', 'valid_to', 'valid_from_text', 'valid_from_precision']) {
    assert.ok(names.includes(added), `${added} exists`);
  }
});
