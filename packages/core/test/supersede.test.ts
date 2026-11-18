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
  assert.equal(old?.status, 'retracted', '旧事实退休');
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

/* ------------------------------------------------------------------ *
 * 同属性状态链（2026-11-18 发现 A）
 *
 * "ActiveSiteKey 改了三次，三个值同时 active" 的根因：取代只能由模型命名 target，
 * 而模型看不见旧行（池未呈上）或看见了没判成矛盾时，旧值永远留着。声明了「属性」
 * 的事实按定义是该属性此刻的值——互斥由声明本身给出，闸在写入侧收口，与模型
 * 是否看见旧行无关。
 * ------------------------------------------------------------------ */

function seedAttribute(store: ReturnType<typeof openSqlite>, statement: string, attr: string, holder = 'world'): string {
  return store.putFact({
    soulId: 's1',
    userId: 'u1',
    statement,
    holder,
    slots: [{ slot: '属性', value: { kind: 'text', value: attr } }],
  }).id;
}

test('属性闸: 同属性新值落库时，还 active 的旧值被撤掉并记进 attributeRetired', () => {
  const { s, store } = soul();
  const oldId = seedAttribute(store, 'AinanPlayer 的 ActiveSiteKey 在 11-18 为 Douban', 'ActiveSiteKey');

  const { draft } = validateDraft(parseLineDraft(
    '事实: AinanPlayer 的 ActiveSiteKey 在 11-18 改回 Wogg | 配置变更 | | | told | 0.9 | 槽位=属性=ActiveSiteKey',
  ));
  const result = s.commitDrafts(draft!, { turnId: 'tp_1' });

  const old = store.fact(oldId);
  assert.equal(old?.status, 'retracted', '同属性旧值退休');
  assert.equal(old?.supersededBy, result.facts[0].id, '旧值指向新值');
  assert.deepEqual(result.attributeRetired, [oldId], '退休是可见的，不是静默副作用');
  store.close();
});

test('属性闸: 三值链一次收口——两个旧值全部撤掉', () => {
  const { s, store } = soul();
  const first = seedAttribute(store, 'ActiveSiteKey 曾为 Douban', 'ActiveSiteKey');
  const second = seedAttribute(store, 'ActiveSiteKey 曾为 nodejs_wogg', 'ActiveSiteKey');

  const { draft } = validateDraft(parseLineDraft(
    '事实: ActiveSiteKey 现在是 Wogg | 配置变更 | | | told | 0.9 | 槽位=属性=ActiveSiteKey',
  ));
  const result = s.commitDrafts(draft!, { turnId: 'tp_1' });

  assert.equal(store.fact(first)?.status, 'retracted');
  assert.equal(store.fact(second)?.status, 'retracted');
  assert.deepEqual([...result.attributeRetired].sort(), [first, second].sort());
  store.close();
});

test('属性闸: 属性不同（或没写属性）不撤——不是同一件事就互不相干', () => {
  const { s, store } = soul();
  const version = seedAttribute(store, 'core 版本是 0.0.128', '版本');
  const siteKey = seedAttribute(store, 'ActiveSiteKey 为 Douban', 'ActiveSiteKey');

  const { draft } = validateDraft(parseLineDraft(
    '事实: 插件版本是 0.0.137 | 版本 | | | told | 0.9 | 槽位=属性=插件版本',
  ));
  const { draft: bare } = validateDraft(parseLineDraft(
    '事实: AinanPlayer 重启后生效 | 部署 | | | told | 0.9',
  ));
  const result = s.commitDrafts(draft!, { turnId: 'tp_1' });
  s.commitDrafts(bare!, { turnId: 'tp_1' });

  assert.equal(store.fact(version)?.status, 'active', '不同属性各活各的');
  assert.equal(store.fact(siteKey)?.status, 'active');
  assert.deepEqual(result.attributeRetired, []);
  store.close();
});

test('属性闸: holder 隔离——别人的同名属性不撤我的', () => {
  const { s, store } = soul();
  const mine = seedAttribute(store, '小灵认为站点键是 Douban', 'ActiveSiteKey', 'self');

  const { draft } = validateDraft(parseLineDraft(
    '事实: AinanPlayer 的 ActiveSiteKey 改回 Wogg | 配置变更 | | | told | 0.9 | 槽位=属性=ActiveSiteKey',
  ));
  const result = s.commitDrafts(draft!, { turnId: 'tp_1' });

  assert.equal(store.fact(mine)?.status, 'active', '不同持有者各存各的');
  assert.deepEqual(result.attributeRetired, []);
  store.close();
});

test('属性闸: 还没定稿（candidate）的新事实不撤任何东西', () => {
  const { s, store } = soul();
  const old = seedAttribute(store, 'ActiveSiteKey 为 Douban', 'ActiveSiteKey');

  // lesson 角色写入即 candidate（writeStatus），候选不是事实，不能退休现值。
  const { draft } = validateDraft(parseLineDraft(
    '事实: ActiveSiteKey 应该用 Wogg | 教训 | | | told | 0.5 | 角色=lesson | 槽位=属性=ActiveSiteKey',
  ));
  const result = s.commitDrafts(draft!, { turnId: 'tp_1' });

  assert.equal(result.facts[0]?.status, 'candidate');
  assert.equal(store.fact(old)?.status, 'active', '候选不退休现值');
  assert.deepEqual(result.attributeRetired, []);
  store.close();
});

test('属性闸: 散落在尾部的第二段槽位不丢——属性排第二也要认得', () => {
  const { s, store } = soul();
  const oldId = seedAttribute(store, 'ActiveSiteKey 为 Douban', 'ActiveSiteKey');

  // 两个非键值段：第一个是参与者槽位，第二个是属性。旧解析只取第一段、静默丢掉
  // 第二段——属性丢了闸就永远不触发，发现 A 会从解析器这侧原样复发。
  const { draft } = validateDraft(parseLineDraft(
    '事实: AinanPlayer 的 ActiveSiteKey 改回 Wogg | 配置变更 | | | told | 0.9 | 站点=AinanPlayer | 属性=ActiveSiteKey',
  ));
  const result = s.commitDrafts(draft!, { turnId: 'tp_1' });

  const slots = result.facts[0]?.slots ?? [];
  assert.ok(slots.some((slot) => slot.slot === '站点'), '第一段槽位在');
  assert.ok(slots.some((slot) => slot.slot === '属性' && slot.value.kind === 'text' && slot.value.value === 'ActiveSiteKey'), '第二段属性在');
  assert.equal(store.fact(oldId)?.status, 'retracted', '闸拿到了属性，旧值退休');
  store.close();
});
