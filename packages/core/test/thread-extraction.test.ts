import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { renderExtractionPrompt } from '../src/prompts.ts';
import { validateDraft } from '../src/extract.ts';

const base = { soulId: 's1', userId: 'u1' };
const NOW = new Date('2026-11-04T12:00:00+08:00').getTime();

test('thread prompt: every turn is numbered, both sides labelled', () => {
  const prompt = renderExtractionPrompt({
    now: NOW,
    turns: [
      { turnNo: 1, userText: '小林 2020 年入职 A 公司', startedAt: NOW - 86400000 },
      { turnNo: 2, userText: '她最近怎么样', assistantText: '她 10-24 被裁员了' },
    ],
  });
  assert.match(prompt, /<turn n="1"[^>]*>\n\s+用户：小林 2020 年入职 A 公司/);
  assert.match(prompt, /<turn n="2"[^>]*>\n\s+用户：她最近怎么样\n\s+我：她 10-24 被裁员了/);
});

test('draft parsing: 轮次 becomes sourceTurnNo, and the writer maps it to a turn id', () => {
  const parsed = validateDraft({
    facts: [{ statement: '小林 2024-10-24 被裁员', source: 'told', confidence: 0.8, source_turn_no: 2 }],
    operations: [],
  });
  assert.ok(parsed.draft);
  assert.equal(parsed.draft.facts[0].sourceTurnNo, 2);

  const store = openSqlite(':memory:');
  const soul = new Soul({ store, ...base });
  soul.rememberEntity('小林', 'person');
  const result = soul.commitDrafts(parsed.draft, {
    turnIds: { 1: 'tp_one', 2: 'tp_two' },
    now: NOW,
  });
  assert.equal(result.facts[0].sourceTurnId, 'tp_two');
  store.close();
});

test('self-containment: a person-layer fact that never names the person is refused', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, ...base });
  soul.rememberEntity('小林', 'person');
  const result = soul.commitDrafts({
    entities: [],
    facts: [
      {
        statement: '10-24 被裁员了',
        holder: '小林',
        source: 'told',
        confidence: 0.8,
        slots: [],
      },
    ],
    gaps: [],
    by: 'rules',
  });
  assert.equal(result.facts.length, 0);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['not-self-contained:小林']);
  store.close();
});

test('extract: a thread is one model call and the fact names its turn', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, ...base });
  soul.rememberEntity('小林', 'person');
  let seenPrompt = '';
  const llm = async (prompt: string) => {
    seenPrompt = prompt;
    return [
      '事实: 小林 2024-10-24 被裁员 | 裁员 | 2024-10-24 | 10-24 | told | 0.8 | 持有=world | 精度=day | 轮次=2',
    ].join('\n');
  };
  const turns = [
    { turnNo: 1, userText: '小林 2020 年入职 A 公司', startedAt: NOW - 86_400_000 },
    { turnNo: 2, userText: '她 10-24 被裁员了', assistantText: '记下了', startedAt: NOW },
  ];
  const draft = await soul.extract('她 10-24 被裁员了', { llm, turns, mode: 'auto', now: NOW });
  assert.match(seenPrompt, /<turn n="1"[^>]*>\n\s+用户：小林 2020 年入职 A 公司/);
  assert.match(seenPrompt, /<turn n="2"[^>]*>\n\s+用户：她 10-24 被裁员了/);
  const result = soul.commitDrafts(draft, {
    turnId: 'tp_two',
    turnIds: { 1: 'tp_one', 2: 'tp_two' },
    now: NOW,
  });
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].sourceTurnId, 'tp_two');
  store.close();
});
