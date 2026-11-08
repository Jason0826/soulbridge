import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProfileMergePrompt } from '../src/profile-prompt.ts';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import {
  gateConclusion,
  normalizeStatement,
  parseConclusionDraft,
  parseRelationDraft,
  readVerification,
  parseProfileMerge,
  groupProfileCandidates,
  isDerivedProfileLine,
  parseVerificationDraft,
} from '../src/consolidate.ts';
import { renderConsolidationPrompt, renderVerificationPrompt, renderRuleClassifyPrompt } from '../src/prompts.ts';
import { parseRuleClassifications } from '../src/rules.ts';

const base = { soulId: 's1', userId: 'u1' };

function seed() {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const a = store.putFact({ ...base, statement: '用户讨厌同一件事反复讲', validFrom: 1000 });
  const b = store.putFact({ ...base, statement: '用户说换工具又要重新交代很烦', validFrom: 2000 });
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
  assert.equal(store.fact(first.fact!.id)?.status, 'retracted');

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
/* ---------------- duplicate handling ---------------- */

test('relation: the four kinds parse from one fixed vocabulary', () => {
  assert.deepEqual(parseRelationDraft('关系: 重复 fc_abc | 理由=同一件事'), {
    kind: 'duplicate',
    target: 'fc_abc',
    reason: '同一件事',
  });
  assert.equal(parseRelationDraft('关系: 细化 fc_def | 理由=多了条件')?.kind, 'refine');
  assert.equal(parseRelationDraft('关系: 矛盾 fc_ghi')?.kind, 'conflict');
  assert.deepEqual(parseRelationDraft('关系: 无关'), { kind: 'unrelated', reason: undefined });
  assert.equal(parseRelationDraft('看不懂'), null);
});

test('normalizeStatement: only catches the same text, never a paraphrase', () => {
  assert.equal(normalizeStatement('用户讨厌反复交代。'), normalizeStatement('用户讨厌反复交代'));
  assert.notEqual(normalizeStatement('用户讨厌反复交代'), normalizeStatement('用户讨厌重复劳动'));
});

test('conclusions: a restatement merges its evidence instead of duplicating', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f1', statement: '用户说工具切换很烦' });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f2', statement: '用户说要机制不要 hope' });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f3', statement: '用户说要方法论依据' });

  const first = soul.recordConclusion(
    { statement: '用户要机制不要 hope', evidence: ['f1', 'f2'], confidence: 0.6 },
    { allowed: ['f1', 'f2'] },
  );
  assert.equal(first.ok, true);

  const merged = soul.recordConclusion(
    { statement: '用户倾向方法论依据而不是 prompt 的 hope', evidence: ['f2', 'f3'], confidence: 0.6 },
    { allowed: ['f2', 'f3'], mergeInto: first.fact?.id },
  );
  assert.equal(merged.ok, true);
  assert.equal(merged.merged, first.fact?.id);
  assert.equal(merged.fact, undefined);

  // One conclusion holds all three facts; its wording was not rewritten.
  const held = soul.conclusions(10);
  assert.equal(held.length, 1);
  assert.equal(held[0].statement, '用户要机制不要 hope');
  assert.deepEqual(
    held[0].slots.filter((slot) => slot.slot === '证据').map((slot) => slot.value.kind === 'fact' && slot.value.factId),
    ['f1', 'f2', 'f3'],
  );
  assert.ok(held[0].confidence >= 0.7);
  store.close();
});

test('conclusions: merging never grows evidence from outside the batch', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f1', statement: 'a' });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f2', statement: 'b' });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'x9', statement: '不在本批' });
  const first = soul.recordConclusion({ statement: '用户在工具切换时容易不耐烦', evidence: ['f1', 'f2'], confidence: 0.6 }, { allowed: ['f1', 'f2'] });

  const merged = soul.recordConclusion(
    { statement: '用户在工具切换时容易不耐烦', evidence: ['f1', 'f2', 'x9'], confidence: 0.6 },
    { allowed: ['f1', 'f2'], mergeInto: first.fact?.id },
  );
  assert.equal(merged.merged, first.fact?.id);
  const held = soul.conclusions(10)[0];
  const ids = held.slots.filter((slot) => slot.slot === '证据').map((slot) => slot.value.kind === 'fact' && slot.value.factId);
  assert.deepEqual(ids, ['f1', 'f2']);
  store.close();
});

