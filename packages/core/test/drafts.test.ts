import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { extractByRules, extractWithModel, parseLineDraft, validateDraft } from '../src/extract.ts';

const NOW = new Date('2026-10-31T12:00:00+08:00').getTime();

test('rules: person, relation, time and verb from one sentence', () => {
  const draft = extractByRules('我同事小林上周被裁员了，挺难受的', NOW);
  assert.equal(draft.by, 'rules');
  assert.equal(draft.entities[0].name, '小林');
  assert.deepEqual(draft.entities[0].attrs, { relation: '同事' });
  const fact = draft.facts[0];
  assert.equal(fact.typeName, '裁员');
  assert.equal(fact.validFromText, '上周');
  assert.equal(fact.source, 'told');
  const slot = fact.slots[0];
  assert.equal(slot.slot, '被裁员者', 'passive voice picks the passive slot');
  assert.deepEqual(slot.value, { kind: 'entity', entityName: '小林', entityType: 'person' });
});

test('rules: an event with no person still becomes a fact', () => {
  const draft = extractByRules('今天下雨了', NOW);
  assert.equal(draft.facts.length, 1);
  assert.equal(draft.facts[0].slots.length, 0, 'no invented entity for the weather');
  assert.equal(draft.facts[0].validFromText, '今天');
});

test('rules: un uncertainty gap inside one turn binds the pronoun to the last person', () => {
  const draft = extractByRules('我同事小林上周被裁员了。不知道她后来怎么样了', NOW);
  assert.equal(draft.gaps.length, 1);
  assert.equal(draft.gaps[0].aboutEntityName, '小林', '她 refers back to 小林 inside this turn');
  assert.equal(draft.facts.filter((f) => f.source === 'inferred').length, 1, 'a bound pronoun is inferred, not told');
});

test('rules: across turns a bare pronoun is not attached to anyone', () => {
  const draft = extractByRules('不知道她后来怎么样了', NOW);
  assert.equal(draft.gaps.length, 0, 'no guessing across turns');
  assert.equal(draft.facts.length, 0);
});

test('extract: the model goes first even when the rules would match', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const llm = () =>
    '{"entities":[{"name":"小林","type":"person"}],"facts":[{"statement":"模型抽取的结果","slots":[{"slot":"当事人","entity":"小林"}]}],"gaps":[]}';
  const draft = await soul.extract('我同事小林上周被裁员了', { now: NOW, llm });
  assert.equal(draft.by, 'llm', 'model answer wins over the rule draft');
  assert.equal(draft.facts[0].statement, '模型抽取的结果');
  store.close();
});

test('extract: a broken model falls back to the rules instead of losing the turn', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const draft = await soul.extract('我同事小林上周被裁员了', {
    now: NOW,
    llm: () => {
      throw new Error('model down');
    },
  });
  assert.equal(draft.by, 'rules');
  assert.equal(draft.entities[0].name, '小林');
  store.close();
});

test('extract: rules mode never calls the model', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  let called = false;
  const draft = await soul.extract('我同事小林上周被裁员了', {
    now: NOW,
    mode: 'rules',
    llm: () => {
      called = true;
      return '{}';
    },
  });
  assert.equal(called, false);
  assert.equal(draft.by, 'rules');
  store.close();
});

test('rules: uncertainty opens a gap instead of asserting', () => {
  const draft = extractByRules('我同事小林被裁员之后就没消息了，不知道她后来怎么样了', NOW);
  assert.equal(draft.gaps.length, 1);
  assert.equal(draft.gaps[0].aboutEntityName, '小林');
  assert.ok(draft.gaps[0].tension > 0);
});

test('rules: small talk yields nothing', () => {
  const draft = extractByRules('好的', NOW);
  assert.equal(draft.facts.length, 0);
  assert.equal(draft.entities.length, 0);
});

test('model: sees existing entities and facts in the prompt', async () => {
  let prompt = '';
  const draft = await extractWithModel(
    '她找到新工作了',
    (p) => {
      prompt = p;
      return '{"entities":[],"operations":[],"gaps":[]}';
    },
    NOW,
    { entities: [{ id: 'en_1', name: '小林', relation: '同事' }], facts: [{ id: 'fc_1', statement: '小林被裁员', validFromText: '上周' }] },
  );
  assert.match(prompt, /<known-entities>/);
  assert.match(prompt, /小林/);
  assert.match(prompt, /\[fc_1\]/);
  assert.equal(draft.draft, null, 'an empty answer is not a draft');
});

test('model: supersede retires the old fact and writes the new one', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const first = soul.commitDrafts({
    entities: [{ name: '小林', type: 'person' }],
    facts: [{ statement: '小林在找工作', validFromText: '上周', source: 'told', confidence: 0.7, slots: [{ slot: '求职者', value: { kind: 'entity', entityName: '小林' } }] }],
    gaps: [],
    by: 'rules',
  });
  const oldFact = first.facts[0];

  const llm = () =>
    `{"entities":[],"operations":[{"op":"supersede","target":"${oldFact.id}",
      "fact":{"statement":"小林找到新工作了","valid_from_text":"今天","source":"told",
              "slots":[{"slot":"入职者","entity":"小林"}]}}],"gaps":[]}`;
  const draft = await soul.extract('小林找到新工作了', { llm, now: NOW });
  const result = soul.commitDrafts(draft, { now: NOW });

  assert.equal(result.facts.length, 1);
  const all = store.facts({ soulId: 's1', userId: 'u1' });
  const retired = all.find((f) => f.id === oldFact.id);
  assert.equal(retired?.status, 'retracted');
  assert.equal(retired?.supersededBy, result.facts[0].id, 'old fact points at its replacement');
  store.close();
});

