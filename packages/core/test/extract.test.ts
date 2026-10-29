import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleExtract, RULES, distillStrategy, MAX_STRATEGY_CHARS, llmExtractTurn, isQuestion } from '../src/reflect.ts';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
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

test('distill: 长段落只保留带要求的那个从句', () => {
  const text =
    '误判倒也谈不上，这些词你是要放到情景里面才有意义，每次有可能是抱怨，也有可能真的是策略，比如你每次在做改动之前，都需要让我解释说明，为什么、怎么做、会有什么影响';
  const drafts = ruleExtract([user(text)]);
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].content.length <= MAX_STRATEGY_CHARS, '策略必须短');
  assert.ok(drafts[0].content.includes('做改动之前') && drafts[0].content.includes('需要'), '保留带触发词与要求的从句');
  assert.ok(!drafts[0].content.startsWith('误判'), '丢掉前面的讨论');
  assert.ok(!drafts[0].content.includes('有可能是抱怨'), '只保留真正的指令从句');
});

test('distill: 本来就很短的指令保持不变', () => {
  assert.equal(distillStrategy('以后提交前先跑 make check'), '以后提交前先跑 make check');
});

test('distill: 触发词和要求词离得太远则不提炼，也不入库', () => {
  const text =
    '每次都很慢，我花了很多时间排查，改了很多地方，最后发现是端口的问题，也换了电脑，清空了缓存，重装了依赖，所以你需要的话我可以再看';
  assert.equal(distillStrategy(text), null);
  assert.equal(ruleExtract([user(text)]).length, 0);
});
test('observe 去重：同一句话重复出现只写一条', async () => {
  const { Soul } = await import('../src/index.ts');
  const { openSqlite } = await import('../src/sqlite.ts');
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });

  await soul.observe({ role: 'user', content: '我习惯先看日志再动手' });
  await soul.observe({ role: 'user', content: '我习惯先看日志再动手' });

  assert.equal(store.count('xiaoling', 'u1'), 1);
  store.close();
});
test('LLM 端口：解析 JSON 并保留类型', async () => {
  const llm = async () => '{"type":"strategy","text":"改动前先解释方案"}';
  const draft = await llmExtractTurn('随便一句', llm);
  assert.equal(draft?.type, 'strategy');
  assert.equal(draft?.content, '改动前先解释方案');
});

test('LLM 端口：null 表示不值得记，不抛错', async () => {
  const draft = await llmExtractTurn('今天天气不错', async () => '{"type":"null"}');
  assert.equal(draft, null);
});

test('LLM 端口：坏 JSON / 非法类型抛错（交给调用方回退规则）', async () => {
  await assert.rejects(() => llmExtractTurn('x', async () => '这不是 JSON'));
  await assert.rejects(() => llmExtractTurn('x', async () => '{"type":"episodic","text":"a"}'));
});

test('reflect：模型说 null 时不再用规则兜底', async () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: Date.now() });
  const { reflect } = await import('../src/reflect.ts');
  const result = await reflect(store, {
    soulId: 'xiaoling',
    userId: 'u1',
    turns: [{ role: 'user', content: '以后提交前先跑 make check' }],
    llm: async () => '{"type":"null"}',
  });
  assert.equal(result.memories, 0, '模型判定不记，则规则不得插手');
  store.close();
});

test('reflect：模型失败时回退到规则', async () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: Date.now() });
  const { reflect } = await import('../src/reflect.ts');
  const result = await reflect(store, {
    soulId: 'xiaoling',
    userId: 'u1',
    turns: [{ role: 'user', content: '以后提交前先跑 make check' }],
    llm: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(result.memories, 1, '传输失败时规则兜底');
  store.close();
});

test('question guard: interrogatives are not extracted', () => {
  const no = ruleExtract([{ role: 'user', content: '我们这个记忆会记住日常生活吗？' }]);
  assert.equal(no.length, 0, 'a question is not a fact');

  const tail = ruleExtract([{ role: 'user', content: '以后提交前先跑测试吗' }]);
  assert.equal(tail.length, 0, 'trailing 吗 without punctuation still marks a question');

  const ok = ruleExtract([{ role: 'user', content: '以后提交前先跑测试' }]);
  assert.equal(ok.length, 1, 'statements still work');
});

test('isQuestion: shapes', () => {
  assert.equal(isQuestion('为什么'), false);
  assert.equal(isQuestion('这个怎么做？'), true);
  assert.equal(isQuestion('what?'), true);
  assert.equal(isQuestion('以后别问我为什么'), false);
});