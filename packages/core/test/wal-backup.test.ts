import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupBeforeUpgrade } from '../src/sqlite.ts';

test('备份包含 WAL 里的最新写入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soulbridge-wal-'));
  const file = join(dir, 'db.sqlite');

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE t (v TEXT)');
  // Written but not closed: the row lives in the -wal sidecar.
  db.prepare('INSERT INTO t VALUES (?)').run('kept');

  backupBeforeUpgrade(db, file, 2);
  db.close();

  const copy = new DatabaseSync(`${file}.bak-v2`);
  const row = copy.prepare('SELECT v FROM t').get() as { v: string };
  assert.equal(row.v, 'kept', '备份不能丢掉还在 WAL 里的提交');
  const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  assert.equal(check.integrity_check, 'ok', '备份可独立打开且完整');
  copy.close();

  assert.ok(statSync(`${file}.bak-v2`).size > 0);
  rmSync(dir, { recursive: true, force: true });
});
