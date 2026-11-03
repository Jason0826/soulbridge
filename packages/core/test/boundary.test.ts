/**
 * The boundary between what the model decides and what the code decides (ADR 0027).
 *
 * These tests fix the shape decisions that used to be made silently by syntax:
 *   - a slot value is text unless the model marks it as a reference (`@名字`);
 *   - an entity is created only from a declaration that carries its type;
 *   - `holder` never mints an entity from a string.
 *
 * A regression here is a semantic decision leaking back into code, which is exactly the
 * class of bug that produced `en_person_无` and a `person` default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { parseLineDraft, validateDraft } from '../src/extract.ts';

const base = { soulId: 's1', userId: 'u1' };

function soul() {
  const store = openSqlite(':memory:');
  return { s: new Soul({ store, ...base }), store };
}

test('boundary: a plain slot value stays text even when the name is declared', () => {
  const { s, store } = soul();
  const raw = [
    '实体: 小林 | person',
    '事实: 小林被裁员了 | 裁员 | | | told | 0.7 | 被裁员者=小林',
  ].join('\n');
  const { draft } = validateDraft(parseLineDraft(raw));
  const result = s.commitDrafts(draft!, { turnId: 't1' });

  const fact = result.facts[0];
  const slot = fact.slots.find((entry) => entry.slot === '被裁员者');
  assert.equal(slot?.value.kind, 'text', '没有 @ 就不是引用');
  assert.equal(store.findEntities({ soulId: 's1', userId: 'u1' }).length, 1, '只建了声明过的那一个实体');
  store.close();
});

test('boundary: @ turns a declared name into an entity reference', () => {
  const { s, store } = soul();
  const raw = [
    '实体: 小林 | person',
    '事实: 小林被裁员了 | 裁员 | | | told | 0.7 | 被裁员者=@小林',
  ].join('\n');
  const { draft } = validateDraft(parseLineDraft(raw));
  const result = s.commitDrafts(draft!, { turnId: 't1' });

  const slot = result.facts[0].slots.find((entry) => entry.slot === '被裁员者');
  assert.equal(slot?.value.kind, 'entity');
  store.close();
});

test('boundary: an @ reference to an undeclared name degrades to text, not a new entity', () => {
  const { s, store } = soul();
  const raw = '事实: 某人被裁员了 | 裁员 | | | told | 0.7 | 被裁员者=@张三';
  const { draft } = validateDraft(parseLineDraft(raw));
  const result = s.commitDrafts(draft!, { turnId: 't1' });

  const slot = result.facts[0].slots.find((entry) => entry.slot === '被裁员者');
  assert.equal(slot?.value.kind, 'text');
  assert.equal(result.droppedSlots.length, 1);
  assert.equal(store.findEntities({ soulId: 's1', userId: 'u1' }).length, 0, '不凭空建实体');
  store.close();
});

test('boundary: a holder names an existing entity and never mints one', () => {
  const { s, store } = soul();
  const result = s.commitDrafts(
    {
      entities: [{ name: '小林', type: 'person' }],
      facts: [
        { statement: '小林认为裁员是必然的', source: 'told', confidence: 0.7, holder: '小林', slots: [] },
        { statement: '用户认为这件事应该先验证', source: 'told', confidence: 0.8, holder: '未声明的人', slots: [] },
      ],
      gaps: [],
      by: 'llm',
    },
    { turnId: 't1' },
  );

  const named = result.facts.find((fact) => fact.statement.startsWith('小林'));
  const unknown = result.facts.find((fact) => fact.statement.startsWith('用户'));
  assert.notEqual(named?.holder, 'world', '已知的人作为持有者');
  assert.equal(unknown?.holder, 'world', '未知持有者回落世界层');
  assert.equal(result.holderFallbacks.length, 1);
  // 只有声明的小林：holder 指向它，没有为「未声明的人」建实体
  assert.equal(store.findEntities({ soulId: 's1', userId: 'u1' }).length, 1);
  store.close();
});
