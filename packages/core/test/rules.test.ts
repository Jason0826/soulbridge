/**
 * Rule firing (ADR 0033): a rule appears when its situation applies, never always.
 *
 * These tests are the contract: malformed triggers must not become "always", and a
 * rule that mentions both content and state must require both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fires, parseRuleClassifications, parseTrigger, selectRules } from '../src/rules.ts';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

const rule = (trigger: object, extra: object = {}) => ({
  id: 'r1',
  statement: '用 edit 工具改 JSON',
  trigger: trigger as never,
  ...extra,
});

test('rules: a keyword in the message fires the rule', () => {
  assert.equal(fires(rule({ any: ['package.json'] }), '把 package.json 的版本号改了'), true);
  assert.equal(fires(rule({ any: ['package.json'] }), '今天天气不错'), false);
});

test('rules: matching is case-insensitive and substring-based', () => {
  assert.equal(fires(rule({ any: ['JSON'] }), '改一下 json 配置'), true);
});

test('rules: a regex can express the situation the keywords miss', () => {
  assert.equal(fires(rule({ regex: '\\.json\\b' }), '编辑 config.json'), true);
  assert.equal(fires(rule({ regex: '\\.json\\b' }), '编辑 config.yaml'), false);
});

test('rules: a broken regex never matches instead of throwing', () => {
  assert.equal(fires(rule({ regex: '([' }), 'anything'), false);
});

test('rules: a state condition reads the counters, not the text', () => {
  assert.equal(fires(rule({ state: 'long-session' }), '随便聊聊', { 'long-session': true }), true);
  assert.equal(fires(rule({ state: 'long-session' }), '随便聊聊', {}), false);
});

test('rules: content and state together require both', () => {
  const both = rule({ any: ['json'], state: 'long-session' });
  assert.equal(fires(both, '改 json', { 'long-session': true }), true);
  assert.equal(fires(both, '改 json', {}), false);
  assert.equal(fires(both, '今天天气不错', { 'long-session': true }), false);
});

test('rules: no trigger means the rule never fires', () => {
  assert.equal(fires(rule({}), '改 json'), false);
  assert.equal(parseTrigger('{}'), null);
  assert.equal(parseTrigger('not json'), null);
});

test('rules: only firing rules are returned, strongest first, capped', () => {
  const rules = [
    rule({ any: ['json'] }, { id: 'a', confidence: 0.6 }),
    rule({ any: ['json'] }, { id: 'b', confidence: 0.9 }),
    rule({ any: ['天气'] }, { id: 'c', confidence: 1 }),
  ];
  const selected = selectRules(rules, '改一下 json', {});
  assert.deepEqual(selected.map((item) => item.id), ['b', 'a']);
  assert.deepEqual(selectRules(rules, '改一下 json', {}, 1).map((item) => item.id), ['b']);
});

test('rules: the store loads rules and skips ones without a usable trigger', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putFact({
    soulId: 's1',
    userId: 'u1',
    id: 'r-json',
    statement: '用 edit 工具改 JSON，不要用字符串替换',
    role: 'rule', typeName: '规则',
    holder: 'self',
    confidence: 0.9,
    slots: [{ slot: '触发', value: { kind: 'text', value: '{"any":["json","package.json"]}' } }],
  });
  store.putFact({
    soulId: 's1',
    userId: 'u1',
    id: 'r-broken',
    statement: '没有触发条件的规则',
    role: 'rule', typeName: '规则',
    holder: 'self',
    confidence: 0.9,
    slots: [{ slot: '触发', value: { kind: 'text', value: 'not json' } }],
  });

  const rules = soul.rules();
  assert.deepEqual(rules.map((item) => item.id), ['r-json']);
  assert.equal(fires(rules[0], '帮我改 package.json'), true);
  store.close();
});
test('classifier: a keyed line becomes a rule; no condition becomes 待修', () => {
  const raw = [
    '规则: fc_a | 关键词=json,package.json | 动作=用 edit 工具改 JSON',
    '规则: fc_b | 正则=\\.json\\b',
    '规则: fc_c | 状态=long-session',
    '规则: fc_d | 动作=没有触发条件的规则',
    '画像: fc_e',
    '待修: fc_f | 原因=判断不了',
  ].join('\n');
  const classified = parseRuleClassifications(raw);
  assert.deepEqual(
    classified.map((item) => [item.id, item.kind]),
    [
      ['fc_a', 'rule'],
      ['fc_b', 'rule'],
      ['fc_c', 'rule'],
      ['fc_d', 'pending'],
      ['fc_e', 'profile'],
      ['fc_f', 'pending'],
    ],
  );
  // The trigger is assembled by the parser, never authored by the model.
  assert.deepEqual(JSON.parse(classified[0].trigger ?? '{}'), { any: ['json', 'package.json'] });
  assert.equal(classified[0].action, '用 edit 工具改 JSON');
  assert.deepEqual(JSON.parse(classified[2].trigger ?? '{}'), { state: 'long-session' });
  assert.equal(classified[3].reason, '规则缺少触发条件');
});

test('classifier: a rule line can carry its catalog line, an index line is its own answer', () => {
  const classified = parseRuleClassifications(
    [
      '规则: fc_a | 关键词=json | 动作=用 edit 工具改 JSON | 索引=改 JSON 别用字符串替换',
      '索引: fc_b | 索引=重启要用计划任务，别在会话里直接跑脚本',
      '索引: fc_c',
    ].join('\n'),
  );
  assert.deepEqual(
    classified.map((item) => item.kind),
    ['rule', 'index', 'index'],
  );
  assert.equal(classified[0].index, '改 JSON 别用字符串替换');
  assert.ok(classified[0].trigger, '索引不是触发条件的替代品');
  assert.equal(classified[1].index, '重启要用计划任务，别在会话里直接跑脚本');
  // An empty column is not an index: the caller reports it instead of writing a blank
  // catalog line, and it is not silently turned into a re-classification either.
  assert.equal(classified[2].index, undefined);
});

test('catalog: indexed rules only, ordered by reproduction then confidence, capped', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const put = (id: string, statement: string, confidence: number, index?: string, recalls = 0) => {
    store.putFact({
      soulId: 's1',
      userId: 'u1',
      id,
      statement,
      role: 'rule',
      typeName: '规则',
      holder: 'self',
      confidence,
      slots: [
        { slot: '触发', value: { kind: 'text', value: '{"any":["json"]}' } },
        ...(index ? [{ slot: '目录句', value: { kind: 'text' as const, value: index } }] : []),
      ],
    });
    for (let i = 0; i < recalls; i += 1) store.recordRecalls([id], 1000 + i);
  };
  put('r-fired', '经常复现的规则', 0.6, '经常复现', 2);
  put('r-once', '复现过一次的规则', 0.6, '复现过一次', 1);
  put('r-strong', '置信最高但没复现的规则', 1, '置信最高', 0);
  // No catalog line: counted as missing, never shown with a cut-down statement.
  put('r-raw', '没有索引句的规则', 0.9, undefined);

  const all = soul.catalog(10);
  assert.deepEqual(all.entries.map((rule) => rule.id), ['r-fired', 'r-once', 'r-strong']);
  assert.equal(all.total, 4);
  assert.equal(all.missingIndex, 1);
  assert.deepEqual(soul.catalog(2).entries.map((rule) => rule.id), ['r-fired', 'r-once']);
  store.close();
});

test('catalog: an index can be filled after classification, but never onto a lesson', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putFact({
    soulId: 's1',
    userId: 'u1',
    id: 'r-1',
    statement: '用 edit 工具改 JSON',
    role: 'rule',
    typeName: '规则',
    holder: 'self',
    confidence: 0.9,
    slots: [{ slot: '触发', value: { kind: 'text', value: '{"any":["json"]}' } }],
  });
  store.putFact({
    soulId: 's1',
    userId: 'u1',
    id: 'l-1',
    statement: '还没分类的教训',
    role: 'lesson',
    status: 'candidate',
    holder: 'self',
    confidence: 0.9,
  });

  // The backfill writes onto a placed rule through the same slot the classifier uses.
  assert.equal(soul.markRuleIndex('r-1', '改 JSON 别用字符串替换'), true);
  assert.equal(soul.catalog(5).entries[0].index, '改 JSON 别用字符串替换');
  // A candidate must not enter the always-on block by the back door, and it must not
  // be demoted or promoted by being asked: the answer is skipped and reported.
  assert.equal(soul.markRuleIndex('l-1', '一条不该出现的索引'), false);
  assert.equal(soul.markRuleIndex('nope', '不存在的 id'), false);
  assert.equal(store.fact('l-1')?.status, 'candidate');
  store.close();
});

test('classifier: a profile line carries its dimension, and only a real one', () => {
  // The dimension decided here is what the merge step later cuts batches along, so
  // it has to travel with the classification instead of being guessed downstream.
  const classified = parseRuleClassifications(
    [
      '画像: fc_a | 维度=沟通偏好',
      '画像: fc_b | 维度=胡说八道',
      '画像: fc_c',
    ].join('\n'),
  );
  assert.equal(classified[0].dimension, '沟通偏好');
  // An invented dimension is not a dimension: the item stays unlabelled, which the
  // merge log reports, instead of being filed under a lens nobody defined.
  assert.equal(classified[1].dimension, undefined);
  assert.equal(classified[2].dimension, undefined);
  assert.deepEqual(
    classified.map((item) => item.kind),
    ['profile', 'profile', 'profile'],
  );
});