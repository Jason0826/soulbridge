/**
 * Give every fact a `role` and move `status` to the four-state vocabulary.
 *
 * Why a script and not a migration: the change is data-shaped (backfill from type_name, map
 * old statuses) and it is the one irreversible step in the rebuild, so it must be inspectable
 * before it runs. Dry-run by default; --apply takes a backup, runs in one transaction, and
 * verifies counts after.
 *
 *   node scripts/migrate-roles.mjs            # dry run: what would change
 *   node scripts/migrate-roles.mjs --apply    # backup + migrate + verify
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const dbFile = join(HOME, 'soul.db');
const apply = process.argv.includes('--apply');

/** type_name → role. Anything not listed is an observation. */
const ROLE_BY_TYPE = {
  规则: 'rule',
  画像: 'profile',
  结论: 'judgment',
  判断: 'judgment',
  决定: 'judgment',
  承诺: 'promise',
  教训: 'lesson',
};

const STATE_MAP = { none: 'active', open: 'active', kept: 'active', broken: 'retracted', superseded: 'retracted' };

const db = new DatabaseSync(dbFile, { readOnly: !apply });
const rows = db.prepare("SELECT COALESCE(type_name,'') t, status, COUNT(*) n FROM facts GROUP BY t, status").all();

const roleCounts = {};
const stateCounts = {};
for (const row of rows) {
  const role = ROLE_BY_TYPE[row.t] ?? 'observation';
  roleCounts[role] = (roleCounts[role] ?? 0) + Number(row.n);
  const state = STATE_MAP[row.status] ?? 'active';
  stateCounts[state] = (stateCounts[state] ?? 0) + Number(row.n);
}

console.log('将写入的 role 分布:');
for (const [role, n] of Object.entries(roleCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${role}`);
console.log('将写入的 status 分布:');
for (const [state, n] of Object.entries(stateCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${state}`);

if (!apply) {
  console.log('\n（dry run）确认无误后加 --apply。');
  db.close();
  process.exit(0);
}

// Backup first: VACUUM INTO reads through WAL and cannot be half-written.
const backup = join(HOME, `soul.db.bak-roles-${Date.now()}`);
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`备份: ${backup}`);

db.exec('BEGIN IMMEDIATE');
try {
  db.exec("ALTER TABLE facts ADD COLUMN role TEXT NOT NULL DEFAULT 'observation'");
  for (const [typeName, role] of Object.entries(ROLE_BY_TYPE)) {
    db.prepare('UPDATE facts SET role = ? WHERE type_name = ?').run(role, typeName);
  }
  // '判断' was a type name before the rename; keep it in the mapping for old rows.
  for (const [oldState, newState] of Object.entries(STATE_MAP)) {
    db.prepare('UPDATE facts SET status = ? WHERE status = ?').run(newState, oldState);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  console.error('迁移失败，已回滚：', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const verify = db.prepare('SELECT role, status, COUNT(*) n FROM facts GROUP BY role, status').all();
console.log('校验:');
for (const row of verify) console.log(`  ${row.role}/${row.status}: ${row.n}`);
db.close();
