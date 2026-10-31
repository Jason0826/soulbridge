import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import type { TurnPair } from '../src/types.ts';

function pair(sessionId: string, turn: number, at: number, userText: string): TurnPair {
  return {
    id: `tp_${sessionId}_${turn}`,
    soulId: 'xiaoling',
    userId: 'u1',
    sessionId,
    turn,
    at,
    userText,
    assistantText: `reply ${turn}`,
    metadata: {},
    createdAt: at,
  };
}

function setup() {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  store.putTurnPair(pair('s1', 1, 1000, '第一个会话的开头'));
  store.putTurnPair(pair('s1', 2, 2000, '中间'));
  store.putTurnPair(pair('s1', 3, 3000, '第三个会话前最后一条'));
  store.putTurnPair(pair('s2', 1, 5000, '第二个会话的开头'));
  return { store, soul };
}

test('sessions: derived from pairs, most recent first', () => {
  const { store, soul } = setup();
  const sessions = soul.sessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, 's2');
  assert.equal(sessions[0].turns, 1);
  assert.equal(sessions[1].sessionId, 's1');
  assert.equal(sessions[1].turns, 3);
  assert.equal(sessions[1].start, 1000);
  assert.equal(sessions[1].end, 3000);
  store.close();
});

test('handoff: previous session gives its first and last exchanges only', () => {
  const { store, soul } = setup();
  const handoff = soul.handoff('s2');
  assert.ok(handoff);
  assert.equal(handoff.session.sessionId, 's1');
  // 主题取最长的那条用户消息；"中间"只有两个字，没有主题信息
  assert.equal(handoff.first.userText, '第三个会话前最后一条');
  assert.deepEqual(
    handoff.last.map((p) => p.turn),
    [1, 3],
    'last two substantial exchanges, oldest first',
  );
  store.close();
});

test('handoff: nothing to hand over on the first conversation', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  store.putTurnPair(pair('only', 1, 1000, '唯一一条'));
  assert.equal(soul.handoff('only'), null);
  store.close();
});

test('countTurnPairs: counts one session when asked', () => {
  const { store, soul } = setup();
  assert.equal(soul.countTurnPairs(), 4);
  assert.equal(store.countTurnPairs('xiaoling', 'u1', 's1'), 3);
  assert.equal(store.countTurnPairs('xiaoling', 'u1', 's2'), 1);
  store.close();
});
