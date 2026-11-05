import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { readThreadSpans } from '../src/extract.ts';

const base = { soulId: 's1', userId: 'u1' };

/* ---------------- the parser: one line per topic span ---------------- */

test('spans: one line per topic, ranges optional', () => {
  const multi = readThreadSpans('线索: 1-5 继续 th_ab12\n线索: 6-8 新 | 在聊 cookie 与认证');
  assert.equal(multi.line, 'present');
  assert.deepEqual(multi.spans, [
    { from: 1, to: 5, attribution: { kind: 'continue', id: 'th_ab12' } },
    { from: 6, to: 8, attribution: { kind: 'new', topic: '在聊 cookie 与认证' } },
  ]);

  const whole = readThreadSpans('线索: 继续 th_ab12 | 主题=认领方式定下来了');
  assert.deepEqual(
    whole.spans,
    [{ from: 1, attribution: { kind: 'continue', id: 'th_ab12', topic: '认领方式定下来了' } }],
    '无范围 = 整段（单话题行逐字兼容）',
  );

  const openEnd = readThreadSpans('线索: 5- 继续 th_ab12');
  assert.deepEqual(openEnd.spans[0], { from: 5, attribution: { kind: 'continue', id: 'th_ab12' } }, '到段尾');

  const single = readThreadSpans('线索: 3 新 | 单轮转折');
  assert.deepEqual(single.spans[0], { from: 3, to: 3, attribution: { kind: 'new', topic: '单轮转折' } });

  const fitted = readThreadSpans('线索: 继续 th_ab12\n线索: 7 新 | 后半段');
  assert.deepEqual(
    fitted.spans,
    [
      { from: 1, to: 6, attribution: { kind: 'continue', id: 'th_ab12' } },
      { from: 7, to: 7, attribution: { kind: 'new', topic: '后半段' } },
    ],
    '开头没写止的段停在下一条线索之前——否则 find-first 永远走不到后面的行；裸数字=单轮',
  );
});

test('spans: the three observation states stay apart', () => {
  assert.equal(readThreadSpans('线索: 无').line, 'absent');
  assert.equal(readThreadSpans('事实: 没有线索行').line, 'absent');
  assert.equal(readThreadSpans('线索: 1-2 胡言乱语').line, 'invalid');

  const mixed = readThreadSpans('线索: 瞎写\n线索: 继续 th_ab12');
  assert.equal(mixed.line, 'present', '有一行可用就算 present——多行坏行不该拖垮整份答案');
  assert.equal(mixed.bad, '线索: 瞎写', '坏行仍然可查，不是只计数');

  // A date must not be read as a range: 2026-10-24 is not turns 2026..10.
  assert.equal(readThreadSpans('线索: 2026-10-24 继续 th_ab12').line, 'invalid');
});

/* ---------------- the apply: every turn of the segment gets a thread ---------------- */

function segment() {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, ...base });
  // Host turn numbers jump by 10–30 per exchange; prompt numbers are 1..n. Both ride
  // along, and spans must match the prompt numbers while threads count the real ones.
  const turns = [
    { promptNo: 1, turnNo: 10, turnId: 't1', at: 1000, fallbackTopic: '第一句' },
    { promptNo: 2, turnNo: 25, turnId: 't2', at: 2000, fallbackTopic: '第二句' },
    { promptNo: 3, turnNo: 40, turnId: 't3', at: 3000, fallbackTopic: '第三句' },
  ];
  for (const turn of turns) {
    store.putTurn({
      ...base,
      id: turn.turnId,
      sessionId: 'sess',
      turnNo: turn.turnNo,
      startedAt: turn.at,
      userText: turn.fallbackTopic,
      steps: [],
    });
  }
  return { store, soul, turns };
}

