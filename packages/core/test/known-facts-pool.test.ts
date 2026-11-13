/**
 * The `<known-facts>` candidate pool (2026-11-11).
 *
 * Three contracts, each chosen because the old `limit: 12` broke it:
 *   1. selection — the facts about the subject this text names beat newer unrelated
 *      rows (the old pool was "newest 12", so a 42-row release-state cluster was never
 *      in view: 12 / 1379 = 0.87%)
 *   2. truncation — a group that fits leaves whole (half of one subject's facts turns
 *      "these two disagree" into "nothing here"); one that does NOT fit hands over its
 *      most text-relevant facts instead of nothing — the biggest group is exactly the
 *      one dedup needs, so "whole or nothing" always chose nothing (阿Q 180 facts and
 *      entity:用户 60 facts were both dropped whole in production)
 *   3. accounting — chosen / chars / byTier / droppedGroups describe the pool, so a
 *      thin pool can never be mistaken for "no duplicates" (rules 18/20)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul, EXTRACTION_FACT_BUDGET_CHARS, EXTRACTION_RECENT_FACTS } from '../src/index.ts';

const base = { soulId: 's1', userId: 'u1' };

function seed() {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const entity = (name: string) => store.putEntity({ ...base, type: 'thing', name, seenAt: 1_000 });
  const fact = (statement: string, entityId?: string, validFrom = 1_000) =>
    store.putFact({
      ...base,
      statement,
      holder: 'world',
      role: 'observation',
      status: 'active',
      source: 'told',
      confidence: 0.8,
      validFrom,
      ...(entityId ? { slots: [{ slot: '主体', value: { kind: 'entity' as const, entityId } }] } : {}),
    });
  return { store, soul, entity, fact };
}

test('pool: the subject this text names wins over newer unrelated rows', () => {
  const { store, soul, entity, fact } = seed();
  const plugin = entity('插件发布');
  const old = fact('插件 0.0.133 已发布并装机', plugin.id, 1_000);
  // Twenty newer rows about something else: the old contract showed only these.
  for (let i = 0; i < 20; i += 1) fact(`无关的第 ${i} 条记录，讲的是别的事情`, undefined, 2_000 + i);

  const context = soul.extractionContext(20, { text: '插件发布那事怎么样了' });
  const ids = context.facts.map((entry) => entry.id);
  assert.ok(ids.includes(old.id), '旧事实必须在候选里——它才是这句话要去重/取代的对象');
  assert.ok((context.factCandidates?.byTier.entity ?? 0) >= 1);
  assert.ok((context.factCandidates?.byTier.recent ?? 0) >= 1, '无关的新行作为地板仍然在');
  store.close();
});

test('pool: a fitting group leaves whole; an oversized one leaves its most relevant facts', () => {
  const { store, soul, entity, fact } = seed();
  // Order inside a tier is last-mentioned-first (findEntities), so pin it: the small
  // group goes in first and must survive whole; the big one overflows behind it.
  const small = store.putEntity({ ...base, type: 'thing', name: '小主体', seenAt: 2_000 });
  const smallId = fact('小主体的一句话', small.id).id;
  const large = store.putEntity({ ...base, type: 'thing', name: '大主体', seenAt: 1_000 });
  const filler = '，这一条故意写得很长好把预算顶爆'.repeat(4);
  const largeIds: string[] = [];
  for (let i = 0; i < 40; i += 1) largeIds.push(fact(`大主体的第 ${i} 条事实${filler}`, large.id).id);

  const context = soul.extractionContext(20, { text: '小主体和大主体都提一下' });
  const ids = new Set(context.facts.map((entry) => entry.id));
  const largeShown = largeIds.filter((id) => ids.has(id)).length;
  const chars = context.facts.reduce((sum, entry) => sum + entry.statement.length, 0);

  assert.ok(ids.has(smallId), '装得下的组仍整组进——组完整是常态，不是被放弃的规则');
  assert.ok(
    largeShown > 0 && largeShown < largeIds.length,
    `装不下的组给相关性切片，而不是整组丢（旧契约正是饿死主角组的根因），现在 ${largeShown}/${largeIds.length}`,
  );
  assert.ok(chars <= EXTRACTION_FACT_BUDGET_CHARS, `预算仍是硬停规则，实际 ${chars}`);
  const dropped = context.factCandidates?.droppedGroups.find((entry) => entry.group === 'entity:大主体');
  assert.ok(dropped, '切掉的部分要记账（规则 18）——否则池子薄了看不出来');
  assert.equal(dropped?.facts, largeIds.length - largeShown, '记的条数 = 没进池的条数');
  store.close();
});

test('pool: the slice keeps the facts that read like this text, not just the newest ones', () => {
  const { store, soul, entity, fact } = seed();
  const subject = entity('大主体');
  // The matching facts are the OLDEST (valid_from 1000): a recency-ordered slice
  // would starve them. Relevance to the incoming text has to win — that is what
  // the pool exists to answer ("is this sentence already known?").
  const matchIds: string[] = [];
  for (let i = 0; i < 10; i += 1) matchIds.push(fact(`大主体的盘竹筷辫第 ${i} 次被提起`, subject.id, 1_000).id);
  const fillerIds: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    fillerIds.push(fact(`大主体的无关记录第 ${i} 条${'，这一条故意写得很长好把预算顶爆'.repeat(4)}`, subject.id, 9_000).id);
  }

  const context = soul.extractionContext(20, { text: '大主体的盘竹筷辫怎么样了' });
  const ids = new Set(context.facts.map((entry) => entry.id));
  const chars = context.facts.reduce((sum, entry) => sum + entry.statement.length, 0);

  assert.ok(
    matchIds.every((id) => ids.has(id)),
    '与来文词面相近的事实必须在池里——去重要对的就是它们，按时间截会先饿死它们',
  );
  assert.ok(chars <= EXTRACTION_FACT_BUDGET_CHARS, `预算仍是硬停规则，实际 ${chars}`);
  assert.ok(context.facts.length < matchIds.length + fillerIds.length, '预算确实切过，不是整组放行');
  const dropped = context.factCandidates?.droppedGroups.find((entry) => entry.group === 'entity:大主体');
  assert.equal(
    dropped?.facts,
    matchIds.length + fillerIds.length - context.facts.length,
    '记账 = 没进池的条数（切片后仍是全量对账）',
  );
  store.close();
});

test('pool: the accounting matches what was actually handed over', () => {
  const { store, soul, entity, fact } = seed();
  const subject = entity('预算主体');
  for (let i = 0; i < 25; i += 1) fact(`预算主体的第 ${i} 条事实，内容够长以便观察字符记账`, subject.id);

  const context = soul.extractionContext(20, { text: '预算主体怎么样了' });
  const candidates = context.factCandidates;
  assert.ok(candidates, '候选集的来历必须回传，否则"池子薄"和"没有重复"长得一样');
  assert.equal(candidates.chosen, context.facts.length);
  assert.equal(
    candidates.chars,
    context.facts.reduce((sum, entry) => sum + entry.statement.length, 0),
    '字符数是渲染出去的那部分，不是候选全集的',
  );
  const tierSum = candidates.byTier.entity + candidates.byTier.thread + candidates.byTier.similar + candidates.byTier.recent;
  assert.equal(tierSum, candidates.chosen, '每一条都得有来源层级');
  store.close();
});

test('pool: nothing named falls back to the newest rows, and stays bounded', () => {
  const { store, soul, entity, fact } = seed();
  const subject = entity('某个主体');
  for (let i = 0; i < 30; i += 1) fact(`某个主体的第 ${i} 条事实`, subject.id);

  const context = soul.extractionContext(20, { text: '今天天气不错' });
  assert.equal(context.factCandidates?.byTier.entity, 0, '文本没点名，实体层不该乱认');
  assert.ok((context.factCandidates?.byTier.recent ?? 0) > 0, '地板层要有东西');
  assert.ok(
    context.facts.length <= EXTRACTION_RECENT_FACTS,
    `地板层不超过 ${EXTRACTION_RECENT_FACTS} 条（旧的 limit: 12 只剩在这里）`,
  );
  store.close();
});

test('pool: an oversized group is sliced to the budget, never shown whole, never dropped whole', () => {
  const { store, soul, entity, fact } = seed();
  const huge = entity('超大主体');
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const id = fact(`超大主体的一条很长的事实${'。'.repeat(800)}`).id;
    store.addSlots(id, [{ slot: '主体', value: { kind: 'entity', entityId: huge.id } }]);
    ids.push(id);
  }
  const context = soul.extractionContext(20, { text: '超大主体' });
  const chars = context.facts.reduce((sum, entry) => sum + entry.statement.length, 0);
  assert.ok(context.facts.length > 0, '单组超预算也要给——空池不是"没有重复"，是"模型没得比"（规则 20）');
  assert.ok(context.facts.length < ids.length, `切片要真起作用：给 ${context.facts.length}/${ids.length}`);
  assert.ok(chars <= EXTRACTION_FACT_BUDGET_CHARS, `预算对超大组也硬生效，实际 ${chars}`);
  const dropped = context.factCandidates?.droppedGroups.find((entry) => entry.group === 'entity:超大主体');
  assert.equal(dropped?.facts, ids.length - context.facts.length, '切掉的记账');
  store.close();
});

test('pool: one fact bigger than the whole budget is still shown alone — the pool is never empty', () => {
  const { store, soul, entity, fact } = seed();
  const subject = entity('巨句主体');
  // A single statement over the entire budget: slicing fits nothing, but an empty
  // candidate set would read as "no duplicates" when it really means "not allowed
  // to look". One oversized fact is the bounded exception (AGENTS 15/17: a whole
  // unit, at most one).
  const id = fact(`巨句主体的超长事实${'。'.repeat(3000)}`).id;
  store.addSlots(id, [{ slot: '主体', value: { kind: 'entity', entityId: subject.id } }]);

  const context = soul.extractionContext(20, { text: '巨句主体' });
  assert.equal(context.facts.length, 1, '比整个预算还长的单条也要整条给');
  assert.equal(context.facts[0]?.id, id);
  store.close();
});
