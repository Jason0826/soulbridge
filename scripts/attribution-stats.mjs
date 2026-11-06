/**
 * Is attribution forming chapters? (ADR 0034 acceptance)
 *
 * The change made "continue the previous thread" the default, because 123 threads for
 * 297 turns (103 of them single-turn) starved consolidation: 112 closed threads yielded
 * 2 conclusions. This script reports the acceptance numbers, with PASS/FAIL, from the
 * live database and the plugin log.
 *
 *   node scripts/attribution-stats.mjs            # current window
 *   node scripts/attribution-stats.mjs --all      # include history before the change
 *
 * The window starts at the first log line that carries `join=` (the new attribution
 * writes it); history before that used the old rule and is reported separately.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const all = process.argv.includes('--all');

const log = readFileSync(join(HOME, 'plugin.log'), 'utf8').split('\n').filter(Boolean);
const joinLines = log.filter((line) => line.includes('join='));

/**
 * The window starts when the new logic started running: the last `apply()` line, or
 * the first line that carries `join=` if that is earlier. Using the first join line
 * alone gives a near-empty window (the first extract after a restart can be minutes
 * away), and mixing an all-time numerator with a windowed denominator is worse than
 * an empty sample.
 */
function lastApplyMs() {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i].includes('apply() called')) {
      const at = Date.parse(log[i].slice(0, 24));
      if (Number.isFinite(at)) return at;
    }
  }
  return null;
}
const firstJoinMs = Date.parse(joinLines[0]?.slice(0, 24) ?? '');
const applied = lastApplyMs();
const windowStartMs = all
  ? 0
  : Math.min(...[firstJoinMs, applied].filter((value) => Number.isFinite(value ?? NaN)));

const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const query = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

// ---- 1. 归属（来自日志：只有新逻辑才会写 join=） ----
// Backfilled runs are excluded: they are re-extractions of history that never saw the
// new default-continue rule, so counting them would answer "is the new rule working" with
// evidence from before it existed. They are counted separately instead of hidden.
// 口径（2026-11-06 改段级，ADR 0034 修订）：③ 之后 join= 是一段的逐轮原因**并集（去重）**，
// 按段读——一段里出现过的原因各计一次；单原因行（历史与单线索段）与旧算法逐字一致。
const reasons = new Map();
let backfilled = 0;
for (const line of joinLines) {
  if (Date.parse(line.slice(0, 24)) < windowStartMs) continue;
  if (/origin=backfill/.test(line)) {
    backfilled += 1;
    continue;
  }
  const union = /join=([a-z-]+(?:\+[a-z-]+)*)/.exec(line)?.[1];
  if (!union) {
    reasons.set('unknown', (reasons.get('unknown') ?? 0) + 1);
    continue;
  }
  for (const reason of new Set(union.split('+'))) {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
}
const total = [...reasons.values()].reduce((sum, n) => sum + n, 0);
const joined = (reasons.get('continue') ?? 0) + (reasons.get('fallback-previous') ?? 0) + (reasons.get('fallback-unknown-id') ?? 0);
const created = (reasons.get('explicit-new') ?? 0) + (reasons.get('no-context') ?? 0);

// ---- 2. 线索规模（DB） ----
const threads = query('SELECT id, status FROM threads');
const turnsPerThread = new Map(
  query('SELECT thread_id id, COUNT(*) n FROM turns WHERE thread_id IS NOT NULL GROUP BY thread_id').map((r) => [r.id, Number(r.n)]),
);
const factsPerThread = new Map();
for (const row of query(
  `SELECT t.thread_id id, COUNT(DISTINCT f.id) n
     FROM turns t JOIN facts f ON f.source_turn_id = t.id
    WHERE t.thread_id IS NOT NULL GROUP BY t.thread_id`,
)) {
  factsPerThread.set(row.id, Number(row.n));
}
const windowThreads = all
  ? threads
  : query('SELECT DISTINCT t.thread_id id FROM turns t WHERE t.started_at >= ? AND t.thread_id IS NOT NULL', windowStartMs);
const threadIds = windowThreads.map((r) => r.id);
const multiTurn = threadIds.filter((id) => (turnsPerThread.get(id) ?? 0) >= 2).length;
const multiFact = threadIds.filter((id) => (factsPerThread.get(id) ?? 0) >= 2).length;

// ---- 3. 归纳产出与可追溯（与窗口一致：同一段时间内的分子分母） ----
const conclusions = all
  ? query("SELECT id FROM facts WHERE type_name = '结论'")
  : query("SELECT id FROM facts WHERE type_name = '结论' AND created_at >= ?", windowStartMs);
let traceable = 0;
for (const conclusion of conclusions) {
  const evidence = query(
    "SELECT ref_fact_id id FROM fact_slots WHERE fact_id = ? AND slot = '证据' AND ref_fact_id IS NOT NULL",
    conclusion.id,
  );
  const existing = evidence.filter((row) => one('SELECT 1 x FROM facts WHERE id = ?', row.id));
  if (existing.length >= 2) traceable += 1;
}
const closed = all
  ? one("SELECT COUNT(*) n FROM threads WHERE status = 'closed'").n
  : one("SELECT COUNT(*) n FROM threads WHERE status = 'closed' AND closed_at >= ?", windowStartMs).n;
// Cross-check of the log-based rate: turns recorded in the window, attributed or not.
const windowTurnRows = all
  ? query('SELECT id, thread_id FROM turns')
  : query('SELECT id, thread_id FROM turns WHERE started_at >= ?', windowStartMs);
const windowTurns = windowTurnRows.length;
const attributed = windowTurnRows.filter((row) => row.thread_id != null).length;
// 段级口径（ADR 0034 修订）的分母：还在缓冲里的轮次在等离开点（决定 4 认的 1 轮延迟），
// 它们不是"没归属"——从分母里剔除。队列文件读不出来时说清楚，不静默当 0（规则 11）。
const queueFile = join(HOME, 'pending-extract.json');
const buffered = new Set();
if (existsSync(queueFile)) {
  try {
    const parsed = JSON.parse(readFileSync(queueFile, 'utf8'));
    if (Array.isArray(parsed)) for (const item of parsed) buffered.add(String(item.turnId));
  } catch {
    console.log('注: pending-extract.json 解析失败——缓冲按 0 计，归属率分母可能偏大');
  }
}
const flushedRows = windowTurnRows.filter((row) => !buffered.has(String(row.id)));
const flushed = flushedRows.length;
const flushedAttributed = flushedRows.filter((row) => row.thread_id != null).length;

// ---- 4. 打印与判定 ----
const pct = (part, whole) => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(0)}%`);
/**
 * A zero denominator is not a failure: it means the change has not been exercised yet.
 * Reporting FAIL there would call an empty sample a verdict.
 */
const MIN_SAMPLE = 20;
const verdict = (sample, condition) => {
  if (sample === 0) return '— 无样本';
  if (sample < MIN_SAMPLE) return `样本不足（${sample}/${MIN_SAMPLE}）`;
  return condition ? 'PASS' : 'FAIL';
};

console.log(`窗口: ${all ? '全部历史' : new Date(windowStartMs).toISOString()} → 现在`);
console.log(`\n归属原因（新逻辑 ${total} 个计数；③ 后 join= 为段级并集，一段出现过的原因各计一次）`);
for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(18)} ${String(count).padStart(4)}  ${pct(count, total)}`);
}
console.log(`  继续:新建 = ${joined}:${created}`);
if (backfilled > 0) console.log(`  回填批次（已排除）: ${backfilled} 段（origin=backfill）`);

