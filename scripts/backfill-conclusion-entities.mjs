/**
 * Backfill `关于` (entity) slots onto conclusions written before 0.0.57.
 *
 * A conclusion recalls by the entities its evidence mentions; the first four
 * conclusions were written before that rule existed, so asking about 核桃 could
 * not find the conclusion about 核桃. This derives the slots from the evidence
 * that is already there — no model, no judgement, just the union.
 *
 *   node scripts/backfill-conclusion-entities.mjs --dry-run
 *   node scripts/backfill-conclusion-entities.mjs --apply
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
const missing = db
  .prepare(
    `SELECT c.id AS conclusion, s.entity_id AS entity, ent.name AS entity_name, c.statement
     FROM facts c
     JOIN fact_slots e ON e.fact_id = c.id AND e.slot = '证据' AND e.ref_fact_id IS NOT NULL
     JOIN fact_slots s ON s.fact_id = e.ref_fact_id AND s.value_type = 'entity'
     LEFT JOIN entities ent ON ent.id = s.entity_id
     WHERE c.type_name = '结论' AND c.status != 'superseded'
       AND NOT EXISTS (
         SELECT 1 FROM fact_slots x
         WHERE x.fact_id = c.id AND x.slot = '关于' AND x.entity_id = s.entity_id
       )
     GROUP BY c.id, s.entity_id`,
  )
  .all();

console.log(`missing entity anchors: ${missing.length}`);
for (const row of missing) {
  console.log(`  ${row.conclusion}  +关于=${row.entity_name ?? row.entity}  ← ${String(row.statement).slice(0, 40)}`);
}

if (apply && missing.length > 0) {
  const insert = db.prepare(
    `INSERT INTO fact_slots (fact_id, slot, value_type, entity_id, value_num, value_text, ref_fact_id)
     VALUES (?, '关于', 'entity', ?, NULL, NULL, NULL)`,
  );
  for (const row of missing) insert.run(row.conclusion, row.entity);
  console.log(`applied: ${missing.length} slots`);
}
db.close();
