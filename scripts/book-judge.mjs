#!/usr/bin/env node
/**
 * 读书实验 · 独立裁判（0015 §8：自评不算 —— 答题 deepseek-chat，裁判 deepseek-reasoner）。
 *
 *   node scripts/book-judge.mjs [--answers <jsonl>] [--out <md>]
 *
 * 每题：真值表的「合格答案要点」+ 被评回答 + 回答者当时可见的候选池 →
 * 四分类 对/错/不知道/编造，另判「可追溯」（关键细节能在池里找到依据）。
 * 池是判可追溯的分母：答案里的细节只可能来自池（模型看不见别的），所以
 * 「池里有」≡「库里有且被检索到」。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlm } from './book-llm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const answersPath = resolve(arg('answers', join(here, '..', 'docs', 'experiments', '2026-11-11-book-qa-answers.jsonl')));
const outPath = resolve(arg('out', join(here, '..', 'docs', 'experiments', '2026-11-11-book-qa-scores.md')));
const TRUTH = join(here, '..', 'docs', 'experiments', '2026-11-11-book-recall-truth.md');

// A different model than the answerer, on purpose (0015 §8 第 3 条).
process.env.BOOK_LLM_MODEL = process.env.BOOK_JUDGE_MODEL ?? 'deepseek-reasoner';

function loadKeys() {
  const md = readFileSync(TRUTH, 'utf8');
  const section5 = md.split('## 5. 题库')[1]?.split('## 6.')[0] ?? '';
  const keys = new Map();
  for (const match of section5.matchAll(/^\| ([PER]\d+) \| (.+?) \| (.+?) \|$/gm)) {
    keys.set(match[1], { question: match[2].trim(), key: match[3].trim() });
  }
  if (keys.size !== 30) {
    console.error(`truth table yielded ${keys.size} keys, expected 30 — refusing to judge`);
    process.exit(2);
  }
  return keys;
}

const keys = loadKeys();
const answers = readFileSync(answersPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const llm = createLlm();
console.log(`judge: ${answers.length} answers with ${llm.info}`);

const verdicts = [];
for (const record of answers) {
  const truth = keys.get(record.id);
  const pool = record.pool.facts.map((f) => `- [${f.id}] ${f.statement}`).join('\n');
  const prompt = [
    '<task>判分，只输出一行。</task>',
    `<问题>${truth.question}</问题>`,
    `<标准答案要点>${truth.key}</标准答案要点>`,
    `<被评回答>${record.answer}</被评回答>`,
    '<事实池（回答者当时可见的全部事实）>',
    pool,
    '</事实池>',
    '判为四类之一：对（要点齐全且不矛盾）/ 错（与要点矛盾）/ 不知道（没答或明确说不知道）/ 编造（给出池里不存在的关键细节）。',
    '另判可追溯：回答的每个关键细节能否在事实池里找到依据（是/否）。',
    '输出恰好一行：verdict=对|错|不知道|编造 traceable=是|否 reason=一句话',
  ].join('\n');
  const raw = (await llm(prompt)).trim();
  const verdict = (raw.match(/verdict=(对|错|不知道|编造)/) ?? [])[1] ?? '错';
  const traceable = /traceable=是/.test(raw);
  verdicts.push({ id: record.id, verdict, traceable, raw, question: truth.question });
  console.log(`  ${record.id} ${verdict} traceable=${traceable ? '是' : '否'} :: ${raw.slice(0, 90)}`);
}

/* ---------------- score against the frozen lines (truth table §1) ---------------- */

const byCat = { P: [], E: [], R: [] };
for (const v of verdicts) byCat[v.id[0]].push(v);
const right = (list) => list.filter((v) => v.verdict === '对').length;
const fabricated = verdicts.filter((v) => v.verdict === '编造').length;
const traceable = verdicts.filter((v) => v.traceable).length;
const lines = [
  ['人物 recall', `${right(byCat.P)}/10`, '≥60% → ≥6'],
  ['事件 recall', `${right(byCat.E)}/10`, '≥50% → ≥5'],
  ['关系 recall', `${right(byCat.R)}/10`, '≥50% → ≥5'],
  ['编造率', `${fabricated}/30`, '≤10% → ≤3（一票否决）'],
  ['可追溯率', `${traceable}/30`, '≥80% → ≥24'],
];
const pass = right(byCat.P) >= 6 && right(byCat.E) >= 5 && right(byCat.R) >= 5 && fabricated <= 3 && traceable >= 24;

const md = [
  '# 读书实验 · QA 基线判分',
  '',
  `> 答题：deepseek-chat · 裁判：${process.env.BOOK_JUDGE_MODEL ?? 'deepseek-reasoner'} · 判分时间：${new Date().toISOString()}`,
  `> 答案：[\`${answersPath.split(/[\\/]/).slice(-1)[0]}\`](./${answersPath.split(/[\\/]/).slice(-1)[0]}) · 题库与线：[真值表](./2026-11-11-book-recall-truth.md)（跑前落盘，不许改）`,
  '',
  '| 指标 | 读数 | 通过线 |',
  '|---|---|---|',
  ...lines.map(([name, value, line]) => `| ${name} | ${value} | ${line} |`),
  '',
  `**结论：${pass ? '通过' : '未通过'}**（任一不过 → 不进 MVP2，0015 §6）`,
  '',
  '| # | 判定 | 可追溯 | 问题 | 裁判原话 |',
  '|---|---|---|---|---|',
  ...verdicts.map((v) => `| ${v.id} | ${v.verdict} | ${v.traceable ? '是' : '否'} | ${v.question} | ${v.raw.replace(/\|/g, '/')} |`),
  '',
].join('\n');
writeFileSync(outPath, md, 'utf8');
console.log('\n' + lines.map(([n, v, l]) => `${n.padEnd(10)} ${v.padEnd(8)} (${l})`).join('\n'));
console.log(`\n结论：${pass ? '通过' : '未通过'} → ${outPath}`);