test('conclusions: candidates put shared evidence first', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  for (const id of ['f1', 'f2', 'f3', 'f4']) store.putFact({ soulId: 's1', userId: 'u1', id, statement: id });
  const unrelated = soul.recordConclusion({ statement: '用户对认证问题的关注点比较具体', evidence: ['f3', 'f4'], confidence: 0.6 }, { allowed: ['f3', 'f4'] });
  const related = soul.recordConclusion({ statement: '用户对工具切换的忍耐度很低', evidence: ['f1', 'f2'], confidence: 0.6 }, { allowed: ['f1', 'f2'] });

  const candidates = soul.conclusionCandidates(['f1', 'f2'], 5);
  assert.equal(candidates[0].id, related.fact?.id);
  assert.equal(candidates[1].id, unrelated.fact?.id);
  store.close();
});
test('conclusions: a conclusion inherits the entities its evidence mentions', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const lin = store.putEntity({ soulId: 's1', userId: 'u1', type: 'person', name: '小林', seenAt: 1 });
  const wu = store.putEntity({ soulId: 's1', userId: 'u1', type: 'thing', name: '核桃', seenAt: 1 });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f1', statement: '小林说核桃要在紧急时用', slots: [{ slot: '说', value: { kind: 'entity', entityId: lin.id } }, { slot: '对象', value: { kind: 'entity', entityId: wu.id } }] });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f2', statement: '小林又强调了一次', slots: [{ slot: '说', value: { kind: 'entity', entityId: lin.id } }] });

  const written = soul.recordConclusion(
    { statement: '小林很在意这个暗号的用法', evidence: ['f1', 'f2'], confidence: 0.6 },
    { allowed: ['f1', 'f2'] },
  );
  const about = written.fact?.slots.filter((slot) => slot.slot === '关于').map((slot) => slot.value.kind === 'entity' && slot.value.entityId);
  assert.deepEqual(about, [lin.id, wu.id], 'both entities are reachable from the conclusion');
  store.close();
});

test('conclusions: candidates match by entity even when evidence is disjoint', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const lin = store.putEntity({ soulId: 's1', userId: 'u1', type: 'person', name: '小林', seenAt: 1 });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f1', statement: '小林换了工作', slots: [{ slot: '谁', value: { kind: 'entity', entityId: lin.id } }] });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f2', statement: '小林不喜欢被催', slots: [{ slot: '谁', value: { kind: 'entity', entityId: lin.id } }] });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f3', statement: '今天吃了火锅', slots: [{ slot: '谁', value: { kind: 'text', value: '用户' } }] });

  soul.recordConclusion({ statement: '小林最近在工作上有些变化', evidence: ['f1', 'f2'], confidence: 0.6 }, { allowed: ['f1', 'f2'] });
  const byEntity = soul.conclusionCandidates([], 5);
  assert.equal(byEntity.length, 1, 'a conclusion about 小林 is found through its entity');
  store.close();
});
test('verification: an empty or unparseable reply is a retry, not a rejection', () => {
  // The draft was never checked; dropping it would lose a thread for nothing.
  assert.equal(readVerification('').kind, 'retry');
  assert.equal(readVerification('   ').kind, 'retry');
  assert.equal(readVerification('我看不懂').kind, 'retry');

  const supported = readVerification('判定: 支持 | 理由=两条事实都提到');
  assert.equal(supported.kind, 'verdict');
  if (supported.kind === 'verdict') assert.equal(supported.verdict.verdict, 'supported');

  const unsupported = readVerification('判定: 不支持 | 理由=只有一条提到');
  assert.equal(unsupported.kind, 'verdict');
  if (unsupported.kind === 'verdict') assert.equal(unsupported.verdict.verdict, 'unsupported');
});
test('profile: merged lines keep only sources that were offered', () => {
  const allowed = new Set(['fc_a', 'fc_b']);
  const lines = parseProfileMerge(
    ['画像: 要机制不要靠自觉 | 维度=工作方式 | 来源=fc_a,fc_b', '画像: 凭空来的判断 | 维度=工作方式 | 来源=fc_zzz', '画像: 短 | 维度=工作方式 | 来源=fc_a'].join('\n'),
    allowed,
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].sources, ['fc_a', 'fc_b']);
});

