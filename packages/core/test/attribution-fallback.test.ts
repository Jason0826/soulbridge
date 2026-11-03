/**
 * Attribution defaults to continuity (ADR 0034).
 *
 * The old rule opened a new thread whenever the answer was missing, unparseable, or
 * named a thread that does not exist. Measured, that produced 123 threads for 297
 * turns: 104 held no fact, and 112 closed threads yielded 2 conclusions — the
 * understanding stage had no chapters to read. The default is now "join the previous
 * turn's thread", and every decision records why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

const NOW = Date.parse('2026-11-03T01:00:00Z');
const base = { soulId: 's1', userId: 'u1' };

function setup() {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, ...base });
  // Two recorded turns with a thread already applying to the first.
  const first = soul.recordTurnPair({
    sessionId: 'sess',
    turn: 1,
    userText: '记忆要不要分三层',
    assistantText: '分',
    at: NOW,
  });
  const thread = soul.applyThread({ kind: 'new', topic: '记忆分三层' }, {
    sessionId: 'sess',
    turnNo: 1,
    turnId: first,
    at: NOW,
  });
  return { store, soul, first, threadId: thread.threadId };
}

function record(soul: Soul, turnNo: number, userText: string): string {
  return soul.recordTurnPair({
    sessionId: 'sess',
    turn: turnNo,
    userText,
    assistantText: 'ok',
    at: NOW + turnNo * 1000,
  });
}

test('attribution: an unparseable answer joins the previous thread, not a new one', () => {
  const { store, soul, threadId } = setup();
  const turnId = record(soul, 2, '继续，说说怎么落地');
  const result = soul.applyThread(undefined, {
    sessionId: 'sess',
    turnNo: 2,
    turnId,
    at: NOW + 2000,
    previousThreadId: threadId,
  });
  assert.equal(result.threadId, threadId);
  assert.equal(result.created, false);
  assert.equal(result.joinReason, 'fallback-previous');
  assert.equal(store.threadTurns(threadId).length, 2, '两轮进了同一条线索');
  store.close();
});

test('attribution: a hallucinated thread id joins the previous thread', () => {
  const { store, soul, threadId } = setup();
  const turnId = record(soul, 2, '接着刚才说的');
  const result = soul.applyThread({ kind: 'continue', id: 'th_does_not_exist' }, {
    sessionId: 'sess',
    turnNo: 2,
    turnId,
    at: NOW + 2000,
    previousThreadId: threadId,
  });
  assert.equal(result.threadId, threadId);
  assert.equal(result.joinReason, 'fallback-previous');
  store.close();
});

test('attribution: an explicit new topic still opens a thread', () => {
  const { store, soul, threadId } = setup();
  const turnId = record(soul, 2, '换个话题：cookie 为什么失效');
  const result = soul.applyThread({ kind: 'new', topic: 'cookie 失效' }, {
    sessionId: 'sess',
    turnNo: 2,
    turnId,
    at: NOW + 2000,
    previousThreadId: threadId,
  });
  assert.notEqual(result.threadId, threadId);
  assert.equal(result.created, true);
  assert.equal(result.joinReason, 'explicit-new');
  assert.equal(result.topic, 'cookie 失效');
  store.close();
});

test('attribution: continuing with a new topic rewrites the label', () => {
  const { store, soul, threadId } = setup();
  const turnId = record(soul, 2, '换个说法：现在是在定认领方式');
  const result = soul.applyThread(
    { kind: 'continue', id: threadId, topic: '认领方式定下来了' },
    {
      sessionId: 'sess',
      turnNo: 2,
      turnId,
      at: NOW + 2000,
      previousThreadId: threadId,
    },
  );
  assert.equal(result.threadId, threadId);
  assert.equal(result.topicUpdated, true);
  assert.equal(result.topic, '认领方式定下来了');
  assert.equal(store.thread(threadId)?.topic, '认领方式定下来了', '库里的主题也更新了');
  store.close();
});

test('attribution: continuing without a topic keeps the old label', () => {
  const { store, soul, threadId } = setup();
  const turnId = record(soul, 2, '继续');
  const result = soul.applyThread(
    { kind: 'continue', id: threadId },
    {
      sessionId: 'sess',
      turnNo: 2,
      turnId,
      at: NOW + 2000,
      previousThreadId: threadId,
    },
  );
  assert.equal(result.topicUpdated, false);
  assert.equal(store.thread(threadId)?.topic, '记忆分三层');
  store.close();
});

test('attribution: no previous thread and no answer falls back to a new thread', () => {
  const { store, soul } = setup();
  const turnId = record(soul, 2, '第一句话');
  const result = soul.applyThread(undefined, {
    sessionId: 'sess',
    turnNo: 2,
    turnId,
    at: NOW + 2000,
  });
  assert.equal(result.created, true);
  assert.equal(result.joinReason, 'no-context');
  store.close();
});

test('attribution: extraction context carries the previous line and candidate turns', () => {
  const { store, soul } = setup();
  record(soul, 2, '接着上一层说');
  const context = soul.extractionContext(10, { turnNo: 2, sessionId: 'sess' });
  assert.equal(context.previousUserText, '记忆要不要分三层');
  assert.equal(context.threads?.[0]?.id?.startsWith('th_'), true);
  assert.ok((context.threads?.[0]?.recent ?? []).some((line) => line.text.includes('记忆要不要分三层')));
  store.close();
});
