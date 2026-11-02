import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new DatabaseSync(join(homedir(), '.soulbridge', 'soul.db'), { readOnly: true });
const rows = db
  .prepare(
    `SELECT type_name, COUNT(*) AS n, ROUND(AVG(recall_count), 1) AS avg, MAX(recall_count) AS mx
     FROM facts WHERE status != 'superseded'
     GROUP BY type_name ORDER BY avg DESC`,
  )
  .all();
console.log('按类型：平均 recall_count / 最大');
for (const r of rows) {
  console.log(`  ${String(r.type_name).padEnd(6)} n=${String(r.n).padEnd(4)} avg=${String(r.avg ?? 0).padEnd(6)} max=${r.mx}`);
}
const sampled = db
  .prepare(
    `SELECT statement, recall_count, status FROM facts
     WHERE recall_count > 0 ORDER BY recall_count DESC LIMIT 5`,
  )
  .all();
console.log('复习分最高的 5 条：');
for (const r of sampled) console.log(`  ${String(r.recall_count).padStart(3)}  ${String(r.statement).slice(0, 40)}`);
db.close();
