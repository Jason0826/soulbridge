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
import { planRetrieval, subjectCandidate } from '../src/retrieval.ts';

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

test('router: an unknown name is an unknown subject, not an absent one', () => {
  // "上次和 c 吃饭" — c is not in the store. Falling through to continuity would
  // answer with whatever topic closed last, which is the failure this guards.
  const plan = planRetrieval('上次和 c 吃饭是什么时候', ['a']);
  assert.equal(plan.primitive, 'entity');
  assert.equal(plan.subject, 'c');
  assert.match(plan.reason, /unknown subject/);
});

test('router: pronouns and particles are not subjects', () => {
  assert.equal(planRetrieval('上次我和你聊到哪了', []).primitive, 'continuity');
  assert.equal(subjectCandidate('和你说过'), undefined);
  assert.equal(subjectCandidate('和 c 吃饭是什么时候'), 'c');
});

test('router: a one-letter entity does not match inside a word', () => {
  // The live bug: an entity named "a" turned "把 package.json 的版本号改一下" into
  // `entity(a)`, and planBlocks then suppressed the related-conversation block.
  const plan = planRetrieval('把 package.json 的版本号改一下', ['a']);
  assert.equal(plan.primitive, 'related');
  // …but a real mention still routes.
  assert.equal(planRetrieval('上次和 a 吃饭是什么时候', ['a']).subject, 'a');
});

test('router: only people and places can be a subject', () => {
  // Concepts and products match ordinary messages; routing to them is the same bug.
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putEntity({ soulId: 's1', userId: 'u1', type: 'thing', name: '情绪' });
  store.putEntity({ soulId: 's1', userId: 'u1', type: 'thing', name: 'handoff 文件' });
  store.putEntity({ soulId: 's1', userId: 'u1', type: 'person', name: '小林' });
  assert.equal(soul.planRetrieval('我觉得它的情绪不太对').primitive, 'related');
  assert.equal(soul.planRetrieval('看一下 handoff 文件的格式').primitive, 'related');
  assert.equal(soul.planRetrieval('上次和小林吃饭聊了什么').subject, '小林');
  store.close();
});

test('router: a conjunction phrase is not a name', () => {
  // 上次一样 / 数据保持 / 他一起 all used to become subjects, injecting a fake
  // <about-now> for somebody who does not exist.
  for (const text of ['跟上次一样就行', '和数据保持一致', '我和他一起去的', '跟上次聊到的地方一样']) {
    assert.equal(subjectCandidate(text), undefined, text);
  }
});
test('latestAbout: relevance to the question beats plain recency', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const a = store.putEntity({ soulId: 's1', userId: 'u1', type: 'person', name: 'a', seenAt: 1 });
  const now = Date.parse('2026-11-02T00:00:00Z');
  const day = 86_400_000;
  store.putFact({
    soulId: 's1',
    userId: 'u1',
    id: 'old-meal',
    statement: '用户和a一起吃火锅',
    at: now - 100 * day,
    slots: [{ slot: '对象', value: { kind: 'entity', entityId: a.id } }],
  });
  store.putFact({
    soulId: 's1',
    userId: 'u1',
    id: 'new-job',
    statement: 'a换了工作',
    at: now - day,
    slots: [{ slot: '对象', value: { kind: 'entity', entityId: a.id } }],
  });

  // Recency alone would return the job; the question is about the meal.
  assert.equal(soul.latestAbout('a', { limit: 1 })[0]?.id, 'new-job');
  assert.equal(soul.latestAbout('a', { query: '上次和a吃火锅是什么时候', limit: 1 })[0]?.id, 'old-meal');
  store.close();
});

test('latestAbout: a frequently recalled fact decays more slowly', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const a = store.putEntity({ soulId: 's1', userId: 'u1', type: 'person', name: 'a', seenAt: 1 });
  const now = Date.parse('2026-11-02T00:00:00Z');
  const day = 86_400_000;
  // Same age, so the only difference is practice: use must be what moves it.
  for (const [id, daysAgo] of [['practiced', 30], ['fresh', 30]] as const) {
    store.putFact({
      soulId: 's1',
      userId: 'u1',
      id,
      statement: 'a搬家了',
      at: now - daysAgo * day,
      slots: [{ slot: '对象', value: { kind: 'entity', entityId: a.id } }],
    });
  }
  for (let i = 0; i < 20; i += 1) store.recordRecalls(['practiced'], now);

  const ranked = soul.latestAbout('a', { query: '搬家', limit: 2 });
  assert.equal(ranked[0]?.id, 'practiced', 'use slows decay');
  store.close();
});