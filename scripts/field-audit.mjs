#!/usr/bin/env node
/**
 * 字段审计：看每个字段"声明了没有、写了没有、读了没有、真机上有没有分布"。
 *
 * 为什么需要它：soulkernel 留下的字段会以"类型里有、机制不存在"的形式活着
 * （visibility 恒为 private、archived 零写入、validFrom 只写不读）。
 * 逐个 grep 发现太慢，而且容易漏。
 *
 * 用法：node scripts/field-audit.mjs [--db <path>]
 * 只读：只 SELECT，不写库；没有库时只做静态分析。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbArg = process.argv.indexOf('--db');
const DB =
  dbArg > -1 ? process.argv[dbArg + 1] : join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.soulbridge/soul.db');

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n.endsWith('.ts') ? [p] : [];
  });
const srcText = walk(join(ROOT, 'packages/core/src'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function staticStats(field) {
  const refs = (srcText.match(new RegExp(`\\b${field}\\b`, 'g')) ?? []).length;
  const assigns = (srcText.match(new RegExp(`\\b${field}\\s*[:=](?!=)`, 'g')) ?? []).length;
  return { refs, assigns };
}

let db = null;
try {
  const { DatabaseSync } = await import('node:sqlite');
  if (existsSync(DB)) db = new DatabaseSync(DB, { readOnly: true });
} catch {
  db = null;
}

function liveStats(table, column) {
  if (!db) return null;
  try {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    if (total === 0) return { total: 0, nulls: 0, distinct: 0, sample: [] };
    const nulls = db
      .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" IS NULL`)
      .get().n;
    const rows = db
      .prepare(`SELECT "${column}" AS v, COUNT(*) AS n FROM "${table}" GROUP BY 1 ORDER BY n DESC LIMIT 4`)
      .all();
    return { total, nulls, distinct: rows.length, sample: rows.map((r) => `${r.v}:${r.n}`) };
  } catch {
    return null;
  }
}

const verdict = (s, live) => {
  if (live && live.total === 0) return '表为空';
  if (live && live.nulls === live.total) return '全 NULL（无写入）';
  if (live && live.distinct === 1) return '常量（无区分度）';
  if (s.refs <= 1) return '只有类型声明';
  if (s.assigns === 0) return '只读不写';
  return '在用';
};

const TABLES = db
  ? db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name)
  : ['memories', 'emotions', 'affect_samples', 'corrections'];

const rows = [];
for (const table of TABLES) {
  let columns = [];
  if (db) {
    columns = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  }
  for (const column of columns) {
    const field = camel(column);
    const s = staticStats(field || column);
    const live = liveStats(table, column);
    rows.push({ table, column, field, ...s, live, verdict: verdict(s, live) });
  }
}

console.log(`库：${db ? DB : '（未找到，仅静态分析）'}\n`);
let current = '';
for (const r of rows) {
  if (r.table !== current) {
    current = r.table;
    console.log(`\n## ${current}`);
    console.log('字段'.padEnd(22) + '引用  赋值  真机'.padEnd(30) + '判定');
  }
  const live = r.live
    ? `n=${r.live.total} null=${r.live.nulls} distinct=${r.live.distinct} ${r.live.sample.join(' ')}`
    : '—';
  console.log(
    r.column.padEnd(22) +
      String(r.refs).padStart(4) +
      String(r.assigns).padStart(6) +
      '  ' +
      live.padEnd(38) +
      r.verdict,
  );
}

console.log('\n## 类型枚举（无表可查，只看引用）');
for (const t of ['semantic', 'episodic', 'relationship', 'archived', 'shared', 'private']) {
  console.log(`  '${t}'  ${(srcText.match(new RegExp(`'${t}'`, 'g')) ?? []).length} 处`);
}
