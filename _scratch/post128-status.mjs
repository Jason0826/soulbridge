/** 只读：0.0.128 生效后的抽取与新事实（核对戳用） */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const live = Date.parse('2026-11-16T08:02:16Z');
const db = new DatabaseSync(join(homedir(), '.soulbridge', 'soul.db'), { readOnly: true });
const facts = db.prepare('SELECT COUNT(*) n FROM facts WHERE created_at >= ?').get(live).n;
const conclusions = db.prepare("SELECT COUNT(*) n FROM facts WHERE type_name = '结论' AND created_at >= ?").get(live).n;
db.close();

let extracts = 0;
for (const line of readFileSync(join(homedir(), '.soulbridge', 'trace.jsonl'), 'utf8').split('\n')) {
  if (!line.includes('"event":"extract"')) continue;
  try {
    if (Date.parse(JSON.parse(line).ts) >= live) extracts += 1;
  } catch { /* torn line */ }
}
console.log(`0.0.128 生效后：extract ${extracts} 次 · 新事实 ${facts} 条（含结论 ${conclusions}）`);
