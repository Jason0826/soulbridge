// 只读探针：生产库里实体组的大小分布——最大组修法三候选的影响面（11-13）
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new DatabaseSync(join(homedir(), '.soulbridge', 'soul.db'), { readOnly: true });

const top = db
  .prepare(
    `SELECT e.name, COUNT(*) n, SUM(LENGTH(f.statement)) ch
       FROM facts f
       JOIN fact_slots fs ON fs.fact_id = f.id AND fs.slot = '主体'
       JOIN entities e ON e.id = fs.entity_id
      WHERE f.status = 'active'
      GROUP BY e.id ORDER BY ch DESC LIMIT 12`,
  )
  .all();
console.log('== 实体组 top 12（active，按字符） ==');
for (const row of top) console.log(`  ${row.name}: ${row.n} 条 / ${row.ch} ch`);

const over = db
  .prepare(
    `SELECT COUNT(*) FROM (
       SELECT fs.entity_id FROM facts f
       JOIN fact_slots fs ON fs.fact_id = f.id AND fs.slot = '主体'
       WHERE f.status = 'active'
       GROUP BY fs.entity_id HAVING SUM(LENGTH(f.statement)) > 2400)`,
  )
  .get();
const groups = db
  .prepare(
    `SELECT COUNT(DISTINCT fs.entity_id) FROM facts f
       JOIN fact_slots fs ON fs.fact_id = f.id AND fs.slot = '主体'
      WHERE f.status = 'active'`,
  )
  .get();
console.log(`\n组 > 2400ch: ${over[0]} / 有实体槽的组数: ${groups[0]}`);

// 单条事实长度分布（组内按相关性截的前提：组内条目有长短差）
const lens = db
  .prepare(
    `SELECT MIN(LENGTH(statement)) mn, MAX(LENGTH(statement)) mx,
            AVG(LENGTH(statement)) avg, COUNT(*) n
       FROM facts WHERE status='active'`,
  )
  .get();
console.log(`单条事实: min ${lens.mn} / max ${lens.mx} / avg ${Math.round(lens.avg)} / n ${lens.n}`);

// 阿Q 实验组（book-* soul 或同名实体）是否还在
const aq = db
  .prepare(
    `SELECT e.name, COUNT(*) n, SUM(LENGTH(f.statement)) ch
       FROM facts f
       JOIN fact_slots fs ON fs.fact_id = f.id AND fs.slot = '主体'
       JOIN entities e ON e.id = fs.entity_id
      WHERE f.status='active' AND e.name LIKE '%阿Q%'
      GROUP BY e.id`,
  )
  .all();
console.log('阿Q 组:', JSON.stringify(aq));
db.close();
