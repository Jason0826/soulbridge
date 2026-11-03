/**
 * Move the legacy `memories` rows into facts (retirements.json: memories-write).
 *
 * This script used to copy rows with its own SQL and then `DELETE FROM memories` —
 * a second mapping next to the code, and a deletion where the project rule is "keep
 * the original, retire it". It now calls `Soul.migrateLegacyMemories()`, which is
 * idempotent, keeps every old row with `superseded_by` pointing at its new fact, and
 * is the same code the tests cover.
 *
 *   node scripts/migrate-memories.mjs --dry-run
 *   node scripts/migrate-memories.mjs --apply
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite } from '../packages/core/src/index.ts';
import { Soul } from '../packages/core/src/index.ts';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const dbFile = join(HOME, 'soul.db');
const apply = process.argv.includes('--apply');
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('pass --dry-run or --apply');
  process.exit(2);
}
if (!existsSync(dbFile)) {
  console.error(`no database at ${dbFile}`);
  process.exit(2);
}

// Identities come from the data, not from a constant: the store may hold more than
// one soul/user pair, and a migration that touches only one looks like it worked.
const probe = new DatabaseSync(dbFile, { readOnly: true });
const souls = probe.prepare('SELECT DISTINCT soul_id, user_id FROM memories').all();
const pending = probe.prepare("SELECT COUNT(*) n FROM memories WHERE status = 'active'").get();
probe.close();
console.log(`identities: ${souls.length} | active memories: ${pending.n}`);

if (!apply) {
  console.log('dry run — nothing migrated');
  process.exit(0);
}

const backup = `${dbFile}.bak-memories-${Date.now()}`;
copyFileSync(dbFile, backup);
console.log(`backup: ${backup}`);

const store = openSqlite(dbFile);
let total = { migrated: 0, linked: 0, skipped: 0 };
for (const row of souls) {
  const soul = new Soul({ store, soulId: String(row.soul_id), userId: String(row.user_id) });
  const result = soul.migrateLegacyMemories();
  total = {
    migrated: total.migrated + result.migrated,
    linked: total.linked + result.linked,
    skipped: total.skipped + result.skipped,
  };
  console.log(`${row.soul_id}/${row.user_id}:`, result);
}
store.close();
console.log('合计:', total);
if (total.migrated + total.linked === 0) {
  console.log('没有可迁移的行（已经跑过或表已空）');
}
