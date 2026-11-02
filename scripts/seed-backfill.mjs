/**
 * Re-extract the raw conversation with the current extractor.
 *
 * After reset-derived wiped the old derivations, the turns are all we have — and
 * they are enough: the extractor's input is one turn's user text, which is exactly
 * what is stored. This seeds the plugin's existing queue, so the same code path and
 * the same prompt run as for a live turn; the queue drains one item per step.
 *
 *   node scripts/seed-backfill.mjs --limit 120 --dry-run
 *   node scripts/seed-backfill.mjs --limit 120 --apply
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const limit = arg('limit', 120);
const apply = args.includes('--apply');
if (!apply && !args.includes('--dry-run')) {
  console.error('pass --dry-run or --apply');
  process.exit(2);
}

const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const rows = db
  .prepare('SELECT id, turn_no, user_text FROM turns ORDER BY turn_no DESC LIMIT ?')
  .all(limit)
  .reverse() // replay oldest → newest, so threads are built forward in time
  .filter((row) => {
    const text = String(row.user_text ?? '').trim();
    if (text.length === 0) return false;
    return !/^(好的?|嗯+|哦+|可以|行|ok|okay|收到|明白|继续|好)[。！!.\s]*$/i.test(text);
  });
db.close();

const queueFile = join(HOME, 'pending-extract.json');
let existing = [];
if (existsSync(queueFile)) {
  try {
    const parsed = JSON.parse(readFileSync(queueFile, 'utf8'));
    if (Array.isArray(parsed)) existing = parsed;
  } catch {
    existing = [];
  }
}
const seen = new Set(existing.map((item) => item.turnId));
const added = rows
  .filter((row) => !seen.has(String(row.id)))
  .map((row) => ({ turnId: String(row.id), turnNo: Number(row.turn_no), attempts: 0 }));

console.log(`turns selected: ${added.length} (limit ${limit})`);
console.log(`queue: ${existing.length} → ${existing.length + added.length}`);

if (apply) {
  writeFileSync(queueFile, JSON.stringify([...existing, ...added].slice(0, 400), null, 2), 'utf8');
  console.log(`seeded ${queueFile} (oldest first drains first: order is newest-last, so reverse in place)`);
}
