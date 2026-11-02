/**
 * The failure this guards: "上次和 a 吃饭" answered with whatever topic closed last.
 *
 * Subject first, cue second. And the entity timeline must never look outside its
 * subject — saying nothing is acceptable, saying b when asked about a is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { planRetrieval } from '../src/retrieval.ts';

test('router: the subject decides the primitive, not the word 上次', () => {
  const names = ['a', 'c', '核桃', '核桃暗号'];
  assert.deepEqual(planRetrieval('上次和 a 吃饭是什么时候', names), {
    primitive: 'entity',
    subject: 'a',
    reason: 'mentions "a"',
  });
  assert.equal(planRetrieval('上次和 c 吃饭是什么时候', names).subject, 'c');
  // Longest name wins: 核桃暗号 must not degrade to 核桃.
  assert.equal(planRetrieval('核桃暗号的规则是什么', names).subject, '核桃暗号');
});

test('router: without a subject, 上次 means conversation continuity', () => {
  const plan = planRetrieval('上次聊到哪了', []);
  assert.equal(plan.primitive, 'continuity');
});

test('router: a time word without a subject is a window, not continuity', () => {
  assert.equal(planRetrieval('上周都发生了什么', []).primitive, 'time');
});

test('router: no subject and no cue falls back to relevance', () => {
  assert.equal(planRetrieval('这个方案还行吗', []).primitive, 'related');
});

test('latestAbout: an entity timeline never leaves its subject', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const a = store.putEntity({ soulId: 's1', userId: 'u1', type: 'person', name: 'a', seenAt: 1 });
  const c = store.putEntity({ soulId: 's1', userId: 'u1', type: 'person', name: 'c', seenAt: 1 });
  store.putFact({
    soulId: 's1',
    userId: 'u1',
    id: 'f1',
    statement: '用户与a初次见面时一起吃了火锅',
    at: 1000,
    slots: [{ slot: '对象', value: { kind: 'entity', entityId: a.id } }],
  });
  store.putFact({
    soulId: 's1',
    userId: 'u1',
    id: 'f2',
    statement: '用户和c吵架了',
    at: 2000,
    slots: [{ slot: '对象', value: { kind: 'entity', entityId: c.id } }],
  });

  assert.deepEqual(soul.latestAbout('a').map((fact) => fact.id), ['f1']);
  assert.deepEqual(soul.latestAbout('c').map((fact) => fact.id), ['f2']);
  // No memory about d is an answer, not an error.
  assert.deepEqual(soul.latestAbout('d'), []);
  store.close();
});

test('latestAbout: a predicate narrows inside the subject', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const a = store.putEntity({ soulId: 's1', userId: 'u1', type: 'person', name: 'a', seenAt: 1 });
  store.putFact({
    soulId: 's1',
    userId: 'u1',
    id: 'f1',
    statement: '用户与a吃了火锅',
    at: 1000,
    slots: [{ slot: '对象', value: { kind: 'entity', entityId: a.id } }],
  });
  store.putFact({
    soulId: 's1',
    userId: 'u1',
    id: 'f2',
    statement: 'a换了工作',
    at: 2000,
    slots: [{ slot: '对象', value: { kind: 'entity', entityId: a.id } }],
  });

  assert.deepEqual(soul.latestAbout('a', { predicate: '火锅' }).map((fact) => fact.id), ['f1']);
  assert.deepEqual(soul.latestAbout('a', { predicate: '吵架' }), []);
  store.close();
});
