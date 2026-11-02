/**
 * Retire stale profile rows (one-off cleanup, 2026-11-02).
 *
 * Two kinds are stale:
 *  - lines that current gates would reject (semicolon-welded, too long);
 *  - lines produced by merging already-merged lines ("cascade"). Re-merging a
 *    compression loses detail, so the cascade output is thinner than the set it came
 *    from and should not be what gets injected.
 *
 * Each retired row is superseded, never deleted, and points at the surviving row that
 * resembles it most — the trail stays walkable.
 *
 *   node scripts/retire-stale-profile.mjs --dry-run
 *   node scripts/retire-stale-profile.mjs --apply
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
const rows = db
  .prepare(
    `SELECT f.id, f.statement, f.created_at,
            (SELECT COUNT(*) FROM fact_slots s WHERE s.fact_id = f.id AND s.slot = '来源') AS sources
     FROM facts f
     WHERE f.type_name = '画像' AND f.status != 'superseded'
     ORDER BY f.created_at`,
  )
  .all();

const sourceIds = (id) =>
  db.prepare("SELECT ref_fact_id AS id FROM fact_slots WHERE fact_id = ? AND slot = '来源'").all(id);

const hasSourceSlot = (id) =>
  db.prepare("SELECT 1 AS x FROM fact_slots WHERE fact_id = ? AND slot = '来源' LIMIT 1").get(id) !== undefined;

const clean = (text) => text.replace(/[\s，。、；：！？,.;:!?"'（）()]/g, '');
const grams = (text) => {
  const set = new Set();
  const body = clean(text);
  for (let i = 0; i < body.length - 1; i += 1) set.add(body.slice(i, i + 2));
  return set;
};
const similarity = (a, b) => {
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const gram of A) if (B.has(gram)) shared += 1;
  return shared / (A.size + B.size - shared);
};

const isStale = (row) =>
  /[；;]/.test(row.statement) ||
  row.statement.length > 32 ||
  (row.sources > 0 && sourceIds(row.id).some((source) => hasSourceSlot(source.id)));

const survivors = rows.filter((row) => !isStale(row));
const stale = rows.filter((row) => isStale(row));

console.log(`active=${rows.length} survivors=${survivors.length} stale=${stale.length}`);
for (const row of stale) {
  const best = survivors
    .map((candidate) => ({ candidate, score: similarity(row.statement, candidate.statement) }))
    .sort((a, b) => b.score - a.score)[0];
  console.log(`retire ${row.id} (sources=${row.sources}) → ${best?.candidate.id ?? '-'} | ${row.statement.slice(0, 30)}`);
  if (!apply) continue;
  // Only point at a successor that actually resembles it; a spurious trail is worse
  // than no trail.
  const target = best && best.score >= 0.2 ? best.candidate.id : undefined;
  if (target && target !== row.id) {
    db.prepare("UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ?").run(target, row.id);
  } else {
    db.prepare("UPDATE facts SET status = 'superseded' WHERE id = ?").run(row.id);
  }
}
if (apply) console.log(`retired ${stale.length}`);
db.close();
