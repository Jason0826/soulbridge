/** 只读：0.0.128 生效后新事实按类型分布 + 目的类 + 结论（观察点②③） */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const live = Date.parse('2026-11-16T08:02:16Z');
const db = new DatabaseSync(join(homedir(), '.soulbridge', 'soul.db'), { readOnly: true });
console.log('--- 类型分布 ---');
for (const r of db.prepare('SELECT type_name, COUNT(*) n FROM facts WHERE created_at >= ? GROUP BY type_name ORDER BY n DESC').all(live)) {
  console.log(` ${r.type_name} ${r.n}`);
}
console.log('--- 目的类 ---');
const purpose = db.prepare("SELECT id, statement, created_at FROM facts WHERE created_at >= ? AND type_name = '目的'").all(live);
for (const r of purpose) console.log(` ${r.id} ${r.created_at} ${r.statement}`);
if (!purpose.length) console.log(' (0 条)');
console.log('--- 结论类 ---');
for (const r of db.prepare("SELECT id, statement, created_at FROM facts WHERE created_at >= ? AND type_name = '结论'").all(live)) {
  console.log(` ${r.id} ${r.created_at} ${r.statement}`);
}
db.close();
