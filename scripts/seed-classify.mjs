/**
 * Classify the migrated lessons into rules (with a trigger) and profile items.
 *
 * 128 lessons were migrated as plain facts. Most of them cannot be injected every
 * turn — that is the wallpaper problem — so they are split: a rule gets a trigger
 * and appears only when its situation applies; a profile item is about the person
 * and stays in the profile layer.
 *
 * The plugin drains this queue one batch per quiet step, the same way extraction
 * works, so every model call stays inside a live turn.
 *
 *   node scripts/seed-classify.mjs --dry-run
 *   node scripts/seed-classify.mjs --apply
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const apply = process.argv.includes('--apply');
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('pass --dry-run or --apply');
  process.exit(2);
}

const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const rows = db
  .prepare(
    `SELECT id, statement FROM facts
     WHERE type_name IN ('教训', '原则', '性格')
       AND status != 'superseded'
       AND NOT EXISTS (SELECT 1 FROM fact_slots s WHERE s.fact_id = facts.id AND s.slot = '触发')
     ORDER BY created_at`,
  )
  .all();
db.close();

console.log(`unclassified lessons: ${rows.length}`);
const queueFile = join(HOME, 'pending-classify.json');
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
  writeFileSync(queueFile, JSON.stringify([...existing, ...items].slice(0, 400), null, 2), 'utf8');
  console.log(`queued ${items.length} (total ${existing.length + items.length})`);
} else {
  console.log(`would queue ${items.length}`);
}
