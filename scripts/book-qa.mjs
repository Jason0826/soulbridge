#!/usr/bin/env node
/**
 * 读书实验 · 检索侧问答（brief 0015 §9 第 5 步的脚本半场）。
 *
 *   node scripts/book-qa.mjs [--soul book-ahq] [--out <path>] [--only P1,E3]
 *
 * 每题：extractionContext(text=问题) 取候选（与生产同一阶梯、同一 2400 字预算），
 * 用核心自己的 renderKnownFacts 渲染（与抽取提示词逐字节同格式），模型只准依据
 * <known-facts> 作答并引用 [id]。答案、候选池、引用一起落 JSONL —— 判分时能分清
 * 「检索没取到」和「取到了没答上」。
 *
 * 题库从真值表 md 解析（一件事一个表示：改题只改真值表）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite } from '../packages/core/src/sqlite.ts';
import { Soul } from '../packages/core/src/index.ts';
import { renderKnownEntities, renderKnownFacts } from '../packages/core/src/prompts.ts';
import { createLlm } from './book-llm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TRUTH = join(here, '..', 'docs', 'experiments', '2026-11-11-book-recall-truth.md');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const soulId = arg('soul', 'book-ahq');
const outPath = resolve(arg('out', join(here, '..', 'docs', 'experiments', '2026-11-11-book-qa-answers.jsonl')));
const only = arg('only', null) ? new Set(arg('only', '').split(',')) : null;

/** Questions come from the frozen truth table — never from a second list here. */
function loadQuestions() {
  const md = readFileSync(TRUTH, 'utf8');
  // Only §5: the event/relationship tables in §3–§4 reuse the same E#/R# ids for
  // their answer keys, and parsing those too would silently load the wrong column.
  const section5 = md.split('## 5. 题库')[1]?.split('## 6.')[0] ?? '';
  const questions = [];
  for (const match of section5.matchAll(/^\| ([PER]\d+) \| (.+?) \| (.+?) \|$/gm)) {
    questions.push({ id: match[1], question: match[2].trim(), key: match[3].trim() });
  }
  if (questions.length !== 30) {
    console.error(`truth table yielded ${questions.length} questions, expected 30 — refusing to run`);
    process.exit(2);
  }
  return questions;
}

const questions = loadQuestions().filter((q) => !only || only.has(q.id));
const store = openSqlite(join(process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge'), 'soul.db'));
const soul = new Soul({ store, soulId, userId: 'local' });
const llm = createLlm();

console.log(`qa: ${questions.length} questions → soul=${soulId} ${llm.info}`);
const lines = [];
for (const q of questions) {
  const started = Date.now();
  const context = soul.extractionContext(20, { text: q.question });
  const prompt = [
    '<task>只依据 <known-facts> 回答问题：细节必须出自这些事实，并在句末以 [id] 引用来源；',
    '<known-facts> 里没有的就答「不知道」，禁止编造。</task>',
    renderKnownEntities(context.entities),
    renderKnownFacts(context.facts),
    `<question>${q.question}</question>`,
  ].join('\n');
  const answer = await llm(prompt);
  const cited = [...answer.matchAll(/\[(fc_[a-z0-9_]+)\]/g)].map((m) => m[1]);
  const record = {
    id: q.id,
    question: q.question,
    answer: answer.trim(),
    cited,
    pool: {
      chosen: context.factCandidates.chosen,
      byTier: context.factCandidates.byTier,
      facts: context.facts.map((f) => ({ id: f.id, statement: f.statement })),
    },
    ms: Date.now() - started,
  };
  lines.push(JSON.stringify(record));
  console.log(`  ${q.id} pool=${record.pool.chosen} cited=${cited.length} ms=${record.ms} :: ${record.answer.slice(0, 60).replace(/\n/g, ' ')}`);
}
writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`\nwrote ${lines.length} answers → ${outPath}`);
store.close();
