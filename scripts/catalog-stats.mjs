/**
 * Did the always-on catalog give the model a reason to ask? (0029 stage 1)
 *
 * The judgement line is about calls, not about injection size: after the catalog
 * ships, `soul_recall` / `soul_detail` calls must be > 0 (the baseline was 0 for the
 * whole life of the tool), and at least 7 of a 10-call sample must fetch something
 * relevant. This script produces the numbers and the sample; relevance is a human
 * read — each call is printed with the user message of the turn it happened in, so
 * the reader can judge from the context instead of from a proxy.
 *
 * Who reads it: whoever judges 0029 stage 1 — after ~3 days, or as soon as the first
 * calls appear. Nobody reads it for routine status.
 *
 *   node scripts/catalog-stats.mjs [--since <iso>] [--sample 10]
 *
 * The default window starts at the first `catalog` event in trace.jsonl: before it
 * there was no directory, so counting calls from an earlier time would mix two
 * different systems. `--since` pushes the window forward (e.g. after a redeploy).
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const TRACE_FILE = join(HOME, 'trace.jsonl');

function argValue(name, fallback) {
  const at = process.argv.indexOf(name);
  if (at < 0) return fallback;
  return process.argv[at + 1] ?? fallback;
}

const SAMPLE = Math.max(1, Number(argValue('--sample', 10)));
// The judgement needs a window, not just a count: the first turn after the catalog
// ships has zero calls by construction, and calling that a failure would invite
// exactly the forcing the brief forbids. 24h is the floor before "no calls" is news.
const MIN_HOURS = Number(argValue('--min-hours', 24));
if (!Number.isFinite(MIN_HOURS) || MIN_HOURS < 0) {
  console.error(`--min-hours 不是非负数字：${argValue('--min-hours', '')}`);
  process.exit(1);
}
const SINCE_ARG = argValue('--since', '');
if (SINCE_ARG && Number.isNaN(Date.parse(SINCE_ARG))) {
  console.error(`--since 不是可解析的时间：${SINCE_ARG}`);
  process.exit(1);
}

/** One trace line, or null for a truncated one. A leading BOM is not JSON. */
function parseLine(line) {
  const text = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
  if (!text.includes('"event"')) return null;
  try {
    const event = JSON.parse(text);
    return event && typeof event === 'object' ? event : null;
  } catch {
    return null;
  }
}

const events = [];
if (existsSync(TRACE_FILE)) {
  const reader = createInterface({ input: createReadStream(TRACE_FILE), crlfDelay: Infinity });
  for await (const line of reader) {
    const event = parseLine(line);
    if (event) events.push(event);
  }
}

const firstCatalog = events.find((event) => event.event === 'catalog')?.ts;
const GATE = SINCE_ARG || firstCatalog;
if (!GATE) {
  console.log('还没有 catalog 事件：目录没有上线过（或 trace 已轮转），判决线无从谈起。');
  process.exit(0);
}
const gateMs = Date.parse(GATE);
const after = events.filter((event) => Date.parse(event.ts) >= gateMs);

function mean(list) {
  if (list.length === 0) return 0;
  return list.reduce((sum, n) => sum + n, 0) / list.length;
}

const catalogs = after.filter((event) => event.event === 'catalog');
const classify = after.filter((event) => event.event === 'classify');
const backfill = after.filter((event) => event.event === 'catalog-backfill');
const toolCalls = after.filter((event) => event.event === 'tool-call');
const recalls = toolCalls.filter((event) => event.name === 'soul_recall');
const details = toolCalls.filter((event) => event.name === 'soul_detail');
const fired = after.filter((event) => event.event === 'rule_fired');

