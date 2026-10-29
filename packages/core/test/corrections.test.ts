import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, SCHEMA_VERSION } from '../src/sqlite.ts';
import { Soul } from '../src/index.ts';
import { isCorrection, correctionRule } from '../src/reflect.ts';

test('isCorrection: 识别纠正，放过普通陈述', () => {
  assert.equal(isCorrection('不对，截断是粗暴的方式'), true);
  assert.equal(isCorrection('错了，这个方案不行'), true);
  assert.equal(isCorrection('以后提交前先跑测试'), false);
  assert.equal(correctionRule('不对，截断是粗暴的方式'), '不对');
  assert.equal(correctionRule('以后提交前先跑测试'), null);
});

test('recordCorrection: 完整保存两段文本，不做截断', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  const assistantText = '我会用 slice(0, 400) 截断日志。'.repeat(50);
  const userText = '不对，截断是粗暴的方式';

  const id = soul.recordCorrection({ userText, assistantText, rule: '不对' });
  const [saved] = soul.corrections();

  assert.equal(saved.id, id);
  assert.equal(saved.userText, userText);
  assert.equal(saved.assistantText, assistantText, '回复必须完整保存');
  assert.equal(saved.rule, '不对');
  store.close();
});

test('corrections 不进入注入内容', () => {
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'u1' });
  soul.recordCorrection({ userText: '不对，截断是粗暴的方式', assistantText: '……' });

  const result = soul.context({ track: false });
  assert.ok(!result.text.includes('截断是粗暴'), '证据不得出现在 prompt 里');
  assert.equal(result.used.length, 0);
  store.close();
});

test('迁移：v2 库升级后 corrections 可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soulbridge-v3-'));
  const file = join(dir, 'v2.db');

  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE souls (soul_id TEXT PRIMARY KEY, name TEXT NOT NULL, creator TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE emotions (
      soul_id TEXT NOT NULL, user_id TEXT NOT NULL, passion REAL NOT NULL, bond REAL NOT NULL,
      tension REAL NOT NULL, self_regard REAL NOT NULL, curiosity REAL NOT NULL, contentment REAL NOT NULL,
      primary key (soul_id, user_id)
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, soul_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL,
      content TEXT NOT NULL, importance REAL NOT NULL, vividness REAL NOT NULL,
      recall_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, visibility TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_recalled_at INTEGER,
      valid_from INTEGER, valid_until INTEGER, superseded_by TEXT,
      updated_at INTEGER, deleted_at INTEGER
    );
    INSERT INTO schema_meta (k, v) VALUES ('schema_version', '2');
  `);
  legacy.close();

  const store = openSqlite(file);
  store.saveCorrection({
    id: 'cor_1',
    soulId: 'xiaoling',
    userId: 'u1',
    at: 1,
    userText: '不对',
  });
  assert.equal(store.countCorrections('xiaoling', 'u1'), 1);
  store.close();

  const check = new DatabaseSync(file);
  const row = check.prepare("SELECT v FROM schema_meta WHERE k = 'schema_version'").get() as { v: string };
  assert.equal(Number(row.v), SCHEMA_VERSION);
  check.close();
  rmSync(dir, { recursive: true, force: true });
});
