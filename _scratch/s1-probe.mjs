/** 只读探查：S1 四条判据现在各有什么数据可算（2026-11-17） */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);

console.log('== 1. trace 事件类型 ==');
const traceFile = join(HOME, 'trace.jsonl');
const counts = new Map();
const injectSample = [];
const toolish = [];
if (existsSync(traceFile)) {
  for (const line of readFileSync(traceFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const e = String(row.event);
    counts.set(e, (counts.get(e) ?? 0) + 1);
    if (e === 'inject' && injectSample.length < 3) injectSample.push(row);
    if (/recall|detail|list|tool|soul_/i.test(e)) toolish.push(row);
  }
}
for (const [e, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${e.padEnd(24)} ${n}`);
console.log('inject 样本键:', injectSample.map((r) => Object.keys(r).join(',')));
if (injectSample[0]) console.log('inject 首样本:', JSON.stringify(injectSample[0]).slice(0, 400));
console.log('tool 类事件数:', toolish.length, toolish.slice(0, 2).map((r) => r.event));

console.log('\n== 2. sqlite 表 ==');
for (const r of all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")) console.log('  ' + r.name);

console.log('\n== 3. corrections（判据3 数据源） ==');
try {
  for (const r of all('SELECT source, COUNT(*) n FROM corrections GROUP BY source ORDER BY n DESC')) console.log(`  ${String(r.source).padEnd(28)} ${r.n}`);
  const w = all("SELECT source, COUNT(*) n FROM corrections WHERE at >= ? GROUP BY source", Date.now() - 7 * 86400000);
  console.log('  最近7天:', JSON.stringify(w));
} catch (e) { console.log('  corrections 读失败:', e.message); }

console.log('\n== 4. 判据3 相关：取代/退休 ==');
console.log('  facts retracted :', all("SELECT COUNT(*) n FROM facts WHERE status='retracted'")[0].n);
console.log('  superseded_by 非空:', all('SELECT COUNT(*) n FROM facts WHERE superseded_by IS NOT NULL')[0].n);

console.log('\n== 5. turns 结构（判据1 候选池） ==');
console.log('  turns 列:', all('PRAGMA table_info(turns)').map((c) => c.name).join(', '));
console.log('  steps 列:', all('PRAGMA table_info(steps)').map((c) => c.name).join(', '));
console.log('  turns 总数:', all('SELECT COUNT(*) n FROM turns')[0].n);

console.log('\n== 6. 判据4 可查证：工具调用痕迹 ==');
for (const t of ['recall_log', 'tool_calls', 'recalls']) {
  try { console.log(`  ${t}:`, all(`SELECT COUNT(*) n FROM ${t}`)[0].n); } catch { console.log(`  ${t}: 无此表`); }
}
db.close();

console.log('\n== 7. plugin.log 里 recall/detail 调用痕迹 ==');
const logFile = join(homedir(), '.soulbridge', 'plugin.log');
if (existsSync(logFile)) {
  const txt = readFileSync(logFile, 'utf8');
  for (const kw of ['soul_recall', 'soul_detail', 'soul_list', 'recall(', 'listFacts']) {
    const n = txt.split(kw).length - 1;
    console.log(`  ${kw.padEnd(14)} ${n}`);
  }
} else console.log('  无 plugin.log');
