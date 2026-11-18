/** C2 人判样本：复现 quality.mjs --s1-sample 的抽样，补出每条注入的事实原文（人判需要知道注入了什么） */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const home = homedir();
const since = Date.now() - 7 * 86_400_000; // 与 quality.mjs --days 7 同窗
const lines = readFileSync(join(home, '.soulbridge', 'trace.jsonl'), 'utf8').split('\n');
const injects = [];
for (const line of lines) {
  if (!line.includes('"event":"inject"')) continue;
  try {
    const e = JSON.parse(line);
    if (Date.parse(e.ts) < since) continue;
    if (Array.isArray(e.ids) && e.ids.length) injects.push(e);
  } catch { /* torn */ }
}

const wanted = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 10;
const stride = Math.max(1, Math.floor(injects.length / wanted));
const picks = [];
for (let i = 0; i < injects.length && picks.length < wanted; i += stride) picks.push(injects[i]);

const db = new DatabaseSync(join(home, '.soulbridge', 'soul.db'), { readOnly: true });
const getFact = db.prepare('SELECT statement FROM facts WHERE id = ?');

for (const inj of picks) {
  const ts = Date.parse(inj.ts);
  const rows = db.prepare(
    'SELECT assistant_text FROM turns WHERE session_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC LIMIT 1',
  ).all(inj.session, ts, ts);
  const row = rows[0] ?? db.prepare(
    'SELECT assistant_text FROM turns WHERE session_id = ? AND ABS(started_at - ?) <= 900000 ORDER BY ABS(started_at - ?) LIMIT 1',
  ).all(inj.session, ts, ts)[0];
  const text = String(row?.assistant_text ?? '（该轮未落库——进行中或已压缩）').replace(/\s+/g, ' ');

  console.log(`===== ${inj.ts}  turn=${inj.turn}  注入 ${inj.ids.length} 条 =====`);
  console.log('--- 注入事实 ---');
  for (const id of inj.ids) {
    const f = getFact.get(id);
    console.log(` [${id}] ${String(f?.statement ?? '（库中查不到）').slice(0, 120)}`);
  }
  console.log(`--- 回答（前 600 字）---\n${text.slice(0, 600)}\n`);
}
db.close();
