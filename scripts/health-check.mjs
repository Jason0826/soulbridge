#!/usr/bin/env node
/**
 * 全局体检：每次改动之后跑一遍，看整体有没有散落。
 *
 * 为什么是脚本而不是一条约定：规则会被忘记，脚本不会。
 * 它检查四件事——规模、测试、声明与实现是否一致、工作区状态。
 *
 * 用法：node scripts/health-check.mjs [--no-tests]
 * 退出码：有 FAIL 时为 1，只有 WARN 时为 0。
 *
 * ⚠️ 只适用于本仓库的目录结构与文档约定（换仓库会 FAIL，不会假绿）。
 * 可迁移的是检查项清单，不是这个文件——见 ADR 0019 关于"经验 vs 工具"的边界。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const add = (level, area, message, detail) => results.push({ level, area, message, detail });

// ---------- 1. 规模 ----------
// 3089 on 2026-10-31: turn_pairs landed while the old memories path still exists.
// Removing memories is the point of the rewrite; this must come back under 3000
// then. Do not raise it a second time without deleting something else.
const CORE_BUDGET = 3200;
const FILE_BUDGET = 300;

function walk(dir, ext) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

const srcDir = join(ROOT, 'packages/core/src');
const srcFiles = walk(srcDir, '.ts');
const srcLines = srcFiles.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);
// 目录不存在时必须报错，不能报 PASS：0 行会让别的仓库"假绿"，比崩掉更危险。
if (srcFiles.length === 0) {
  add('FAIL', '规模', `找不到 ${relative(ROOT, srcDir)}/*.ts —— 这个脚本只适用于本仓库结构`);
} else if (srcLines > CORE_BUDGET) {
  add('FAIL', '规模', `core 源码 ${srcLines} 行，超出预算 ${CORE_BUDGET}`);
} else {
  add('PASS', '规模', `core 源码 ${srcLines}/${CORE_BUDGET} 行（${srcFiles.length} 个文件）`);
}

const bigFiles = srcFiles
  .map((f) => ({ f, n: readFileSync(f, 'utf8').split('\n').length }))
  .filter((x) => x.n > FILE_BUDGET);
for (const { f, n } of bigFiles) {
  add('WARN', '规模', `${relative(ROOT, f)} 有 ${n} 行，超过单文件预算 ${FILE_BUDGET}`);
}

const docFiles = walk(join(ROOT, 'docs'), '.md');
add('PASS', '规模', `文档 ${docFiles.length} 个 / ${docFiles.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0)} 行`);
if (!existsSync(join(ROOT, 'docs/README.md'))) {
  add('WARN', '文档', `docs/ 没有 README.md 索引（${docFiles.length} 个文件，新人只能靠 handoff 猜）`);
}

// ---------- 2. 测试 ----------
if (!process.argv.includes('--no-tests')) {
  const testDir = join(ROOT, 'packages/core/test');
  const testFiles = walk(testDir, '.test.ts');
  if (testFiles.length === 0) {
    add('FAIL', '测试', `找不到 ${relative(ROOT, testDir)}/*.test.ts —— 无法验证任何东西`);
  } else {
    const failed = [];
    for (const f of testFiles) {
      const r = spawnSync(process.execPath, [f], { cwd: ROOT, stdio: 'ignore' });
      if (r.status !== 0) failed.push(relative(ROOT, f));
    }
    if (failed.length > 0) {
      add('FAIL', '测试', `${failed.length}/${testFiles.length} 个测试文件失败`, failed.join(', '));
    } else {
      add('PASS', '测试', `${testFiles.length} 个测试文件全部通过`);
    }
  }
}

// ---------- 3. 声明 vs 实现 ----------
const srcText = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * 只在类型定义 / 映射 / upsert 回显里出现，没有任何业务写入点的字段 = 声明超前于能力。
 * 逐条看赋值的右侧：`excluded.x` 是 upsert 回显，`?` 是占位符，都不算更新路径。
 */