test('profile: merging supersedes the sources and keeps the trail', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f1', statement: '用户要机制不要 prompt', role: 'profile', typeName: '画像', holder: 'self' });
  store.putFact({ soulId: 's1', userId: 'u1', id: 'f2', statement: '结构化输出优先工具解析', role: 'profile', typeName: '画像', holder: 'self' });

  const written = soul.applyProfileMerge([
    { statement: '要机制，不靠 prompt 自觉', sources: ['f1', 'f2'], dimension: '工作方式' },
  ]);
  assert.equal(written.length, 1);
  assert.equal(soul.profile(8).length, 1, 'the merged line is the active profile');
  assert.equal(store.fact('f1')?.status, 'retracted');
  assert.equal(store.fact('f1')?.supersededBy, written[0].id, 'source points at the merge');
  store.close();
});
test('profile gates: the three bad lines from the live merge are rejected', () => {
  // These are the actual outputs of the first live merge; each is a different failure.
  const allowed = new Set(['fc_a', 'fc_b', 'fc_c', 'fc_d']);
  const lines = parseProfileMerge(
    [
      '画像: 每次因为换工具，换模型而要重复去讲 | 维度=沟通偏好 | 来源=fc_a', // fragment
      '画像: 有时候希望先讨论 | 维度=沟通偏好 | 来源=fc_b', // hedged
      '画像: 一切事情都要先验证 | 维度=工作方式 | 来源=fc_c', // absolute
      '画像: 先验证再动手，不靠推测 | 维度=工作方式 | 来源=fc_d', // good
    ].join('\n'),
    allowed,
  );
  assert.deepEqual(lines.map((line) => line.statement), ['先验证再动手，不靠推测']);
});

test('profile gates: the same sentence twice is folded, a paraphrase is left to the model', () => {
  // Code folds what overlaps at the character level. "一轮对话要当成整体" vs
  // "一轮对话要当成一个整体" only reaches 0.64, so paraphrase-level dedupe stays the
  // prompt's job — pretending the rule can do it would be the same hope as before.
  const allowed = new Set(['fc_a', 'fc_b']);
  const lines = parseProfileMerge(
    [
      '画像: 用户要机制不靠自觉 | 维度=工作方式 | 来源=fc_a',
      '画像: 用户要机制，不靠自觉 | 维度=工作方式 | 来源=fc_b',
    ].join('\n'),
    allowed,
  );
  assert.equal(lines.length, 1);
});
test('profile gates: a semicolon-welded line is rejected, the split version passes', () => {
  // The real output of the first merge: three ideas welded with semicolons.
  const allowed = new Set(['fc_a', 'fc_b', 'fc_c']);
  const welded = parseProfileMerge('画像: 设指标促成长；记忆按想起概率衰减 | 维度=工作方式 | 来源=fc_a', allowed);
  assert.equal(welded.length, 0);

  const split = parseProfileMerge(
    [
      '画像: 设指标促成长 | 维度=工作方式 | 来源=fc_a',
      '画像: 记忆按想起概率衰减 | 维度=工作方式 | 来源=fc_b',
      '画像: 教训按作用域和复现衰减 | 维度=工作方式 | 来源=fc_c',
    ].join('\n'),
    allowed,
  );
  assert.equal(split.length, 3);
});
test('profile prompt: dimension definitions travel with the request', () => {
  const prompt = renderProfileMergePrompt({ items: [{ id: 'fc_a', statement: '先验证再动手' }] });
  // Without the definitions the model invents what "价值观" means.
  assert.match(prompt, /超越具体情境/);
  assert.match(prompt, /边界：明确说过的/);
  assert.match(prompt, /维度=价值观/);
});

test('profile prompt: a single-dimension batch says so', () => {
  const plain = renderProfileMergePrompt({ items: [{ id: 'fc_a', statement: '先验证再动手' }] });
  const scoped = renderProfileMergePrompt({
    items: [{ id: 'fc_a', statement: '先验证再动手' }],
    dimension: '工作方式',
  });
  // Without the scope block the model is free to re-widen the batch it was handed.
  assert.doesNotMatch(plain, /<scope>/);
  assert.match(scoped, /全部是「工作方式」维度的判断/);
  assert.match(scoped, /维度=工作方式/);
});

