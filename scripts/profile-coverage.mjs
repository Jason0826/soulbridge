/**
 * Does the profile cover the dimensions, or only the ones we happened to talk about?
 *
 * A person is not one list. This prints how many lines each dimension has and which
 * dimensions are empty — the empty rows are the honest answer to "is this a person or
 * a work colleague".
 *
 *   node scripts/profile-coverage.mjs
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const DIMENSIONS = ['价值观', '工作方式', '沟通偏好', '情绪', '人际关系', '生活兴趣', '边界'];

const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const rows = db
  .prepare(
    `SELECT f.id, f.statement,
            (SELECT s.value_text FROM fact_slots s WHERE s.fact_id = f.id AND s.slot = '维度' LIMIT 1) AS dimension
     FROM facts f
     WHERE f.type_name = '画像' AND f.status != 'superseded'`,
  )
  .all();
db.close();

const counts = new Map(DIMENSIONS.map((dimension) => [dimension, 0]));
let unlabelled = 0;
for (const row of rows) {
  if (!row.dimension) {
    unlabelled += 1;
    continue;
  }
  counts.set(row.dimension, (counts.get(row.dimension) ?? 0) + 1);
}

console.log(`active profile lines: ${rows.length} (unlabelled: ${unlabelled})`);
let covered = 0;
for (const dimension of DIMENSIONS) {
  const count = counts.get(dimension) ?? 0;
  if (count > 0) covered += 1;
  console.log(`  ${count > 0 ? '✅' : '❌'} ${dimension.padEnd(6)} ${count}`);
}
console.log(`dimension coverage: ${covered}/${DIMENSIONS.length}`);
