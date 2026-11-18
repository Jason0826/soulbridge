import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
const db = new DatabaseSync(join(homedir(), '.soulbridge', 'soul.db'), { readOnly: true });

// slot 值分布 + 实体槽覆盖
const slots = db.prepare(`SELECT slot, value_type, COUNT(*) n FROM fact_slots GROUP BY slot, value_type ORDER BY n DESC`).all();
console.log('== fact_slots 分布 ==');
for (const s of slots) console.log(`  ${s.slot} (${s.value_type}): ${s.n}`);

// 每个实体组的 active 字符数（任何 slot 挂的 entity 都算——代码是按 entityId 查 facts 的）
const groups = db
  .prepare(
    `SELECT e.name, COUNT(DISTINCT f.id) n, SUM(LENGTH(f.statement)) ch
       FROM facts f
       JOIN fact_slots fs ON fs.fact_id = f.id AND fs.entity_id IS NOT NULL
       JOIN entities e ON e.id = fs.entity_id
      WHERE f.status = 'active'
      GROUP BY e.id ORDER BY ch DESC LIMIT 15`,
  )
  .all();
console.log('\n== 实体组 top 15（任意槽挂的实体） ==');
for (const g of groups) console.log(`  ${g.name}: ${g.n} 条 / ${g.ch} ch`);

const over = db
  .prepare(
    `SELECT COUNT(*) c FROM (
       SELECT fs.entity_id FROM facts f
       JOIN fact_slots fs ON fs.fact_id = f.id AND fs.entity_id IS NOT NULL
       WHERE f.status = 'active'
       GROUP BY fs.entity_id HAVING SUM(LENGTH(f.statement)) > 2400)`,
  )
  .get();
const total = db
  .prepare(
    `SELECT COUNT(DISTINCT fs.entity_id) c FROM facts f
       JOIN fact_slots fs ON fs.fact_id = f.id AND fs.entity_id IS NOT NULL
      WHERE f.status='active'`,
  )
  .get();
console.log(`\n组 > 2400ch: ${over.c} / 有实体的组数: ${total.c}`);

// 单实体组按“事实条数”排（180 条那类）
const big = db
  .prepare(
    `SELECT e.name, COUNT(DISTINCT f.id) n, SUM(LENGTH(f.statement)) ch
       FROM facts f
       JOIN fact_slots fs ON fs.fact_id = f.id AND fs.entity_id IS NOT NULL
       JOIN entities e ON e.id = fs.entity_id
      WHERE f.status='active'
      GROUP BY e.id HAVING n > 40 ORDER BY n DESC LIMIT 10`,
  )
  .all();
console.log('\n== 条数 > 40 的组 ==');
for (const g of big) console.log(`  ${g.name}: ${g.n} 条 / ${g.ch} ch`);
db.close();
