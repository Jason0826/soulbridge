/**
 * Move the legacy `memories` rows into the two-layer facts, then retire the table.
 *
 * The legacy table is the last piece of the old model: it holds lessons and traits
 * that are real knowledge ("JSON 用 edit 工具改"), but stores them outside the facts
 * layer, so anchors had to read two sources. Migrating them as person-layer facts
 * keeps the knowledge and lets anchors read one place.
 *
 *   node scripts/migrate-memories.mjs --dry-run
 *   node scripts/migrate-memories.mjs --apply
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

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

const LABEL = { strategy: '教训', cognition: '原则', trait: '性格', fact: '事实' };
const db = new DatabaseSync(dbFile);
const rows = db.prepare("SELECT * FROM memories WHERE status != 'superseded'").all();
console.log(`legacy memories: ${rows.length}`);

const byLabel = {};
for (const row of rows) {
  const label = LABEL[row.type] ?? '事实';
  byLabel[label] = (byLabel[label] ?? 0) + 1;
}
console.log('mapping:', JSON.stringify(byLabel));

if (!apply) {
  console.log('dry run — nothing migrated');
  db.close();
  process.exit(0);
}

const backup = `${dbFile}.bak-memories-${Date.now()}`;
copyFileSync(dbFile, backup);
console.log(`backup: ${backup}`);

const insert = db.prepare(
  `INSERT OR IGNORE INTO facts
     (id, soul_id, user_id, statement, type_name, holder, at, at_text, at_end, at_precision,
      place_id, status, confidence, source, source_turn_id, superseded_by, created_at)
   VALUES (?, ?, ?, ?, ?, 'self', NULL, NULL, NULL, 'unknown', NULL, 'none', ?, 'told', NULL, NULL, ?)`,
);

db.exec('BEGIN');
try {
  let migrated = 0;
  for (const row of rows) {
    const label = LABEL[row.type] ?? '事实';
    const confidence = Math.min(1, Math.max(0.3, Number(row.importance ?? 7) / 10));
    const result = insert.run(
      `fc_lg_${row.id}`,
      row.soul_id,
      row.user_id,
      String(row.content).trim(),
      label,
      confidence,
      Number(row.created_at ?? Date.now()),
    );
    migrated += Number(result.changes);
  }
  db.exec('DELETE FROM memories');
  db.exec('COMMIT');
  console.log(`migrated: ${migrated} facts; memories table cleared`);
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
db.close();