test('model: an unknown supersede target keeps the news and reports why it did not replace', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const llm = () => '{"operations":[{"op":"supersede","target":"fc_nope","fact":{"statement":"小林搬走了","at_text":"昨天","slots":[{"slot":"搬家者","entity":"小林"}]}}],"entities":[{"name":"小林","type":"person"}],"gaps":[]}';
  const draft = await soul.extract('小林搬走了', { llm, now: NOW });
  // The writer decides whether a predecessor exists (single place for that judgement);
  // the extractor keeps what the model said so the skip report can explain it.
  assert.equal(draft.operations?.[0].op, 'supersede');
  assert.equal(draft.operations?.[0].targetId, 'fc_nope');
  const result = soul.commitDrafts(draft, { now: NOW });
  assert.equal(result.facts.length, 1, '句子不丢');
  assert.match(result.skipped[0]?.reason ?? '', /unknown-supersede-target/);
  store.close();
});

test('model: noop writes nothing', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const llm = () => '{"operations":[{"op":"noop"}],"entities":[{"name":"小林","type":"person"}],"gaps":[]}';
  const draft = await soul.extract('好的知道了', { llm, now: NOW });
  const result = soul.commitDrafts(draft, { now: NOW });
  assert.equal(result.facts.length, 0);
  assert.equal(store.facts({ soulId: 's1', userId: 'u1' }).length, 0);
  store.close();
});

test('model: valid JSON becomes a draft; bad JSON is refused', async () => {
  const answer = `好的，结果如下：
{"entities":[{"name":"小林","type":"person","attrs":{"relation":"同事"}}],
 "facts":[{"statement":"小林被裁员","type_name":"裁员","at_text":"上周","source":"told","confidence":0.8,
           "slots":[{"slot":"被裁员者","entity":"小林"},{"slot":"裁员人数","number":300}]}],
 "gaps":[{"topic":"她后来有着落吗","about":"小林"}]}`;
  const ok = await extractWithModel('文本', () => answer, NOW);
  assert.ok(ok.draft);
  assert.equal(ok.draft.by, 'llm');
  assert.equal(ok.draft.facts[0].slots[1].value.kind, 'number');

  const broken = await extractWithModel('文本', () => '我不知道', NOW);
  assert.equal(broken.draft, null);
  // The line template is the primary path now, so the message names the raw text.
  assert.match(broken.error ?? '', /unparseable/i);
});

test('validate: drops what cannot be trusted, keeps the rest', () => {
  const result = validateDraft({
    entities: [{ name: '小林', type: 'person' }, { name: '', type: 'person' }, { name: 'X', type: 'galaxy' }],
    facts: [
      { statement: '小林被裁员', slots: [{ slot: '被裁员者', entity: '小林' }] },
      { statement: '', slots: [] },
    ],
    gaps: [],
  });
  assert.equal(result.draft?.entities.length, 1, 'bad type and empty name dropped');
  assert.equal(result.draft?.facts.length, 1, 'empty statement dropped');
  assert.equal(result.draft?.facts[0].source, 'told', 'missing source defaults to told');
});

test('commit: writes entities, facts and slots; repeats are refused, not duplicated', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });

  const draft = await soul.extract('我同事小林上周被裁员了', { now: NOW });
  const first = soul.commitDrafts(draft, { now: NOW });
  assert.equal(first.entities.length, 1);
  assert.equal(first.facts.length, 1);
  assert.equal(first.skipped.length, 0);

  const fact = first.facts[0];
  assert.equal(fact.validFromText, '上周');
  const slot = fact.slots[0];
  assert.equal(slot.value.kind, 'entity');
  const entityId = slot.value.kind === 'entity' ? slot.value.entityId : '';
  assert.equal(first.entities[0].id, entityId, 'slot points at the entity that was written');

  const second = soul.commitDrafts(draft, { now: NOW });
  assert.equal(second.facts.length, 0);
  assert.equal(second.skipped[0].reason, 'duplicate');
  assert.equal(store.facts({ soulId: 's1', userId: 'u1' }).length, 1, 'still one fact');
  store.close();
});

test('commit: a fact with neither slot nor time is kept (the gate labels, not filters)', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const result = soul.commitDrafts({
    entities: [],
    facts: [{ statement: '唔', source: 'told', confidence: 0.5, slots: [] }],
    gaps: [],
    by: 'rules',
  });
  // A live trace showed 45 of 103 drafted facts deleted by this gate, 40 of them for a
  // single bad slot. The sentence is the thing worth keeping; how it can be found is
  // recorded separately (droppedSlots / holderFallbacks), never by deleting it.
  assert.equal(result.facts.length, 1);
  assert.equal(result.skipped.length, 0);
  store.close();
});

