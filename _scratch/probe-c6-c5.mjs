/** 只读：C6a/C6b/C5 接线前探数——关闭线索、结论、affect payload.hits 结构 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const home = homedir();
const since = Date.now() - 7 * 86_400_000;
const db = new DatabaseSync(join(home, '.soulbridge', 'soul.db'), { readOnly: true });

console.log('--- C6a 分母/分子 ---');
console.log(' 全量关闭线索 (closed_at 非空):', db.prepare('SELECT COUNT(*) n FROM threads WHERE closed_at IS NOT NULL').get().n);
console.log(' 全量线索总数:', db.prepare('SELECT COUNT(*) n FROM threads').get().n);
console.log(' 窗口(7d)关闭线索:', db.prepare('SELECT COUNT(*) n FROM threads WHERE COALESCE(closed_at,0) >= ?').get(since).n);
console.log(' 全量结论 facts:', db.prepare("SELECT COUNT(*) n FROM facts WHERE type_name = '结论'").get().n);
console.log(' 窗口结论 facts:', db.prepare("SELECT COUNT(*) n FROM facts WHERE type_name = '结论' AND COALESCE(created_at,0) >= ?").get(since).n);
console.log(' 线索 status 分布:', JSON.stringify(db.prepare('SELECT status, COUNT(*) n FROM threads GROUP BY status').all()));

console.log('--- C5 源1：affect payload.hits ---');
const rows = db.prepare('SELECT at, payload FROM affect_samples ORDER BY at DESC LIMIT 200').all();
let withHits = 0;
let sample = null;
for (const r of rows) {
  try {
    const p = JSON.parse(r.payload);
    if (Array.isArray(p.hits) && p.hits.length) {
      withHits += 1;
      if (!sample) sample = { at: r.at, hits: p.hits.slice(0, 5) };
    }
  } catch { /* bad payload */ }
}
console.log(` 近 200 条 affect_samples 带 hits: ${withHits}`);
console.log(' 样本:', JSON.stringify(sample));
console.log(' 窗口 affect_samples:', db.prepare('SELECT COUNT(*) n FROM affect_samples WHERE COALESCE(at,0) >= ?').get(since).n);

console.log('--- C5 源2：词表规模（seed-lexicon.ts 正则试解析） ---');
db.close();
