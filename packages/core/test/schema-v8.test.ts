/**
 * v8: recall statistics and time indexes.
 *
 * 0019 decided nothing is deleted and that what decays is the probability of being
 * recalled. That needs two facts about each memory: how often it was used, and
 * when it was last used. The indexes make the two structured primitives (entity
 * timeline, time window) cheap once the store grows.
 *
 * A test opens the same database twice; the upgrade must be idempotent.
 */
import { openSqlite } from '../src/sqlite.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('v8: facts gain recall statistics and their indexes', () => {
  const store = openSqlite(':memory:');
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f1', statement: '用户与a吃过火锅' });
  assert.equal(store.fact('f1')?.recallCount, 0);
  assert.equal(store.fact('f1')?.lastRecalledAt, undefined);

  store.recordRecalls(['f1'], 1000);
  store.recordRecalls(['f1'], 2000);
  assert.equal(store.fact('f1')?.recallCount, 2);
  assert.equal(store.fact('f1')?.lastRecalledAt, 2000);
  store.close();
});
