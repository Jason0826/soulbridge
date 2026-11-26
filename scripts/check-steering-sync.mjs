#!/usr/bin/env node
/**
 * 跨仓库 steering 同步检查：模板（本仓库 docs/steering-project-principles.md）与各项目
 * AGENTS.md 副本的规则编号必须一致。
 *
 * 为什么需要它：模板和副本住在不同仓库，health-check §4.6.2 只比得了本仓库这一对；
 * 跨仓库没有哪条 git hook 能同时看见两边，于是「模板加了第 51 条、副本还停在 50 条」
 * 会安静地漂下去——跟 §12 的「指向旧副本」是同一类病：不报错的旧事实。
 *
 * 判据和 §4.6.2 一样：只比编号集合。文案各写各的可以，编号缺一个不行
 * （缺一条 = 那边的 agent 少一条约束）。
 *
 * 怎么声明自己是副本：在 AGENTS.md 里写一行
 *   <!-- steering-sync: soulbridge/docs/steering-project-principles.md -->
 * 值 = <仓库目录名>/<该仓库内模板路径>，相对工作区根。没有这一行的仓库一律跳过——
 * 它有自己的一套规则体系（dsh-src、webhtv 就是），硬比只会制造假警报。
 *
 * 用法：
 *   node scripts/check-steering-sync.mjs              # 扫同级所有仓库
 *   node scripts/check-steering-sync.mjs --verbose    # 连跳过的一起列出来
 * 环境变量 STEERING_WORKSPACE 可换工作区根（默认 = 本仓库的上一级）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = process.env.STEERING_WORKSPACE ?? resolve(ROOT, '..');
const MARKER = /<!--\s*steering-sync:\s*(\S+)\s*-->/;
const verbose = process.argv.includes('--verbose');

/** 规则编号 = 行首「数字. 空格」；和 health-check §4.6.2 用同一个正则。 */
function ruleNumbers(text) {
  return new Set(
    text
      .split('\n')
      .map((line) => /^(\d+)\.\s/.exec(line))
      .filter(Boolean)
      .map((match) => Number(match[1])),
  );
}

const copies = [];
const skipped = [];
for (const name of readdirSync(WORKSPACE).sort()) {
  const dir = join(WORKSPACE, name);
  if (name.startsWith('.') || !statSync(dir).isDirectory()) continue;
  const agents = join(dir, 'AGENTS.md');
  if (!existsSync(agents)) continue;
  const text = readFileSync(agents, 'utf8');
  const marker = MARKER.exec(text);
  if (!marker) {
    skipped.push(name);
    continue;
  }
  copies.push({ name, agents, declared: marker[1], numbers: ruleNumbers(text) });
}

if (copies.length === 0) {
  console.log(`没有仓库声明自己是副本（找过 ${WORKSPACE} 下的 AGENTS.md）—— 无可比对`);
  if (verbose && skipped.length > 0) console.log(`跳过的（有自己的规则体系）：${skipped.join('、')}`);
  process.exit(0);
}

let failed = 0;
for (const copy of copies) {
  // 声明的模板必须真实存在：声明指向一个不存在的路径，比不声明更糟（安静地自认为在跟随）。
  const templatePath = resolve(WORKSPACE, copy.declared);
  if (!existsSync(templatePath)) {
    console.log(`✗ ${copy.name}：声明的模板不存在 → ${copy.declared}`);
    failed += 1;
    continue;
  }
  const template = ruleNumbers(readFileSync(templatePath, 'utf8'));
  const missing = [...template].filter((n) => !copy.numbers.has(n));
  const extra = [...copy.numbers].filter((n) => !template.has(n));
  if (missing.length > 0 || extra.length > 0) {
    console.log(
      `✗ ${copy.name} 与模板分叉：副本缺 ${missing.join(',') || '无'}；副本多 ${extra.join(',') || '无'}`,
    );
    failed += 1;
  } else {
    console.log(`✓ ${copy.name} 与模板同源（${template.size} 条）`);
  }
}

if (verbose && skipped.length > 0) {
  console.log(`跳过（没有 steering-sync 标记）：${skipped.join('、')}`);
}
console.log(`\n合计：${copies.length - failed} 个副本同源 / ${failed} 个分叉`);
process.exit(failed > 0 ? 1 : 0);
