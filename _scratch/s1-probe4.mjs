/** 只读探查 4：族快照有效性、跨周重复两种口径、turns 连接键 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const db = new DatabaseSync(join(homedir(), '.soulbridge', 'soul.db'), { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);

// a. 快照 vs 当前活跃规则（rule-compression 的门）
const snapshot = JSON.parse(readFileSync(join(ROOT, 'scripts/data/rule-families-2026-11-09.json'), 'utf8')).families;
const rules = all("SELECT id, created_at FROM facts WHERE role='rule' AND status='active'");
const known = new Map(rules.map((r) => [r.id, r]));
const owned = new Set(snapshot.flatMap((f) => f.ids));
const missing = rules.filter((r) => !owned.has(r.id));
const stale = [...owned].filter((id) => !known.has(id));
console.log(`快照 ${snapshot.length} 族 · 活跃规则 ${rules.length} · 快照外新增 ${missing.length} · 快照内已非活跃 ${stale.length}`);
if (missing.length) console.log('  新增样例:', missing.slice(0, 3).map((r) => r.id).join(', '));

// b. 跨周重复两种定义（先验族）
const weekKey = (ms) => {
  const d = new Date(Number(ms));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3); // 本周四 = ISO 周键
  return d.toISOString().slice(0, 10);
};
const priors = snapshot.filter((f) => f.kind === 'prior');
let priorActive = 0, defA = 0, defB = 0;
for (const fam of priors) {
  const rows = fam.ids.map((id) => known.get(id)).filter(Boolean);
  priorActive += rows.length;
  if (rows.length === 0) continue;
  const weeks = new Set(rows.map((r) => weekKey(r.created_at)));
  if (weeks.size >= 2) {
    defA += rows.length;                 // A: 多周族的全部成员
    const first = [...weeks].sort()[0];
    defB += rows.length - rows.filter((r) => weekKey(r.created_at) === first).length; // B: 首周之后的成员
  }
}
console.log(`先验倾向(活跃) ${priorActive} 条`);
console.log(`  定义A 多周族全部成员: ${defA} → ${priorActive ? ((defA / priorActive) * 100).toFixed(1) : '?'}%`);
console.log(`  定义B 首周之后成员 : ${defB} → ${priorActive ? ((defB / priorActive) * 100).toFixed(1) : '?'}%`);
console.log(`  (11-10 基线 27/112 = 24.1%)`);

// c. turns 连接键
const t = all('SELECT id, session_id, turn_no FROM turns ORDER BY rowid DESC LIMIT 3');
console.log('turns 样本:', JSON.stringify(t));
const traceFile = join(homedir(), '.soulbridge', 'trace.jsonl');
let inj = null;
for (const line of readFileSync(traceFile, 'utf8').split('\n')) {
  if (line.includes('"event":"inject"')) { try { inj = JSON.parse(line); } catch { /* */ } }
}
console.log('最近 inject:', JSON.stringify({ ts: inj?.ts, session: inj?.session, turn: inj?.turn }));
const hit = all('SELECT COUNT(*) n FROM turns WHERE session_id = ? AND turn_no = ?', inj.session, inj.turn);
console.log('按 (session_id, turn_no) 连接命中:', hit[0].n);
db.close();
