/**
 * The gate is a labeller, not a filter (live trace: 40 of 45 refusals were one slot).
 *
 * A fact whose slot named an undeclared entity was deleted whole, and a fact with no
 * slot and no time was deleted too — even when it was a stance whose holder is itself
 * the way back. The rule now: a readable sentence is kept. An undeclared slot becomes
 * text (no entity invented), an unknown holder falls back to the world layer, and
 * only unreadable statements and exact duplicates are refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

const base = { soulId: 's1', userId: 'u1' };

function soul() {
  const store = openSqlite(':memory:');
  const s = new Soul({ store, ...base });
  return { s, store };
}

test('gate: an undeclared entity slot is kept as text, and the fact survives', () => {
  const { s, store } = soul();
  const result = s.commitDrafts({
    entities: [{ name: '小林', type: 'person' }],
    facts: [
      {
        statement: '小林用 PowerShell 改了配置',
        source: 'told',
        confidence: 0.8,
        slots: [
          { slot: '执行者', value: { kind: 'entity', entityName: '小林' } },
          { slot: '工具', value: { kind: 'entity', entityName: 'PowerShell 改代码' } },
        ],
      },
    ],
    gaps: [],
    by: 'llm',
  });
  assert.equal(result.facts.length, 1, '一句话不能因为一个槽位被删掉');
  assert.deepEqual(result.droppedSlots.map((slot) => slot.value), ['PowerShell 改代码']);
  assert.equal(result.skipped.length, 0);
  const stored = store.facts({ ...base, limit: 5 })[0];
  const slots = store.fact(stored.id)?.slots ?? [];
  const tool = slots.find((slot) => slot.slot === '工具');
  assert.equal(tool?.value.kind, 'text', '未声明的名字保留为文本，不建实体');
  const performer = slots.find((slot) => slot.slot === '执行者');
  assert.equal(performer?.value.kind, 'entity', '声明的名字仍然是实体');
  store.close();
});

test('gate: a stance with no slot and no time is kept, anchored by its holder', () => {
  const { s, store } = soul();
  const result = s.commitDrafts({
    entities: [{ name: '用户', type: 'person' }],
    facts: [
      {
        statement: '用户要求把改动流程做成 checklist',
        holder: '用户',
        source: 'experienced',
        confidence: 0.9,
        slots: [],
      },
    ],
    gaps: [],
    by: 'llm',
  });
  assert.equal(result.facts.length, 1);
  const fact = result.facts[0];
  assert.notEqual(fact.holder, 'world', '持有人是人物层，不是世界层');
  store.close();
});

test('gate: a sentence with nothing but words is kept and remains findable by text', () => {
  const { s, store } = soul();
  const result = s.commitDrafts({
    entities: [],
    facts: [{ statement: '今天很热', source: 'told', confidence: 0.6, slots: [] }],
    gaps: [],
    by: 'rules',
  });
  assert.equal(result.facts.length, 1);
  assert.equal(store.facts({ ...base, limit: 5 }).length, 1);
  store.close();
});

test('gate: an unknown holder falls back to the world layer instead of dropping', () => {
  const { s, store } = soul();
  const result = s.commitDrafts({
    entities: [{ name: 'a', type: 'person' }],
    facts: [
      {
        statement: '用户觉得这个方案可行',
        holder: '用户',
        source: 'told',
        confidence: 0.6,
        slots: [{ slot: '提出者', value: { kind: 'entity', entityName: 'a' } }],
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

test('gate: an unreadable statement and an exact duplicate are still refused', () => {
  const { s, store } = soul();
  const draft = {
    entities: [],
    facts: [{ statement: '   ', source: 'told' as const, confidence: 0.5, slots: [] }],
    gaps: [],
    by: 'rules' as const,
  };
  assert.equal(s.commitDrafts(draft).skipped[0].reason, 'empty statement');

  const once = {
    entities: [],
    facts: [{ statement: '今天很热', atText: '今天', source: 'told' as const, confidence: 0.6, slots: [] }],
    gaps: [],
    by: 'rules' as const,
  };
  assert.equal(s.commitDrafts(once).facts.length, 1);
  const again = s.commitDrafts(once, { at: Date.now() + 1000 });
  assert.equal(again.facts.length, 0);
  assert.equal(again.skipped[0].reason, 'duplicate');
  store.close();
});

test('gate: the three counters add up to what the model wrote', () => {
  const { s, store } = soul();
  const result = s.commitDrafts({
    entities: [{ name: '小林', type: 'person' }],
    facts: [
      { statement: '小林今天加班', source: 'told', confidence: 0.7, slots: [{ slot: '主体', value: { kind: 'entity', entityName: '小林' } }] },
      { statement: '用户讨厌重复', holder: '陌生人', source: 'told', confidence: 0.8, slots: [] },
      { statement: '用 PowerShell 改', source: 'told', confidence: 0.6, slots: [{ slot: '工具', value: { kind: 'entity', entityName: 'PowerShell' } }] },
    ],
    gaps: [],
    by: 'llm',
  });
  assert.equal(result.facts.length, 3, '三条都进库');
  assert.equal(result.droppedSlots.length, 1);
  assert.equal(result.holderFallbacks.length, 1);
  assert.equal(result.skipped.length, 0);
  store.close();
});
