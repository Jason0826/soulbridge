import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, relevance, recency, rank, scoreMemory } from '../src/scoring.ts';
import type { Memory } from '../src/types.ts';

const NOW = Date.parse('2026-10-27T12:00:00Z');

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_1',
    soulId: 'xiaoling',
    userId: 'u1',
    type: 'strategy',
    content: '提交前先跑 make check',
    importance: 8,
    vividness: 0.8,
    recallCount: 0,
    status: 'active',
    visibility: 'private',
    keywords: [],
    createdAt: NOW - 86_400_000,
    ...overrides,
  };
}

test('tokenize: 中文用二元组，英文用词', () => {
  const tokens = tokenize('提交前 run make check');
  assert.ok(tokens.includes('提交'));
  assert.ok(tokens.includes('交前'));
  assert.ok(tokens.includes('make'));
  assert.ok(!tokens.includes('提交前先跑'));
});

test('relevance: 命中关键词得 1，完全不相关得 0', () => {
  const m = memory();
  assert.equal(relevance(tokenize('提交前'), m), 1);
  assert.equal(relevance(tokenize('数据库迁移'), m), 0);
  assert.ok(relevance(tokenize('提交 测试'), m) > 0);
});

test('recency: 30 天减半', () => {
  assert.equal(recency(NOW, NOW), 1);
  assert.ok(Math.abs(recency(NOW - 30 * 86_400_000, NOW) - 0.5) < 1e-9);
});

test('scoreMemory: 重要度与新鲜度都影响分数', () => {
  const fresh = memory({ createdAt: NOW });
  const stale = memory({ createdAt: NOW - 120 * 86_400_000 });
  assert.ok(scoreMemory(fresh, [], NOW) > scoreMemory(stale, [], NOW));

  const important = memory({ createdAt: NOW, importance: 10 });
  const minor = memory({ createdAt: NOW, importance: 1 });
  assert.ok(scoreMemory(important, [], NOW) > scoreMemory(minor, [], NOW));
});

test('rank: 有查询时，不相关的记忆被排除；没有查询时按权重排序', () => {
  const relevant = memory({ id: 'a', content: '提交前先跑 make check', importance: 3, createdAt: NOW });
  const irrelevant = memory({ id: 'b', content: '用户喜欢深色模式', importance: 10, createdAt: NOW });

  const ranked = rank([irrelevant, relevant], '提交前要做什么', NOW);
  assert.equal(ranked.length, 1, '不相关的记忆应被排除，即使它更重要');
  assert.equal(ranked[0].memory.id, 'a');

  const unqueried = rank([irrelevant, relevant], '', NOW);
  assert.equal(unqueried.length, 2);
  assert.equal(unqueried[0].memory.id, 'b', '无查询时重要度更高者在前');
});
