import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleExtract, RULES } from '../src/reflect.ts';
import type { Turn } from '../src/types.ts';

const user = (content: string): Turn => ({ role: 'user', content });

test('standing instruction: 每次 + 要求 → strategy', () => {
  const drafts = ruleExtract([
    user('你每次在做改动之前，都需要让我解释说明，为什么、怎么做、会有什么影响'),
  ]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].type, 'strategy');
});

test('complaint: 每次 但没有要求词 → 不生成策略', () => {
  const drafts = ruleExtract([user('你的重启脚本又失败了，有crash。。你调调好，每次不能让我手动fix啊')]);
  assert.equal(drafts.length, 0);
});

test('time trigger without a request → 不生成策略', () => {
  assert.equal(ruleExtract([user('每次都很慢')]).length, 0);
});

test('以后 + 先 → strategy（既有用法不回归）', () => {
  const drafts = ruleExtract([user('以后提交前先跑 make check')]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].type, 'strategy');
});

test('preference / decision / remember 各自命中', () => {
  assert.equal(ruleExtract([user('我喜欢简洁的回答')])[0].type, 'trait');
  assert.equal(ruleExtract([user('我决定以后只用 pnpm')])[0].type, 'cognition');
  assert.equal(ruleExtract([user('记住这个端口是 9475')])[0].type, 'fact');
});

test('assistant turns never produce drafts', () => {
  assert.equal(ruleExtract([{ role: 'assistant', content: '以后都听你的' }]).length, 0);
});

test('抽取规则预算：≤ 8 条', () => {
  assert.ok(RULES.length <= 8, `rules: ${RULES.length}`);
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length, '规则 id 必须唯一');
});
