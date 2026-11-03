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
  for (const block of ['<role>', '<terms>', '<output-format>', '<rules>', '<examples>', '<context>', '<source>', '<output>', '<when-to-write>']) {
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

test('extraction prompt: every term is defined once, with its boundary', () => {
  const prompt = renderExtractionPrompt({ text: 'x', now: NOW });
  // Definitions live in one <terms> block; format notes and rules point at it instead
  // of restating it. Two copies of "what is an entity" is how the model learned to
  // write topics into slots.
  assert.match(prompt, /<terms>/);
  for (const term of ['实体', '事实', '持有', '槽位', '日期与精度', '来源', '类型名', '置信', '原则候选', '缺口', '线索']) {
    assert.ok(prompt.includes(`**${term}**`), `术语缺少定义：${term}`);
  }
  // Each boundary shows what counts and what does not — the pair is what a model can
  // apply; a definition alone was not enough in practice.
  for (const marker of ['算：', '不算：', '边界：']) {
    assert.ok(prompt.includes(marker), `术语块缺少边界标记：${marker}`);
  }
  assert.match(prompt, /不删除原始对话/);
  assert.match(prompt, /能写成新闻报道的/);
  assert.match(prompt, /能用"这说的是谁"问出来的才算/);
});

test('extraction prompt: terms come before the format, and rules do not restate them', () => {
  const prompt = renderExtractionPrompt({ text: 'x', now: NOW });
  assert.ok(prompt.indexOf('<terms>') < prompt.indexOf('<output-format>'));
  // The rules block carries operations only; definitions are not repeated there.
  const rules = prompt.slice(prompt.indexOf('<rules>'), prompt.indexOf('</rules>'));
  assert.equal(rules.includes('自包含'), false, '格式说明不应该在规则里再写一遍');
  assert.equal(rules.includes('换算成 YYYY-MM-DD'), false);
  assert.match(rules, /supersede/);
});

test('extraction prompt: evidence goes in whole, never a prefix', () => {
  const longLine =
    '用户要求把注入块里的证据完整保留，因为截断会让后面的判断失去依据，尤其是最后一句往往才是结论，切成半句等于把证据删掉';
  const prompt = renderExtractionPrompt({
    text: 'x',
    now: NOW,
    previousUserText: longLine,
    threads: [{ id: 'th_1', topic: '一个完整主题标题不该在中间被切开', recent: [{ role: 'user', text: longLine }] }],
  });
  // The whole line is present, including its last characters — the part a character
  // cut would remove first and the model would need most.
  assert.ok(prompt.includes(longLine), '整句都在');
  assert.ok(prompt.includes(longLine.slice(-8)), '结尾没有被切掉');
  assert.match(prompt, /一个完整主题标题不该在中间被切开/);
});

test('extraction prompt: the exchange goes in whole, both sides labelled', () => {
  const prompt = renderExtractionPrompt({
    text: '把版本号改一下',
    now: NOW,
    assistantText: '改好了，用的是 edit 工具',
  });
  // ADR 0035: without the reply half, the prompt's "my promises" category is dead.
  assert.match(prompt, /<source>\n用户：把版本号改一下\n我：改好了，用的是 edit 工具\n<\/source>/);

  const oneSided = renderExtractionPrompt({ text: '只说了这一句', now: NOW });
  assert.match(oneSided, /<source>\n用户：只说了这一句\n<\/source>/);
  assert.equal(oneSided.includes('我：'), false, '没有回复时不编一个');
});

test('extraction prompt: provenance rules name both sides', () => {
  const prompt = renderExtractionPrompt({ text: 'x', now: NOW });
  assert.match(prompt, /用户那一侧写 told 或 experienced/);
  assert.match(prompt, /我那一侧写 inferred/);
  assert.match(prompt, /完成声明/);
});

test('extraction prompt: stays within a sane size', () => {
  const prompt = renderExtractionPrompt({ text: 'x'.repeat(200), now: NOW });
  // A guard against runaway growth, not a target: the base prompt is ~3916 chars with
  // a 200-char source (the terms block is the bulk), and candidate text is added at
  // runtime on top. Raise deliberately when the prompt gains a required section.
  assert.ok(prompt.length < 4600, `prompt grew to ${prompt.length} chars`);
});
