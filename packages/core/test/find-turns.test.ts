import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

function seed() {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const put = (turnNo: number, user: string, answer: string, at: number, sessionId = 'sess-1') =>
    store.putTurn({
      soulId: 's1',
      userId: 'u1',
      sessionId,
      turnNo,
      startedAt: at,
      userText: user,
      steps: answer ? [{ idx: 0, kind: 'text', text: answer, at }] : [],
    });
  put(1, '我们聊聊记忆模型', '记忆分三层', 1000);
  put(2, '再说说检索', '检索用 BM25', 2000);
  put(3, '记忆的遗忘怎么做', '衰减从上次召回算起', 3000);
  put(4, '换到另一个会话', '好', 4000, 'sess-2');
  return { store, soul };
}

test('findTurns: returns every match, counts total, flags truncation', () => {
  const { store, soul } = seed();

  const all = soul.findTurns('记忆');
  assert.equal(all.total, 2, 'both turns mentioning 记忆 are counted');
  assert.equal(all.turns.length, 2);
  assert.equal(all.truncated, false);

  const capped = soul.findTurns('记忆', { limit: 1 });
  assert.equal(capped.total, 2);
  assert.equal(capped.turns.length, 1);
  assert.equal(capped.truncated, true, 'caller can tell the answer would be incomplete');
  store.close();
});

test('findTurns: substring works without the tokenizer (short needle)', () => {
  const { store, soul } = seed();
  // 「表」 is a single character: tokenized search misses it, a filter must not.
  store.putTurn({
    soulId: 's1',
    userId: 'u1',
    sessionId: 'sess-1',
    turnNo: 9,
    startedAt: 5000,
    userText: '那张表设计好了吗',
    steps: [{ idx: 0, kind: 'text', text: '表还没定', at: 5000 }],
  });
  assert.equal(soul.findTurns('表').total, 1);
  store.close();
});

test('findTurns: session and time filters compose', () => {
  const { store, soul } = seed();
  assert.equal(soul.findTurns('', { sessionId: 'sess-2' }).total, 1);
  assert.equal(soul.findTurns('', { since: 2500 }).total, 2);
  assert.equal(soul.findTurns('', { until: 1500 }).total, 1);
  assert.equal(soul.findTurns('', { sessionId: 'sess-1', since: 2500 }).total, 1);
  store.close();
});

test('findTurns: LIKE wildcards in the needle are escaped', () => {
  const { store, soul } = seed();
  store.putTurn({
    soulId: 's1',
    userId: 'u1',
    sessionId: 'sess-1',
    turnNo: 10,
    startedAt: 6000,
    userText: '进度 100% 了',
    steps: [],
  });
  assert.equal(soul.findTurns('%').total, 1, 'a literal % matches only the row containing it');
  assert.equal(soul.findTurns('_').total, 0);
  store.close();
});
