/**
 * Rule firing (ADR 0033): a rule appears when its situation applies, never always.
 *
 * These tests are the contract: malformed triggers must not become "always", and a
 * rule that mentions both content and state must require both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fires, parseTrigger, selectRules } from '../src/rules.ts';
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
    typeName: '规则',
    holder: 'self',
    confidence: 0.9,
    slots: [{ slot: '触发', value: { kind: 'text', value: '{"any":["json","package.json"]}' } }],
  });
  store.putFact({
    soulId: 's1',
    userId: 'u1',
    id: 'r-broken',
    statement: '没有触发条件的规则',
    typeName: '规则',
    holder: 'self',
    confidence: 0.9,
    slots: [{ slot: '触发', value: { kind: 'text', value: 'not json' } }],
  });

  const rules = soul.rules();
  assert.deepEqual(rules.map((item) => item.id), ['r-json']);
  assert.equal(fires(rules[0], '帮我改 package.json'), true);
  store.close();
});