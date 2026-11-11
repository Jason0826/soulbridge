/**
 * state.md 瘦身：把过期的日期条目、以及带日期的快照节移进 docs/state-archive/YYYY-MM.md。
 *
 * 归档不是删除——内容一个字不丢，grep 仍能找到；衰减的只是 accessibility：
 * state.md 是每次必读的热文档，进 archive 后不主动读就看不见（availability 不变）。
 *
 * 移之前必须先"上浮"：条目里仍为真的事实要先进接手须知或固定章节，再移。
 * 哪些还热是语义判断，不归脚本；脚本只负责搬家，health-check 负责拦"该移没移"。
 *
 * 用法：
 *   node scripts/archive-state.mjs                    # 归档 7 天前的（默认规则）
 *   node scripts/archive-state.mjs --before 2026-11-05  # 按内容判断，显式给截止日
 *   node scripts/archive-state.mjs --dry-run          # 只报告，不写文件
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, 'docs', 'state.md');
const ARCHIVE_DIR = join(ROOT, 'docs', 'state-archive');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const beforeArg = args.includes('--before') ? args[args.indexOf('--before') + 1] : null;
if (beforeArg && !/^\d{4}-\d{2}-\d{2}$/.test(beforeArg)) {
  console.error(`--before 要 YYYY-MM-DD，收到 ${beforeArg}`);
  process.exit(1);
}
const cutoff =
  beforeArg ??
  new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

const raw = readFileSync(STATE, 'utf8');
const lines = raw.split(/\r?\n/);

// 两类块：行首 **YYYY-MM-DD 的日期条目；标题里带日期的快照节（如 `## 三·零、2026-11-03 …`）。
const ENTRY = /^\*\*(\d{4}-\d{2}-\d{2})/;
const SECTION = /^## .*?(\d{4}-\d{2}-\d{2})/;
const blocks = [];
for (let i = 0; i < lines.length; i++) {
  const entry = ENTRY.exec(lines[i]);
  const section = !entry ? SECTION.exec(lines[i]) : null;
  const date = entry?.[1] ?? section?.[1];
  if (!date) continue;
  let end = i + 1;
  while (end < lines.length) {
    if (ENTRY.test(lines[end])) break; // 下一条日期条目
    if (/^## /.test(lines[end])) break; // 下一个二级标题
    end++;
  }
  blocks.push({ start: i, end, date, kind: section ? 'section' : 'entry' });
  i = end - 1;
}

const stale = blocks.filter((block) => block.date < cutoff);
if (stale.length === 0) {
  console.log(`没有早于 ${cutoff} 的条目，state.md 不用动。`);
  process.exit(0);
}

const moved = stale.map((block) => ({
  ...block,
  text: lines.slice(block.start, block.end).join('\n').replace(/\s+$/, ''),
}));

console.log(`${dryRun ? '[dry-run] ' : ''}截止 ${cutoff}，将归档 ${moved.length} 块：`);
for (const block of moved) {
  console.log(`  L${block.start + 1} [${block.kind}] ${block.date} ${lines[block.start].slice(0, 60)}`);
}
if (dryRun) process.exit(0);

// 归档文件按条目自己的月份分（跨月时截止日的月份会装错）。
const groups = new Map();
for (const block of moved) {
  const fileMonth = block.date.slice(0, 7);
  if (!groups.has(fileMonth)) groups.set(fileMonth, []);
  groups.get(fileMonth).push(block);
}

// 从后往前删，避免行号漂移；原位留指针。
const pointer = (target) => `> （本节已归档 → [state-archive/${target}](state-archive/${target})）`;
for (let i = moved.length - 1; i >= 0; i--) {
  const block = moved[i];
  const replaceWith = block.kind === 'section' ? [pointer(`${block.date.slice(0, 7)}.md`), ''] : [];
  lines.splice(block.start, block.end - block.start, ...replaceWith);
}

// 日期条目区的入口留一行常驻指针（只加一次）。
const firstEntryAt = lines.findIndex((line) => ENTRY.test(line));
const pointerMonth = moved[0].date.slice(0, 7);
const standing = `> 日期条目只留最近 7 天，更早的在 [state-archive/${pointerMonth}.md](state-archive/${pointerMonth}.md)（规则见 docs/README）。`;
if (firstEntryAt > 0 && !lines.some((line) => line.startsWith('> 日期条目只留最近'))) {
  lines.splice(firstEntryAt, 0, standing, '');
}

mkdirSync(ARCHIVE_DIR, { recursive: true });
for (const [fileMonth, blocks] of groups) {
  const archive = join(ARCHIVE_DIR, `${fileMonth}.md`);
  let text = existsSync(archive) ? readFileSync(archive, 'utf8') : '';
  if (!text) {
    text += `# state.md 归档（${fileMonth}）\n\n`;
    text += '> 从 [state.md](../state.md) 移出的过期日期条目与快照节。\n';
    text += '> 归档不删除：availability 不变，衰减的只是被想起的概率（不在热文档里）。\n';
    text += '> 移动前先上浮：仍为真的事实先进接手须知或固定章节（规则见 docs/README）。\n';
  }
  for (const block of blocks) {
    // 相对链接随位置改变基准：docs/ → docs/state-archive/，非外部链接补 ../。
    const body = block.text.replace(/\]\((?!([a-z][a-z0-9+.-]*:|\/|#|\.\.\/))([^)]+)\)/g, '](../$2)');
    text += `\n---\n\n${body}\n`;
  }
  writeFileSync(archive, text, 'utf8');
}
writeFileSync(STATE, lines.join('\n'), 'utf8');
console.log(`归档 ${moved.length} 块 → docs/state-archive/（${[...groups.keys()].join(', ')}）；state.md 现 ${lines.length} 行。`);
