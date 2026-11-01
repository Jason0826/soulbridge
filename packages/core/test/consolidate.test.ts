import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { gateConclusion, parseConclusionDraft, parseVerificationDraft } from '../src/consolidate.ts';
import { renderConsolidationPrompt, renderVerificationPrompt } from '../src/prompts.ts';

const base = { soulId: 's1', userId: 'u1' };

function seed() {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const a = store.putFact({ ...base, statement: '用户讨厌同一件事反复讲', at: 1000 });
  const b = store.putFact({ ...base, statement: '用户说换工具又要重新交代很烦', at: 2000 });
  return { store, soul, a, b };
}

test('gate: one citation is a fact, not a conclusion', () => {
  const result = gateConclusion({
    draft: { statement: '用户讨厌反复交代', evidence: ['fc_a'], confidence: 0.9 },
    allowed: new Set(['fc_a']),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, />=2 evidence/);
});

test('gate: evidence outside the batch is refused', () => {
  const result = gateConclusion({
    draft: { statement: '用户讨厌反复交代', evidence: ['fc_a', 'fc_ghost'], confidence: 0.8 },
    allowed: new Set(['fc_a', 'fc_b']),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not in batch/);
});

test('gate: an absolute word that the evidence never used is over-generalisation', () => {
  const strict = gateConclusion({
    draft: { statement: '用户讨厌一切重复劳动', evidence: ['fc_a', 'fc_b'], confidence: 0.8 },
    allowed: new Set(['fc_a', 'fc_b']),
  });
  assert.equal(strict.ok, false);
  assert.match(strict.reason, /over-generalised/);

  // Quoting the user is different from inventing the rule.
  const quoted = gateConclusion({
    draft: {
      statement: '用户说从来不接受反复交代',
      evidence: ['fc_a', 'fc_b'],
      confidence: 0.8,
      evidenceText: '用户说从来不接受反复交代',
    },
    allowed: new Set(['fc_a', 'fc_b']),
  });
  assert.equal(quoted.ok, true);
});

test('gate: two citations pass and confidence is clamped', () => {
  const result = gateConclusion({
    draft: { statement: '用户讨厌同一件事反复交代', evidence: ['fc_a', 'fc_b'], confidence: 3 },
    allowed: new Set(['fc_a', 'fc_b']),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.confidence, 1);
});

test('parse: a conclusion line becomes a draft; 无 means nothing', () => {
  const draft = parseConclusionDraft('结论: 用户讨厌反复交代 | 证据=fc_a,fc_b | 置信=0.7');
  assert.equal(draft?.statement, '用户讨厌反复交代');
  assert.deepEqual(draft?.evidence, ['fc_a', 'fc_b']);
  assert.equal(draft?.confidence, 0.7);
  assert.equal(parseConclusionDraft('无'), null);
  assert.equal(parseConclusionDraft('好的，我来归纳'), null);
});

test('parse: verification verdicts map to three outcomes', () => {
  assert.equal(parseVerificationDraft('判定: 支持 | 依据=fc_a,fc_b | 理由=都说了反复')?.verdict, 'supported');
  assert.equal(parseVerificationDraft('判定: 部分支持 | 理由=只有一条提到')?.verdict, 'partial');
  assert.equal(parseVerificationDraft('判定: 不支持 | 理由=说的是另一件事')?.verdict, 'unsupported');
});

test('record: a conclusion is a fact held by the soul, with evidence slots', () => {
  const { store, soul, a, b } = seed();
  const result = soul.recordConclusion(
    { statement: '用户讨厌同一件事反复交代', evidence: [a.id, b.id], confidence: 0.6 },
    { allowed: [a.id, b.id] },
  );
  assert.equal(result.ok, true);
  const fact = result.fact;
  assert.equal(fact?.typeName, '结论');
  assert.equal(fact?.holder, 'self');
  assert.equal(fact?.slots.length, 2);
  assert.deepEqual(fact?.slots.map((slot) => slot.value), [
    { kind: 'fact', factId: a.id },
    { kind: 'fact', factId: b.id },
  ]);

  assert.equal(soul.conclusions().length, 1);
  store.close();
});

test('record: a conflicting conclusion supersedes the old one instead of piling up', () => {
  const { store, soul, a, b } = seed();
  const first = soul.recordConclusion(
    { statement: '用户讨厌同一件事反复交代', evidence: [a.id, b.id], confidence: 0.6 },
    { allowed: [a.id, b.id] },
  );
  const second = soul.recordConclusion(
    {
      statement: '用户只在切换工具时介意重复交代',
      evidence: [a.id, b.id],
      confidence: 0.7,
      supersedes: first.fact!.id,
    },
    { allowed: [a.id, b.id] },
  );
  assert.equal(second.ok, true);
  assert.equal(second.superseded, first.fact!.id);
  assert.equal(store.fact(first.fact!.id)?.status, 'superseded');

  const current = soul.conclusions();
  assert.equal(current.length, 1);
  assert.equal(current[0].statement, '用户只在切换工具时介意重复交代');
  store.close();
});

test('prompts: draft and verification are separate, and the check never sees the draft', () => {
  const draft = renderConsolidationPrompt({
    facts: [{ id: 'fc_a', statement: '用户讨厌反复讲' }],
    existing: [],
  });
  assert.match(draft, /<facts>/);
  assert.match(draft, /两条证据支持/);
  assert.match(draft, /不许放大/);

  const verify = renderVerificationPrompt({
    conclusion: '用户讨厌反复交代',
    facts: [{ id: 'fc_a', statement: '用户讨厌反复讲' }],
  });
  assert.match(verify, /<conclusion>/);
  assert.match(verify, /直接/);
  // The check must stay independent: no draft reasoning, no extraction rules.
  assert.doesNotMatch(verify, /归纳器/);
  assert.doesNotMatch(verify, /置信/);
});

test('prompts: a threaded consolidation shows the turns and demands the ending', () => {
  const prompt = renderConsolidationPrompt({
    facts: [{ id: 'f1', statement: '用户想分三层' }, { id: 'f2', statement: '用户决定先做线索层' }],
    existing: [],
    thread: { topic: '记忆分三层', turns: ['用户：记忆分三层', '用户：cookie 失效', '用户：回到三层怎么落地'] },
  });
  assert.match(prompt, /<thread>/);
  assert.match(prompt, /3\. 用户：回到三层怎么落地/);
  assert.match(prompt, /覆盖到最后一次回来/);
});