test('profile: the merge input is cut along dimensions, never welded across them', () => {
  const groups = groupProfileCandidates([
    { id: 'a', statement: '先验证再动手', dimension: '工作方式' },
    { id: 'b', statement: '讨厌重复交代', dimension: '沟通偏好' },
    { id: 'c', statement: '从根本解决', dimension: '工作方式' },
    { id: 'd', statement: '没标注过的一句', dimension: undefined },
    { id: 'e', statement: '维度写错的', dimension: '不是维度' },
  ]);
  // Biggest group first: it is where one call collapses the most repetition.
  assert.deepEqual(
    groups.map((group) => [group.dimension, group.items.length]),
    [
      ['工作方式', 2],
      ['', 2],
      ['沟通偏好', 1],
    ],
  );
  // An unknown dimension is not a dimension; it joins the unlabelled group instead
  // of inventing a batch the parser would then reject line by line.
  assert.deepEqual(
    groups[1].items.map((item) => item.id),
    ['d', 'e'],
  );
});

test('profile: a batch declared as one dimension rejects a line from another', () => {
  const allowed = new Set(['fc_a', 'fc_b']);
  const lines = parseProfileMerge(
    [
      '画像: 先验证再动手 | 维度=工作方式 | 来源=fc_a',
      '画像: 讨厌重复交代 | 维度=沟通偏好 | 来源=fc_b',
    ].join('\n'),
    allowed,
    '工作方式',
  );
  // The prompt asks for one dimension; the parser is what enforces it.
  assert.deepEqual(lines.map((line) => line.statement), ['先验证再动手']);
});

test('profile: a line that cites evidence is derived, marker or not', () => {
  assert.equal(isDerivedProfileLine({ slots: [{ slot: '证据' }] }), true);
  assert.equal(isDerivedProfileLine({ slots: [{ slot: '合并' }] }), true);
  assert.equal(isDerivedProfileLine({ slots: [{ slot: '维度' }] }), false);
  assert.equal(isDerivedProfileLine({}), false);
});

test('profile: marking a lesson writes the dimension the merge will cut along', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putFact({ ...base, id: 'f1', statement: '讨厌同一件事反复讲', typeName: '教训', holder: 'self' });
  store.putFact({ ...base, id: 'f2', statement: '先验证再动手', typeName: '教训', holder: 'self' });
  store.putFact({ ...base, id: 'f3', statement: '边界不明的一句', typeName: '教训', holder: 'self' });

  soul.markProfile('f1', { dimension: '沟通偏好' });
  soul.markProfile('f2', { dimension: '不存在的维度' });
  soul.markProfile('f3');

  const dimension = (id: string) => store.fact(id)?.slots.find((slot) => slot.slot === '维度')?.value;
  assert.deepEqual(dimension('f1'), { kind: 'text', value: '沟通偏好' });
  // An invalid dimension writes nothing rather than a wrong label: an unlabelled
  // judgment waits, a mislabelled one would be merged into the wrong lens.
  assert.equal(dimension('f2'), undefined);
  assert.equal(dimension('f3'), undefined);
  // All three are profile items and none is derived, so all wait to be merged; the
  // unlabelled ones are reported by the merge step, not merged blindly.
  assert.equal(soul.profileItems().length, 3);
  store.close();
});

test('profile prompt: the classifier and the merge share one definition of a dimension', () => {
  const merge = renderProfileMergePrompt({ items: [{ id: 'fc_a', statement: '先验证再动手' }] });
  const classify = renderRuleClassifyPrompt({ items: [{ id: 'fc_a', statement: '先验证再动手' }] });
  // Two copies of "什么算价值观" would drift the first time either is edited, so
  // the classifier renders the merge prompt's block instead of retyping it.
  for (const line of ['超越具体情境', '自愿投入时间', '必须贴着原话']) {
    assert.ok(merge.includes(line), `merge prompt missing ${line}`);
    assert.ok(classify.includes(line), `classify prompt missing ${line}`);
  }
  assert.match(classify, /画像: id \| 维度=/);
});

test('classifier prompt: the catalog column is asked for, and the example passes the parser', () => {
  const prompt = renderRuleClassifyPrompt({ items: [{ id: 'fc_a', statement: '先验证再动手' }] });
  // 0029: every rule owes one neutral line for the always-on catalog. It is part of
  // the same call — a second model call for the index would be a second judgement.
  assert.match(prompt, /每条规则都必须给索引/);
  // One definition, two statements of it: the self-containment bar is a shared block,
  // so the classifying batch and the index-only batch cannot drift apart. Scoped to the
  // rules block so the index-mode copy cannot make this pass on its own.
  const rulesBlock = /<rules>([\s\S]*?)<\/rules>/.exec(prompt)?.[1] ?? '';
  assert.match(rulesBlock, /索引句是以后\*\*唯一\*\*能想起这条规则的线索/);
  // A batch of new candidates must not see the index-only instruction: a rule that
  // only gets a catalog line and no trigger is a rule that can never fire.
  assert.equal(prompt.includes('<index-mode>'), false, '新候选批次不该看到索引模式');

  const example = /<output>\n([\s\S]*?)\n<\/output>/.exec(prompt)?.[1] ?? '';
  const parsed = parseRuleClassifications(example);
  // The example is the contract: a model copying it must parse into one of each.
  assert.deepEqual(parsed.map((item) => item.kind), ['rule', 'profile', 'index']);
  assert.ok(parsed[0].trigger, '规则行必须带可用的触发条件');
  assert.equal(parsed[0].index, '改 JSON 别用字符串替换');
  assert.equal(parsed[2].index, '重启要用计划任务，别在会话里直接跑脚本');
});

