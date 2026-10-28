import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, SCHEMA_VERSION, DbNewerThanBinaryError } from '../src/sqlite.ts';
import { ensureConfig, loadConfig, newDeviceId, resolveDbPath } from '../src/storage/config.ts';
import { mergeRecords, pickLatest, liveRecords } from '../src/storage/merge.ts';
import type { Memory } from '../src/types.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'soulbridge-test-'));
}

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
    keywords: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

test('T23 迁移：v1 数据库升到当前版本，数据保留且生成备份', () => {
  const dir = tempDir();
  const file = join(dir, 'v1.db');

  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE souls (soul_id TEXT PRIMARY KEY, name TEXT NOT NULL, creator TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE emotions (
      soul_id TEXT NOT NULL, user_id TEXT NOT NULL, passion REAL NOT NULL, bond REAL NOT NULL,
      tension REAL NOT NULL, self_regard REAL NOT NULL, curiosity REAL NOT NULL, contentment REAL NOT NULL,
      PRIMARY KEY (soul_id, user_id)
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, soul_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL,
      content TEXT NOT NULL, importance REAL NOT NULL, vividness REAL NOT NULL,
      recall_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, visibility TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_recalled_at INTEGER,
      valid_from INTEGER, valid_until INTEGER, superseded_by TEXT
    );
    INSERT INTO schema_meta (k, v) VALUES ('schema_version', '1');
    INSERT INTO memories (id, soul_id, user_id, type, content, importance, vividness, status, visibility, keywords, created_at)
      VALUES ('mem_legacy', 'xiaoling', 'u1', 'fact', '旧库的一条记忆', 5, 0.5, 'active', 'private', '[]', 1000);
  `);
  legacy.close();

  const store = openSqlite(file);
  const rows = store.query({ soulId: 'xiaoling', userId: 'u1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '旧库的一条记忆');
  assert.equal(rows[0].updatedAt, 1000, 'updated_at 应回填为 created_at');
  store.close();

  const check = new DatabaseSync(file);
  const version = check.prepare("SELECT v FROM schema_meta WHERE k = 'schema_version'").get() as { v: string };
  assert.equal(Number(version.v), SCHEMA_VERSION);
  check.close();

  assert.ok(existsSync(`${file}.bak-v1`), '升级前应生成备份');
  rmSync(dir, { recursive: true, force: true });
});

test('T24 拒绝降级：未来版本的库不写入', () => {
  const dir = tempDir();
  const file = join(dir, 'future.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  db.prepare("INSERT INTO schema_meta (k, v) VALUES ('schema_version', '99')").run();
  db.close();

  assert.throws(() => openSqlite(file), (error: unknown) => {
    assert.ok(error instanceof DbNewerThanBinaryError);
    assert.equal((error as DbNewerThanBinaryError).code, 'DB_NEWER_THAN_BINARY');
    return true;
  });
  rmSync(dir, { recursive: true, force: true });
});

test('T25 并发写：两个连接交替写不丢数据', () => {
  const dir = tempDir();
  const file = join(dir, 'concurrent.db');
  const a = openSqlite(file);
  const b = openSqlite(file);

  for (let i = 0; i < 25; i += 1) {
    a.put(memory({ id: `a_${i}`, content: `A ${i}` }));
    b.put(memory({ id: `b_${i}`, content: `B ${i}` }));
  }

  const rows = a.query({ soulId: 'xiaoling', userId: 'u1', limit: 1000 });
  assert.equal(rows.length, 50);
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test('T27 身份：config 创建、deviceId 稳定、env 覆盖', () => {
  const dir = tempDir();
  const previous = process.env.SOULBRIDGE_HOME;
  process.env.SOULBRIDGE_HOME = dir;
  try {
    const first = ensureConfig();
    assert.match(first.deviceId, /^dev_[0-9a-f]{8}$/);
    const second = loadConfig();
    assert.equal(second?.deviceId, first.deviceId);

    process.env.SOULBRIDGE_USER = 'someone';
    const overridden = ensureConfig();
    assert.equal(overridden.userId, 'someone');
    delete process.env.SOULBRIDGE_USER;

    assert.equal(resolveDbPath(), join(dir, 'soul.db'));
    assert.notEqual(newDeviceId(), newDeviceId());
  } finally {
    if (previous === undefined) delete process.env.SOULBRIDGE_HOME;
    else process.env.SOULBRIDGE_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T28/T29 合并语义：LWW + 设备字典序 + 墓碑不复活', () => {
  type Record = { id: string; device: string; at: number; updatedAt: number; deleted?: boolean };
  const older: Record = { id: 'm1', device: 'dev_a', at: 1, updatedAt: 10 };
  const newer: Record = { id: 'm1', device: 'dev_z', at: 1, updatedAt: 20 };
  assert.equal(pickLatest(older, newer).device, 'dev_z');
  assert.equal(pickLatest(newer, older).device, 'dev_z', '与顺序无关');

  const tieA: Record = { id: 'm2', device: 'dev_a', at: 1, updatedAt: 5 };
  const tieB: Record = { id: 'm2', device: 'dev_b', at: 1, updatedAt: 5 };
  assert.equal(pickLatest(tieA, tieB).device, 'dev_b');
  assert.equal(pickLatest(tieB, tieA).device, 'dev_b');

  const tombstone: Record = { id: 'm3', device: 'dev_b', at: 2, updatedAt: 30, deleted: true };
  const original: Record = { id: 'm3', device: 'dev_a', at: 1, updatedAt: 10 };
  const merged = mergeRecords([original, tombstone]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].deleted, true);
  assert.equal(liveRecords([original, tombstone]).length, 0, '删除后不能被旧记录复活');
});
