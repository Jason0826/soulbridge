import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite, SCHEMA_VERSION } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

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

test('threads: quiet is counted in turns, not in turn-number distance', () => {
  const store = openSqlite(':memory:');
  // The host's turn numbers jump (observed 10–30 per exchange), so a numeric
  // difference would close a topic one message after it opened.
  store.putTurn({ ...S, id: 's1', sessionId: 'sess', turnNo: 1, startedAt: 1000, userText: '开头', steps: [] });
  store.putTurn({ ...S, id: 's20', sessionId: 'sess', turnNo: 20, startedAt: 2000, userText: '下一轮', steps: [] });
  store.putTurn({ ...S, id: 's40', sessionId: 'sess', turnNo: 40, startedAt: 3000, userText: '再下一轮', steps: [] });

  const oldThread = store.openThread({ ...S, sessionId: 'sess', topic: '早就聊完的', openedAt: 1000, turnNo: 1 });
  const fresh = store.openThread({ ...S, sessionId: 'sess', topic: '刚聊的', openedAt: 2000, turnNo: 20 });

  // Two turns happened after the old thread's last turn; the fresh one is one behind.
  const closed = store.closeIdleThreads(S.soulId, S.userId, 'sess', 2, 30 * 60_000, [], 5000);
  assert.deepEqual(closed, [oldThread.id]);
  assert.equal(store.thread(fresh.id)?.status, 'open');

  // Idempotent.
  assert.deepEqual(store.closeIdleThreads(S.soulId, S.userId, 'sess', 2, 30 * 60_000, [], 6000), []);
  store.close();
});

test('threads: a topic from another session closes, because that session ended', () => {
  const store = openSqlite(':memory:');
  const other = store.openThread({ ...S, sessionId: 'old-session', topic: '上个会话的', openedAt: 1000, turnNo: 5 });
  // The other session's last turn was long ago, so it counts as finished.
  assert.deepEqual(store.closeIdleThreads(S.soulId, S.userId, 'new-session', 6, 30 * 60_000, [], 9_000_000), [other.id]);
  assert.equal(store.thread(other.id)?.status, 'closed');
  store.close();
});

test('threads: handoff prefers a concluded topic over a one-line question', () => {
  const store = openSqlite(':memory:');
  // A trivial one-message thread that closed later than the real one.
  const trivial = store.openThread({ ...S, sessionId: 'old', topic: '我是谁', openedAt: 1000, turnNo: 1 });
  store.closeThread(trivial.id, 9000);
  // The real topic, with a conclusion.
  const real = store.openThread({ ...S, sessionId: 'old', topic: '设定紧急暗号', openedAt: 500, turnNo: 1 });
  const summary = store.putFact({ ...S, statement: '核桃是紧急暗号', typeName: '结论', holder: 'self' });
  store.closeThread(real.id, 8000, summary.id);

  assert.equal(store.lastClosedThread(S.soulId, S.userId)?.id, real.id);
  store.close();
});
test('threadContext: the chapter, in order, with the facts drawn from it', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putTurn({ ...S, id: 't1', sessionId: 'sess', turnNo: 1, startedAt: 1000, userText: 'A1 记忆分三层', steps: [] });
  store.putTurn({ ...S, id: 't2', sessionId: 'sess', turnNo: 2, startedAt: 2000, userText: 'B1 cookie 失效', steps: [] });
  store.putTurn({ ...S, id: 't3', sessionId: 'sess', turnNo: 3, startedAt: 3000, userText: 'A2 回到三层', steps: [] });

  const thread = store.openThread({ ...S, sessionId: 'sess', topic: '记忆分三层', openedAt: 1000, turnNo: 1 });
  store.attachTurn('t1', thread.id);
  store.attachTurn('t3', thread.id); // non-adjacent, back to A
  store.putFact({ ...S, id: 'f1', statement: '用户想分三层', sourceTurnId: 't1' });
  store.putFact({ ...S, id: 'f2', statement: '用户决定先做线索层', sourceTurnId: 't3' });

  const context = soul.threadContext(thread.id);
  assert.deepEqual(context?.turns.map((turn) => turn.userText), ['A1 记忆分三层', 'A2 回到三层']);
  assert.deepEqual(context?.facts.map((fact) => fact.id), ['f1', 'f2']);
  store.close();
});
test('lastClosedThread: the newest finished topic, with its conclusion and last turns', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putTurn({ ...S, id: 't1', sessionId: 'old', turnNo: 1, startedAt: 1000, userText: '第一轮', steps: [] });
  store.putTurn({ ...S, id: 't2', sessionId: 'old', turnNo: 2, startedAt: 2000, userText: '第二轮', steps: [] });

  const thread = store.openThread({ ...S, sessionId: 'old', topic: '记忆如何影响行为', openedAt: 1000, turnNo: 2 });
  store.attachTurn('t1', thread.id);
  store.attachTurn('t2', thread.id);
  const fact = store.putFact({ ...S, statement: '用户要求先有机制', typeName: '结论', holder: 'self', sourceTurnId: 't2' });
  store.closeThread(thread.id, 5000, fact.id);

  const last = soul.lastClosedThread();
  assert.equal(last?.thread.id, thread.id);
  assert.equal(last?.conclusion?.statement, '用户要求先有机制');
  assert.deepEqual(last?.turns.map((turn) => turn.userText), ['第一轮', '第二轮']);
  store.close();
});
test('threads: a live parallel session keeps its topics open', () => {
  const store = openSqlite(':memory:');
  // A second window is open and active: it must not be closed just because the
  // conversation moved to another session.
  store.putTurn({ ...S, id: 'o1', sessionId: 'other', turnNo: 1, startedAt: 9_000_000, userText: '那边的对话', steps: [] });
  const live = store.openThread({ ...S, sessionId: 'other', topic: '还在另一个窗口聊', openedAt: 8_000_000, turnNo: 1 });

  const closed = store.closeIdleThreads(S.soulId, S.userId, 'current', 6, 30 * 60_000, [], 9_100_000);
  assert.deepEqual(closed, []);
  assert.equal(store.thread(live.id)?.status, 'open');
  store.close();
});
test('threads: an archived session closes at once, however recent its turns are', () => {
  const store = openSqlite(':memory:');
  // The user archived the session: that is a declaration, not an inference, so
  // recency must not override it.
  store.putTurn({ ...S, id: 'a1', sessionId: 'archived-session', turnNo: 900, startedAt: 9_000_000, userText: '刚说过的话', steps: [] });
  const thread = store.openThread({ ...S, sessionId: 'archived-session', topic: '归档会话里的话题', openedAt: 8_000_000, turnNo: 900 });

  const closed = store.closeIdleThreads(
    S.soulId,
    S.userId,
    'current',
    6,
    30 * 60_000,
    ['archived-session'],
    9_100_000,
  );
  assert.deepEqual(closed, [thread.id]);
  store.close();
});