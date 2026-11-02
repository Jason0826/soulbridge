/**
 * Clear everything that was derived by the old extractor, keep the raw record.
 *
 * The bad data is not the conversation — it is what the previous prompt decided to
 * make of it: facts with holder=world for the user's opinions, junk entities,
 * conclusions drawn from a batch instead of a thread. Those cannot be repaired by
 * more extraction; they have to go, and turns/steps are what we re-extract from.
 *
 *   node scripts/reset-derived.mjs --dry-run
 *   node scripts/reset-derived.mjs --apply
 *
 * A backup of the database is written next to it before anything is deleted.
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

const TABLES = ['fact_slots', 'facts', 'gaps', 'threads', 'entities'];
const db = new DatabaseSync(dbFile);

const counts = () => {
  const out = {};
  for (const table of TABLES) out[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  out.turns = db.prepare('SELECT COUNT(*) AS n FROM turns').get().n;
  out.steps = db.prepare('SELECT COUNT(*) AS n FROM steps').get().n;
  return out;
};

const before = counts();
console.log('before:', JSON.stringify(before));

if (!apply) {
  console.log('dry run — nothing deleted');
  db.close();
  process.exit(0);
}

const backup = `${dbFile}.bak-${Date.now()}`;
copyFileSync(dbFile, backup);
console.log(`backup: ${backup}`);

// Order matters: slots reference facts, facts reference nothing, threads hold the
// summary id. Raw turns and steps stay exactly as they are.
db.exec('BEGIN');
try {
  db.exec('DELETE FROM fact_slots');
  db.exec('DELETE FROM facts');
  db.exec('DELETE FROM gaps');
  db.exec('DELETE FROM threads');
  db.exec('DELETE FROM entities');
  // Attribution lived on the turn; the new extraction decides it again.
  db.exec('UPDATE turns SET thread_id = NULL');
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

console.log('after:', JSON.stringify(counts()));
console.log('kept: turns and steps (the raw record)');
db.close();