function assignmentsOf(name) {
  const out = [];
  // `=(?!=)` 排除比较（`x == null`）与严格比较，只看真正的赋值。
  for (const m of srcText.matchAll(new RegExp(`\\b${name}\\s*=(?!=)\\s*([^,;\\n]+)`, 'g'))) {
    const rhs = m[1].trim();
    if (rhs.startsWith('excluded.')) continue;
    if (rhs === '?' || rhs === 'null') continue;
    out.push(`${m[0].slice(0, 60)}`);
  }
  return out;
}

const declaredOnly = [
  { field: 'vividness', camel: 'vividness', mint: '创建时定值，之后没有任何路径改变它' },
  { field: 'validUntil', camel: 'valid_until', mint: '只有类型与映射，从不生成过期时间' },
  { field: 'supersededBy', camel: 'superseded_by', mint: '只有类型与映射，没有业务写入点' },
];

for (const { field, camel, mint } of declaredOnly) {
  const writes = [...assignmentsOf(field), ...assignmentsOf(camel)];
  if (writes.length > 0) add('PASS', '一致性', `\`${field}\` 有业务写入：${writes[0]}`);
  else add('WARN', '一致性', `\`${field}\` 没有业务写入 —— ${mint}`);
}

/** 公开 API 的包装不算调用者：业务里没人调 = 冲突取代只是手动能力。 */
const supersedeCalls = [...srcText.matchAll(/\.supersede\(/g)].filter(
  (m) => !/this\.store\.supersede\($/.test(srcText.slice(Math.max(0, m.index - 20), m.index + m[0].length)),
).length;
if (supersedeCalls === 0) {
  add('WARN', '一致性', '`supersede()` 有实现但没有业务调用者 —— 冲突取代是手动 API，不是机制');
} else {
  add('PASS', '一致性', `\`supersede()\` 有 ${supersedeCalls} 处业务调用`);
}

// ---------- 4. 文档自身的结构 ----------
const roadmapPath = join(ROOT, 'docs/roadmap.md');
if (!existsSync(roadmapPath)) {
  add('FAIL', '文档', '找不到 docs/roadmap.md');
} else {
  const roadmap = readFileSync(roadmapPath, 'utf8');
  const ids = [...roadmap.matchAll(/^### (N\d+)\./gm)].map((m) => m[1]);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (ids.length === 0) {
    add('WARN', '文档', 'roadmap 里没有 `### N数字.` 形式的编号项 —— 编号检查无从执行');
  } else if (dupIds.length > 0) {
    add('FAIL', '文档', `roadmap 编号重复：${[...new Set(dupIds)].join(', ')}`);
  } else {
    add('PASS', '文档', `roadmap 编号无重复（${ids.length} 项）`);
  }
}

// 版本表：handoff 里写的版本应该和 package.json 一致
const pkgPath = join(ROOT, 'package.json');
const handoffPath = join(ROOT, 'docs/handoff.md');
if (!existsSync(pkgPath) || !existsSync(handoffPath)) {
  add('WARN', '文档', '缺少 package.json 或 docs/handoff.md —— 跳过版本一致性检查');
} else {
  const coreVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  const handoffCore = /core \| ([0-9.]+)/.exec(readFileSync(handoffPath, 'utf8'))?.[1];
  if (!handoffCore) {
    add('WARN', '文档', 'handoff 里找不到 `core | x.y.z` 版本表 —— 跳过');
  } else if (handoffCore !== coreVersion) {
    add('FAIL', '文档', `handoff 写 core ${handoffCore}，package.json 是 ${coreVersion}`);
  } else {
    add('PASS', '文档', `版本表与 package.json 一致（core ${coreVersion}）`);
  }
}

// ---------- 4.5 spec 字段说明覆盖 ----------
// 规则：代码里出现一列，spec/storage.v0.md 里必须有一句说明。
const sqliteSrc = readFileSync(join(ROOT, 'packages/core/src/sqlite.ts'), 'utf8');
const columns = new Set();
// 基础表：按逗号切分括号内的定义（同一行多个列也能拆开）
for (const m of sqliteSrc.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\);/g)) {
  for (const part of m[2].split(',')) {
    const c = /^\s*([a-z][a-z0-9_]*)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)/i.exec(part.replace(/\n/g, ' '));
    if (c) columns.add(c[1]);
  }
}
// 迁移增列：ensureColumn(db, 'table', 'column', ...) 与 ALTER TABLE ... ADD COLUMN 两种写法
for (const m of sqliteSrc.matchAll(/ensureColumn\([^,]+,\s*'[^']+',\s*'([a-z][a-z0-9_]*)'/g)) columns.add(m[1]);
for (const m of sqliteSrc.matchAll(/ADD COLUMN\s+([a-z][a-z0-9_]*)/gi)) columns.add(m[1]);

const storageSpecPath = join(ROOT, 'docs/spec/storage.v0.md');
if (!existsSync(storageSpecPath)) {
  add('WARN', '文档', '缺少 spec/storage.v0.md，跳过字段说明检查');
} else if (columns.size === 0) {
  add('WARN', '文档', '没能从 sqlite.ts 解析出任何列 —— 检查规则可能已失效');
} else {
  const spec = readFileSync(storageSpecPath, 'utf8');
  const section = spec.slice(Math.max(0, spec.indexOf('## 7.')));
  const documented = new Set();
  for (const line of section.split('\n')) {
    const cell = /^\|\s*([^|]*)\|/.exec(line);
    if (!cell) continue;
    for (const m of cell[1].matchAll(/`([a-z][a-z0-9_]*)`/g)) documented.add(m[1]);
  }
  const missing = [...columns].filter((c) => !documented.has(c));
  if (missing.length > 0) {
    add('FAIL', '文档', `spec 缺 ${missing.length}/${columns.size} 列的说明`, missing.join(', '));
  } else {
    add('PASS', '文档', `spec 覆盖全部 ${columns.size} 列`);
  }
}

// ---------- 4.6 文档链接 / 索引 / 时间炸弹 ----------
// 文档不会自己红，所以要给它制造失败点：断链、没进索引、测试里的固定日期过期。
const docsRoot = join(ROOT, 'docs');
const docFiles2 = walk(docsRoot, '.md');
const missingLinks = [];
const linksByFile = new Map();

for (const file of docFiles2) {
  // 先剥掉代码块，里面的 [x](y) 不是链接
  const raw = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  const targets = [];
  for (const m of raw.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = m[1].trim();
    if (!rawTarget || /^(https?:|mailto:)/i.test(rawTarget)) continue;
    let target = rawTarget.split('#')[0].split('?')[0];
    if (!target) continue; // 纯锚点
    try {
      target = decodeURI(target);
    } catch {
      /* 保持原样 */
    }
    const abs = resolve(dirname(file), target);
    targets.push(abs);
    if (!existsSync(abs)) missingLinks.push(`${relative(ROOT, file)} → ${rawTarget}`);
  }
  linksByFile.set(file, targets);
}

if (missingLinks.length > 0) {
  add('FAIL', '文档', `${missingLinks.length} 个断链`, missingLinks.slice(0, 8).join('; '));
} else {
  add('PASS', '文档', `文档内链全部有效（${docFiles2.length} 份）`);
}

// 索引覆盖：docs/ 顶层的文档必须能从 README 点到
const readmePath = join(docsRoot, 'README.md');
if (!existsSync(readmePath)) {
  add('WARN', '文档', '缺少 docs/README.md，无法检查索引覆盖');
} else {
  const indexed = new Set(linksByFile.get(readmePath) ?? []);
  const topLevelDocs = docFiles2.filter((f) => dirname(f) === docsRoot && basename(f) !== 'README.md');
  const unindexed = topLevelDocs.filter((f) => !indexed.has(f)).map((f) => basename(f));
  if (unindexed.length > 0) add('WARN', '文档', `顶层文档未进 README 索引：${unindexed.join(', ')}`);
  else add('PASS', '文档', `顶层文档均已进索引（${topLevelDocs.length} 份）`);
}

// 时间炸弹：测试里写死的日期，超过 30 天就会变成"过去"
const FIXTURE_MAX_AGE_MS = 30 * 86_400_000;
const staleFixtures = [];
for (const f of walk(join(ROOT, 'packages/core/test'), '.test.ts')) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/Date\.parse\('(\d{4}-\d{2}-\d{2})/g)) {
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && Date.now() - at > FIXTURE_MAX_AGE_MS) {
      staleFixtures.push(`${relative(ROOT, f)}: ${m[1]}`);
    }
  }
}
if (staleFixtures.length > 0) {
  add('WARN', '测试', `${staleFixtures.length} 处写死的日期已超过 30 天，确认是否仍在断言"未来"`, staleFixtures.join('; '));
} else {
  add('PASS', '测试', '测试里没有过期 30 天以上的固定日期');
}

