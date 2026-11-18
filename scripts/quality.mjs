/**
 * Quality ratios for every model-driven stage (ADR 0031).
 *
 * A stage without a ratio can only be judged by feeling, and "it seems better"
 * is not evidence. This reads what the plugin already writes — the SQLite store
 * and trace.jsonl — and prints the four numbers the ADR requires plus the two
 * that show model health.
 *
 * Usage:
 *   node scripts/quality.mjs                 # last 7 days
 *   node scripts/quality.mjs --days 30
 *   node scripts/quality.mjs --json
 *   node scripts/quality.mjs --s1-sample [n] # C2 人判样本
 *   node scripts/quality.mjs --c5-sample [n] # C5 人判样本（三类判定）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const daysIndex = args.indexOf('--days');
const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 7;
const since = Date.now() - Math.max(1, days) * 86_400_000;

const dbFile = join(HOME, 'soul.db');
const traceFile = join(HOME, 'trace.jsonl');

if (!existsSync(dbFile)) {
  console.error(`no database at ${dbFile}`);
  process.exit(2);
}

const db = new DatabaseSync(dbFile, { readOnly: true });
const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);

const facts = one(
  "SELECT COUNT(*) AS n FROM facts WHERE COALESCE(type_name,'') != '结论' AND COALESCE(created_at, 0) >= ?",
  since,
).n;
const conclusions = one(
  "SELECT COUNT(*) AS n FROM facts WHERE type_name = '结论' AND COALESCE(created_at, 0) >= ?",
  since,
).n;
const turns = one('SELECT COUNT(*) AS n FROM turns WHERE started_at >= ?', since).n;
const turnsWithThread = one(
  'SELECT COUNT(*) AS n FROM turns WHERE started_at >= ? AND thread_id IS NOT NULL',
  since,
).n;
const threads = one('SELECT COUNT(*) AS n FROM threads WHERE opened_at >= ?', since).n;
const unanchored = one(
  `SELECT COUNT(*) AS n FROM facts f
   WHERE COALESCE(f.created_at, 0) >= ?
     AND NOT EXISTS (SELECT 1 FROM fact_slots s WHERE s.fact_id = f.id AND s.value_type = 'entity')`,
  since,
).n;
const affectAll = one('SELECT COUNT(*) AS n FROM affect_samples WHERE at >= ?', since).n;
const affectSignal = one('SELECT COUNT(*) AS n FROM affect_samples WHERE at >= ? AND confidence > 0', since).n;

// 0027: the model owns both ends of a fact's time. A NULL valid_from can only be a
// model omission — the v15 migration filled every existing row, and the writer no
// longer invents one (putFact writes what the model gave, or null).
const timeFacts = one('SELECT COUNT(*) AS n FROM facts').n;
const timeNullFrom = one('SELECT COUNT(*) AS n FROM facts WHERE valid_from IS NULL').n;
// Before this moment the code filled the date itself, so precision rows created
// earlier describe the migration, not the model. Recorded in state.md (0027 deploy).
const V15_AT = Date.parse('2026-11-04T12:48:00.000Z');
const afterV15 = one('SELECT COUNT(*) AS n FROM facts WHERE COALESCE(created_at, 0) >= ?', V15_AT).n;
const afterV15Null = one(
  'SELECT COUNT(*) AS n FROM facts WHERE COALESCE(created_at, 0) >= ? AND valid_from IS NULL',
  V15_AT,
).n;
const precisionAfterV15 = all(
  'SELECT COALESCE(valid_from_precision, ?) AS p, COUNT(*) AS n FROM facts WHERE COALESCE(created_at, 0) >= ? GROUP BY p',
  'unknown',
  V15_AT,
);
// A located date must sit on a calendar-day instant (UTC midnight): windows compare in
// that unit and the display reads it back as a date. A row stamped with `now` and called
// `day` would still match a window while claiming an hour as a day (0027 写入侧收口).
const dayOffBoundary = one(
  `SELECT COUNT(*) AS n FROM facts WHERE valid_from IS NOT NULL AND valid_from % 86400000 != 0 AND valid_from_precision IN ('day','range')`,
).n;
// A successful supersede is visible as a retracted row whose successor was written
// in-window; a failed one never reaches the database at all — the gate skips it and
// the trace records the reason.
const supersedeSuccess = one(
  `SELECT COUNT(*) AS n FROM facts f JOIN facts s ON s.id = f.superseded_by
   WHERE f.status = 'retracted' AND COALESCE(s.created_at, 0) >= ?`,
  since,
).n;
// 0028: extraction runs only at a departure, and the verdict judges calls after
// the gate went live (apply() v0.0.120) — pre-gate calls are history, not
// violations. Pairing against trace events happens below, after the file parse.
const GATE_AT = Date.parse('2026-11-05T14:33:06.000Z');
const turnsPostGate = one(
  'SELECT COUNT(*) AS n FROM turns WHERE started_at >= ?',
  Math.max(since, GATE_AT),
).n;

// --- S1 使用者判据（debt #9）：工程门禁之外的使用者视角 ---
// 口径与"分子谁判"的唯一声明：docs/stages/s1-dsh-memory.md「可算口径（2026-11-17）」。
// C1/C2/C3 的分子只能人判——本节只出候选与样本（空样本不是判决，pass 留 null）；
// C4 机器可判。标记词是测量工具（同 0035 审计口径），不进运行时路由。
const REPETITION_MARKERS = [/我说过/, /跟你讲/, /跟你说了/, /不是说/, /又说/, /再说一遍/, /怎么又/, /还记得/, /提过/, /重复/];
const userTurnsWindow = all(
  'SELECT user_text FROM turns WHERE user_text IS NOT NULL AND COALESCE(started_at, 0) >= ?',
  since,
);
const repeatCandidates = userTurnsWindow.filter((row) =>
  REPETITION_MARKERS.some((marker) => marker.test(row.user_text)),
).length;
// C3：只有 rule:* 是候选。structural:* 是已知噪声探测器（S1 收尾：3/28 ≈ 11% 精度），
// 单列计数，保证它永远进不了分子、也不会无声消失。
const c3Candidates = one(
  "SELECT COUNT(*) AS n FROM corrections WHERE at >= ? AND rule LIKE 'rule:%'",
  since,
).n;
const c3Noise = one(
  "SELECT COUNT(*) AS n FROM corrections WHERE at >= ? AND rule LIKE 'structural:%'",
  since,
).n;
const activeFacts = one("SELECT COUNT(*) AS n FROM facts WHERE status = 'active'").n;
// C1b（C1 的系统侧代理，不是原义）：先验倾向里"首周之后又写了一遍"的条数占比。
// 这个定义精确复现 2026-11-10 基线 27/112 = 24.1%，读数因此可比。
// 跨周指标按天性全量计算，--days 不过滤它。只数 11-09 快照内的先验族：
// 快照外 35 条新规则未分类、不入分母（rule-compression 的门负责报它们）。
const weekKey = (ms) => {
  const d = new Date(Number(ms));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3); // 本周四 = ISO 周键
  return d.toISOString().slice(0, 10);
};
const activeRules = all("SELECT id, created_at FROM facts WHERE role = 'rule' AND status = 'active'");
const c1b = { families: 0, total: 0, restated: 0, rate: null };
try {
  const families = JSON.parse(
    readFileSync(new URL('data/rule-families-2026-11-09.json', import.meta.url), 'utf8'),
  ).families.filter((family) => family.kind === 'prior');
  const activeById = new Map(activeRules.map((row) => [row.id, row]));
  for (const family of families) {
    const rows = family.ids.map((id) => activeById.get(id)).filter(Boolean);
    if (rows.length === 0) continue;
    c1b.families += 1;
    c1b.total += rows.length;
    const firstWeek = [...new Set(rows.map((row) => weekKey(row.created_at)))].sort()[0];
    c1b.restated += rows.filter((row) => weekKey(row.created_at) !== firstWeek).length;
  }
  c1b.rate = c1b.total === 0 ? null : Number((c1b.restated / c1b.total).toFixed(3));
} catch {
  /* 快照缺失 → rate 留 null 打印 —，不编数 */
}

