#!/usr/bin/env node
/**
 * Session index and handoff, read from the real database (briefs/0011).
 *
 * Usage:
 *   node --experimental-strip-types scripts/session-index.mjs
 *   node --experimental-strip-types scripts/session-index.mjs --session <id>
 *   SOULBRIDGE_HOME=/path ... (defaults to ~/.soulbridge)
 *
 * Prints one line per conversation and, with --session, what a new session
 * would inherit from the previous one.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = new URL('../packages/core/src/', import.meta.url).href;
const { openSqlite } = await import(`${root}sqlite.ts`);
const { Soul } = await import(`${root}index.ts`);
const { ensureConfig, resolveDbPath } = await import(`${root}storage/config.ts`);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const store = openSqlite(resolveDbPath());
const config = ensureConfig();
const soul = new Soul({ store, soulId: config.soulId, userId: config.userId });

const sessions = soul.sessions(20);
console.log(`数据库: ${resolveDbPath()}`);
console.log(`会话数: ${sessions.length}`);
for (const s of sessions) {
  const start = new Date(s.start).toISOString().slice(5, 16).replace('T', ' ');
  const end = new Date(s.end).toISOString().slice(5, 16).replace('T', ' ');
  console.log(`  ${s.sessionId.slice(0, 20).padEnd(22)} ${start} → ${end}  ${String(s.turns).padStart(3)} 轮`);
}

const current = opt('--session');
if (current) {
  const handoff = soul.handoff(current);
  if (!handoff) {
    console.log('\n没有可交接的上一会话');
  } else {
    console.log(`\n交接给 ${current.slice(0, 20)}：上一会话 ${handoff.session.sessionId.slice(0, 20)}（${handoff.session.turns} 轮）`);
    console.log('  首条 Q:', handoff.first.userText.replace(/\s+/g, ' ').slice(0, 80));
    for (const p of handoff.last) {
      console.log('  末条 Q:', p.userText.replace(/\s+/g, ' ').slice(0, 70));
      console.log('       A:', p.assistantText.replace(/\s+/g, ' ').slice(0, 70));
    }
  }
}
store.close();
