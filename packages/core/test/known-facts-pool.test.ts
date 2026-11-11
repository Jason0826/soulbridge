/**
 * The `<known-facts>` candidate pool (2026-11-11).
 *
 * Three contracts, each chosen because the old `limit: 12` broke it:
 *   1. selection — the facts about the subject this text names beat newer unrelated
 *      rows (the old pool was "newest 12", so a 42-row release-state cluster was never
 *      in view: 12 / 1379 = 0.87%)
 *   2. truncation — a group leaves whole or not at all (half of one subject's facts
 *      turns "these two disagree" into "nothing here")
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

test('pool: truncation drops whole groups, never half of one subject', () => {
  const { store, soul, entity, fact } = seed();
  const small = entity('小主体');
  const smallId = fact('小主体的一句话', small.id).id;
  const large = entity('大主体');
  const filler = '，这一条故意写得很长好把预算顶爆'.repeat(4);
  const largeIds: string[] = [];
  for (let i = 0; i < 40; i += 1) largeIds.push(fact(`大主体的第 ${i} 条事实${filler}`, large.id).id);

  const context = soul.extractionContext(20, { text: '小主体和大主体都提一下' });
  const ids = new Set(context.facts.map((entry) => entry.id));
  const largeShown = largeIds.filter((id) => ids.has(id)).length;
  const chars = context.facts.reduce((sum, entry) => sum + entry.statement.length, 0);
  assert.ok(largeShown === 0 || largeShown === largeIds.length, `一组要么全给要么全不给，现在是 ${largeShown}/${largeIds.length}`);
  // Whichever group loses, something must lose: two groups that cannot both fit is
  // exactly the case the budget exists for, and an empty dropped list means the budget
  // was not applied at all.
  assert.ok((context.factCandidates?.droppedGroups.length ?? 0) > 0, '装不下就得丢，并且记账（规则 15/18）');
  if (largeShown === 0) {
    assert.ok(
      context.factCandidates?.droppedGroups.some((entry) => entry.group === 'entity:大主体'),
      '丢掉的组要点名（规则 18）',
    );
    assert.ok(ids.has(smallId), '预算是给装得下的组用的，不是全砍');
    assert.ok(chars <= EXTRACTION_FACT_BUDGET_CHARS, `装得下就得装得下，实际 ${chars} > ${EXTRACTION_FACT_BUDGET_CHARS}`);
  }
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

test('pool: a single oversized group is still shown — an empty pool is not "no duplicates"', () => {
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
  assert.ok(chars > EXTRACTION_FACT_BUDGET_CHARS, '第一组即使超预算也要给——否则模型没得比');
  assert.equal(context.facts.length, ids.length);
  store.close();
});
