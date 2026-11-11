#!/usr/bin/env node
/**
 * 读书实验 · 写入侧喂料（brief 0015 §9 第 3 步）。
 *
 *   node scripts/book-feed.mjs --file book.txt [--soul book-ahq] [--dry-run]
 *                              [--segment 1000] [--limit N] [--from N]
 *
 * 书不是对话，生产的 segment flush 不会为它触发；这个脚本替它触发同一条路：
 * 切段 → soul.extract（与生产同提示词、同闸门）→ commitDrafts 落库，
 * 每段打一行和生产同格式的 `extract done: … pool=… action=…`，
 * 辨别样本（同一事实跨章再现时模型 sup 还是 add）就攒在这里面。
 *
 * 模型来源：DSH 自己的凭据文件（用户已配过），env 可覆盖——
 *   BOOK_LLM_KEY / BOOK_LLM_URL / BOOK_LLM_MODEL / DSH_CREDENTIALS
 *
 * 护栏（两道，都挡在开库之前）：soulId 必须 book- 开头；库必须是 harness.db——
 * 11-11 起实验数据与生产物理隔离（harness-db.mjs 拒绝 soul.db），
 * 当天生产抽取撞的就是实验实体留在共享 id 空间里的同名行。
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '../packages/core/src/sqlite.ts';
import { Soul } from '../packages/core/src/index.ts';
import { createLlm } from './book-llm.mjs';
import { resolveHarnessDb } from './harness-db.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const soulId = arg('soul', 'book-ahq');
if (!soulId.startsWith('book-')) {
  console.error(`refused: soulId "${soulId}" must start with "book-"`);
  process.exit(2);
}
const dbPath = resolveHarnessDb(arg('db', null));
const userId = 'local';
const filePath = arg('file', null);
const segmentChars = Number(arg('segment', '1000'));
const bookTitle = arg('title', '阿Q正传');
const limit = Number(arg('limit', 'Infinity'));
const from = Number(arg('from', '1'));
const dryRun = has('dry-run');

/* ---------------- segmentation: whole paragraphs only (AGENTS 17) ---------------- */

function segmentBook(raw, target) {
  const paragraphs = raw
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const segments = [];
  let current = '';
  for (const paragraph of paragraphs) {
    // A paragraph longer than the target stays whole: cutting mid-paragraph
    // hands the model half a scene and makes "what came before" unreadable.
    if (current && current.length + paragraph.length + 2 > target) {
      segments.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) segments.push(current);
  return segments;
}

if (!filePath) {
  console.error('usage: node scripts/book-feed.mjs --file <txt> [--soul book-ahq] [--db <path>] [--dry-run] [--segment 1000] [--limit N] [--from N]');
  process.exit(2);
}
const raw = readFileSync(filePath, 'utf8');
const segments = segmentBook(raw, segmentChars);

if (dryRun) {
  console.log(`dry-run: ${segments.length} segments, ${raw.length} chars total (target ${segmentChars}/段)`);
  segments.forEach((segment, index) => {
    console.log(`  #${index + 1}  ${String(segment.length).padStart(5)} chars  ${segment.slice(0, 36).replace(/\n/g, ' ')}…`);
  });
  process.exit(0);
}

/* ---------------- model: shared with the QA/judge scripts (book-llm.mjs) ---------------- */

const callModel = createLlm();

/* ---------------- feed ---------------- */

const home = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const store = openSqlite(dbPath);
const soul = new Soul({ store, soulId, userId });
const sessionId = soulId;
// Raw replies are the only way to tell "the model said 无" from "the parse ate it" —
// diagnosing the first feed cost a separate probe for lack of this line.
let currentSegment = 0;
soul.onLlmRaw = (raw) => {
  appendFileSync(join(home, 'book-feed-raw.log'), `### segment ${currentSegment}\n${raw}\n`, 'utf8');
};

console.log(`feeding ${segments.length} segments → soul=${soulId} db=${dbPath} ${callModel.info}`);

const totals = { facts: 0, entities: 0, actions: { add: 0, supersede: 0, update: 0, noop: 0 }, skipped: 0 };
const failed = [];
let fed = 0;

for (let index = from - 1; index < segments.length; index += 1) {
  if (fed >= limit) break;
  const turnNo = index + 1;
  // Resume story: a turn is written after extract but before commit, so a segment
  // that crashes inside commitDrafts leaves a fact-less turn. The `failed` list
  // (exit 1) is what tells you to clean those turns — _scratch/book-cleanup.mjs —
  // before re-running; skipping here is what makes a normal re-run cheap.
  if (store.turnByTurnNo?.(sessionId, turnNo)) {
    console.log(`segment ${turnNo}/${segments.length} skipped (already fed)`);
    continue;
  }
  const segment = segments[index];
  // The production prompt assumes conversation ("只从对话里抽取"): the first feed
  // (11-11) came back 无 on 19/25 raw-novel segments. A user pasting a book says
  // "记下这段" — the harness says the same, so the prompt itself stays untouched.
  const text = `下面这段《${bookTitle}》的原文，把里面关于人物和事件的事实抽取出来：\n\n${segment}`;
  currentSegment = turnNo;
  const started = Date.now();
  try {
    const context = soul.extractionContext(20, { text });
    const draft = await soul.extract(text, { llm: callModel, mode: 'auto', context });
    const turnId = soul.recordTurnPair({ sessionId, turn: turnNo, userText: text, assistantText: '', at: started });
    const result = soul.commitDrafts(draft, { turnId, turnIds: { 1: turnId }, now: started });
    const pool = context.factCandidates;
    const acts = result.actions;
    totals.facts += result.facts.length;
    totals.entities += result.entities.length;
    totals.skipped += result.skipped.length;
    if (acts) for (const kind of Object.keys(totals.actions)) totals.actions[kind] += acts[kind];
    console.log(
      `extract done: by=${draft.by} reason=${draft.reason ?? '-'} entities=${result.entities.length} facts=${result.facts.length}` +
        ` gaps=${result.gaps.length} skipped=${result.skipped.length}` +
        ` ms=${Date.now() - started} segment=${turnNo}/${segments.length}` +
        (pool ? ` pool=${pool.chosen}(${pool.chars}ch e${pool.byTier.entity}/t${pool.byTier.thread}/s${pool.byTier.similar}/r${pool.byTier.recent}) poolDropped=${pool.droppedGroups.length}${pool.droppedGroups.length ? `:${pool.droppedGroups.map((d) => d.group).slice(0, 3).join(',')}` : ''}` : '') +
        (acts ? ` action=add${acts.add}/sup${acts.supersede}/upd${acts.update}/noop${acts.noop}` : ''),
    );
    fed += 1;
  } catch (error) {
    failed.push(turnNo);
    console.error(`segment ${turnNo}/${segments.length} FAILED: ${error.message}`);
  }
}

console.log(
  `\nsummary: fed=${fed} failed=${failed.length ? failed.join(',') : 0} facts=${totals.facts} entities=${totals.entities}` +
    ` skipped=${totals.skipped} actions=add${totals.actions.add}/sup${totals.actions.supersede}/upd${totals.actions.update}/noop${totals.actions.noop}`,
);
store.close();
if (failed.length) {
  console.error(`re-run with --from ${Math.min(...failed)} to retry the failed segments`);
  process.exit(1);
}
