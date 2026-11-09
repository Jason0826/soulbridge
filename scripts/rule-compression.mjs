#!/usr/bin/env node
/**
 * What would a prior layer cost, and is there evidence for it?
 *
 * The direction (2026-11-09) is to stop treating memory as retrieval and try a
 * small always-on layer of dispositions instead. That hypothesis dies or lives on
 * two numbers: how many dispositions there are (does it fit in every turn?) and
 * how often each one was restated (is it a tendency or a one-off?).
 *
 * The judgment of "which rules are the same disposition" is not code's job
 * (ADR 0027), so it lives in a dated snapshot file and this script only counts:
 *
 *   node scripts/rule-compression.mjs                # 读数
 *   node scripts/rule-compression.mjs --md            # 附录表格
 *   node scripts/rule-compression.mjs --db <path>
 *
 * Exit code is the gate: a rule that no family owns (added since the snapshot,
 * or a typo'd id) fails the run instead of being silently ignored — an
 * unclassified rule is the same silence that let 56 trigger-less rules hide.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, 'data', 'rule-families-2026-11-09.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const dbPath = arg('--db', process.env.SOULBRIDGE_HOME ? join(process.env.SOULBRIDGE_HOME, 'soul.db') : join(homedir(), '.soulbridge', 'soul.db'));
const db = new DatabaseSync(dbPath, { readOnly: true });
const q = (sql, ...args) => db.prepare(sql).all(...args);

const rules = q(`
  SELECT f.id, f.statement, f.created_at, f.source_turn_id,
    (SELECT s.value_text FROM fact_slots s WHERE s.fact_id = f.id AND s.slot = '依据' LIMIT 1) AS basis
  FROM facts f WHERE f.role = 'rule' AND f.status = 'active'
  ORDER BY f.created_at, f.id`);
const pairTurn = new Map(q('SELECT id, turn FROM turn_pairs').map((r) => [r.id, r.turn]));
const turnOf = (r) => r.source_turn_id || (r.basis ? pairTurn.get(r.basis) ?? null : null);

const snapshot = JSON.parse(readFileSync(arg('--families', SNAPSHOT), 'utf8')).families;
const known = new Map(rules.map((r) => [r.id, r]));

// --- gate: the partition must cover exactly the rules that are active today ---
const owner = new Map();
const problems = [];
for (const family of snapshot) {
  for (const id of family.ids) {
    if (owner.has(id)) problems.push(`id ${id} in ${owner.get(id)} and ${family.key}`);
    if (!known.has(id)) problems.push(`id ${id} (${family.key}) is no longer an active rule`);
    owner.set(id, family.key);
  }
}
for (const rule of rules) if (!owner.has(rule.id)) problems.push(`active rule ${rule.id} belongs to no family: ${rule.statement.slice(0, 40)}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n✗ ${problems.length} problem(s) — the snapshot and the rule layer disagree`);
  process.exit(1);
}

// --- counts ---
const byKind = new Map();
for (const family of snapshot) {
  const entry = byKind.get(family.kind) ?? { families: 0, rules: 0 };
  entry.families += 1;
  entry.rules += family.ids.length;
  byKind.set(family.kind, entry);
}
const age = (r) => new Date(Number(r.created_at)).toISOString().slice(0, 10);
const evidence = (family) => {
  const rows = family.ids.map((id) => known.get(id));
  const turns = new Set(rows.map(turnOf).filter(Boolean));
  const dates = rows.map(age).sort();
  return { n: rows.length, turns: turns.size, unknown: rows.filter((r) => !turnOf(r)).length, first: dates[0], last: dates[dates.length - 1] };
};

const rows = snapshot.map((family) => ({ ...family, ...evidence(family) }));
const priors = rows.filter((r) => r.kind === 'prior');
const restated = priors.filter((r) => r.turns >= 2);
const once = priors.filter((r) => r.turns === 1);
const untraced = priors.filter((r) => r.turns === 0);

if (process.argv.includes('--md')) {
  console.log('| 族 | 成员 | 证据轮次 | 倾向 |');
  console.log('|---|---|---|---|');
  for (const r of priors.sort((a, b) => b.n - a.n || a.key.localeCompare(b.key))) {
    console.log(`| ${r.key} | ${r.n} | ${r.turns}${r.unknown ? ` (+${r.unknown} 无轮次)` : ''} | ${r.statement} |`);
  }
  process.exit(0);
}

const rulesTotal = rules.length;
console.log(`规则：${rulesTotal} 条 · 轮次来源 ${new Set(rules.map(turnOf).filter(Boolean)).size} 个 · 无轮次 ${rules.filter((r) => !turnOf(r)).length} 条`);
console.log(`\n分类（${snapshot.length} 族）`);
for (const [kind, v] of [...byKind].sort((a, b) => b[1].rules - a[1].rules)) {
  console.log(`  ${kind.padEnd(7)} ${String(v.families).padStart(3)} 族 / ${String(v.rules).padStart(3)} 条`);
}
const nonPrior = rulesTotal - priors.reduce((s, r) => s + r.n, 0);
console.log(`\n先验层候选：${priors.length} 族 / ${priors.reduce((s, r) => s + r.n, 0)} 条（合并比 ${(priors.reduce((s, r) => s + r.n, 0) / priors.length).toFixed(1)} : 1）`);
console.log(`  复现 >=2 轮：${restated.length} 族 / ${restated.reduce((s, r) => s + r.n, 0)} 条`);
console.log(`  复现  =1 轮：${once.length} 族 / ${once.reduce((s, r) => s + r.n, 0)} 条`);
console.log(`  无轮次来源：${untraced.length} 族 / ${untraced.reduce((s, r) => s + r.n, 0)} 条`);
console.log(`  非先验：${nonPrior} 条（本地约束 / 一次性记录 / 无处方）`);

const chars = priors.reduce((s, r) => s + r.statement.length + 12, 0);
const fullChars = rules.reduce((s, r) => s + r.statement.length, 0);
console.log(`\n成本（按 1.6 字/token 估）`);
console.log(`  先验层 ${priors.length} 行：${chars} 字 ≈ ${Math.round(chars / 1.6)} token/轮`);
console.log(`  现有目录 20 行实测 917 字 ≈ 573 token/轮`);
console.log(`  201 条全文：${fullChars} 字 ≈ ${Math.round(fullChars / 1.6)} token（全量注入不可行）`);
db.close();
