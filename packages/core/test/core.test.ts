import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { buildContext } from '../src/context.ts';
import { reflect, ruleExtract, nextEmotion } from '../src/reflect.ts';
import { DEFAULT_EMOTION } from '../src/types.ts';
import type { Memory } from '../src/types.ts';

const NOW = Date.parse('2026-10-27T12:00:00Z');

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem_${Math.random().toString(36).slice(2, 8)}`,
    soulId: 'xiaoling',
    userId: 'u1',
    type: 'strategy',
    content: '提交前先跑 make check',
    importance: 8,
    vividness: 0.8,
    recallCount: 0,
    status: 'active',
    visibility: 'private',
    keywords: ['提交', 'make'],
    createdAt: NOW - 86_400_000,
    ...overrides,
  };
}

test('store: 私有记忆只对本人可见，shared 对所有人可见', () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });

  const priv = memory({ userId: 'u1', visibility: 'private', content: 'u1 的私有' });
  const shared = memory({ userId: 'u1', visibility: 'shared', content: '共享事实' });
  store.put(priv);
  store.put(shared);

  const forU1 = store.query({ soulId: 'xiaoling', userId: 'u1' }).map((m) => m.content);
  const forU2 = store.query({ soulId: 'xiaoling', userId: 'u2' }).map((m) => m.content);

  assert.deepEqual(forU1.sort(), ['u1 的私有', '共享事实'].sort());
  assert.deepEqual(forU2, ['共享事实']);
  store.close();
});

test('store: touch 增加召回次数并记录时间', () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });
  const m = memory();
  store.put(m);

  store.touch([m.id], NOW);
  store.touch([m.id], NOW);

  const [after] = store.query({ soulId: 'xiaoling', userId: 'u1' });
  assert.equal(after.recallCount, 2);
  assert.equal(after.lastRecalledAt, NOW);
  store.close();
});

test('context: 包含身份、记忆，并在注入后记一次唤醒', () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW - 5 * 86_400_000 });
  store.put(memory());

  const result = buildContext(store, { soulId: 'xiaoling', userId: 'u1', query: '提交前' }, NOW);
  assert.match(result.text, /<soul name="小灵">/);
  assert.match(result.text, /提交前先跑 make check/);
  assert.equal(result.used.length, 1);
  assert.equal(result.dropped, 0);

  const [after] = store.query({ soulId: 'xiaoling', userId: 'u1' });
  assert.equal(after.recallCount, 1);
  store.close();
});

test('context: 超预算时整条丢弃而不是截断', () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });
  for (let i = 0; i < 20; i += 1) {
    store.put(memory({ content: `第 ${i} 条很长的记忆内容，用来把预算撑爆，重复填充文字。` }));
  }

  const result = buildContext(store, { soulId: 'xiaoling', userId: 'u1', maxChars: 400 }, NOW);
  assert.ok(result.dropped > 0, '应当丢弃部分记忆');
  assert.ok(result.chars <= 400, `注入文本应受预算约束，实际 ${result.chars}`);
  assert.ok(!result.text.includes('…'), '不允许出现截断省略号');
  store.close();
});

test('context: 高张力时注入谨慎指令', () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });
  store.saveEmotion('xiaoling', 'u1', { ...DEFAULT_EMOTION, tension: 1.5 });

  const result = buildContext(store, { soulId: 'xiaoling', userId: 'u1' }, NOW);
  assert.match(result.text, /回答前先确认理解/);
  store.close();
});

test('reflect: 规则抽取 + 去重 + 情绪更新', async () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });

  const turns = [
    { role: 'user' as const, content: '以后提交前先跑 make check' },
    { role: 'assistant' as const, content: '好' },
    { role: 'user' as const, content: '我喜欢简洁的回答' },
    { role: 'user' as const, content: '不对，这个方案错了' },
  ];

  const drafts = ruleExtract(turns);
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].type, 'strategy');
  assert.equal(drafts[1].type, 'trait');

  const first = await reflect(store, { soulId: 'xiaoling', userId: 'u1', turns, now: NOW });
  assert.equal(first.memories, 2);
  assert.ok(first.emotion.tension >= 0.4, '被纠正后张力应上升');

  const second = await reflect(store, { soulId: 'xiaoling', userId: 'u1', turns, now: NOW + 1000 });
  assert.equal(second.memories, 0, '同样内容不应重复写入');
  store.close();
});

test('nextEmotion: 普通会话让张力衰减', () => {
  const calm = nextEmotion({ ...DEFAULT_EMOTION, tension: 1 }, [{ role: 'user', content: '继续' }]);
  assert.ok(calm.tension < 1);
});

test('reflect: updateEmotion=false 不改变情绪（每轮调用不重复计数）', async () => {
  const store = openSqlite(':memory:');
  store.ensureSoul({ soulId: 'xiaoling', name: '小灵', createdAt: NOW });
  store.saveEmotion('xiaoling', 'u1', { ...DEFAULT_EMOTION }, NOW);
  const before = store.emotion('xiaoling', 'u1');

  const result = await reflect(store, {
    soulId: 'xiaoling',
    userId: 'u1',
    turns: [{ role: 'user', content: '不对，这个方案错了' }],
    updateEmotion: false,
  });

  assert.deepEqual(result.emotion, before);
  assert.deepEqual(store.emotion('xiaoling', 'u1'), before);
  store.close();
});