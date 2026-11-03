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
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const add = (level, area, message, detail) => results.push({ level, area, message, detail });

// ---------- 1. 规模（棘轮预算） ----------
// 原来的 3200 行 / 单文件 300 行是拍脑袋定的，早就被自己的设计打破——问题不在
// 数字太小，在于"绝对上限"这种形式：它只能靠重新拍一个更大的数字来续命。
// 现在改成棘轮：scripts/budget.json 记实测值，只能往下调；超了就是 FAIL，
// 要加东西先删同等规模的东西，然后 --update-budget。
const BUDGET_PATH = join(ROOT, 'scripts/budget.json');
const measuredFiles = {};
for (const file of walk(join(ROOT, 'packages/core/src'), '.ts')) {
  const name = relative(join(ROOT, 'packages/core/src'), file).replace(/\\/g, '/').split('/').pop();
  measuredFiles[name] = readFileSync(file, 'utf8').split('\n').length;
}

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
const PLUGIN_ENTRY = 'D:/git-workspace/repos/dsh-plugin-soulbridge/index.js';
const pluginLines = existsSync(PLUGIN_ENTRY) ? readFileSync(PLUGIN_ENTRY, 'utf8').split('\n').length : 0;

// history 是账的理由：--update-budget 只改数字，不许把"为什么涨"冲掉。
const previousBudget = existsSync(BUDGET_PATH) ? JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) : null;
const measuredBudget = {
  date: new Date().toISOString().slice(0, 10),
  note: '棘轮预算：数字是实测值，只能往下调，不能往上调。要加功能导致超限时，先删掉同等规模的东西，再跑 --update-budget。',
  history: previousBudget?.history ?? [],
  coreLines: srcLines,
  pluginLines,
  files: measuredFiles,
};

