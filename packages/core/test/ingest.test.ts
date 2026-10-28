import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteering, normalizeForDedupe } from '../src/storage/steering.ts';
import { parseTranscriptJsonl } from '../src/storage/transcript.ts';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';

const STEERING = `# AGENTS.md

一些介绍性文字。

## Rules

- 提交前必须跑 make check，否则 CI 会挂。
- 不要修改 third_party 目录。
- 我喜欢简洁的回答，不要铺垫。
- [x] 每次发布前更新 CHANGELOG。

这个仓库使用 TypeScript，所有代码必须通过 typecheck。

\`\`\`bash
rm -rf /
\`\`\`

| a | b |
|---|---|
| 1 | 2 |

![badge](https://example.com/badge.svg)
https://example.com
`;

test('steering 解析：只取陈述句与列表项，跳过围栏/表格/链接', () => {
  const drafts = parseSteering(STEERING);
  const texts = drafts.map((d) => d.text);

  assert.equal(drafts.length, 5);
  assert.ok(texts.some((t) => t.includes('提交前必须跑 make check')));
  assert.ok(texts.some((t) => t.includes('这个仓库使用 TypeScript')));
  assert.ok(!texts.some((t) => t.includes('rm -rf')));
  assert.ok(!texts.some((t) => t.includes('| a |')));
  assert.ok(!texts.some((t) => t.startsWith('http')));
  assert.ok(!texts.some((t) => t.startsWith('一些介绍性文字')));
});

test('steering 分类：必须→strategy、喜欢→trait、项目→fact', () => {
  const drafts = parseSteering(STEERING);
  const byText = (needle: string) => drafts.find((d) => d.text.includes(needle));

  assert.equal(byText('提交前必须跑')?.type, 'strategy');
  assert.equal(byText('提交前必须跑')?.importance, 8);
  assert.equal(byText('我喜欢简洁')?.type, 'trait');
  assert.equal(byText('这个仓库使用')?.type, 'strategy', '含“必须”归为策略');
});

test('steering 去重：同一文件内重复句只保留一条', () => {
  const drafts = parseSteering('- 提交前必须跑 make check。\n- 提交前必须跑 make check。');
  assert.equal(drafts.length, 1);
});

test('normalizeForDedupe：忽略空格与标点', () => {
  assert.equal(normalizeForDedupe('提交前 必须跑 make check。'), normalizeForDedupe('提交前必须跑 make check'));
});

test('import 幂等：第二次导入不写重复记忆', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  const drafts = parseSteering(STEERING);

  const importOnce = () => {
    const existing = new Set(
      store.query({ soulId: 'xiaoling', userId: 'u1', limit: 1000 }).map((m) => normalizeForDedupe(m.content)),
    );
    let written = 0;
    for (const draft of drafts) {
      const key = normalizeForDedupe(draft.text);
      if (existing.has(key)) continue;
      existing.add(key);
      soul.remember(draft.text, { type: draft.type, importance: draft.importance });
      written += 1;
    }
    return written;
  };

  assert.equal(importOnce(), 5);
  assert.equal(importOnce(), 0);
  assert.equal(store.count('xiaoling', 'u1'), 5);
  store.close();
});

test('transcript 解析：四种行形态，跳过头/工具/坏行', () => {
  const text = [
    '{"type":"header","version":1}',
    '{"role":"user","content":"第一条"}',
    '{"type":"assistant","text":"回复一"}',
    '{"message":{"role":"user","content":[{"type":"text","text":"数组内容"}]}}',
    '{"role":"tool","content":"tool output"}',
    'not json',
    '{"role":"user","content":"第一条"}',
  ].join('\n');

  const { turns, skipped } = parseTranscriptJsonl(text);
  assert.equal(turns.length, 4);
  assert.equal(skipped, 3);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user', 'user']);
  assert.equal(turns[2].content, '数组内容');
});

test('transcript 解析：连续重复行被合并', () => {
  const text = [
    '{"role":"user","content":"重复"}',
    '{"role":"user","content":"重复"}',
    '{"role":"assistant","content":"好"}',
  ].join('\n');
  assert.equal(parseTranscriptJsonl(text).turns.length, 2);
});

test('ingest 等价流程：转写 → 反思写入记忆', async () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  const { turns } = parseTranscriptJsonl(
    [
      '{"role":"user","content":"以后提交前先跑 make check"}',
      '{"role":"assistant","content":"好"}',
      '{"role":"user","content":"我喜欢简洁的回答"}',
    ].join('\n'),
  );

  const result = await soul.reflect(turns);
  assert.equal(result.memories, 2);
  assert.equal(store.count('xiaoling', 'u1'), 2);

  const again = await soul.reflect(turns);
  assert.equal(again.memories, 0, '重复 ingest 不应重复写');
  store.close();
});
