import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite, SCHEMA_VERSION } from '../src/sqlite.ts';

const S = { soulId: 's1', userId: 'u1' };

test('threads: a topic can hold non-adjacent turns', () => {
  const store = openSqlite(':memory:');
  assert.ok(SCHEMA_VERSION >= 7);

  // A B A — the case a segment model cannot represent.
  store.putTurn({ ...S, id: 't1', sessionId: 'sess', turnNo: 1, startedAt: 1000, userText: '聊记忆分层', steps: [] });
  store.putTurn({ ...S, id: 't2', sessionId: 'sess', turnNo: 2, startedAt: 2000, userText: 'cookie 为什么失效', steps: [] });
  store.putTurn({ ...S, id: 't3', sessionId: 'sess', turnNo: 3, startedAt: 3000, userText: '回到三层怎么落地', steps: [] });

  const threadA = store.openThread({ ...S, sessionId: 'sess', topic: '记忆分三层', openedAt: 1000, turnNo: 1 });
  const threadB = store.openThread({ ...S, sessionId: 'sess', topic: 'cookie 与认证', openedAt: 2000, turnNo: 2 });

  store.attachTurn('t1', threadA.id);
  store.attachTurn('t2', threadB.id);
  store.attachTurn('t3', threadA.id); // back to A

  const open = store.openThreads(S.soulId, S.userId);
  assert.equal(open.length, 2);
  // Most recently used first: B was touched at turn 2, A at turn 1.
  assert.equal(open[0].id, threadB.id);
  assert.equal(open[1].id, threadA.id);
  store.close();
});

test('threads: closing records the time and the summary fact', () => {
  const store = openSqlite(':memory:');
  const thread = store.openThread({ ...S, sessionId: 'sess', topic: '记忆分三层', openedAt: 1000 });
  store.closeThread(thread.id, 5000, 'fc_summary');

  const closed = store.thread(thread.id);
  assert.equal(closed?.status, 'closed');
  assert.equal(closed?.closedAt, 5000);
  assert.equal(closed?.summaryFactId, 'fc_summary');
  assert.equal(store.openThreads(S.soulId, S.userId).length, 0);
  store.close();
});

test('threads: touchThread moves a thread to the front of the candidates', () => {
  const store = openSqlite(':memory:');
  const a = store.openThread({ ...S, sessionId: 'sess', topic: 'A', openedAt: 1000, turnNo: 1 });
  const b = store.openThread({ ...S, sessionId: 'sess', topic: 'B', openedAt: 2000, turnNo: 2 });
  assert.equal(store.openThreads(S.soulId, S.userId)[0].id, b.id);

  store.touchThread(a.id, 9);
  assert.equal(store.openThreads(S.soulId, S.userId)[0].id, a.id);
  store.close();
});

test('threads: quiet threads close by turn distance, not by wall clock', () => {
  const store = openSqlite(':memory:');
  const active = store.openThread({ ...S, sessionId: 'sess', topic: '还在聊的', openedAt: 1000, turnNo: 10 });
  const stale = store.openThread({ ...S, sessionId: 'sess', topic: '早就聊完的', openedAt: 1000, turnNo: 3 });

  // Six idle turns is the default: the stale thread is 7 behind, the active one 0.
  const closed = store.closeIdleThreads(S.soulId, S.userId, 10, 6, 5000);
  assert.deepEqual(closed, [stale.id]);

  assert.equal(store.thread(stale.id)?.status, 'closed');
  assert.equal(store.thread(stale.id)?.closedAt, 5000);
  assert.equal(store.thread(active.id)?.status, 'open');

  // Closing is idempotent: the same call finds nothing left to do.
  assert.deepEqual(store.closeIdleThreads(S.soulId, S.userId, 10, 6, 6000), []);
  store.close();
});