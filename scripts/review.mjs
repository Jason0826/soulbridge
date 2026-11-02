/**
 * Whole-system review, one command.
 *
 * The rule is "look at the whole thing before and after every change". That was not
 * followed for eight changes in a row because the review was a habit with nothing to
 * run it on: every check was local (tests red/green, one log line, one row count).
 *
 * This script is the part that can be mechanical: it reports the numbers that drift
 * silently — duplicated plumbing, tables nobody writes, modules nobody imports,
 * vocabulary that keeps growing, files that keep growing. It does not judge design;
 * it stops the reviewer from being surprised.
 *
 *   node scripts/review.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CORE_SRC = join(ROOT, 'packages', 'core', 'src');
const CORE_TESTS = join(ROOT, 'packages', 'core', 'test');
const PLUGIN = 'D:/git-workspace/repos/dsh-plugin-soulbridge';
const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');

const warn = [];
const note = (message) => {
  warn.push(message);
  console.log(`  WARN  ${message}`);
};
const ok = (message) => console.log(`  ok    ${message}`);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/* 1. Tables: a table with no writer or no reader is drift. */
console.log('\ntables');
const sqlite = readFileSync(join(CORE_SRC, 'sqlite.ts'), 'utf8');
const tables = [...sqlite.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
for (const table of tables) {
  const writes = [...sqlite.matchAll(new RegExp(`(INSERT(?: OR \\w+)? INTO ${table}\\b|UPDATE ${table}\\b)`, 'g'))].length;
  const reads = [...sqlite.matchAll(new RegExp(`FROM ${table}\\b`, 'g'))].length;
  if (writes === 0) note(`${table}: 有表无写者（冻结或漏了写入）`);
  else if (reads === 0) note(`${table}: 有写无读（只进不出）`);
  else ok(`${table}: 写 ${writes} / 读 ${reads}`);
}

/* 2. Duplicated plumbing: each queue re-implements the same five functions. */
console.log('\nqueues (plugin)');
try {
  const plugin = readFileSync(join(PLUGIN, 'index.js'), 'utf8');
  const queues = [...plugin.matchAll(/function read(\w+)Queue\(/g)].map((m) => m[1]);
  ok(`队列实现 ${queues.length} 套: ${queues.join(', ')}`);
  if (queues.length > 1) note(`${queues.length} 套队列代码形状相同，应合并为 1 套`);
  const lines = plugin.split('\n').length;
  if (lines > 1200) note(`插件单文件 ${lines} 行（>1200 行时职责已不可读）`);
  else ok(`插件单文件 ${lines} 行`);
} catch {
  note('插件仓库不可读，跳过');
}

/* 3. Prompt / parser surface: every added judgment adds one of each. */
console.log('\nprompt surface (core)');
const coreFiles = walk(CORE_SRC);
const countExports = (pattern) =>
  coreFiles.reduce((sum, file) => sum + (readFileSync(file, 'utf8').match(pattern) ?? []).length, 0);
const renders = countExports(/^export function render\w+/gm);
const parsers = countExports(/^export function parse\w+/gm);
ok(`render ${renders} 个 / parse ${parsers} 个`);
if (renders > 4) note(`${renders} 个提示词模板，每加一个判断要同步加闸门与测试`);

/* 4. Modules nobody imports: exported surface that only tests touch. */
console.log('\nmodules');
for (const file of coreFiles) {
  const name = relative(CORE_SRC, file).replace(/\\/g, '/');
  const base = name.split('/').pop().replace(/\.ts$/, '');
  // Entries are imported by people, not by other modules: skip them by full path.
  if (['index.ts', 'types.ts', 'store.ts', 'affect/index.ts'].includes(name)) continue;
  const importers = coreFiles.filter((other) => {
    if (other === file) return false;
    return new RegExp(`from '[^']*${base}\\.ts'`).test(readFileSync(other, 'utf8'));
  });
  const tested = walk(CORE_TESTS).some((test) => new RegExp(`${base}\\.ts`).test(readFileSync(test, 'utf8')));
  if (importers.length === 0) note(`${name}: 无源码引用${tested ? '（仅测试）' : '（完全未用）'}`);
}
ok(`${coreFiles.length} 个源文件已扫描`);

/* 5. Vocabulary: type_name is supposed to describe, not to classify. */
console.log('\nvocabulary (live db)');
try {
  const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
  const rows = db
    .prepare("SELECT type_name, COUNT(*) n FROM facts WHERE status != 'superseded' GROUP BY type_name ORDER BY n DESC")
    .all();
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  ok(`${rows.length} 个标签 / ${total} 条事实: ${rows.slice(0, 8).map((r) => `${r.type_name}${r.n}`).join(' ')}`);
  const singles = rows.filter((row) => row.n === 1).length;
  if (singles > rows.length / 3) note(`${singles}/${rows.length} 个标签只用过一次（碎片化）`);
  const lifecycle = db
    .prepare('SELECT status, COUNT(*) n FROM facts GROUP BY status')
    .all();
  ok(`状态分布: ${lifecycle.map((r) => `${r.status}=${r.n}`).join(' ')}`);
  db.close();
} catch {
  note('数据库不可读，跳过');
}

console.log(`\n${warn.length} 处需要整体判断，其余是常态。`);
process.exitCode = 0;
