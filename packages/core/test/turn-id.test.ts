/**
 * A repeated turn must return the id that is actually stored.
 *
 * The unique (session, turn) index drops the second insert, but the method used to
 * return the freshly generated id anyway. The adapter enqueued extraction with that
 * phantom id, and the queue later dropped the item as "turn missing" — the stored
 * row was never extracted under this path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

test('turns: a repeat returns the stored id, not a phantom', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const first = soul.recordTurnPair({ sessionId: 'sess', turn: 7, userText: '你好', assistantText: '在', at: 1000 });
  const second = soul.recordTurnPair({ sessionId: 'sess', turn: 7, userText: '你好', assistantText: '在', at: 2000 });

  assert.equal(second, first, 'the repeat must point at the row that exists');
  assert.equal(store.turn(first)?.userText, '你好');
  assert.equal(store.turn(second)?.id, first);
  store.close();
});