// C6a（ADR 0036 收编 0034 验收表）：每 10 条关闭线索出几条结论。
// 分母按 0034 出生口径钉全量（0.2→≥5 当时就是全量算的），窗口值单列观察不判——
// 线的分母必须跟线的出生时一致，否则读数不可比（debt §五：分母定义随数落盘）。
const closedThreadsAll = one('SELECT COUNT(*) AS n FROM threads WHERE closed_at IS NOT NULL').n;
const conclusionsAll = one("SELECT COUNT(*) AS n FROM facts WHERE type_name = '结论'").n;
const c6aRate = closedThreadsAll === 0 ? null : Number(((conclusionsAll / closedThreadsAll) * 10).toFixed(2));
const closedThreadsWindow = one(
  'SELECT COUNT(*) AS n FROM threads WHERE COALESCE(closed_at, 0) >= ?',
  since,
).n;

// C5 候选双源（ADR 0036 §2）：affect payload.hits ∪ user_text 命中词表。
// 词表从 seed-lexicon.ts 的 SEED_LEXICON.entries 正则解析（term-audit 同款读法），
// 不另抄一份；解析出 0 词 = 解析失败，显式报错而不是把「没候选」当真（规则 11）。
const seedLexiconSrc = readFileSync(
  new URL('../packages/core/src/affect/seed-lexicon.ts', import.meta.url),
  'utf8',
);
const lexiconTerms = [
  ...seedLexiconSrc.matchAll(/^\s*([\p{Script=Han}A-Za-z]+):\s*\{\s*category:/gmu),
].map((match) => match[1]);
if (lexiconTerms.length === 0) {
  console.error('C5: seed-lexicon.ts 词条解析为 0——词表读法坏了，拒绝出候选');
  process.exit(2);
}
// 源1：affect 命中（近窗，payload.hits 非空即候选；negated 也留给人判——否定了的情绪
// 仍是「表达了情绪」，接没接住归人判三类，机器不预筛）。
const affectHitRows = all(
  'SELECT at, payload FROM affect_samples WHERE at >= ?',
  since,
).filter((row) => {
  try {
    const payload = JSON.parse(row.payload);
    return Array.isArray(payload.hits) && payload.hits.length > 0;
  } catch {
    return false;
  }
});
// 源2：user_text 命中词表（标记词补召回——词典地板下 90 条只有 2 条带 hits）。
const c5MarkerRows = all(
  'SELECT session_id, started_at, user_text FROM turns WHERE user_text IS NOT NULL AND COALESCE(started_at, 0) >= ?',
  since,
).filter((row) => lexiconTerms.some((term) => row.user_text.includes(term)));

// trace.jsonl is append-only and may contain partial writes; skip unparseable lines.
const trace = [];
if (existsSync(traceFile)) {
  for (const line of readFileSync(traceFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (Number(row.ts ? Date.parse(row.ts) : 0) >= since) trace.push(row);
    } catch {
      /* a torn line is not a reason to lose the rest */
    }
  }
}

// S1 C2/C4：inject 带 ids 是"可回溯抽查"的前提（S1 收尾建议第 1 条，已上线）；
// tool-call 记录 S1 判定用过的 soul_* 工具。
const injects = trace.filter((row) => row.event === 'inject');
const injectsTraced = injects.filter((row) => Array.isArray(row.ids) && row.ids.length > 0).length;
// C6b（ADR 0036 §3）：注入里带结论 id 的次数——「存在但没被说出不算洞察」的前半段
// （机器计数→观察值）；对话中主动引用归人判（--c5-sample 同款流程），先测基线。
const conclusionIdSet = new Set(
  all("SELECT id FROM facts WHERE type_name = '结论'").map((row) => row.id),
);
const injectsWithConclusion = injects.filter(
  (row) => Array.isArray(row.ids) && row.ids.some((id) => conclusionIdSet.has(id)),
).length;
const soulToolCalls = trace.filter(
  (row) => row.event === 'tool-call' && (row.name === 'soul_recall' || row.name === 'soul_detail'),
);
const soulToolHits = soulToolCalls.filter((row) => Number(row.hits) > 0 || row.hit === true).length;

// C2 抽查样本：均匀抽 n 次注入，配该轮 assistant_text 供人判"回答是否主动带上记忆"。
// 判决（≥8/10 达标）由人给出并记 state.md——脚本只出样本，不自评（S1 判据 2 的教训）。
if (args.includes('--s1-sample')) {
  const flagIndex = args.indexOf('--s1-sample');
  const wanted = Number(args[flagIndex + 1]) > 0 ? Number(args[flagIndex + 1]) : 10;
  const stride = Math.max(1, Math.floor(injects.length / wanted));
  const picks = [];
  for (let i = 0; i < injects.length && picks.length < wanted; i += stride) picks.push(injects[i]);
  console.log(`S1 C2 抽查样本：窗口内 ${injects.length} 次注入，抽 ${picks.length} 次（步长 ${stride}）`);
  console.log('判：该轮回答是否主动带上注入的记忆内容；线=先测基线（原 ≥8/10 未测基线已改），结果记 state.md\n');
  for (const inj of picks) {
    const ts = Date.parse(inj.ts);
    const row =
      all(
        'SELECT assistant_text FROM turns WHERE session_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC LIMIT 1',
        inj.session,
        ts,
        ts,
      )[0] ??
      all(
        'SELECT assistant_text FROM turns WHERE session_id = ? AND ABS(started_at - ?) <= 900000 ORDER BY ABS(started_at - ?) LIMIT 1',
        inj.session,
        ts,
        ts,
      )[0];
    const text = String(row?.assistant_text ?? '（该轮未落库——进行中或已压缩）').replace(/\s+/g, ' ');
    console.log(`${inj.ts}  turn=${inj.turn}  注入 ${inj.ids?.length ?? 0} 条`);
    console.log(`  回答: ${text.slice(0, 160)}${text.length > 160 ? '…' : ''}\n`);
  }
  db.close();
  process.exit(0);
}

// C5 抽查样本（ADR 0036 决策 4 第二步）：双源候选均匀抽 n 个，配 user_text 与该轮
// 回答供人判三类（接住 / 没接住 / 不适用——不适用不入分母）。判决记 state.md。
if (args.includes('--c5-sample')) {
  const flagIndex = args.indexOf('--c5-sample');
  const wanted = Number(args[flagIndex + 1]) > 0 ? Number(args[flagIndex + 1]) : 10;
  // 双源合并去重：同一轮既被词表命中又被 affect 记了 hits，算一个候选（记 src 双标）。
  const byTurn = new Map();
  for (const row of c5MarkerRows) {
    byTurn.set(`${row.session_id}:${row.started_at}`, {
      ts: row.started_at,
      session: row.session_id,
      userText: row.user_text,
      src: 'lex',
    });
  }
  for (const row of affectHitRows) {
    // affect 没有 session/turn 外键——按时间就近配到轮次（±15 分钟，同 --s1-sample 兜底窗）。
    const turn = all(
      'SELECT session_id, started_at, user_text FROM turns WHERE ABS(started_at - ?) <= 900000 ORDER BY ABS(started_at - ?) LIMIT 1',
      row.at,
      row.at,
    )[0];
    const key = turn ? `${turn.session_id}:${turn.started_at}` : `affect:${row.at}`;
    const existing = byTurn.get(key);
    if (existing) existing.src = 'lex+affect';
    else {
      let hits = [];
      try {
        hits = JSON.parse(row.payload).hits ?? [];
      } catch { /* 坏 payload 不毒害候选，src 仍标 affect */ }
      byTurn.set(key, {
        ts: row.at,
        session: turn?.session_id ?? null,
        userText: turn?.user_text ?? '（affect 命中未能配到轮次——±15min 内无落库轮次）',
        src: `affect(${hits.map((h) => h.term).join('/')})`,
      });
    }
  }
  const candidates = [...byTurn.values()].sort((a, b) => a.ts - b.ts);
  if (candidates.length === 0) {
    console.log('S1 C5 抽查样本：窗口内双源候选 0 个——空样本不是判决，先攒候选（词表源 + affect 源）');
    db.close();
    process.exit(0);
  }
  const stride = Math.max(1, Math.floor(candidates.length / wanted));
  const picks = [];
  for (let i = 0; i < candidates.length && picks.length < wanted; i += stride) picks.push(candidates[i]);
  console.log(`S1 C5 抽查样本：窗口内 ${candidates.length} 个候选（词表 ${c5MarkerRows.length} + affect ${affectHitRows.length}，同轮已合并），抽 ${picks.length} 个（步长 ${stride}）`);
  console.log('判三类：接住=回应涉及情绪本身（承认/共情/顺着处境说）；没接住=直接办事/转移/无视；不适用=候选假阳性不入分母。结果记 state.md\n');
  for (const cand of picks) {
    const turnRow = cand.session
      ? all(
          'SELECT assistant_text FROM turns WHERE session_id = ? AND ABS(started_at - ?) <= 900000 ORDER BY ABS(started_at - ?) LIMIT 1',
          cand.session,
          cand.ts,
          cand.ts,
        )[0]
      : undefined;
    const text = String(turnRow?.assistant_text ?? '（该轮未落库——进行中或已压缩）').replace(/\s+/g, ' ');
    const when = new Date(cand.ts).toISOString();
    console.log(`${when}  src=${cand.src}`);
    console.log(`  用户: ${String(cand.userText).replace(/\s+/g, ' ').slice(0, 200)}`);
    console.log(`  回答: ${text.slice(0, 400)}${text.length > 400 ? '…' : ''}\n`);
  }
  db.close();
  process.exit(0);
}
db.close();

const pct = (part, whole) => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`);
const per = (part, whole) => (whole === 0 ? '—' : (part / whole).toFixed(2));

const extracts = trace.filter((row) => row.event === 'extract');
// 0028: an extract event with no triggered drain behind it is an in-session
// call — the exact work the gate exists to stop. The verdict counts CALLS
// after GATE_AT (one bypass = one too many); older calls are history: shown,
// not judged (取舍要可见). The pairing window is generous — the queue event is
// written in the same tick as the extract event (98ms measured) — and an
// unpaired post-gate extract counts as in-session, so a broken gate fails
// loudly instead of passing. GATE_AT and turnsPostGate are declared above,
// next to the other database reads (the connection closes at db.close()).
const triggeredDrains = trace.filter((row) => row.event === 'extract-queue' && row.trigger);
const ranAtDeparture = (row) => {
  const at = Date.parse(row.ts);
  return triggeredDrains.some((drain) => {
    const dt = Date.parse(drain.ts) - at;
    return dt >= 0 && dt <= 2000;
  });
};
const inSession = extracts.filter((row) => Date.parse(row.ts) < GATE_AT || !ranAtDeparture(row));
const inSessionPostGate = inSession.filter((row) => Date.parse(row.ts) >= GATE_AT).length;
// Why the rules path ran. "model-failed" and a deliberate rules mode are very
// different problems, and a single ratio hides which one is happening.
//
// A retried turn writes one event per attempt, so counting events overstates
// failures badly: one turn retried ten times looked like ten broken extractions.
// Only the final outcome of each turn counts, and records written before the
// reason field existed are "unmeasured", not "failed".
const finalByTurn = new Map();
for (const row of extracts) {
  if (row.turn === undefined) continue;
  finalByTurn.set(row.turn, row);
}
const measured = [...finalByTurn.values()];
const measuredLlm = measured.filter((row) => row.by === 'llm').length;
const fallbackReasons = new Map();
for (const row of measured) {
  if (row.by === 'llm') continue;
  const key = String(row.reason ?? 'unmeasured').split(':')[0].slice(0, 40);
  fallbackReasons.set(key, (fallbackReasons.get(key) ?? 0) + 1);
}
const knownFallback = measured.filter((row) => row.by !== 'llm' && row.reason !== undefined).length;
const modelDenominator = measuredLlm + knownFallback;
const attributions = measured.filter((row) => row.thread);
const threadCreated = attributions.filter((row) => row.threadCreated).length;

// A failed supersede never reaches the database: the gate skips it and the trace
// records why. Counting both sides is the only way to see whether the model names
// targets that do not exist (unknown-supersede-target) or ones already replaced
// (supersede-target-retracted) — a silent failure would otherwise look like a
// model that simply never revises anything.
const supersedeFailureReasons = new Map();
let supersedeFailures = 0;
for (const row of trace) {
  if (row.event !== 'extract') continue;
  for (const skipped of row.skipped ?? []) {
    const reason = String(skipped.reason ?? '');
    if (!reason.startsWith('supersede-target-') && !reason.startsWith('unknown-supersede-target')) continue;
    supersedeFailures += 1;
    supersedeFailureReasons.set(reason, (supersedeFailureReasons.get(reason) ?? 0) + 1);
  }
}
const supersedeAttempts = supersedeSuccess + supersedeFailures;

const consolidations = trace.filter((row) => row.event === 'consolidate' && (row.verdict === 'supported' || row.dropped));
const supported = consolidations.filter((row) => row.verdict === 'supported').length;

// 0026: what one turn cost. The platform export is one line per day, so the turn that
// burned the money is invisible until the day is over; the plugin writes one record per
// finished turn. Requests per turn is the heaviness signal, and prompt tokens per
// request is the "context is being re-bought" signal that decides whether a session is
// too expensive to keep going. Incomplete turns (evicted / interrupted, `open`) are
// excluded from the distribution and counted separately — half a turn is not a data point.
const turnCosts = trace.filter((row) => row.event === 'turn-cost');
const completeTurns = turnCosts.filter((row) => !row.open);
const openTurns = turnCosts.length - completeTurns.length;
const requestCounts = completeTurns
  .map((row) => Number(row.requests) || 0)
  .filter((n) => n > 0)
  .sort((a, b) => a - b);
const requestTotal = requestCounts.reduce((sum, n) => sum + n, 0);
const promptTokens = completeTurns.reduce(
  (sum, row) => sum + (Number(row.input) || 0) + (Number(row.cacheHit) || 0) + (Number(row.cacheWrite) || 0),
  0,
);
const freshTokens = completeTurns.reduce((sum, row) => sum + (Number(row.input) || 0), 0);
const quantile = (sorted, q) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
const requestBuckets = [
  { label: '1-5', lo: 1, hi: 5 },
  { label: '6-15', lo: 6, hi: 15 },
  { label: '16-30', lo: 16, hi: 30 },
  { label: '31+', lo: 31, hi: Number.POSITIVE_INFINITY },
].map((bucket) => ({ label: bucket.label, n: requestCounts.filter((n) => n >= bucket.lo && n <= bucket.hi).length }));
const heaviestTurns = [...completeTurns]
  .sort((a, b) => (Number(b.requests) || 0) - (Number(a.requests) || 0))
  .slice(0, 3)
  .map((row) => ({
    requests: Number(row.requests) || 0,
    // Session ids look like "session-ac4cb717-…": the uuid prefix is what a human
    // recognises in the log, the word "session" is not.
    session: String(row.session ?? '').replace(/^session-/, '').slice(0, 8),
    turn: row.turn,
  }));

const report = {
  window: { days, since: new Date(since).toISOString() },
  // 事实密度线 2026-11-16 重定 ≤3（ADR 0031 修订注）：初版 ≤1.5 是「每轮一抽」时代
  // 口径，粒度三次变化把读数推到 0.73→1.9→2.12→2.59，「回填所致」假设被证伪
  // （7 日窗回填 0 次、34 次抽取全 live ≈8 条/次）。ADR 线第二款「且无『用户要求
  // X 类』」尚未实现——度量缺口，随重定登记在 ADR 0031。
  factsPerTurn: { facts, turns, ratio: turns === 0 ? null : Number((facts / turns).toFixed(2)), pass: turns > 0 && facts / turns <= 3 },
  extraction: {
    turns: measured.length,
    byLlm: measuredLlm,
    knownFallback,
    unmeasured: measured.length - measuredLlm - knownFallback,
    modelRate: modelDenominator === 0 ? null : Number((measuredLlm / modelDenominator).toFixed(3)),
    pass: modelDenominator === 0 ? null : measuredLlm / modelDenominator >= 0.8,
  },
  // 0028: the verdict judges post-gate calls only — pre-gate calls were the old
  // per-turn path, not a gate violation; they stay visible as windowCalls.
  inSessionExtraction: {
    windowCalls: inSession.length,
    postGateCalls: inSessionPostGate,
    postGateTurns: turnsPostGate,
    ratio: turnsPostGate === 0 ? null : Number((inSessionPostGate / turnsPostGate).toFixed(2)),
    pass: turnsPostGate === 0 ? null : inSessionPostGate === 0,
  },
  attribution: {
    attached: attributions.length,
    created: threadCreated,
    newThreadRate: attributions.length === 0 ? null : Number((threadCreated / attributions.length).toFixed(3)),
    coverageOfTurns: turns === 0 ? null : Number((turnsWithThread / turns).toFixed(3)),
    threads,
  },
  conclusions: {
    total: conclusions,
    supported,
    checked: consolidations.length,
    supportRate: consolidations.length === 0 ? null : Number((supported / consolidations.length).toFixed(3)),
    pass: consolidations.length === 0 ? null : supported / consolidations.length >= 0.8,
  },
  anchors: {
    facts,
    unanchored,
    rate: facts === 0 ? null : Number((unanchored / facts).toFixed(3)),
  },
  affect: {
    samples: affectAll,
    withSignal: affectSignal,
    signalRate: affectAll === 0 ? null : Number((affectSignal / affectAll).toFixed(3)),
    // 2026-11-16：debt #5 冻结期不判决——词典地板下 ≥50% 永远不可达（llm 分析器
    // 无实现、<affect> 消费端 confidence≥0.6 实际渲染≈0），常驻 FAIL 只会淹没真信号；
    // 解冻（llm 分析器落地）后恢复 ≥50% 判决。
    pass: null,
    frozen: 'debt #5',
  },
  // S1 使用者判据（debt #9）：C1/C2/C3 分子只能人判——pass 留 null 直到抽查/复核
  // 落盘（空样本不是判决）；C4 机器可判。口径唯一声明在 stages/s1-dsh-memory.md。
  s1: {
    c1Repeat: {
      candidates: repeatCandidates,
      turns: userTurnsWindow.length,
      judged: 0,
      line: '≤1 次/周',
      pass: null,
    },
    c1bCrossWeek: {
      families: c1b.families,
      restated: c1b.restated,
      total: c1b.total,
      rate: c1b.rate,
      baseline: '27/112 = 24.1% (2026-11-10)',
      line: null,
      note: '0030 §0 拟 ≤10%，未拍 → 观察；全量计算，不随 --days',
    },
    c2Injection: {
      injects: injects.length,
      traced: injectsTraced,
      sampleReviewed: 0,
      line: '先测基线（原 ≥8/10 未测基线，2026-11-18 改定；首判 4/10 见 state.md 10:55 条目）',
      pass: null,
    },
    c3Misremember: {
      candidates: c3Candidates,
      noiseExcluded: c3Noise,
      reviewed: 0,
      line: '≤1 次/周',
      pass: null,
    },
    c4Verifiable: {
      activeFacts,
      toolCalls: soulToolCalls.length,
      toolHits: soulToolHits,
      line: '可用即可',
      pass: activeFacts > 0,
    },
    // C5/C6 随 ADR 0036 Accepted 接线（2026-11-18）。C5 分子人判 → pass 留 null；
    // C6a 机器判（全量口径，0034 出生）；C6b 计数机器、主动引用人判。
    c5Tone: {
      lexiconCandidates: c5MarkerRows.length,
      affectCandidates: affectHitRows.length,
      lexiconTerms: lexiconTerms.length,
      judged: 0,
      line: '先测 10 样本基线',
      pass: null,
    },
    c6Insight: {
      closedThreads: closedThreadsAll,
      conclusions: conclusionsAll,
      ratePer10: c6aRate,
      closedThreadsWindow,
      conclusionsWindow: conclusions,
      line: '≥5/10（0034 收编，全量口径）',
      pass: c6aRate === null ? null : c6aRate >= 5,
      injectsWithConclusion,
      injects: injects.length,
      c6bLine: '注入带结论计数=观察值；主动引用人判先测基线',
      c6bPass: null,
    },
  },
  timeAxis: {
    total: timeFacts,
    nullFrom: timeNullFrom,
    nullRate: timeFacts === 0 ? null : Number((timeNullFrom / timeFacts).toFixed(4)),
    afterV15: afterV15,
    afterV15Null: afterV15Null,
    precision: Object.fromEntries(precisionAfterV15.map((row) => [row.p, row.n])),
  },
  supersede: {
    attempts: supersedeAttempts,
    success: supersedeSuccess,
    fail: supersedeFailures,
    failRate: supersedeAttempts === 0 ? null : Number((supersedeFailures / supersedeAttempts).toFixed(3)),
    reasons: Object.fromEntries(supersedeFailureReasons),
    // Fewer than five attempts says nothing about a rate: 空样本不是判决.
    judged: supersedeAttempts >= 5,
  },
  turnCost: {
    turns: requestCounts.length,
    openTurns,
    requests: {
      total: requestTotal,
      mean: requestCounts.length === 0 ? null : Number((requestTotal / requestCounts.length).toFixed(1)),
      p50: quantile(requestCounts, 0.5),
      p90: quantile(requestCounts, 0.9),
      max: requestCounts.length === 0 ? null : requestCounts[requestCounts.length - 1],
    },
    distribution: Object.fromEntries(requestBuckets.map((bucket) => [bucket.label, bucket.n])),
    perRequest: {
      prompt: requestTotal === 0 ? null : Math.round(promptTokens / requestTotal),
      fresh: requestTotal === 0 ? null : Math.round(freshTokens / requestTotal),
    },
    heaviest: heaviestTurns,
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const verdict = (value) => (value === null ? '—' : value ? 'PASS' : 'FAIL');

console.log(`soulbridge quality — last ${days} days (${HOME})`);
console.log('');
console.log(`事实密度      ${report.factsPerTurn.ratio ?? '—'} 条/轮   ${verdict(report.factsPerTurn.pass)}   (${facts} 条 / ${turns} 轮，通过线 ≤3，2026-11-16 重定)`);
console.log(
  `抽取走模型    ${pct(measuredLlm, modelDenominator)}        ${verdict(report.extraction.pass)}   (${measuredLlm}/${modelDenominator} 轮，通过线 ≥80%；另有 ${report.extraction.unmeasured} 轮未记录原因，不计入)`,
);
console.log(
  `结论支持率    ${pct(supported, consolidations.length)}        ${verdict(report.conclusions.pass)}   (${supported}/${consolidations.length} 次，通过线 ≥80%)`,
);
console.log(
  `情绪非零率    ${pct(affectSignal, affectAll)}        观察    (${affectSignal}/${affectAll} 条；debt #5 冻结期不判决，解冻后恢复 ≥50%)`,
);
console.log('');
console.log('--- 使用者判据（S1 六条 · debt #9；口径与谁判见 stages/s1-dsh-memory.md） ---');
console.log(
  `C1 重申候选      ${repeatCandidates} 条 / ${userTurnsWindow.length} 轮    人判 0 → 待验收（≤1 次/周；候选池低召回，不代替人判）`,
);
console.log(
  `C1b 跨周重复率   ${pct(c1b.restated, c1b.total)}        观察（基线 27/112=24.1%·11-10；0030 §0 拟 ≤10% 未拍；全量不随 --days）`,
);
console.log(
  `C2 注入可回溯    ${pct(injectsTraced, injects.length)}        先测基线（首判 4/10·11-18 已落 state.md；` +
    `node scripts/quality.mjs --s1-sample 出样本；${injectsTraced}/${injects.length} 带 ids）`,
);
console.log(
  `C3 记岔候选      ${c3Candidates} 条         复核 0 → 待验收（≤1 次/周；structural 噪声 ${c3Noise} 不计）`,
);
console.log(
  `C4 可查证        活跃事实 ${activeFacts} · soul_* 调用 ${soulToolCalls.length} 次(成功 ${soulToolHits})   ` +
    `${verdict(activeFacts > 0)}（可用即可；调用数=使用度，没人用记 debt #9）`,
);
console.log(
  `C5 语气候选      词表 ${c5MarkerRows.length} + affect ${affectHitRows.length} 个候选（${lexiconTerms.length} 词条解析）   ` +
    `先测基线（--c5-sample 出样本，人判三类；分子 pass 留 null）`,
);
console.log(
  `C6a 归纳产出率   ${c6aRate ?? '—'} 条/10 关闭   ${verdict(report.s1.c6Insight.pass)} ` +
    `(全量 ${conclusionsAll} 结论 / ${closedThreadsAll} 关闭，线 ≥5/10·0034 收编；` +
    `窗口观察 ${conclusions}/${closedThreadsWindow} 不判)`,
);
console.log(
  `C6b 注入带结论   ${injectsWithConclusion}/${injects.length} 次注入带结论 id   观察（` +
    `${report.s1.c6Insight.c6bLine}）`,
);
console.log('');
console.log(
  `无实体锚点    ${pct(unanchored, facts)}         （观察值：有些事实只有时间，没有参与者）`,
);
console.log(`线索新开率    ${pct(threadCreated, attributions.length)}         （观察值，暂无通过线）`);
console.log(`归属覆盖率    ${pct(turnsWithThread, turns)}         （有线索的轮次 / 全部轮次）`);
console.log(`线索数        ${threads} 条`);
console.log('');
console.log('--- 时间轴（0027：两端都由模型判定） ---');
console.log(
  `valid_from 空值率   ${pct(timeNullFrom, timeFacts)}   观察    (${timeNullFrom}/${timeFacts}；NULL 只可能是 0027 之后模型省略——v15 已给旧行全部填过值)`,
);
console.log(
  `0027 后新事实      ${afterV15} 条 · valid_from 空 ${afterV15Null} · ` +
    (precisionAfterV15.length === 0 ? '尚无' : precisionAfterV15.map((row) => `${row.p} ${row.n}`).join(' · ')),
);
console.log(
  `day/range 非日历日 ${dayOffBoundary}         ` +
    `${dayOffBoundary === 0 ? 'PASS' : 'FAIL'}（必须为 0：located日期要落在 UTC 零点，窗口和显示都按这个单位比）`,
);
console.log(
  `取代引用           成功 ${supersedeSuccess} · 失败 ${supersedeFailures}` +
    (supersedeFailureReasons.size > 0 ? `（${[...supersedeFailureReasons].map(([reason, n]) => `${reason} ${n}`).join(' · ')}）` : '') +
    `   ${supersedeAttempts >= 5 ? (supersedeFailures / supersedeAttempts <= 0.2 ? 'PASS' : 'FAIL') + '（失败率 ≤20%）' : '样本不足，不判决（<5 次）'}`,
);
console.log('');
console.log('--- 离开点（0028：抽取只在离开点发生） ---');
console.log(
  `会话中抽取/轮   ${report.inSessionExtraction.ratio ?? '—'} 次/轮   ${verdict(report.inSessionExtraction.pass)}   ` +
    `(闸门后 ${inSessionPostGate} 次 / ${turnsPostGate} 轮，通过线 =0；窗口内另有 ${inSession.length - inSessionPostGate} 次全在 0028② 闸门 11-05 14:33Z 之前，不计入)`,
);
console.log('');
console.log('--- 每轮成本（0026：turn-cost 事件） ---');
if (requestCounts.length === 0) {
  console.log('窗口内无完成的 turn-cost 事件（插件 ≥0.0.113 才有）');
} else {
  console.log(
    `每轮请求数        共 ${requestCounts.length} 轮 · 合计 ${requestTotal} 次 · 平均 ${report.turnCost.requests.mean} · ` +
      `p50 ${report.turnCost.requests.p50} · p90 ${report.turnCost.requests.p90} · 最重 ${report.turnCost.requests.max}` +
      (openTurns > 0 ? `（另有 ${openTurns} 条未完成轮次不计入）` : ''),
  );
  console.log(`请求数分布        ${requestBuckets.map((bucket) => `${bucket.label}: ${bucket.n}`).join(' · ')}`);
  console.log(
    `每请求上下文      平均 ${report.turnCost.perRequest.prompt} token（纯输入 ${report.turnCost.perRequest.fresh}；含缓存读写）` +
      '    ← 这个数涨，就该换会话了',
  );
  console.log(
    `最重三轮          ${heaviestTurns.map((t) => `${t.requests}次(${t.session}/${t.turn})`).join(' · ')}`,
  );
}
console.log('');
if (fallbackReasons.size > 0) {
  console.log('');
  console.log('规则兜底原因：');
  for (const [reason, count] of [...fallbackReasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(24)} ${count}`);
  }
}
console.log('');
console.log('口径：trace.jsonl + soul.db，只读；窗口按 started_at / at / ts 过滤。');