if (process.argv.includes('--update-budget')) {
  writeFileSync(BUDGET_PATH, `${JSON.stringify(measuredBudget, null, 2)}\n`, 'utf8');
  add('PASS', '规模', `预算已按实测重写：core ${srcLines} 行 / 插件 ${pluginLines} 行`);
} else if (srcFiles.length === 0) {
  // 目录不存在时必须报错，不能报 PASS：0 行会让别的仓库"假绿"，比崩掉更危险。
  add('FAIL', '规模', `找不到 ${relative(ROOT, srcDir)}/*.ts —— 这个脚本只适用于本仓库结构`);
} else if (!existsSync(BUDGET_PATH)) {
  add('FAIL', '规模', '缺少 scripts/budget.json —— 先跑一次 --update-budget 建立棘轮');
} else {
  const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
  const over = [];
  if (srcLines > budget.coreLines) over.push(`core ${srcLines} > ${budget.coreLines}`);
  if (pluginLines > budget.pluginLines) over.push(`插件 ${pluginLines} > ${budget.pluginLines}`);
  for (const [name, lines] of Object.entries(measuredFiles)) {
    const allowed = budget.files?.[name];
    if (allowed !== undefined && lines > allowed) over.push(`${name} ${lines} > ${allowed}`);
  }
  if (over.length > 0) {
    add('FAIL', '规模', `超出棘轮预算（先删再加）：${over.join('；')}`);
  } else {
    add('PASS', '规模', `core ${srcLines}/${budget.coreLines} 行 · 插件 ${pluginLines}/${budget.pluginLines} 行 · ${srcFiles.length} 个文件在预算内`);
  }
  // 低于预算说明删了东西：提示把棘轮收紧，否则预算会重新变成空话。
  const slack = budget.coreLines - srcLines;
  if (slack > Math.max(50, budget.coreLines * 0.03)) {
    add('WARN', '规模', `core 比预算少 ${slack} 行 —— 跑 --update-budget 收紧棘轮`);
  }
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
  // 编号项既可以是 `### R1.` 标题，也可以是表格里的 `| **R1** |`。
  // 检查的是"编号不重复"，不是某种排版格式。
  const ids = [
    ...[...roadmap.matchAll(/^### ([A-Z]\d+)\./gm)].map((m) => m[1]),
    ...[...roadmap.matchAll(/^\| \*\*([A-Z]\d+)\*\*/gm)].map((m) => m[1]),
  ];
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (ids.length === 0) {
    add('WARN', '文档', 'roadmap 里没有 `### R1.` 或 `| **R1** |` 形式的编号项 —— 编号检查无从执行');
  } else if (dupIds.length > 0) {
    add('FAIL', '文档', `roadmap 编号重复：${[...new Set(dupIds)].join(', ')}`);
  } else {
    add('PASS', '文档', `roadmap 编号无重复（${ids.length} 项）`);
  }
}

// 版本表：state.md 里写的版本应该和 package.json 一致。
// handoff.md 已删除：两份"现状态"文档必然互相过期，只留 state.md 一份。
const pkgPath = join(ROOT, 'package.json');
const handoffPath = join(ROOT, 'docs/state.md');
if (!existsSync(pkgPath) || !existsSync(handoffPath)) {
  add('WARN', '文档', '缺少 package.json 或 docs/state.md —— 跳过版本一致性检查');
} else {
  const coreVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  const handoffCore = /core ([0-9.]+)/.exec(readFileSync(handoffPath, 'utf8'))?.[1];
  if (!handoffCore) {
    add('WARN', '文档', 'state.md 里找不到 `core x.y.z` —— 跳过');
  } else if (handoffCore !== coreVersion) {
    add('FAIL', '文档', `state.md 写 core ${handoffCore}，package.json 是 ${coreVersion}`);
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

// ---------- 4.6.1 替换事故的痕迹 ----------
// 两次真实事故：把 `` `n `` 当成换行写进了文档（一次让整节挤成一行，一次把 `node` 切成了 ode）。
// 这类损坏在 diff 里看着像正常修改，读起来才发现句子断了，所以单独扫一遍。
const docArtifacts = [];
for (const file of docFiles2) {
  const text = readFileSync(file, 'utf8');
  // The corruption signature is `` `n` `` (a newline written as backtick-n inside code
  // style), not any "`n" — that also matches legitimate inline code such as `node …`.
  if (text.includes('\u0060n\u0060')) docArtifacts.push(`${relative(ROOT, file)}: 含 \u0060n\u0060`);
  for (const line of text.split('\n')) {
    if (/^(ode|pm|px|ot) /.test(line)) docArtifacts.push(`${relative(ROOT, file)}: 行首残片「${line.slice(0, 20)}」`);
  }
}
if (docArtifacts.length > 0) {
  add('WARN', '文档', `${docArtifacts.length} 处替换事故痕迹（换行被写成 \u0060n / 行首残片）`, docArtifacts.slice(0, 5).join('; '));
} else {
  add('PASS', '文档', '没有替换事故痕迹（无 `` \u0060n ``、无行首残片）');
}

// ---------- 4.7 文档是否落后于代码 ----------
// "改动必须同步更新文档"以前只是口头约定。判据：state.md 自带「最后核对」时间戳，
// 代码自带最后提交时间；代码更新则文档落后。
// 只看改行为的路径（packages/ 与插件 index.js）——文档自己的提交不能把文档比旧。
const PLUGIN_REPO = 'D:/git-workspace/repos/dsh-plugin-soulbridge';
function lastCodeCommit(repo, paths) {
  const out = spawnSync('git', ['log', '-1', '--format=%cI', '--', paths], { cwd: repo, encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : '';
}
const stateDocPath = join(ROOT, 'docs/state.md');
const stamped = existsSync(stateDocPath)
  ? /最后核对：\*\*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\*\*/.exec(readFileSync(stateDocPath, 'utf8'))
  : null;
if (!stamped) {
  add('WARN', '文档', 'state.md 缺 `最后核对：**YYYY-MM-DD HH:MM**` 时间戳，无法判断是否落后于代码');
} else {
  const docAt = Date.parse(`${stamped[1]}T${stamped[2]}:00`);
  const newest = [
    ['core', lastCodeCommit(ROOT, 'packages')],
    ['plugin', lastCodeCommit(PLUGIN_REPO, 'index.js')],
  ]
    .filter(([, at]) => at)
    .map(([name, at]) => [name, Date.parse(at)])
    .filter(([, at]) => Number.isFinite(at))
    .sort((a, b) => b[1] - a[1])[0];
  if (!newest) {
    add('WARN', '文档', '取不到代码最后提交时间，跳过文档新鲜度检查');
  } else if (newest[1] > docAt + 60_000) {
    add(
      'FAIL',
      '文档',
      `state.md 核对于 ${stamped[1]} ${stamped[2]}，但 ${newest[0]} 代码在 ${new Date(newest[1]).toISOString()} 之后还改过 —— 文档落后于代码`,
    );
  } else {
    add('PASS', '文档', `state.md 与代码同步（核对 ${stamped[1]} ${stamped[2]}）`);
  }
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

// ---------- 6. 结构漂移（原 review.mjs，已合并） ----------
// 为什么在这里：检查项按"一件事一个入口"组织。文档检查、规模检查、结构漂移检查
// 都在这个脚本里；再开第二个"整体 review"脚本，只会让两处结论互相打架（已经发生过一次）。
const sqliteSrcText = readFileSync(join(ROOT, 'packages/core/src/sqlite.ts'), 'utf8');
const tableNames = [...sqliteSrcText.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const frozen = [];
for (const table of new Set(tableNames)) {
  const writes = [...sqliteSrcText.matchAll(new RegExp(`(INSERT(?: OR \\w+)? INTO ${table}\\b|UPDATE ${table}\\b)`, 'g'))].length;
  const reads = [...sqliteSrcText.matchAll(new RegExp(`FROM ${table}\\b`, 'g'))].length;
  if (writes === 0) frozen.push(`${table}(无写者)`);
  else if (reads === 0) frozen.push(`${table}(无读者)`);
}
if (frozen.length > 0) add('WARN', '结构', `表只在一边出现：${frozen.join(', ')}`);
else add('PASS', '结构', `${new Set(tableNames).size} 张表的读写都成对`);

if (existsSync(PLUGIN_ENTRY)) {
  const pluginSrc = readFileSync(PLUGIN_ENTRY, 'utf8');
  const queues = [...pluginSrc.matchAll(/const read(\w+)Queue = \(\) => readQueueFile/g)].map((m) => m[1]);
  const sharedIO = /function readQueueFile\(/.test(pluginSrc) && /function writeQueueFile\(/.test(pluginSrc);
  if (sharedIO && queues.length >= 2) add('PASS', '结构', `${queues.length} 条队列共用一套 IO（各自保留 cap/keep 语义）`);
  else add('WARN', '结构', '队列的文件读写各写各的，应共用一套 IO');
}

const renderCount = srcFiles.reduce((n, f) => n + (readFileSync(f, 'utf8').match(/^export function render\w+/gm) ?? []).length, 0);
const parseCount = srcFiles.reduce((n, f) => n + (readFileSync(f, 'utf8').match(/^export function parse\w+/gm) ?? []).length, 0);
add('PASS', '结构', `提示词 ${renderCount} 个渲染器 / ${parseCount} 个解析器`);
if (renderCount > 6) {
  add('WARN', '结构', `${renderCount} 个提示词模板：每加一个判断要同步改闸门与测试，先看能不能并进已有的`);
}

const dbFile = join(process.env.SOULBRIDGE_HOME ?? join(process.env.USERPROFILE ?? '', '.soulbridge'), 'soul.db');
if (existsSync(dbFile)) {
  try {
    const proj = createRequire(import.meta.url)('node:sqlite');
    const db = new proj.DatabaseSync(dbFile, { readOnly: true });
    const rows = db
      .prepare("SELECT type_name, COUNT(*) n FROM facts WHERE status != 'superseded' GROUP BY type_name ORDER BY n DESC")
      .all();
    const singles = rows.filter((r) => r.n === 1).length;
    db.close();
    add('PASS', '结构', `${rows.length} 个事实标签：${rows.slice(0, 6).map((r) => `${r.type_name}${r.n}`).join(' ')}`);
    if (singles > rows.length / 3) add('WARN', '结构', `${singles}/${rows.length} 个标签只用过一次（碎片化）`);
  } catch {
    add('WARN', '结构', '数据库读不了，跳过词汇统计');
  }
}

// ---------- 7. 退场检查（docs/retirements.json） ----------
// 代码审查的结论：同一件事两个表示，是这里最稳定的缺陷生成器（`operations ?? facts`
// 静默丢了一整类事实；distill 与 extract 两个开关让默认安装静默变哑）。
// 所以旧表示必须登记，并且由机器判定它有没有真的退场。
const RETIREMENTS_PATH = join(ROOT, 'docs/retirements.json');
if (!existsSync(RETIREMENTS_PATH)) {
  add('WARN', '退场', '缺少 docs/retirements.json —— 旧表示没有登记，等于没有退场检查');
} else {
  const ledger = JSON.parse(readFileSync(RETIREMENTS_PATH, 'utf8'));
  let doneOk = 0;
  let stillThere = 0;
  let pendingCount = 0;
  const debt = [];
  for (const entry of ledger.entries ?? []) {
    const check = entry.check ?? {};
    let present = true;
    if (check.kind === 'table') {
      const writers = [...sqliteSrcText.matchAll(new RegExp(`(INSERT(?: OR \\w+)? INTO ${check.name}\\b|UPDATE ${check.name}\\b)`, 'g'))].length;
      const readers = [...sqliteSrcText.matchAll(new RegExp(`FROM ${check.name}\\b`, 'g'))].length;
      present = check.expect === 'no-writer' ? writers > 0 : readers > 0;
    } else if (check.kind === 'file') {
      present = existsSync(join(ROOT, check.path));
    } else if (check.kind === 'symbol') {
      const target = check.path === 'PLUGIN' ? PLUGIN_ENTRY : join(ROOT, check.path);
      present = existsSync(target) && readFileSync(target, 'utf8').includes(check.pattern);
    }
    if (entry.status === 'done') {
      if (present) add('FAIL', '退场', `已退场的旧表示复活了：${entry.id}（${entry.old}）`);
      else doneOk += 1;
    } else {
      pendingCount += 1;
      debt.push(entry.id);
      if (!present) add('WARN', '退场', `${entry.id} 已经清干净了 —— 把 status 改成 done`);
      else stillThere += 1;
    }
  }
  if (doneOk > 0) add('PASS', '退场', `${doneOk} 项已退场且没有复活`);
  if (pendingCount > 0) add('WARN', '退场', `${stillThere}/${pendingCount} 项技术债仍在：${debt.join(', ')}`);
}

// ---------- 8. 唯一声明（docs/declarations.json） ----------
// 原则：变量、常量、名词、枚举、格式、默认值只在一处声明，其他地方只引用/渲染。
// 这一节找的是"同一批字面量还在别的文件里重复写"——改名时会漏改的那种副本。
const DECLARATIONS_PATH = join(ROOT, 'docs/declarations.json');
if (!existsSync(DECLARATIONS_PATH)) {
  add('WARN', '声明', '缺少 docs/declarations.json —— 唯一声明没有登记，等于没有检查');
} else {
  const declarations = JSON.parse(readFileSync(DECLARATIONS_PATH, 'utf8'));
  let clean = 0;
  for (const entry of declarations.entries ?? []) {
    const declaredIn = entry.declaredIn;
    const allowed = new Set([declaredIn, ...(entry.allowed ?? [])]);
    const scan = declaredIn.startsWith('D:') ? [PLUGIN_ENTRY] : srcFiles;
    const copies = scan
      .map((file) => relative(ROOT, file).replace(/\\/g, '/') && file)
      .filter((file) => existsSync(file))
      .filter((file) => {
        const rel = file.replace(/\\/g, '/').replace(`${ROOT.replace(/\\/g, '/')}/`, '');
        if (allowed.has(rel) || allowed.has(file)) return false;
        return readFileSync(file, 'utf8').includes(entry.literal);
      })
      .map((file) => file.replace(/\\/g, '/').replace(`${ROOT.replace(/\\/g, '/')}/`, '').split('/').pop());
    if (copies.length === 0) {
      clean += 1;
    } else if (entry.mode === 'fail') {
      add('FAIL', '声明', `${entry.what} 在 ${copies.length} 处重复写：${copies.join(', ')}`);
    } else {
      add('WARN', '声明', `${entry.what} 有 ${copies.length} 处副本：${copies.join(', ')} —— 应改成引用唯一声明`);
    }
  }
  if (clean > 0) add('PASS', '声明', `${clean} 项只有一处声明`);
}

// ---------- 9. config 只放定义（代码只做解码） ----------
// 约定：packages/core/src/config/ 下的文件只能有数据和类型——不能有函数、分支、循环。
// 定义集中到 config，解码（渲染、校验、SQL 绑定）留在代码里；这条检查防止
// "顺手在配置里写个 helper"——那会让定义文件变成第二个逻辑层。
const CONFIG_DIR = join(ROOT, 'packages/core/src/config');
if (!existsSync(CONFIG_DIR)) {
  add('WARN', '配置', '没有 packages/core/src/config/ —— 定义还散在代码里');
} else {
  const configFiles = walk(CONFIG_DIR, '.ts');
  const offenders = [];
  for (const file of configFiles) {
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    if (/\bfunction\b|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\bswitch\s*\(|\breturn\b/.test(text)) {
      offenders.push(relative(ROOT, file));
    }
  }
  if (offenders.length > 0) {
    add('FAIL', '配置', `config 里出现逻辑（只能有数据和类型）：${offenders.join(', ')}`);
  } else {
    add('PASS', '配置', `${configFiles.length} 个定义文件只有数据，解码在代码里`);
  }
}

// ---------- 10. 代码质量（docs/code-quality.md 里能机械查的部分） ----------
// 只查"判定明确"的规则。品味、设计、耦合这些留给人审清单——假装机器能全查，
// 只会让人相信一个假的绿灯。
const QUALITY_LIMITS = { functionLines: 60, params: 4 };
const noDoc = [];
const tooLong = [];
const manyParams = [];
const anyTypes = [];
const consoleLogs = [];
for (const file of srcFiles) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (line.includes('console.log(')) consoleLogs.push(rel);
    if (/: any\b/.test(line)) anyTypes.push(rel);
  }
  // 缩进 0 的 function 声明 = 顶层函数；往回找最近的 /** 判断有没有说明。
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^export (async )?function \w+/.test(line)) continue;
    const name = /function (\w+)/.exec(line)?.[1] ?? '';
    // 说明可以是 JSDoc（/** … */）或紧邻的一行注释（// …）；空行不影响。
    let hasDoc = false;
    for (let back = i - 1; back >= 0; back -= 1) {
      const previous = lines[back].trim();
      if (previous === '') continue;
      if (previous.endsWith('*/') || previous.startsWith('*') || previous.startsWith('//')) hasDoc = true;
      break;
    }
    if (!hasDoc) noDoc.push(`${rel}: ${name}`);
    // 函数体长度与参数个数
    const header = line;
    const params = /\(([^)]*)\)/.exec(header)?.[1] ?? '';
    if (params.split(',').filter((p) => p.trim()).length > QUALITY_LIMITS.params) manyParams.push(`${rel}: ${name}`);
    let depth = 0;
    let bodyLines = 0;
    for (let j = i; j < lines.length; j += 1) {
      depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
      bodyLines += 1;
      if (depth === 0 && j > i) break;
    }
    // 只看函数体，不算前面的 JSDoc：100 行是硬上限，60 是建议值。
    if (bodyLines > 100) tooLong.push(`${rel}: ${name} (${bodyLines} 行)`);
  }
}
if (noDoc.length > 0) add('WARN', '质量', `${noDoc.length} 个导出函数没有说明（名字之外要写清边界）：${noDoc.slice(0, 5).join('; ')}`);
else add('PASS', '质量', '所有导出函数都有说明文档');
if (tooLong.length > 0) add('WARN', '质量', `${tooLong.length} 个函数超过 100 行：${tooLong.slice(0, 5).join('; ')}`);
if (manyParams.length > 0) add('WARN', '质量', `${manyParams.length} 个函数参数超过 ${QUALITY_LIMITS.params} 个：${manyParams.slice(0, 5).join('; ')}`);
const uniqueAny = [...new Set(anyTypes)];
if (uniqueAny.length > 0) add('WARN', '质量', `${uniqueAny.length} 个文件用了 : any：${uniqueAny.join(', ')}`);
const uniqueLog = [...new Set(consoleLogs)];
if (uniqueLog.length > 0) add('WARN', '质量', `${uniqueLog.length} 个文件直接 console.log：${uniqueLog.join(', ')}`);
if (tooLong.length === 0 && manyParams.length === 0 && uniqueAny.length === 0 && uniqueLog.length === 0) {
  add('PASS', '质量', '函数长度、参数个数、any、console.log 均无违规');
}

// ---------- 11. 差异体检：机械编辑/编码损坏的痕迹 ----------
// 这些痕迹只有一种来源：用字符串替换或重定向改代码，而不是用 edit。
// 三次真实事故都是这样发生的：字面 \n 写进源码、GBK 读成 UTF-8 写回、BOM 丢失。
// 检查只看**这次改动的行**，所以不会淹没在历史里。
const damage = [];
try {
  const diff = spawnSync('git', ['diff', '--unified=0', 'HEAD'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = diff.stdout ?? '';
  for (const raw of text.split('\n')) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);
    if (line.includes('\uFFFD')) damage.push(`U+FFFD 替换字符：${line.trim().slice(0, 70)}`);
    // Written as escapes so this check does not match its own source line.
    if (/[\u951b\u9286\u9225]|\u9532\u65a4\u62f7/.test(line)) {
      damage.push(`编码损坏（GBK 被当 UTF-8）：${line.trim().slice(0, 70)}`);
    }
    // 注释里出现字面 \n 后跟代码 token：替换时想插换行，实际写进了反斜杠和 n。
    if (/\/\/.*\\n\s*(const|let|var|function|if|return|await|else|for|while|export)\b/.test(line)) {
      damage.push(`注释里出现字面 \\n：${line.trim().slice(0, 70)}`);
    }
  }
} catch {
  damage.push('无法运行 git diff（不是 git 仓库？）');
}
if (damage.length > 0) {
  add(
    'FAIL',
    '体检',
    `${damage.length} 行有机械编辑损坏的痕迹 —— 改代码请用 edit/write 工具：` +
      damage.slice(0, 3).join(' | '),
  );
} else {
  add('PASS', '体检', '这次改动的行没有替换/编码损坏的痕迹');
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
