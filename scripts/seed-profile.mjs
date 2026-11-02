/**
 * Queue the judgments about the person for merging (ADR 0033).
 *
 * They are written one per turn, so after a while there are dozens that say almost
 * the same thing. Merging compresses them into a handful, and each merged line keeps
 * the ids it came from so a reader can walk back.
 *
 *   node scripts/seed-profile.mjs --dry-run
 *   node scripts/seed-profile.mjs --apply
 *   node scripts/seed-profile.mjs --apply --include-superseded   # re-test after a bad merge
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const apply = process.argv.includes('--apply');
const includeSuperseded = process.argv.includes('--include-superseded');
const onlySuperseded = process.argv.includes('--only-superseded');
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('pass --dry-run or --apply');
  process.exit(2);
}

const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const statuses = db
  .prepare("SELECT status, COUNT(*) AS n FROM facts WHERE type_name = '画像' GROUP BY status")
  .all();
console.log(`profile rows by status: ${statuses.map((row) => `${row.status}=${row.n}`).join(' ')}`);

const rows = db
  .prepare(
    onlySuperseded
      ? "SELECT id, statement FROM facts WHERE type_name = '画像' AND status = 'superseded' ORDER BY created_at LIMIT 60"
      : includeSuperseded
      ? "SELECT id, statement FROM facts WHERE type_name = '画像' ORDER BY created_at LIMIT 60"
      : "SELECT id, statement FROM facts WHERE type_name = '画像' AND status != 'superseded' ORDER BY created_at LIMIT 60",
  )
  .all();
db.close();

console.log(`profile items to merge: ${rows.length}`);
const queueFile = join(HOME, 'pending-profile.json');
let existing = [];
if (existsSync(queueFile)) {
  try {
    const parsed = JSON.parse(readFileSync(queueFile, 'utf8'));
    if (Array.isArray(parsed)) existing = parsed;
  } catch {
    existing = [];
  }
}
const seen = new Set(existing.map((item) => item.id));
const items = rows
  .filter((row) => !seen.has(String(row.id)))
  .map((row) => ({ id: String(row.id), statement: String(row.statement) }));

if (apply) {
  writeFileSync(queueFile, JSON.stringify([...existing, ...items].slice(0, 200), null, 2), 'utf8');
  console.log(`queued ${items.length} (total ${existing.length + items.length})`);
} else {
  console.log(`would queue ${items.length}`);
}
