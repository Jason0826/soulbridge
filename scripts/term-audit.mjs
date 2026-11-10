/**
 * 术语体检：把「声明」和「库里实际出现」摆在一起，看它们有没有分叉。
 *
 * 谁读：改 `packages/core/src/config/*` 的值域之前；接手第一周。
 * 什么时候读：`health-check` 报了术语相关 WARN，或者你怀疑"同一个词在两个地方意思不一样"。
 *
 * 只做对照，不做判断：
 *   声明 = config/ 里的 `export const XXX = [...]`
 *   实际 = soul.db 各列的 distinct 值
 * 退出码：1 = 数据库里出现了未声明的值（真分叉）；0 = 只有数量级上的观察。
 *
 * 用法：node scripts/term-audit.mjs [--db <path>] [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dbArg = args.includes('--db') ? args[args.indexOf('--db') + 1] : null;
const asJson = args.includes('--json');
const dbPath = dbArg ?? path.join(os.homedir(), '.soulbridge', 'soul.db');

const configDir = path.join(process.cwd(), 'packages', 'core', 'src', 'config');
const declared = new Map(); // NAME -> string[]

for (const file of fs.readdirSync(configDir).filter((f) => f.endsWith('.ts'))) {
  const src = fs.readFileSync(path.join(configDir, file), 'utf8');
  const re = /export const ([A-Z][A-Z0-9_]+)\s*(?::\s*[^=]+)?=\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const values = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    if (values.length > 0) declared.set(m[1], values);
  }
}

if (!fs.existsSync(dbPath)) {
  console.error(`找不到库：${dbPath}（用 --db 指定）`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const distinct = (sql) => db.prepare(sql).all().map((r) => r.v).filter((v) => v !== null);

const actual = {
  role: distinct(`select distinct role v from facts`),
  status: distinct(`select distinct status v from facts`),
  holder_kind: distinct(`
    select distinct case
      when holder in ('world','self') then holder
      when holder like 'en\\_%' escape '\\' then 'entity-id（URL 编码）'
      else '其他：' || holder end v
    from facts`),
};

const report = {
  db: dbPath,
  declared: Object.fromEntries(declared),
  actual,
  drift: {},
  observations: [],
};

const cmp = (label, declaredName, actualValues) => {
  const set = declared.get(declaredName);
  if (!set) return;
  const miss = actualValues.filter((v) => !set.includes(v));
  const unused = set.filter((v) => !actualValues.includes(v));
  if (miss.length) report.drift[label] = { 声明里没有: miss };
  if (unused.length) report.observations.push(`${label}：声明了但库里 0 条 → ${unused.join(', ')}`);
};

cmp('role', 'FACT_ROLES', actual.role);
cmp('status', 'FACT_STATES', actual.status);
cmp('holder', 'HOLDER_WORDS', actual.holder_kind);

const typeNames = db.prepare(`
  select type_name v, count(*) n from facts where superseded_by is null
  group by type_name order by n desc`).all();
const singles = typeNames.filter((r) => r.n === 1).length;
report.observations.push(`type_name：${typeNames.length} 个不同值，其中 ${singles} 个只出现 1 次`);

const straddle = db.prepare(`
  select type_name v, count(distinct role) k from facts where superseded_by is null
  group by type_name having k > 1 order by k desc`).all();
if (straddle.length) report.observations.push(`type_name：${straddle.length} 个值横跨多个 role → ${straddle.slice(0, 8).map((r) => r.v).join(' · ')}`);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`库：${report.db}\n`);
  console.log('声明（config/ 里的值域）');
  for (const [k, v] of Object.entries(report.declared)) console.log(`  ${k}: ${v.join(' | ')}`);
  console.log('\n实际（库里的 distinct）');
  for (const [k, v] of Object.entries(actual)) console.log(`  ${k}: ${v.join(' | ')}`);
  console.log('\n分叉');
  if (Object.keys(report.drift).length === 0) console.log('  无');
  for (const [k, v] of Object.entries(report.drift)) console.log(`  ${k}: ${JSON.stringify(v)}`);
  console.log('\n观察');
  for (const o of report.observations) console.log(`  · ${o}`);
}

process.exit(Object.keys(report.drift).length > 0 ? 1 : 0);
