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
import { execSync } from 'node:child_process';
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

/* 2. Duplicated plumbing: each queue re-implements the same file handling. */
console.log('\nqueues (plugin)');
try {
  const plugin = readFileSync(join(PLUGIN, 'index.js'), 'utf8');
  const queues = [...plugin.matchAll(/const read(\w+)Queue = \(\) => readQueueFile/g)].map((m) => m[1]);
  const sharedIO = /function readQueueFile\(/.test(plugin) && /function writeQueueFile\(/.test(plugin);
  ok(`队列 ${queues.length} 套: ${queues.join(', ')}`);
  if (!sharedIO) note('队列的文件读写各写各的，应共用一套 IO');
  else if (queues.length < 2) note('队列 IO 已共用，但套数对不上（检查是否漏了某条队列）');
  else ok(`共用 1 套 IO，${queues.length} 套各自保留语义（cap/keep/key）`);
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

/* 6. Docs that lag the code. The rule "a change updates its docs" was a promise;
   this is the check. state.md carries its own "最后核对" timestamp, and the code
   carries its last commit — if the code is newer, the doc is stale. */
console.log('\ndocs');
function lastCommit(repo, paths) {
  try {
    return execSync(`git log -1 --format=%cI -- ${paths}`, { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
try {
  const stateDoc = readFileSync(join(ROOT, 'docs', 'state.md'), 'utf8');
  const stamped = /最后核对：\*\*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\*\*/.exec(stateDoc);
  if (!stamped) {
    note('state.md 没有 `最后核对：**YYYY-MM-DD HH:MM**` 时间戳，无法判断是否落后');
  } else {
    const docAt = Date.parse(`${stamped[1]}T${stamped[2]}:00`);
    const newest = [
      // Only files that change behaviour: a docs-only commit must not make the doc
      // look stale relative to itself.
      ['core', lastCommit(ROOT, 'packages')],
      ['plugin', lastCommit(PLUGIN, 'index.js')],
    ]
      .filter(([, at]) => at)
      .map(([name, at]) => [name, Date.parse(at)])
      .sort((a, b) => b[1] - a[1])[0];
    if (!newest) note('取不到代码最后提交时间，跳过文档新鲜度');
    else if (newest[1] > docAt + 60_000) {
      note(`state.md 核对于 ${stamped[1]} ${stamped[2]}，但 ${newest[0]} 代码在 ${new Date(newest[1]).toISOString()} 之后还改过 —— 文档落后于代码`);
    } else {
      ok(`state.md 与代码同步（核对 ${stamped[1]} ${stamped[2]}，代码最后提交 ≤ 核对时间）`);
    }
  }
} catch {
  note('读不到 docs/state.md，跳过文档新鲜度');
}

console.log(`\n${warn.length} 处需要整体判断，其余是常态。`);
process.exitCode = 0;
