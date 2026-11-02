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

db.close();

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

const pct = (part, whole) => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`);
const per = (part, whole) => (whole === 0 ? '—' : (part / whole).toFixed(2));

const extracts = trace.filter((row) => row.event === 'extract');
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

const consolidations = trace.filter((row) => row.event === 'consolidate' && (row.verdict === 'supported' || row.dropped));
const supported = consolidations.filter((row) => row.verdict === 'supported').length;

const report = {
  window: { days, since: new Date(since).toISOString() },
  factsPerTurn: { facts, turns, ratio: turns === 0 ? null : Number((facts / turns).toFixed(2)), pass: turns > 0 && facts / turns <= 1.5 },
  extraction: {
    turns: measured.length,
    byLlm: measuredLlm,
    knownFallback,
    unmeasured: measured.length - measuredLlm - knownFallback,
    modelRate: modelDenominator === 0 ? null : Number((measuredLlm / modelDenominator).toFixed(3)),
    pass: modelDenominator === 0 ? null : measuredLlm / modelDenominator >= 0.8,
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
    pass: affectAll === 0 ? null : affectSignal / affectAll >= 0.5,
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const verdict = (value) => (value === null ? '—' : value ? 'PASS' : 'FAIL');

console.log(`soulbridge quality — last ${days} days (${HOME})`);
console.log('');
console.log(`事实密度      ${report.factsPerTurn.ratio ?? '—'} 条/轮   ${verdict(report.factsPerTurn.pass)}   (${facts} 条 / ${turns} 轮，通过线 ≤1.5)`);
console.log(
  `抽取走模型    ${pct(measuredLlm, modelDenominator)}        ${verdict(report.extraction.pass)}   (${measuredLlm}/${modelDenominator} 轮，通过线 ≥80%；另有 ${report.extraction.unmeasured} 轮未记录原因，不计入)`,
);
console.log(
  `结论支持率    ${pct(supported, consolidations.length)}        ${verdict(report.conclusions.pass)}   (${supported}/${consolidations.length} 次，通过线 ≥80%)`,
);
console.log(
  `情绪非零率    ${pct(affectSignal, affectAll)}        ${verdict(report.affect.pass)}   (${affectSignal}/${affectAll} 条，通过线 ≥50%)`,
);
console.log('');
console.log(
  `无实体锚点    ${pct(unanchored, facts)}         （观察值：有些事实只有时间，没有参与者）`,
);
console.log(`线索新开率    ${pct(threadCreated, attributions.length)}         （观察值，暂无通过线）`);
console.log(`归属覆盖率    ${pct(turnsWithThread, turns)}         （有线索的轮次 / 全部轮次）`);
console.log(`线索数        ${threads} 条`);
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
