/**
 * 0027 §八, reader 1: "上周发生了什么" is answered from a time window over facts —
 * and only facts whose date is locatable (day / range) enter it.
 *
 * The failure this guards: for an unknown-precision fact, `valid_from` is often the day
 * we *recorded* it. Filtering a window on `valid_from` alone would answer "what happened
 * last week" with "what we wrote down last week" — the same mistake as v14's 247 guessed
 * expiries (brief 0027 §一), one layer up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { planRetrieval } from '../src/retrieval.ts';
import { findWindow } from '../src/time.ts';

const DAY = 86_400_000;
const base = { soulId: 's1', userId: 'u1' };

test('findWindow: "上周" becomes one week that starts on a Monday', () => {
  const window = findWindow('上周都发生了什么', Date.now());
  assert.ok(window, 'a resolvable cue yields a window');
  assert.equal(window.cue, '上周');
  assert.equal(window.to - window.from, 7 * DAY, 'one calendar week');
  const start = new Date(window.from);
  assert.equal(start.getDay(), 1, 'weeks start on Monday');
  assert.equal(start.getHours(), 0, 'a window starts at a day boundary');
});

test('findWindow: a day cue is one day, a mixed question still resolves one window', () => {
  const window = findWindow('昨天都发生了什么', Date.now());
  assert.ok(window);
  assert.equal(window.cue, '昨天');
  assert.equal(window.to - window.from, DAY);
});

test('findWindow: a cue that cannot be located yields nothing, not a guess', () => {
  // "那天" and "当时" are time cues the router still recognises, but they point at a
  // context no calendar can supply. No window is the honest answer.
  assert.equal(findWindow('那天都发生了什么', Date.now()), undefined);
  assert.equal(findWindow('这个方案还行吗', Date.now()), undefined);
});

test('planRetrieval: a time question carries the window it resolved', () => {
  const plan = planRetrieval('上周都发生了什么', []);
  assert.equal(plan.primitive, 'time');
  assert.ok(plan.window, 'the router resolves the cue in one place');
  const unresolved = planRetrieval('那天都发生了什么', []);
  assert.equal(unresolved.primitive, 'time', 'a cue is still a time question');
  assert.equal(unresolved.window, undefined, 'but nothing is located');
});

test('factsInWindow: only day/range facts enter, unknown never does', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const at = 5 * DAY;
  const put = (id: string, extra: Record<string, unknown>) =>
    store.putFact({ ...base, id, statement: `事实 ${id}`, validFrom: at, ...extra });

  put('day', { validFromPrecision: 'day' });
  put('range', { validFromPrecision: 'range' });
  // The trap: same valid_from, but the date is not locatable. This is the day we
  // recorded it, and it must not answer "what happened then".
  put('unknown', { validFromPrecision: 'unknown' });
  put('relative', { validFromPrecision: 'relative' });
  put('retracted', { validFromPrecision: 'day', status: 'retracted' });
  store.putFact({ ...base, id: 'before', statement: '窗口之前', validFrom: at - DAY, validFromPrecision: 'day' });

  const found = soul
    .factsInWindow({ from: at, to: at + DAY })
    .map((fact) => fact.id)
    .sort();
  assert.deepEqual(found, ['day', 'range']);
  store.close();
});

test('factsInWindow: the end of a window belongs to the next one', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putFact({ ...base, id: 'edge', statement: '窗口结束那一刻', validFrom: 7 * DAY, validFromPrecision: 'day' });
  assert.deepEqual(soul.factsInWindow({ from: 0, to: 7 * DAY }), [], 'half-open [from, to)');
  assert.equal(soul.factsInWindow({ from: 7 * DAY, to: 8 * DAY }).length, 1);
  store.close();
});

test('factsInWindow: an empty window is an empty answer, not an error', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  assert.deepEqual(soul.factsInWindow({ from: 0, to: DAY }), []);
  store.close();
});