test('spans: two topics in one segment → two threads, every turn attached', () => {
  const { store, soul, turns } = segment();
  const head = store.openThread({ ...base, sessionId: 'sess', topic: '原话题', openedAt: 1, turnNo: 1 });

  const applied = soul.applyThreadSpans(
    [
      { from: 1, to: 2, attribution: { kind: 'continue', id: head.id } },
      { from: 3, attribution: { kind: 'new', topic: '另一个话题' } },
    ],
    { sessionId: 'sess', turns },
  );

  assert.equal(applied.length, 3);
  assert.equal(applied[0].threadId, head.id);
  assert.equal(applied[1].threadId, head.id, '前两轮是同一段');
  assert.notEqual(applied[2].threadId, head.id, '第三轮切出新线索');
  assert.equal(applied[2].created, true);
  assert.equal(applied[2].topic, '另一个话题');
  // The whole point of ③: before, one attribution attached one turn and the rest of
  // the segment carried no thread — handoff, candidates and consolidation saw a hole.
  assert.equal(soul.turnThreadId('t1'), head.id);
  assert.equal(soul.turnThreadId('t2'), head.id);
  assert.equal(soul.turnThreadId('t3'), applied[2].threadId, '段里每一轮都挂上线索');
  // Threads count REAL turn numbers, not prompt positions.
  assert.equal(store.thread(head.id)?.lastTurnNo, 25);
  assert.equal(store.thread(applied[2].threadId)?.lastTurnNo, 40);
  store.close();
});

test('spans: a turn no span covers chains to the previous turn (ADR 0034)', () => {
  const { store, soul, turns } = segment();
  // Explicit single-turn ranges leave a hole at turn 2 (an open first range would be
  // fitted to 1-2 by the parser — that case is pinned in the parse test above).
  const applied = soul.applyThreadSpans(
    [
      { from: 1, to: 1, attribution: { kind: 'new', topic: '话题 A' } },
      { from: 3, to: 3, attribution: { kind: 'new', topic: '话题 B' } },
    ],
    { sessionId: 'sess', turns },
  );
  assert.equal(applied[1].threadId, applied[0].threadId, '没被范围覆盖的轮接前一轮的线索');
  assert.equal(applied[1].joinReason, 'fallback-previous');
  assert.notEqual(applied[2].threadId, applied[1].threadId, '有答案的轮按答案走');
  assert.equal(soul.turnThreadId('t2'), applied[0].threadId, '兜底的轮也挂上了');
  store.close();
});

test('spans: a new span opens ONE thread for its whole run', () => {
  const { store, soul, turns } = segment();
  const applied = soul.applyThreadSpans([{ from: 1, to: 2, attribution: { kind: 'new', topic: '同一话题两轮' } }], {
    sessionId: 'sess',
    turns,
  });
  // The model named one topic for a run; applying its answer per turn would open a
  // same-topic clone on every turn — fragmentation by another name.
  assert.equal(applied[1].threadId, applied[0].threadId, '段内第 2 轮不开克隆线索');
  assert.equal(applied[1].joinReason, 'continue');
  assert.equal(store.thread(applied[0].threadId)?.topic, '同一话题两轮');
  assert.equal(soul.turnThreadId('t2'), applied[0].threadId);
  store.close();
});

test('spans: no answer at all chains every turn to the previous thread', () => {
  const { store, soul, turns } = segment();
  const previous = store.openThread({ ...base, sessionId: 'sess', topic: '之前的线索', openedAt: 1, turnNo: 1 });

  const applied = soul.applyThreadSpans(undefined, {
    sessionId: 'sess',
    turns,
    previousThreadId: previous.id,
  });
  assert.deepEqual(
    applied.map((entry) => entry.threadId),
    [previous.id, previous.id, previous.id],
    '模型没给线索时，整段默认继续（ADR 0034）',
  );
  assert.ok(applied.every((entry) => entry.joinReason === 'fallback-previous'));
  store.close();
});

test('spans: without any hint the first turn opens and the rest follow it', () => {
  const { store, soul, turns } = segment();
  const applied = soul.applyThreadSpans(undefined, { sessionId: 'sess', turns });
  assert.equal(applied[0].joinReason, 'no-context');
  assert.equal(applied[1].threadId, applied[0].threadId);
  assert.equal(applied[1].joinReason, 'fallback-previous');
  assert.equal(applied[2].threadId, applied[0].threadId, '整段进同一条兜底线索，不逐轮开新');
  assert.equal(soul.turnThreadId('t3'), applied[0].threadId);
  store.close();
});
