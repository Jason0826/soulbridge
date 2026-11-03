/**
 * The legacy `memories` rows become facts, once (ADR 0032 / retirements.json).
 *
 * The write path is gone (observe/remember/reflect all write facts), so this test is
 * about the one-time move: nothing lost, nothing copied twice, old rows marked rather
 * than deleted, and the injections pick up the moved statements.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import type { Memory } from '../src/types.ts';

const NOW = Date.parse('2026-11-02T04:00:00Z');

function legacyMemory(id: string, content: string, type: Memory['type'] = 'strategy', importance = 8): Memory {
  return {
    id,
    soulId: 'xiaoling',
    userId: 'u1',
    type,
    content,
    importance,
    vividness: 0.8,
    recallCount: 0,
    status: 'active',
    visibility: 'private',
    keywords: [],
    createdAt: NOW,
    updatedAt: NOW,
    validFrom: NOW,
  };
}

test('migration: memories become facts, and the old rows are marked superseded', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  store.put(legacyMemory('mem_a', '改完代码先跑 verify-installed'));
  store.put(legacyMemory('mem_b', '用户讨厌重复交代', 'trait', 7));

  const result = soul.migrateLegacyMemories();
  assert.deepEqual(result, { migrated: 2, linked: 0, skipped: 0 });

  const facts = soul.list(100);
  assert.equal(facts.length, 2, '两条都进了 facts');
  assert.ok(facts.some((f) => f.content === '改完代码先跑 verify-installed'));

  const rows = store.query({ soulId: 'xiaoling', userId: 'u1', includeExpired: true, status: ['superseded'] });
  assert.equal(rows.length, 2, '旧行不删除，只标 superseded');
  assert.ok(rows.every((row) => row.supersededBy !== undefined), '指向新事实，可追溯');

  // Moved statements still reach the prompt: migrated rows carry 锚点=是.
  assert.ok(soul.context({ track: false }).text.includes('verify-installed'));
  store.close();
});

test('migration: re-running copies nothing twice', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  store.put(legacyMemory('mem_a', '改完代码先跑 verify-installed'));
  soul.migrateLegacyMemories();

  const again = soul.migrateLegacyMemories();
  assert.equal(again.migrated, 0, '旧行已 superseded，不再迁移');
  assert.equal(soul.list(100).length, 1);
  store.close();
});

test('migration: a statement that already has a fact is linked, not duplicated', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  const fact = soul.recordFact({ statement: '改完代码先跑 verify-installed', holder: 'self', source: 'told', confidence: 0.9 });
  store.put(legacyMemory('mem_a', '改完代码先跑 verify-installed'));

  const result = soul.migrateLegacyMemories();
  assert.equal(result.migrated, 0);
  assert.equal(result.linked, 1);
  assert.equal(soul.list(100).length, 1);
  const rows = store.query({ soulId: 'xiaoling', userId: 'u1', includeExpired: true, status: ['superseded'] });
  assert.equal(rows[0]?.supersededBy, fact.id);
  store.close();
});
