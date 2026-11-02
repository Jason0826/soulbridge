/**
 * Does the profile cover the dimensions, and can every line be traced to something?
 *
 * Coverage answers "is this a person or a work colleague". Traceability answers
 * "is this a profile or a horoscope": a line with no source was inferred from
 * nothing, and a wrong line is worse than a missing one.
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
            (SELECT s.value_text FROM fact_slots s WHERE s.fact_id = f.id AND s.slot = '维度' LIMIT 1) AS dimension,
            (SELECT COUNT(*) FROM fact_slots s WHERE s.fact_id = f.id AND s.slot = '来源') AS sources
     FROM facts f
     WHERE f.type_name = '画像' AND f.status != 'superseded'`,
  )
  .all();
db.close();

const counts = new Map(DIMENSIONS.map((dimension) => [dimension, 0]));
let unlabelled = 0;
let traceable = 0;
for (const row of rows) {
  if (row.sources > 0) traceable += 1;
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
console.log(
  `traceable lines: ${traceable}/${rows.length} (${((traceable / rows.length) * 100).toFixed(0)}%)`,
);
if (rows.length > 0 && traceable < rows.length) {
  const orphans = rows.filter((row) => row.sources === 0);
  console.log('untraceable:');
  for (const row of orphans) console.log(`  ${row.id} | ${row.statement.slice(0, 40)}`);
}
