import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderExtractionPrompt } from '../src/prompts.ts';

const NOW = new Date('2026-11-01T12:00:00+08:00').getTime();

test('extraction prompt: every block is present, in order', () => {
  const prompt = renderExtractionPrompt({
    text: '我同事小林上周被裁员了',
    now: NOW,
    entities: [{ id: 'en_1', name: '小林', aliases: ['小林姐'], relation: '同事' }],
    facts: [{ id: 'fc_9', statement: '小林在找工作', atText: '上周' }],
    previousUserText: '她最近有消息吗',
  });
  for (const block of ['<role>', '<output-schema>', '<rules>', '<examples>', '<context>', '<source>', '<output>']) {
    assert.ok(prompt.includes(block), `missing ${block}`);
  }
  // Order matters: the data comes after the instructions, the output anchor last.
  assert.ok(prompt.indexOf('<rules>') < prompt.indexOf('<context>'));
  assert.ok(prompt.indexOf('<source>') < prompt.indexOf('<output>'));
});

test('extraction prompt: the observation date is an absolute anchor', () => {
  const prompt = renderExtractionPrompt({ text: '昨天发生了什么', now: NOW });
  assert.match(prompt, /<observation-date>2026-11-01<\/observation-date>/);
});

test('extraction prompt: known entities carry aliases and relation', () => {
  const prompt = renderExtractionPrompt({
    text: 'x',
    now: NOW,
    entities: [{ id: 'en_1', name: '小林', aliases: ['小林姐'], relation: '同事' }],
    facts: [{ id: 'fc_9', statement: '小林在找工作', atText: '上周' }],
  });
  assert.match(prompt, /小林（别名：小林姐），同事/);
  assert.match(prompt, /\[fc_9\] 小林在找工作（上周）/);
});

test('extraction prompt: empty context says so instead of looking broken', () => {
  const prompt = renderExtractionPrompt({ text: 'x', now: NOW });
  assert.match(prompt, /<known-entities>（空）<\/known-entities>/);
  assert.match(prompt, /<known-facts>（空）<\/known-facts>/);
});

test('extraction prompt: the entity rules that the old prompt lacked', () => {
  const prompt = renderExtractionPrompt({ text: 'x', now: NOW });
  assert.match(prompt, /一个真实的人或物只出现一次/);
  assert.match(prompt, /以“和\/与\/或”连接的两个词/);
  assert.match(prompt, /自包含/);
  assert.match(prompt, /换算成 YYYY-MM-DD/);
  assert.match(prompt, /不确定就省略字段/);
  assert.match(prompt, /<when-to-write>/);
  assert.match(prompt, /不要写/);
  assert.match(prompt, /用户对我的要求、提问、催促、同意、否定/);
  assert.match(prompt, /用户只是在问我一个问题时\*\*不要\*\*建缺口/);
});

test('extraction prompt: stays within a sane size', () => {
  const prompt = renderExtractionPrompt({ text: 'x'.repeat(200), now: NOW });
  assert.ok(prompt.length < 4000, `prompt grew to ${prompt.length} chars`);
});
