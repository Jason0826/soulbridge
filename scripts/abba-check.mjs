/**
 * Acceptance for 0017: does a conclusion cover where the conversation came back?
 *
 * The scenario is A B A: a topic is opened, interrupted, and resumed. If the
 * thread model works, the resumed turn belongs to the same thread and the
 * conclusion cites evidence from it. If consolidation only read the opening, the
 * conclusion cites the first turns only — which is exactly "reading two chapters
 * and calling it the book".
 *
 * Usage:
 *   node scripts/abba-check.mjs --topic 核桃
 *   node scripts/abba-check.mjs --thread th_xxx
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const args = process.argv.slice(2);
const arg = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const topicArg = arg('topic');
const threadArg = arg('thread');
if (!topicArg && !threadArg) {
  console.error('need --topic <keyword> or --thread <id>');
  process.exit(2);
}

const willClose = args.includes('--close');
const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: !willClose });

const thread = threadArg
  ? db.prepare('SELECT * FROM threads WHERE id = ?').get(threadArg)
  : db
      .prepare("SELECT * FROM threads WHERE topic LIKE ? ORDER BY opened_at DESC LIMIT 1")
      .get(`%${topicArg}%`);

if (!thread) {
  console.log(`no thread matching ${threadArg ?? topicArg}`);
  db.close();
  process.exit(1);
}

if (willClose) {
  // Close and enqueue by hand: the acceptance tests consolidation coverage, not
  // the idle counter, so waiting six turns would only add noise.
  db.prepare("UPDATE threads SET status = 'closed', closed_at = ? WHERE id = ?").run(Date.now(), thread.id);
  thread.status = 'closed';
  const queueFile = join(HOME, 'pending-threads.json');
  const queue = existsSync(queueFile) ? JSON.parse(readFileSync(queueFile, 'utf8')) : [];
  if (!queue.includes(thread.id)) queue.push(thread.id);
  writeFileSync(queueFile, JSON.stringify(queue.slice(0, 50), null, 2), 'utf8');
  console.log(`closed and queued: ${thread.id}`);
}

const turns = db.prepare('SELECT id, turn_no, user_text FROM turns WHERE thread_id = ? ORDER BY turn_no').all(thread.id);
const turnIds = turns.map((turn) => turn.id);
const facts =
  turnIds.length === 0
    ? []
    : db
        .prepare(
          `SELECT id, statement, source_turn_id FROM facts
           WHERE source_turn_id IN (${turnIds.map(() => '?').join(',')}) ORDER BY created_at`,
        )
        .all(...turnIds);

const conclusion = thread.summary_fact_id ? db.prepare('SELECT * FROM facts WHERE id = ?').get(thread.summary_fact_id) : null;
const evidence = conclusion
  ? db.prepare("SELECT ref_fact_id FROM fact_slots WHERE fact_id = ? AND slot = '证据' AND ref_fact_id IS NOT NULL").all(conclusion.id)
  : [];
const evidenceIds = evidence.map((row) => row.ref_fact_id);

console.log(`thread   ${thread.id}  [${thread.status}]  ${thread.topic}`);
console.log(`turns    ${turns.length}`);
for (const turn of turns) console.log(`  #${turn.turn_no}  ${String(turn.user_text).replace(/\s+/g, ' ').slice(0, 60)}`);
console.log(`facts    ${facts.length}`);
for (const fact of facts) console.log(`  ${fact.id}  ${String(fact.statement).slice(0, 60)}`);
console.log(`conclusion  ${conclusion ? conclusion.statement : '（还没有结论）'}`);
console.log(`evidence    ${evidenceIds.length > 0 ? evidenceIds.join(', ') : '（无）'}`);

if (!conclusion) {
  console.log('\nPENDING: 线索还没归纳（未闭合，或事实不足 2 条）');
  db.close();
  process.exit(0);
}

// The turn that resumed the topic: everything after the first interruption.
const lastTurnId = turns[turns.length - 1]?.id;
const lastTurnFactIds = facts.filter((fact) => fact.source_turn_id === lastTurnId).map((fact) => fact.id);
const citesLater = lastTurnFactIds.some((id) => evidenceIds.includes(id));
const citesAnyLaterTurn = turns.length < 3
  ? null
  : evidenceIds.some((id) => {
      const fact = facts.find((candidate) => candidate.id === id);
      const turnIndex = turns.findIndex((turn) => turn.id === fact?.source_turn_id);
      return turnIndex >= 1 && turnIndex < turns.length - 0;
    });

console.log('');
if (turns.length < 3) {
  console.log('INCONCLUSIVE: 线索里不足 3 轮，演不了 A B A');
} else if (citesLater) {
  console.log('PASS: 结论引用了最后回来那一轮的事实 —— 读完了整章');
} else if (citesAnyLaterTurn) {
  console.log('PARTIAL: 引用了中断之后的事实，但不是最后一轮');
} else {
  console.log('FAIL: 结论只引用了开头 —— 又是读两章当一本书');
}
db.close();
