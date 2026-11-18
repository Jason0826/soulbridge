/** 只读探查 2：corrections 结构、tool-call 内容、判据1 旧口径出处 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);

console.log('== corrections 结构 ==');
console.log(all('PRAGMA table_info(corrections)').map((c) => `${c.name}:${c.type}`).join(' | '));
console.log('行数:', all('SELECT COUNT(*) n FROM corrections')[0].n);
const cols = all('PRAGMA table_info(corrections)').map((c) => c.name);
for (const cand of ['kind', 'category', 'verdict', 'via', 'trigger', 'phrase', 'outcome', 'llm_outcome']) {
  if (cols.includes(cand)) {
    console.log(`分布 ${cand}:`, JSON.stringify(all(`SELECT ${cand} v, COUNT(*) n FROM corrections GROUP BY v ORDER BY n DESC`)));
  }
}
console.log('最近3条:', JSON.stringify(all('SELECT * FROM corrections ORDER BY rowid DESC LIMIT 3')).slice(0, 600));

console.log('\n== tool-call 事件 ==');
const traceFile = join(HOME, 'trace.jsonl');
for (const line of readFileSync(traceFile, 'utf8').split('\n')) {
  if (!line.includes('"tool-call"')) continue;
  try {
    const r = JSON.parse(line);
    console.log(' ', JSON.stringify(r).slice(0, 300));
  } catch { /* skip */ }
}

console.log('\n== inject 可回溯性（判据2） ==');
let withIds = 0, withoutIds = 0, lastInject = null;
for (const line of readFileSync(traceFile, 'utf8').split('\n')) {
  if (!line.includes('"event":"inject"')) continue;
  try {
    const r = JSON.parse(line);
    if (Array.isArray(r.ids) && r.ids.length > 0) withIds++; else withoutIds++;
    lastInject = r;
  } catch { /* skip */ }
}
console.log(`带 ids ${withIds} · 不带 ${withoutIds} · 最近一次 ${lastInject?.ts} turn=${lastInject?.turn} ids=${lastInject?.ids?.length}`);
db.close();
