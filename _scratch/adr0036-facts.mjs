/** 只读：ADR 0036 背景值（C6 归纳产出）+ C5 候选数据源结构 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(join(homedir(), '.soulbridge', 'soul.db'), { readOnly: true });
const one = (sql, ...p) => db.prepare(sql).get(...p);
const threads = one('SELECT COUNT(*) n FROM threads').n;
const closed = one("SELECT COUNT(*) n FROM threads WHERE closed_at IS NOT NULL OR status = 'closed'").n;
const conclusions = one("SELECT COUNT(*) n FROM facts WHERE type_name = '结论' AND status = 'active'").n;
console.log(`threads ${threads} · 已闭 ${closed} · 结论(active) ${conclusions} · 每10关闭 = ${closed ? ((conclusions / closed) * 10).toFixed(2) : '?'} 条`);
console.log('affect_samples 列:', db.prepare('PRAGMA table_info(affect_samples)').all().map((c) => c.name).join(','));
const week = one('SELECT COUNT(*) n, SUM(CASE WHEN confidence > 0 THEN 1 ELSE 0 END) sig FROM affect_samples WHERE at >= ?', Date.now() - 7 * 86400000);
console.log('affect 近7天:', JSON.stringify(week));
// C5 候选源：情绪词典命中（confidence=0 也算"用户在表达情绪"的候选）
const hits = one("SELECT COUNT(*) n FROM affect_samples WHERE at >= ? AND hits IS NOT NULL AND hits != ''", Date.now() - 7 * 86400000);
console.log('affect 近7天带 hits:', JSON.stringify(hits));
db.close();
