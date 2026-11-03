import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, upgradeToV11 } from '../src/sqlite.ts';

test('upgrade to v11: 原则候选 becomes a lesson candidate, 来源 becomes 证据', () => {
  const file = join(tmpdir(), `soulbridge-v11-${process.pid}-${Date.now()}.db`);
  openSqlite(file).close();

  const raw = new DatabaseSync(file);
  const insertFact = raw.prepare(
    `INSERT INTO facts (id, soul_id, user_id, statement, holder, role, status, confidence, source, created_at)
     VALUES (?, 's1', 'u1', ?, 'world', 'observation', 'active', 1, 'told', 1)`,
  );
  insertFact.run('f_lesson', '改动前先说明影响');
  insertFact.run('f_profile', '做事之前先验证');

  const insertSlot = raw.prepare(
    `INSERT INTO fact_slots (fact_id, slot, value_type, value_text, ref_fact_id) VALUES (?, ?, ?, ?, ?)`,
  );
  insertSlot.run('f_lesson', '原则候选', 'text', '是', null);
  insertSlot.run('f_profile', '来源', 'fact', null, 'f_lesson');
  raw.close();

  const db = new DatabaseSync(file);
  upgradeToV11(db);
  const lesson = db.prepare("SELECT role, status FROM facts WHERE id = 'f_lesson'").get() as {
    role: string;
    status: string;
  };
  const slots = db.prepare("SELECT fact_id, slot FROM fact_slots ORDER BY fact_id").all() as Array<{
    fact_id: string;
    slot: string;
  }>;
  db.close();

  assert.deepEqual({ role: lesson.role, status: lesson.status }, { role: 'lesson', status: 'candidate' });
  assert.deepEqual(
    slots.map((slot) => ({ fact_id: slot.fact_id, slot: slot.slot })),
    [{ fact_id: 'f_profile', slot: '证据' }],
    '来源 renamed, 原则候选 removed',
  );
});
