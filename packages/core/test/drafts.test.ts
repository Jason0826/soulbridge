import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { extractByRules, extractWithModel, validateDraft } from '../src/extract.ts';

const NOW = new Date('2026-10-31T12:00:00+08:00').getTime();

test('rules: person, relation, time and verb from one sentence', () => {
  const draft = extractByRules('我同事小林上周被裁员了，挺难受的', NOW);
  assert.equal(draft.by, 'rules');
  assert.equal(draft.entities[0].name, '小林');
  assert.deepEqual(draft.entities[0].attrs, { relation: '同事' });
  const fact = draft.facts[0];
  assert.equal(fact.typeName, '裁员');
  assert.equal(fact.atText, '上周');
  assert.equal(fact.source, 'told');
  const slot = fact.slots[0];
  assert.equal(slot.slot, '被裁员者', 'passive voice picks the passive slot');
  assert.deepEqual(slot.value, { kind: 'entity', entityName: '小林', entityType: 'person' });
});

test('rules: an event with no person still becomes a fact', () => {
  const draft = extractByRules('今天下雨了', NOW);
  assert.equal(draft.facts.length, 1);
  assert.equal(draft.facts[0].slots.length, 0, 'no invented entity for the weather');
  assert.equal(draft.facts[0].atText, '今天');
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
  assert.match(broken.error ?? '', /json/i);
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

  const draft = await soul.extract('我同事小林上周被裁员了', { at: NOW });
  const first = soul.commitDrafts(draft, { at: NOW });
  assert.equal(first.entities.length, 1);
  assert.equal(first.facts.length, 1);
  assert.equal(first.skipped.length, 0);

  const fact = first.facts[0];
  assert.equal(fact.atText, '上周');
  const slot = fact.slots[0];
  assert.equal(slot.value.kind, 'entity');
  const entityId = slot.value.kind === 'entity' ? slot.value.entityId : '';
  assert.equal(first.entities[0].id, entityId, 'slot points at the entity that was written');

  const second = soul.commitDrafts(draft, { at: NOW });
  assert.equal(second.facts.length, 0);
  assert.equal(second.skipped[0].reason, 'duplicate');
  assert.equal(store.facts({ soulId: 's1', userId: 'u1' }).length, 1, 'still one fact');
  store.close();
});

test('commit: a fact with neither slot nor time is refused and reported', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const result = soul.commitDrafts({
    entities: [],
    facts: [{ statement: '唔', source: 'told', confidence: 0.5, slots: [] }],
    gaps: [],
    by: 'rules',
  });
  assert.equal(result.facts.length, 0);
  assert.equal(result.skipped[0].reason, 'no slots and no time');
  store.close();
});
