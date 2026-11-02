/**
 * Every active profile line, with the facts behind it and its shape.
 *
 * Two numbers matter per line: how many sources it rests on, and whether it is one
 * judgment or several welded together. A comma where both halves stand alone is a
 * welded line — the merge was supposed to split those.
 *
 *   node scripts/profile-lines.mjs
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const rows = db
  .prepare(
    `SELECT f.id, f.statement, f.confidence, f.created_at,
            (SELECT s.value_text FROM fact_slots s WHERE s.fact_id = f.id AND s.slot = '维度' LIMIT 1) AS dimension,
            (SELECT s.value_text FROM fact_slots s WHERE s.fact_id = f.id AND s.slot = '合并' LIMIT 1) AS merged,
            (SELECT COUNT(*) FROM fact_slots s WHERE s.fact_id = f.id AND s.slot = '来源') AS sources
     FROM facts f
     WHERE f.type_name = '画像' AND f.status != 'superseded'
     ORDER BY f.confidence DESC, f.created_at DESC`,
  )
  .all();
db.close();

/** Both sides of a comma read as whole sentences → two judgments in one line. */
function welded(statement) {
  const parts = statement.split(/[，,]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((part) => part.length >= 4);
}

console.log(`active profile lines: ${rows.length}`);
let weldedCount = 0;
for (const row of rows) {
  const comma = (row.statement.match(/[，,]/g) ?? []).length;
  const flag = welded(row.statement) ? 'WELDED' : '      ';
  if (flag === 'WELDED') weldedCount += 1;
  console.log(
    `${flag} ${row.id} ${(row.dimension ?? '(无)').padEnd(5)} src=${row.sources}` +
      ` merged=${row.merged ? 'yes' : 'no '} commas=${comma} len=${[...row.statement].length}`,
  );
  console.log(`        ${row.statement}`);
}
console.log(`welded lines: ${weldedCount}/${rows.length}`);
