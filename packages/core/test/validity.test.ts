import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import type { Memory } from '../src/types.ts';

const NOW = Date.parse('2026-10-29T04:00:00Z');

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem_${Math.random().toString(36).slice(2, 8)}`,
    soulId: 'xiaoling',
    userId: 'u1',
    type: 'fact',
    content: '发布窗口是周三',
    importance: 7,
    vividness: 0.8,
    recallCount: 0,
    status: 'active',
    visibility: 'private',
    keywords: [],
    createdAt: NOW,
    updatedAt: NOW,
    validFrom: NOW,
    ...overrides,
  };
}

test('过期记忆：不进 context，但 store 仍能查到（审计视图）', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  store.put(memory({ id: 'expired', content: '旧发布窗口是周二', validUntil: NOW - 1 }));

  const context = soul.context({ track: false });
  assert.ok(!context.text.includes('旧发布窗口'), '过期内容不得注入');

  // The public list() reads facts now; the legacy table is inspected at the store
  // layer, which is where its remaining semantics (expiry, supersession) live.
  const audited = store.query({ soulId: 'xiaoling', userId: 'u1', includeExpired: true });
  assert.ok(audited.some((m) => m.id === 'expired'), '审计视图仍能看到');
  store.close();
});

test('未过期记忆正常注入', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  // 过期判定用的是真实的 Date.now()，所以这条必须相对真实时间取未来。
  // 用固定的 NOW 会让它在 NOW+1 天之后自己失效（2026-10-30 已经发生过一次）。
  store.put(memory({ id: 'valid', content: '发布窗口是周三', validUntil: Date.now() + 86_400_000 }));
  assert.ok(soul.context({ track: false }).text.includes('发布窗口是周三'));
  store.close();
});

test('supersede：旧条目不进 context，状态与指向正确', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  store.put(memory({ id: 'old', content: '发布窗口是周三' }));
  store.put(memory({ id: 'new', content: '发布窗口改成周四' }));

  assert.equal(soul.supersede('old', 'new'), true);
  const context = soul.context({ track: false });
  assert.ok(!context.text.includes('发布窗口是周三'), '被取代的不再注入');
  assert.ok(context.text.includes('发布窗口改成周四'), '新的仍在');

  const rows = store.query({ soulId: 'xiaoling', userId: 'u1', includeExpired: true, status: ['superseded'] });
  const old = rows.find((m) => m.id === 'old');
  assert.equal(old?.status, 'superseded');
  assert.equal(old?.supersededBy, 'new');
  store.close();
});

test('supersede 幂等，且拒绝不存在的替代者', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  store.put(memory({ id: 'old' }));
  store.put(memory({ id: 'new' }));

  assert.equal(soul.supersede('old', 'missing'), false, '替代者不存在时拒绝');
  assert.equal(soul.supersede('old', 'new'), true);
  assert.equal(soul.supersede('old', 'new'), false, '重复取代返回 false，不抛错');
  store.close();
});

test('recall 排除已被取代的事实', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  const old = soul.recordFact({ statement: '提交前先跑 make check', holder: 'self', source: 'told', confidence: 0.9 });
  soul.recordFact({ statement: '提交前先跑 make check 两次', holder: 'self', source: 'told', confidence: 0.9 });
  store.supersedeFact(old.id, 'fc_replacement');

  const hits = soul.recall('提交前先跑 make check', 10);
  assert.ok(!hits.some((h) => h.memory.id === old.id), '被取代的不参与召回');
  store.close();
});