test('classifier prompt: an already-classified rule is marked and only owes its index line', () => {
  const prompt = renderRuleClassifyPrompt({
    items: [
      { id: 'fc_a', statement: '已经分好类的规则', kind: 'index' },
      { id: 'fc_b', statement: '新候选' },
    ],
  });
  // The item line says which job it is; the output anchor says what to answer.
  assert.match(prompt, /- fc_a \| 规则 \| 已经分好类的规则/);
  assert.match(prompt, /- fc_b \| 新候选/);
  assert.match(prompt, /<index-mode>/);
  assert.match(prompt, /索引: fc_a \| 索引=/);
  assert.match(prompt, /不要重新分类/);
  // 0029 §五: the line must carry the information, not point at a place. The assertions
  // are scoped to the index-mode block on purpose: the same sentences also appear in the
  // classifying rules block, so a whole-prompt search would stay green after the mode
  // block lost them (that mutation was caught here, not in review).
  const modeBlock = /<index-mode>([\s\S]*?)<\/index-mode>/.exec(prompt)?.[1] ?? '';
  assert.match(modeBlock, /不出现 turn 编号/);
  assert.match(modeBlock, /离开原句也能读懂/);
  // The rewrite job reuses this mode: it must say "rewrite", not only "fill in".
  assert.match(modeBlock, /已经有旧的索引句就重写它/);
});

test('profile prompt: the example inside the prompt must pass the parser', () => {
  // The only complete example in the merge prompt used to omit 维度=, which the
  // parser requires — a model copying it produced zero lines, the batch was retried
  // three times and then dropped. The example and the gate must agree.
  const prompt = renderProfileMergePrompt({ items: [{ id: 'fc_a', statement: '占位' }] });
  const example = /<output>\n([\s\S]*?)\n<\/output>/.exec(prompt)?.[1] ?? '';
  const lines = parseProfileMerge(example, new Set(['fc_a', 'fc_b', 'fc_c']), '工作方式');
  assert.equal(lines.length, 1, 'the 工作方式 line survives');
  assert.equal(parseProfileMerge(example, new Set(['fc_a', 'fc_b', 'fc_c'])).length, 2);
});

test('profile: opposite polarity is never a duplicate', () => {
  // 喜欢爬山 and 不喜欢爬山 share ~0.86 of their bigrams; folding them kept whichever
  // came first, which writes the person's preference backwards.
  const lines = parseProfileMerge(
    [
      '画像: 喜欢爬山和露营 | 维度=生活兴趣 | 来源=fc_a',
      '画像: 不喜欢爬山和露营 | 维度=生活兴趣 | 来源=fc_b',
    ].join('\n'),
    new Set(['fc_a', 'fc_b']),
  );
  assert.equal(lines.length, 2);
});

test('profile: derived lines are not offered back as merge input', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  // An original judgment.
  store.putFact({ ...base, id: 'f1', statement: '先验证再动手', role: 'profile', typeName: '画像', holder: 'self' });
  // A merged line: it cites the original, so re-merging it would compress a compression.
  store.putFact({
    ...base,
    id: 'f2',
    statement: '动手前先验证，不靠推测',
    role: 'profile', typeName: '画像',
    holder: 'self',
    slots: [
      { slot: '证据', value: { kind: 'fact', factId: 'f1' } },
      { slot: '合并', value: { kind: 'text', value: '1' } },
    ],
  });
  assert.deepEqual(
    soul.profileItems().map((fact) => fact.id),
    ['f1'],
  );
  // The merged line is still what gets injected: derived is not discarded.
  assert.deepEqual(soul.profile().map((fact) => fact.id).sort(), ['f1', 'f2']);
  store.close();
});