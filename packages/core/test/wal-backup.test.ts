/**
 * The backup is the only way back, so it must be valid — not merely present.
 *
 * Two failures were possible: a file copy after a *busy* checkpoint dropped the
 * newest commits, and an existing backup file was trusted forever (including a
 * broken one from an earlier attempt). The test that existed wrote and backed up on
 * one connection, so neither could happen; the cases below pin a snapshot on a
 * second connection, which is what a CLI running beside the plugin does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupBeforeUpgrade } from '../src/sqlite.ts';

function seed(file: string) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE t (v TEXT)');
  return db;
}

test('backup: a snapshot pinned by another reader does not lose the newest commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soulbridge-wal-'));
  const file = join(dir, 'db.sqlite');
  const writer = seed(file);
  writer.prepare('INSERT INTO t VALUES (?)').run('first');

  // A second connection starts a read transaction: the checkpoint cannot advance
  // past its snapshot, which is exactly the busy case the old copy ignored.
  const reader = new DatabaseSync(file);
  reader.exec('BEGIN');
  reader.prepare('SELECT COUNT(*) FROM t').get();

  writer.prepare('INSERT INTO t VALUES (?)').run('second');
  backupBeforeUpgrade(writer, file, 2);
  reader.exec('COMMIT');
  reader.close();
  writer.close();

  const copy = new DatabaseSync(`${file}.bak-v2`, { readOnly: true });
  const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  assert.equal(check.integrity_check, 'ok', '备份必须能独立通过完整性检查');
  const rows = copy.prepare('SELECT v FROM t ORDER BY rowid').all() as Array<{ v: string }>;
  assert.deepEqual(rows.map((row) => row.v), ['first', 'second'], '备份不能丢掉还在 WAL 里的提交');
  copy.close();
  rmSync(dir, { recursive: true, force: true });
});

test('backup: an unusable existing backup is not trusted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soulbridge-wal-'));
  const file = join(dir, 'db.sqlite');
  const db = seed(file);
  db.prepare('INSERT INTO t VALUES (?)').run('kept');

  // The broken copy an earlier attempt could have left behind.
  writeFileSync(`${file}.bak-v2`, 'not a database', 'utf8');
  assert.throws(() => backupBeforeUpgrade(db, file, 2), /not readable/);
  // It is moved aside rather than silently reused…
  assert.equal(existsSync(`${file}.bak-v2`), false, '坏备份必须被挪走，不能留在原位');
  db.close();

  // …and the next attempt produces a valid one.
  const again = new DatabaseSync(file);
  backupBeforeUpgrade(again, file, 2);
  again.close();
  const copy = new DatabaseSync(`${file}.bak-v2`, { readOnly: true });
  const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  assert.equal(check.integrity_check, 'ok');
  copy.close();
  rmSync(dir, { recursive: true, force: true });
});
