/**
 * Supersede must be a mechanism, not an API (2026-11-03 afternoon review, 3.2).
 *
 * The review found `supersede()` with no business caller: the model could extract "小林去了
 * B 公司" and the old "小林在 A 公司" stayed active forever. The fix is one keyed field on
 * the fact line (`操作=取代 <id>`), with the id verified by the gate — the model names the
 * predecessor, the code decides whether that predecessor is real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { parseLineDraft, validateDraft } from '../src/extract.ts';

const base = { soulId: 's1', userId: 'u1' };
const NOW = Date.parse('2026-11-03T02:00:00Z');

function soul() {
  const store = openSqlite(':memory:');
  const s = new Soul({ store, ...base });
  store.putTurnPair({
    id: 'tp_1',
    soulId: 's1',
    userId: 'u1',
    sessionId: 'sess',
    turn: 1,
    at: NOW,
    userText: '小林在 A 公司',
    assistantText: '记下了',
    metadata: {},
    createdAt: NOW,
  });
  return { s, store };
}

function seedOld(s: Soul): string {
  const result = s.commitDrafts(
    {
      entities: [{ name: '小林', type: 'person' }],
      facts: [{ statement: '小林在 A 公司', source: 'told', confidence: 0.8, slots: [] }],
      gaps: [],
      by: 'llm',
    },
    { turnId: 'tp_1' },
  );
  return result.facts[0].id;
}

test('supersede: 操作=取代 <id> parses into a supersede operation', () => {
  const raw = '事实: 小林去了 B 公司 | 工作 | | | told | 0.8 | 操作=取代 fc_old1';
  const { draft } = validateDraft(parseLineDraft(raw));
  assert.equal(draft?.operations?.[0].op, 'supersede');
  assert.equal(draft?.operations?.[0].targetId, 'fc_old1');
});

test('supersede: a valid target retires the old fact and links the new one', () => {
  const { s, store } = soul();
  const oldId = seedOld(s);

  const { draft } = validateDraft(parseLineDraft(`事实: 小林去了 B 公司 | 工作 | | | told | 0.8 | 操作=取代 ${oldId}`));
  const result = s.commitDrafts(draft!, { turnId: 'tp_1' });

  const old = store.fact(oldId);
  assert.equal(old?.status, 'superseded', '旧事实退休');
  assert.equal(old?.supersededBy, result.facts[0].id);
  store.close();
});

test('supersede: a hallucinated id degrades to an add and reports the reason', () => {
  const { s, store } = soul();
  const { draft } = validateDraft(parseLineDraft('事实: 小林去了 B 公司 | 工作 | | | told | 0.8 | 操作=取代 fc_does_not_exist'));
  const result = s.commitDrafts(draft!, { turnId: 'tp_1' });

  assert.equal(result.facts.length, 1, '句子不丢');
  assert.match(result.skipped[0]?.reason ?? '', /unknown-supersede-target/);
  store.close();
});

test('supersede: 取代 without an id is reported, not silently treated as add', () => {
  const { s, store } = soul();
  const { draft } = validateDraft(parseLineDraft('事实: 小林去了 B 公司 | 工作 | | | told | 0.8 | 操作=取代'));
  const result = s.commitDrafts(draft!, { turnId: 'tp_1' });

  assert.equal(result.facts.length, 1);
  assert.match(result.skipped[0]?.reason ?? '', /unknown-supersede-target/);
  store.close();
});
