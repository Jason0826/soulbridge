import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, upgradeToV12 } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

const base = { soulId: 's1', userId: 'u1' };

test('upgrade to v12: legacy 日期不明 gaps close with a reason', () => {
  const file = join(tmpdir(), `soulbridge-v12-${process.pid}-${Date.now()}.db`);
  openSqlite(file).close();

  const raw = new DatabaseSync(file);
  const insert = raw.prepare(
    `INSERT INTO gaps (id, soul_id, user_id, topic, tension, status, opened_at)
     VALUES (?, 's1', 'u1', ?, 0.3, 'open', ?)`,
  );
  insert.run('g1', '日期不明：用户与a吃了火锅', 1000);
  insert.run('g2', '小林后来有着落吗', 1000);
  raw.close();

  const db = new DatabaseSync(file);
  upgradeToV12(db);
  const rows = db.prepare('SELECT id, status, close_reason FROM gaps ORDER BY id').all() as Array<{
    id: string;
    status: string;
    close_reason: string | null;
  }>;
  db.close();

  assert.deepEqual(
    rows.map((row) => ({ id: row.id, status: row.status, reason: row.close_reason })),
    [
      { id: 'g1', status: 'closed', reason: 'time-unknown-not-a-gap' },
      { id: 'g2', status: 'open', reason: null },
    ],
  );
});

test('sweep: an open question nobody answered in two weeks closes, a fresh one stays', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const now = Date.now();
  store.putGap({ ...base, id: 'old', topic: '她后来怎么样了', tension: 0.6, openedAt: now - 20 * 86_400_000 });
  store.putGap({ ...base, id: 'new', topic: '这个项目定了吗', tension: 0.4, openedAt: now - 86_400_000 });

  const result = soul.sweep(now);
  assert.equal(result.gapsClosed, 1);
  assert.deepEqual(
    soul.store.openGaps('s1', 'u1').map((gap) => gap.id),
    ['new'],
  );
  store.close();
});