// ---------- 5. 工作区 ----------
const git = spawnSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' });
if (git.status === 0) {
  const lines = git.stdout.trim().split('\n').filter(Boolean);
  if (lines.length === 0) add('PASS', '工作区', '干净');
  else {
    const untrackedDocs = lines.filter((l) => l.startsWith('??') && l.includes('.md')).length;
    add('WARN', '工作区', `${lines.length} 项未提交${untrackedDocs ? `（其中 ${untrackedDocs} 个新文档）` : ''}`, lines.join('; '));
  }
}

// 代码/文档同步：改了 packages/ 却没改 docs/ 的 commit。
// 2026-10-31 加：连续两天出现"代码改完、文档还停在旧结论"，靠记性防不住。
// WARN 而非 FAIL：纯重构确实可以不碰文档，但漂移必须可见。
function runGit(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

const LOG_DEPTH = 10;
const logOut = runGit(['log', `-${LOG_DEPTH}`, '--name-only', '--pretty=format:%x01']);
if (logOut) {
  const commits = [];
  let cur = null;
  for (const line of logOut.split('\n')) {
    if (line.includes('\x01')) {
      cur = [];
      commits.push(cur);
    } else if (cur && line.trim()) {
      cur.push(line.trim());
    }
  }
  const drifted = commits.filter((files) => {
    const hasCode = files.some((f) => f.startsWith('packages/'));
    const hasDocs = files.some((f) => f.startsWith('docs/'));
    return hasCode && !hasDocs;
  });
  if (drifted.length > 0) {
    add(
      'WARN',
      '同步',
      `最近 ${commits.length} 个 commit 里有 ${drifted.length} 个改了 packages/ 但没改 docs/`,
      '文档和代码放同一个 commit，别事后补',
    );
  } else {
    add('PASS', '同步', `最近 ${commits.length} 个 commit 的代码与文档改动同步`);
  }
}

// 提交前就能看到：工作区里代码动了、文档没动
if (git.status === 0) {
  const dirty = git.stdout.trim().split('\n').filter(Boolean);
  const dirtyCode = dirty.some((l) => l.includes('packages/'));
  const dirtyDocs = dirty.some((l) => l.includes('docs/'));
  if (dirtyCode && !dirtyDocs) {
    add('WARN', '同步', '工作区里 packages/ 有改动，但 docs/ 没有——是不是该更新的文档还没更新？');
  }
}

// ---------- 输出 ----------
const order = { FAIL: 0, WARN: 1, PASS: 2 };
const icon = { FAIL: '✗', WARN: '!', PASS: '✓' };
for (const r of results.sort((a, b) => order[a.level] - order[b.level])) {
  console.log(`${icon[r.level]} [${r.area}] ${r.message}`);
  if (r.detail) console.log(`    ${r.detail}`);
}
const fails = results.filter((r) => r.level === 'FAIL').length;
const warns = results.filter((r) => r.level === 'WARN').length;
console.log(`\n合计：${fails} FAIL / ${warns} WARN / ${results.length - fails - warns} PASS`);
process.exit(fails > 0 ? 1 : 0);