test('commit: time or a holder makes a fact easier to find, but neither is required', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const bare = soul.commitDrafts({
    entities: [],
    facts: [{ statement: '今天很热', source: 'told', confidence: 0.6, slots: [] }],
    gaps: [],
    by: 'rules',
  });
  assert.equal(bare.facts.length, 1, '没有参与者也没有时间，仍然是一句可以按原文找回的话');

  const loose = soul.commitDrafts({
    entities: [],
    facts: [{ statement: '有些闷', source: 'told', confidence: 0.6, slots: [{ slot: '感受', value: { kind: 'text', value: '闷' } }] }],
    gaps: [],
    by: 'rules',
  });
  assert.equal(loose.facts.length, 1);
  assert.equal(loose.facts[0].slots.length, 1, '文本槽位保留，只是不能按实体检索');

  // No participant, but a time. Frame semantics calls the missing participant
  // null-instantiated, and impersonal statements are legitimate facts, so this
  // one is stored — reachable by when, not by who.
  const timed = soul.commitDrafts({
    entities: [],
    facts: [
      {
        statement: '今天很热',
        validFromText: '今天',
        source: 'told',
        confidence: 0.6,
        slots: [{ slot: '天气', value: { kind: 'text', value: '热' } }],
      },
    ],
    gaps: [],
    by: 'rules',
  });
  assert.equal(timed.facts.length, 1);
  store.close();
});
/* ---------------- two layers (ADR 0032) ---------------- */

test('line format: 持有 and 精度 are keyed, so old lines still parse', () => {
  const raw = [
    '实体: 用户 | self | ',
    '实体: 小林 | person | 同事',
    '事实: 小林在 2026-10-24 那周被裁员 | 裁员 | 2026-10-24 | 上周 | told | 0.8 | 持有=world | 精度=day | 被裁员者=小林',
    '事实: 用户认为改 prompt 没用 | 偏好 | | | told | 0.9 | 持有=用户 | 精度=unknown | 提出者=用户',
  ].join('\n');
  const rows = parseLineDraft(raw);
  const operations = (rows?.operations ?? []) as Array<{ fact: Record<string, unknown> }>;
  assert.equal(operations.length, 2);
  const world = operations[0].fact;
  const mind = operations[1].fact;
  assert.equal(world.holder, 'world');
  assert.equal(world.valid_from_precision, 'day');
  assert.equal(mind.holder, '用户');
  assert.equal(mind.valid_from_precision, 'unknown');
  assert.equal((world.slots as unknown[]).length, 1);
});

test('commit: unknown time is kept on the fact, and is not turned into a gap', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const result = soul.commitDrafts({
    entities: [{ name: 'a', type: 'person' }],
    facts: [
      {
        statement: '用户与a吃了火锅',
        holder: 'world',
        validFromPrecision: 'unknown',
        source: 'told',
        confidence: 0.7,
        slots: [{ slot: '对象', value: { kind: 'entity', entityName: 'a', entityType: 'person' } }],
      },
    ],
    gaps: [],
    by: 'rules',
  });
  assert.equal(result.facts.length, 1, 'unknown time is not a reason to discard');
  assert.equal(result.facts[0].validFromPrecision, 'unknown');
  // A missing date is a property of the fact. Turning it into an open question produced 223
  // gaps in two days, none closable, and buried the gaps worth asking about.
  assert.equal(result.gaps.length, 0, 'no gap is opened for an undated fact');
  store.close();
});

test('commit: a fact in someone\'s mind carries that holder and opens no gap', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const result = soul.commitDrafts({
    entities: [
      { name: '用户', type: 'self' },
      { name: 'a', type: 'person' },
    ],
    facts: [
      {
        statement: '用户认为改 prompt 不能让模型稳定输出',
        holder: '用户',
        validFromPrecision: 'unknown',
        source: 'told',
        confidence: 0.8,
        slots: [{ slot: '提出者', value: { kind: 'entity', entityName: '用户', entityType: 'self' } }],
      },
    ],
    gaps: [],
    by: 'rules',
  });
  assert.equal(result.facts.length, 1);
  assert.match(result.facts[0].holder, /^en_/, 'holder is an entity id, not a word');
  assert.equal(result.gaps.length, 0, 'a stance has no event time to ask about');
  store.close();
});

test('commit: an unknown holder falls back to the world layer, not to a deleted fact', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const result = soul.commitDrafts({
    entities: [{ name: 'a', type: 'person' }],
    facts: [
      {
        statement: '用户觉得这个方案可行',
        holder: '用户',
        source: 'told',
        confidence: 0.6,
        slots: [{ slot: '提出者', value: { kind: 'entity', entityName: 'a', entityType: 'person' } }],
      },
    ],
    gaps: [],
    by: 'rules',
  });
  assert.equal(result.facts.length, 1);
  assert.deepEqual(result.holderFallbacks.map((entry) => entry.holder), ['用户']);
  assert.equal(result.facts[0].holder, 'world');
  store.close();
});