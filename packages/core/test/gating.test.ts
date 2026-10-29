import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
test('observe 门控：规则命中的句子不调用模型', async () => {
  const store = openSqlite(':memory:');
  let calls = 0;
  const soul = new Soul({
    store,
    soulId: 'xiaoling',
    userId: 'u1',
    llm: async () => {
      calls += 1;
      return '{"type":"null"}';
    },
  });
  const result = await soul.observe({ role: 'user', content: '以后提交前先跑测试' });
  assert.equal(calls, 0, '规则命中时模型不应被调用');
  assert.equal(result.extractedBy, 'rules');
  store.close();
});

test('observe 门控：规则漏掉时由模型补，并标记来源', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({
    store,
    soulId: 'xiaoling',
    userId: 'u1',
    llm: async () => '{"type":"fact","text":"升级前先备份 schema 版本文件"}',
  });
  const result = await soul.observe({ role: 'user', content: '这个文件里存的是 schema 版本号，升级时要先备份' });
  assert.equal(result.written, 1);
  assert.equal(result.extractedBy, 'llm');
  assert.equal(store.query({ soulId: 'xiaoling', userId: 'u1' })[0].content, '升级前先备份 schema 版本文件');
  store.close();
});

test('observe 门控：模型说 null 时不写，也不回退', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1', llm: async () => '{"type":"null"}' });
  const result = await soul.observe({ role: 'user', content: '今天先到这里吧' });
  assert.equal(result.written, 0);
  assert.equal(result.extractedBy, 'none');
  store.close();
});

test('observe 门控：模型失败不影响 observe', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({
    store,
    soulId: 'xiaoling',
    userId: 'u1',
    llm: async () => {
      throw new Error('network down');
    },
  });
  const result = await soul.observe({ role: 'user', content: '这个文件里存的是 schema 版本号' });
  assert.equal(result.written, 0);
  assert.equal(result.extractedBy, 'none');
  store.close();
});

test('observe 门控：超长消息不送模型（跳过而非截断）', async () => {
  const store = openSqlite(':memory:');
  let calls = 0;
  const soul = new Soul({
    store,
    soulId: 'xiaoling',
    userId: 'u1',
    llm: async () => {
      calls += 1;
      return '{"type":"null"}';
    },
    llmMaxChars: 2000,
  });
  const result = await soul.observe({ role: 'user', content: '日志'.repeat(1500) });
  assert.equal(calls, 0);
  assert.equal(result.extractedBy, 'none');
  store.close();
});

test('observe 门控：没有注入模型时行为不变（纯规则）', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  const result = await soul.observe({ role: 'user', content: '这个文件里存的是 schema 版本号' });
  assert.equal(result.written, 0);
  assert.equal(result.extractedBy, 'none');
  store.close();
});
