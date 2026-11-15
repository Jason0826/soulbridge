/**
 * The `<known-facts>` candidate pool (2026-11-11).
 *
 * Three contracts, each chosen because the old `limit: 12` broke it:
 *   1. selection — the facts about the subject this text names beat newer unrelated
 *      rows (the old pool was "newest 12", so a 42-row release-state cluster was never
 *      in view: 12 / 1379 = 0.87%)
 *   2. truncation — a group leaves whole or not at all: never sliced inside (half of
 *      one subject's facts turns "these two disagree" into "nothing here"). Order
 *      inside a tier is relevance-first, so the group that reads like this text —
 *      the dedup comparison target — gets the budget and the oversized exception
 *      before the others; the first group may exceed the budget whole (an empty
 *      pool is not "no duplicates", it is "the model was not allowed to look").
 *      2026-11-15: slicing shipped in 0.0.126 and was pulled the same week — the
 *      user does not want a subject's facts cut; relevance order serves the big
 *      group first instead of splitting it.
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

test('pool: the most relevant group goes first — relevance beats recency', () => {
  const { store, soul, fact } = seed();
  // A matches the text almost verbatim but is the OLDER entity (seenAt 1000 →
  // findEntities would put it second); B is newer but its fact shares no bigram
  // with the text. Relevance ordering must put A first — that is what makes the
  // oversized exception land on the group dedup actually needs.
  const a = store.putEntity({ ...base, type: 'thing', name: '相关主体', seenAt: 1_000 });
  const aIds: string[] = [];
  for (let i = 0; i < 5; i += 1) aIds.push(fact(`相关主体的盘竹筷辫第 ${i} 次${'。'.repeat(500)}`, a.id).id);
  const b = store.putEntity({ ...base, type: 'thing', name: '无关主体', seenAt: 2_000 });
  const bId = fact('今天天气不错的一条普通记录', b.id).id;

  const context = soul.extractionContext(20, { text: '相关主体的盘竹筷辫怎么样了，无关主体也提一下' });
  const ids = new Set(context.facts.map((entry) => entry.id));
  const chars = context.facts.reduce((sum, entry) => sum + entry.statement.length, 0);

  assert.ok(
    aIds.every((id) => ids.has(id)),
    '最相关且超预算的组排第一、整组给（例外允许超预算）——按最近提及排会让无关的 B 先手占掉预算',
  );
  assert.ok(chars > EXTRACTION_FACT_BUDGET_CHARS, '例外的代价可见：池子允许超过预算');
  assert.ok(!ids.has(bId), '预算被第一组用完后，后面的组整组丢');
  const dropped = context.factCandidates?.droppedGroups.find((entry) => entry.group === 'entity:无关主体');
  assert.equal(dropped?.facts, 1, '整组丢要记账，条数 = 整组条数（规则 18）');
  store.close();
});

test('pool: an oversized group behind the first is dropped whole — never sliced', () => {
  const { store, soul, fact } = seed();
  // The small group's statement IS the incoming text, so relevance puts it first
  // even though 大主体 is the newer entity. The big group then has no room and
  // must leave whole-or-nothing: 0.0.126 sliced it, which the user rejected.
  const small = store.putEntity({ ...base, type: 'thing', name: '小主体', seenAt: 1_000 });
  const smallId = fact('小主体的一句话，和大主体都提一下', small.id).id;
  const large = store.putEntity({ ...base, type: 'thing', name: '大主体', seenAt: 2_000 });
  const filler = '，这一条故意写得很长好把预算顶爆'.repeat(4);
  const largeIds: string[] = [];
  for (let i = 0; i < 40; i += 1) largeIds.push(fact(`大主体的第 ${i} 条事实${filler}`, large.id).id);

  const context = soul.extractionContext(20, { text: '小主体和大主体都提一下' });
  const ids = new Set(context.facts.map((entry) => entry.id));
  const largeShown = largeIds.filter((id) => ids.has(id)).length;
  const chars = context.facts.reduce((sum, entry) => sum + entry.statement.length, 0);

  assert.ok(ids.has(smallId), '最相关的组排第一、装得下——整组进');
  assert.equal(largeShown, 0, `装不下的组整组丢，绝不给半组（现在 ${largeShown}/${largeIds.length}）`);
  assert.ok(chars <= EXTRACTION_FACT_BUDGET_CHARS, `预算对第一组之外的组仍是硬停规则，实际 ${chars}`);
  const dropped = context.factCandidates?.droppedGroups.find((entry) => entry.group === 'entity:大主体');
  assert.equal(dropped?.facts, largeIds.length, '丢的条数 = 整组条数（不是切剩的）');
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

test('pool: a single oversized group is shown whole — the exception may exceed the budget', () => {
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
  assert.equal(context.facts.length, ids.length, '唯一的组就是最相关的组——整组给，不切（组完整，规则 17）');
  assert.ok(chars > EXTRACTION_FACT_BUDGET_CHARS, '例外允许超预算：空池比超预算更糟（规则 20）');
  assert.equal(
    (context.factCandidates?.droppedGroups.length ?? 0),
    0,
    '没有组被丢——切片退场后不存在"丢一半"',
  );
  store.close();
});

test('pool: one fact bigger than the whole budget is still shown alone — the pool is never empty', () => {
  const { store, soul, entity, fact } = seed();
  const subject = entity('巨句主体');
  // A single statement over the entire budget: it is the whole (only) group, so the
  // exception carries it. An empty candidate set would read as "no duplicates" when
  // it really means "not allowed to look" (rule 20).
  const id = fact(`巨句主体的超长事实${'。'.repeat(3000)}`).id;
  store.addSlots(id, [{ slot: '主体', value: { kind: 'entity', entityId: subject.id } }]);

  const context = soul.extractionContext(20, { text: '巨句主体' });
  assert.equal(context.facts.length, 1, '比整个预算还长的单条也要整条给');
  assert.equal(context.facts[0]?.id, id);
  store.close();
});
