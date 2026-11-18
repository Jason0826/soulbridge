/** 只读：consolidate（支持率）事件按 0.0.128 生效时间切分（观察点：支持率复测到货没） */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const live = Date.parse('2026-11-16T08:02:16Z');
const windowStart = Date.now() - 7 * 86400 * 1000; // 与 quality.mjs 同款 7 日窗
const lines = readFileSync(join(homedir(), '.soulbridge', 'trace.jsonl'), 'utf8').split('\n');
const rows = [];
for (const line of lines) {
  if (!line.includes('"event":"consolidate"')) continue;
  try {
    const e = JSON.parse(line);
    if (!(e.verdict === 'supported' || e.dropped)) continue;
    const t = Date.parse(e.ts);
    if (t >= windowStart) rows.push(e);
  } catch { /* torn */ }
}
const pre = rows.filter((r) => Date.parse(r.ts) < live);
const post = rows.filter((r) => Date.parse(r.ts) >= live);
const s = (a) => `${a.filter((r) => r.verdict === 'supported').length}/${a.length}`;
console.log(`全量（7 日窗内）: ${s(rows)}`);
console.log(`0.0.128 生效前  : ${s(pre)}`);
console.log(`0.0.128 生效后  : ${s(post)}`);
for (const r of post) console.log(` post ${r.ts} ${r.verdict} ${r.reason ?? ''} ${r.statement ?? ''}`.slice(0, 300));
