/**
 * Merge entities that share a name.
 *
 * Extraction typed 核桃 as both a person and a thing, so recall about 核桃 found
 * half its facts. One name is one entity: the oldest row wins (it is the one other
 * rows already reference), the rest are repointed and removed.
 *
 *   node scripts/merge-entities.mjs --dry-run
 *   node scripts/merge-entities.mjs --apply
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const apply = process.argv.includes('--apply');
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('pass --dry-run or --apply');
  process.exit(2);
}

const db = new DatabaseSync(join(HOME, 'soul.db'));
const groups = db
  .prepare(
    `SELECT name, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
     FROM entities GROUP BY name HAVING n > 1 ORDER BY n DESC`,
  )
  .all();

console.log(`duplicate names: ${groups.length}`);
let repointed = 0;
for (const group of groups) {
  const ids = String(group.ids).split(',');
  const rows = ids.map((id) => db.prepare('SELECT * FROM entities WHERE id = ?').get(id));
  // Prefer the 'self' row: the user's identity must not be demoted to a person,
  // and holder-based reads depend on it. Otherwise the oldest row wins.
  const rank = (row) => (row.type === 'self' ? 0 : 1);
  rows.sort((a, b) => rank(a) - rank(b) || Number(a.rowid ?? 0) - Number(b.rowid ?? 0));
  const keep = rows[0];
  const drop = rows.slice(1);
  console.log(`  ${group.name}: keep ${keep.id}(${keep.type}) drop ${drop.map((row) => `${row.id}(${row.type})`).join(', ')}`);
  if (!apply) continue;
  const move = db.prepare('UPDATE fact_slots SET entity_id = ? WHERE entity_id = ?');
  for (const row of drop) {
    const moved = move.run(keep.id, row.id).changes;
    repointed += Number(moved);
    db.prepare('DELETE FROM entities WHERE id = ?').run(row.id);
  }
}

if (apply) console.log(`applied: repointed ${repointed} slots`);
db.close();
