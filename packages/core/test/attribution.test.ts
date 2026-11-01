import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { parseThreadLine } from '../src/extract.ts';

const base = { soulId: 's1', userId: 'u1' };

test('attribution: the line parses into continue / new / nothing', () => {
  assert.deepEqual(parseThreadLine('线索: 继续 th_ab12'), { kind: 'continue', id: 'th_ab12' });
  assert.deepEqual(parseThreadLine('线索: 新 | 在聊 cookie 与认证'), { kind: 'new', topic: '在聊 cookie 与认证' });
  assert.deepEqual(parseThreadLine('线索: 新'), { kind: 'new', topic: undefined });
  assert.equal(parseThreadLine('线索: 无'), null);
  assert.equal(parseThreadLine('事实: 无关的一行'), null);
});

test('attribution: continue attaches to an open thread and refreshes it', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putTurn({ ...base, id: 't1', sessionId: 'sess', turnNo: 1, startedAt: 1000, userText: '第一轮', steps: [] });

  const first = soul.applyThread({ kind: 'new', topic: '记忆分三层' }, {
    sessionId: 'sess',
    turnNo: 1,
    turnId: 't1',
    at: 1000,
    fallbackTopic: '第一句话',
  });
  assert.equal(first.created, true);
  assert.equal(first.topic, '记忆分三层');

  store.putTurn({ ...base, id: 't9', sessionId: 'sess', turnNo: 9, startedAt: 9000, userText: '回来继续', steps: [] });
  const back = soul.applyThread({ kind: 'continue', id: first.threadId }, {
    sessionId: 'sess',
    turnNo: 9,
    turnId: 't9',
    at: 9000,
  });
  assert.equal(back.created, false);
  assert.equal(back.threadId, first.threadId);
  assert.equal(store.thread(first.threadId)?.lastTurnNo, 9);
  store.close();
});

test('attribution: a phantom id falls back to a new thread', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putTurn({ ...base, id: 't1', sessionId: 'sess', turnNo: 1, startedAt: 1000, userText: '随便说说', steps: [] });

  const result = soul.applyThread({ kind: 'continue', id: 'th_ghost' }, {
    sessionId: 'sess',
    turnNo: 1,
    turnId: 't1',
    at: 1000,
    fallbackTopic: '这句话的前二十个字',
  });
  assert.equal(result.created, true);
  assert.equal(result.topic, '这句话的前二十个字');
  store.close();
});

test('attribution: a closed thread is not reopened by a stale continue', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putTurn({ ...base, id: 't1', sessionId: 'sess', turnNo: 1, startedAt: 1000, userText: '第一轮', steps: [] });
  store.putTurn({ ...base, id: 't2', sessionId: 'sess', turnNo: 2, startedAt: 2000, userText: '第二轮', steps: [] });

  const thread = soul.applyThread({ kind: 'new', topic: '旧话题' }, {
    sessionId: 'sess',
    turnNo: 1,
    turnId: 't1',
    at: 1000,
    fallbackTopic: '旧话题',
  });
  store.closeThread(thread.threadId, 1500);

  const result = soul.applyThread({ kind: 'continue', id: thread.threadId }, {
    sessionId: 'sess',
    turnNo: 2,
    turnId: 't2',
    at: 2000,
    fallbackTopic: '新话题',
  });
  assert.equal(result.created, true);
  assert.notEqual(result.threadId, thread.threadId);
  store.close();
});

test('context: open threads are offered with how long ago they were seen', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const thread = store.openThread({ ...base, sessionId: 'sess', topic: '记忆分三层', openedAt: 1000, turnNo: 3 });

  const context = soul.extractionContext(10, { turnNo: 7 });
  assert.equal(context.threads?.length, 1);
  assert.equal(context.threads?.[0].id, thread.id);
  assert.equal(context.threads?.[0].ago, 4);
  store.close();
});
