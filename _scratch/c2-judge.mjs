/** C2 人判辅助：10 样本完整回答落文件 + 注入事实关键词命中预筛（预筛只为定位，判决仍人做） */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const home = homedir();
const since = Date.now() - 7 * 86_400_000;
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
const wanted = 10;
const stride = Math.max(1, Math.floor(injects.length / wanted));
const picks = [];
for (let i = 0; i < injects.length && picks.length < wanted; i += stride) picks.push(injects[i]);

const db = new DatabaseSync(join(home, '.soulbridge', 'soul.db'), { readOnly: true });
const getFact = db.prepare('SELECT statement FROM facts WHERE id = ?');

// 注入事实的区分性关键词（人工从语句里摘，用于预筛回答是否触及记忆内容）
const keywords = ['换会话', '丢', '缓存', '高频重启', '第二批', '走得太远', '债', '去偏', '15%', '贴文章', '安卓', 'API key', 'credentials', '重叠', 'soul_detail', '压缩'];

const out = [];
for (const inj of picks) {
  const ts = Date.parse(inj.ts);
  let row = db.prepare(
    'SELECT assistant_text FROM turns WHERE session_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC LIMIT 1',
  ).all(inj.session, ts, ts)[0];
  row ??= db.prepare(
    'SELECT assistant_text FROM turns WHERE session_id = ? AND ABS(started_at - ?) <= 900000 ORDER BY ABS(started_at - ?) LIMIT 1',
  ).all(inj.session, ts, ts)[0];
  const text = String(row?.assistant_text ?? '（该轮未落库）');

  const fcIds = inj.ids.filter((id) => id.startsWith('fc_'));
  const fcFacts = fcIds.map((id) => ({ id, s: String(getFact.get(id)?.statement ?? '') }));
  const hits = keywords.filter((k) => text.includes(k));

  out.push(`===== ${inj.ts} turn=${inj.turn} 注入 ${inj.ids.length} 条（fc ${fcIds.length}）=====`);
  out.push(`关键词命中: ${hits.join(' / ') || '无'}`);
  out.push('--- 注入 fc 事实 ---');
  for (const f of fcFacts) out.push(` [${f.id}] ${f.s}`);
  out.push(`--- 完整回答（${text.length} 字）---`);
  out.push(text);
  out.push('');
}
db.close();
writeFileSync(join(import.meta.dirname, 'c2-judge.txt'), out.join('\n'), 'utf8');
console.log(`已写 c2-judge.txt：${picks.length} 样本`);