console.log(`\n线索（窗口内 ${threadIds.length} 条）`);
const turnHist = new Map();
for (const id of threadIds) {
  const n = turnsPerThread.get(id) ?? 0;
  turnHist.set(n, (turnHist.get(n) ?? 0) + 1);
}
console.log('  轮次分布: ' + [...turnHist.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}轮=${c}`).join(' '));
console.log(`  ≥2 轮: ${multiTurn}/${threadIds.length} = ${pct(multiTurn, threadIds.length)}`);
console.log(`  ≥2 条事实: ${multiFact}/${threadIds.length} = ${pct(multiFact, threadIds.length)}`);

console.log(`\n归纳`);
console.log(`  结论 ${conclusions.length} 条 | 关闭线索 ${closed} 条 | 每 10 条关闭线索产出 ${closed === 0 ? '—' : (conclusions.length / closed * 10).toFixed(1)} 条`);
console.log(`  证据可追溯（≥2 条有效证据）: ${traceable}/${conclusions.length}`);
console.log(`  窗口内轮次归属（全量，含等离开点的缓冲轮次）: ${attributed}/${windowTurns} = ${pct(attributed, windowTurns)}`);

console.log(`\nADR 0034 通过线（样本 ≥${MIN_SAMPLE} 才判定；归属率分母 = 已 flush 轮次，见 ADR 修订）`);
// 一位小数：整数四舍五入会把 89.9% 显示成 "90% FAIL"，看起来自相矛盾。
const flushRatePct = flushed === 0 ? '—' : `${((flushedAttributed / flushed) * 100).toFixed(1)}%`;
console.log(`  每轮归属率 ≥90%      ${flushRatePct} ${verdict(flushed, flushed > 0 && flushedAttributed / flushed >= 0.9)}`);
console.log(`  ≥2 轮线索 >50%       ${pct(multiTurn, threadIds.length)} ${verdict(threadIds.length, threadIds.length > 0 && multiTurn / threadIds.length > 0.5)}`);
console.log(`  ≥2 事实线索 >30%     ${pct(multiFact, threadIds.length)} ${verdict(threadIds.length, threadIds.length > 0 && multiFact / threadIds.length > 0.3)}`);
console.log(`  每 10 关闭 ≥5 结论   ${closed === 0 ? '—' : (conclusions.length / closed * 10).toFixed(1)} ${verdict(closed, closed > 0 && conclusions.length / closed * 10 >= 5)}`);
console.log(`  证据可追溯 100%      ${pct(traceable, conclusions.length)} ${verdict(conclusions.length, conclusions.length > 0 && traceable === conclusions.length)}`);
if (flushed < MIN_SAMPLE) {
  console.log(`\n结论：已 flush 轮次样本不足（${flushed}/${MIN_SAMPLE}），当前只作观察，不据此改判据。`);
}
db.close();