console.log(`窗口    自 ${GATE}（${SINCE_ARG ? '--since' : '第一条 catalog 事件'}）`);
console.log(
  `目录    ${catalogs.length} 次注入 · 平均 ${Math.round(mean(catalogs.map((e) => e.chars ?? 0)))} 字符` +
    ` · 平均 ${mean(catalogs.map((e) => e.entries ?? 0)).toFixed(1)} 条` +
    `${catalogs[0]?.total !== undefined ? ` · 库里 ${catalogs[0].total} 条规则` : ''}` +
    `${catalogs[0]?.missing ? ` · 其中 ${catalogs[0].missing} 条无索引` : ''}`,
);
console.log(
  `调用    soul_recall ${recalls.length} 次（平均命中 ${mean(recalls.map((e) => e.hits ?? 0)).toFixed(1)} 条）` +
    ` · soul_detail ${details.length} 次（命中 ${details.filter((e) => e.hit).length} / 未命中 ${details.filter((e) => !e.hit).length}）`,
);
console.log(
  `对照    关键词推送开火 ${fired.length} 次 · 带出 ${fired.reduce((n, e) => n + (Array.isArray(e.rules) ? e.rules.length : 0), 0)} 条`,
);
if (classify.length > 0) {
  const indexed = classify.reduce((n, e) => n + (e.indexed ?? 0), 0);
  const skipped = classify.reduce((n, e) => n + (e.indexSkipped ?? 0), 0);
  console.log(`索引    ${classify.length} 个分类批次 · 补出 ${indexed} 条索引句 · 跳过 ${skipped}`);
}
if (backfill.length > 0) {
  const last = backfill.at(-1);
  console.log(
    `补齐    ${backfill.reduce((n, e) => n + (e.queued ?? 0), 0)} 条规则进过索引队列（${backfill.length} 次盘点，` +
      `末次 attempted=${last.attempted ?? '?'}）`,
  );
}

const calls = recalls.length + details.length;
const windowHours = (Date.now() - gateMs) / 3_600_000;
if (calls === 0) {
  console.log(
    windowHours < MIN_HOURS
      ? `判决    待观察：窗口 ${windowHours.toFixed(1)} 小时 < ${MIN_HOURS}——空样本不是判决（规则 20），` +
          `也不是要现在逼一次调用（0029 §0）。`
      : '判决    FAIL：目录上线超过窗口下限，一次 soul_recall / soul_detail 都没有——按 0029 §0 记「模型主动取数」失败，不硬撑。',
  );
} else if (calls < 5) {
  console.log(`判决    样本不足（${calls} 次 < 5）：只报数，不写「已通过」（规则 20）。`);
} else {
  console.log(`判决    调用次数 > 0 成立（${calls} 次）`);
  // The second half of the judgement line needs ten reads to be a rate at all;
  // five calls cannot be "70%", whatever the arithmetic says.
  console.log(
    calls < 10
      ? `相关率    样本 ${calls} 条 < 10：只报数，不判相关率（规则 20）`
      : '相关率    见下面抽样，人工判 ≥70% 才算过（10 条里 ≥7 条相关）',
  );
}

// ---- the sample that the relevance judgement reads -------------------------------
// The database is optional so the counts still work on a copied trace: a missing
// soul.db must not hide the call numbers, only the statements behind them.
const dbFile = join(HOME, 'soul.db');
const db = existsSync(dbFile) ? new DatabaseSync(dbFile, { readOnly: true }) : null;
const statementOf = db ? db.prepare('SELECT statement FROM facts WHERE id = ?') : null;
/** The turn a call happened in: a tool runs inside a turn, so its start bounds it. */
const turnAt = db
  ? db.prepare(
      `SELECT user_text, turn_no FROM turns
       WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
       ORDER BY started_at DESC LIMIT 1`,
    )
  : null;

const sample = toolCalls.slice(-SAMPLE);
if (sample.length > 0) {
  console.log(`\n抽样    最近 ${sample.length} 次调用（每条带调用时的用户消息；相关记 ✓，无关记 ✗）`);
  for (const call of sample) {
    const at = Date.parse(call.ts);
    const catalog = catalogs.filter((event) => Date.parse(event.ts) <= at).at(-1);
    const inCatalog =
      call.name === 'soul_detail' && Array.isArray(catalog?.ids) ? catalog.ids.includes(call.id) : undefined;
    const turn = turnAt ? turnAt.get(at, at) : undefined;
    const what =
      call.name === 'soul_recall'
        ? `query（${call.queryChars ?? 0} 字）→ ${call.hits ?? 0} 条`
        : `${call.id}${call.hit ? '' : '（未命中）'}${inCatalog === undefined ? '' : inCatalog ? ' · 目录内' : ' · 目录外'}`;
    console.log(`  ${call.ts}  ${call.name}  ${what}`);
    if (call.name === 'soul_detail' && call.hit && statementOf) {
      const fact = statementOf.get(call.id);
      console.log(`    取回：${String(fact?.statement ?? '').slice(0, 48)}`);
    }
    if (turn?.user_text) {
      console.log(`    当时用户说（第 ${turn.turn_no} 轮）：${String(turn.user_text).replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  }
}
db?.close();
