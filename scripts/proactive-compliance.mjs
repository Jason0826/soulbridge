/**
 * Proactive compliance + outcome pairing for the L2 trigger registry (0018 §九 2).
 *
 * Three measurements, all proxies with the same honesty rules as rule-compliance.mjs:
 *
 *   1. relay      — the reply that carried the injection contains a now-shaped advice
 *                   pattern. Calibrated on the three real samples: a bare mention of
 *                   "/compact" does NOT count (turn 14 discussed compaction 24 times
 *                   without relaying the switch advice), only a directive does.
 *   2. outcome    — within N turns of the event: a same-session compaction
 *                   (segment-marker / ledger-compact) or the next turn landing in a
 *                   different session (switch) = adopted.
 *   3. counter-   — a reply contains the advice pattern but the turn had no gate event:
 *   .example        source would be memory, not the gate. Reported as CANDIDATES for
 *                   manual review — precision is not established (same caveat as
 *                   rule-compliance's corrections proxy). Scanned from the first gate
 *                   event onward by default; pass --since <iso> to cover the
 *                   deploy→first-event gap (checked by hand here: 1 turn, no directive).
 *
 * Pairing is by timestamp: turns.turn_no is a host-global counter and does not match
 * the trace's per-session turn. The reply paired with an event is the first same-session
 * turn started within 10s after it (prestep → start gap measured at 11–476ms). Distance
 * counts turn-cost events; a turn killed by a restart never emits one, so distance can
 * undercount — verdicts at the window edge deserve a manual look.
 *
 *   node scripts/proactive-compliance.mjs [--turns 3] [--min-sample 5] [--since <iso>]
 *
 * Sample counts below min-sample are printed but not judged (rule 20: an empty sample
 * is not a verdict).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};
const strFlag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : undefined;
};
const windowTurns = flag('turns', 3);
const minSample = flag('min-sample', 5);
const home = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');

const tracePath = join(home, 'trace.jsonl');
if (!existsSync(tracePath)) {
  console.log('无 trace.jsonl：没有 proactive 记录，判定为无样本。');
  process.exit(0);
}

const all = readFileSync(tracePath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const num = (v) => (typeof v === 'number' ? v : Date.parse(v));
const proactive = all.filter((e) => e.event === 'proactive').map((e) => ({ ...e, ts: num(e.ts) }));
const compactions = all
  .filter((e) => (e.event === 'segment-marker' && e.trigger === 'compaction') || e.event === 'ledger-compact')
  .map((e) => ({ ...e, ts: num(e.ts) }))
  .sort((a, b) => a.ts - b.ts);
const turnCosts = all.filter((e) => e.event === 'turn-cost').map((e) => ({ ...e, ts: num(e.ts) }));

const dbPath = join(home, 'soul.db');
if (!existsSync(tracePath) || !existsSync(dbPath)) {
  console.log('缺 trace.jsonl 或 soul.db：判定为无样本。');
  process.exit(0);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const turns = db
  .prepare('SELECT session_id, turn_no, started_at, assistant_text FROM turns ORDER BY started_at ASC')
  .all();
db.close();

// Now-shaped advice directive. Calibrated on the three real gate replies (11-06/11-07):
//   turn 13 relayed  → "现在适合 `/compact` 续命"              matches
//   turn 20 relayed  → "所以：现在就该 `/compact`——四个理由"    matches
//   turn 14 NOT      → 24 mentions, all narration of the compaction that already happened,
//                      longest gap from any 建议/该 to a "/compact" is 20 chars > 12
const RELAY =
  /(现在|此刻)[^\n]{0,20}\/compact|(建议|该|适合)[^\n]{0,12}\/compact|现在[^\n]{0,16}换(个|新)?会话|建议[^\n]{0,16}换(个|新)?会话/;
const PAIR_GAP_MS = 10_000;

const iso = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 19) + 'Z' : String(ts));
const shortSession = (id) => String(id).replace(/^session-/, '').slice(0, 8);
const pairedTurn = (ev) =>
  turns.find((t) => t.session_id === ev.session && t.started_at >= ev.ts && t.started_at - ev.ts <= PAIR_GAP_MS);

const firstEventTs = proactive.length > 0 ? Math.min(...proactive.map((e) => e.ts)) : Infinity;
// Scan window for counter-examples: default starts at the first gate event. To cover the
// deploy→first-event gap (registry shipped before any threshold was crossed), pass
// --since <iso>. An invalid --since is printed, not silently ignored.
const sinceRaw = strFlag('since');
const sinceTs = sinceRaw === undefined ? firstEventTs : Date.parse(sinceRaw);
if (sinceRaw !== undefined && !Number.isFinite(sinceTs)) {
  console.log(`--since 无法解析：${sinceRaw}`);
  process.exit(1);
}

console.log(
  `主动建议合规 · proactive ${proactive.length} 个 · outcome 窗口 ${windowTurns} 轮 · 最少样本 ${minSample} · 反例扫描自 ${iso(sinceTs)}`,
);

// ── 1. relay ────────────────────────────────────────────────────────────────
console.log('\n触发 → 转告（严格指令口径，提及不计）:');
if (proactive.length === 0) {
  console.log('  无样本：还没有任何 proactive 事件。');
} else {
  const byId = new Map();
  for (const ev of proactive) {
    const entry = byId.get(ev.id) ?? { fired: 0, relayed: 0 };
    entry.fired += 1;
    const turn = pairedTurn(ev);
    const text = String(turn?.assistant_text ?? '');
    const hit = RELAY.exec(text);
    if (hit) entry.relayed += 1;
    byId.set(ev.id, entry);
    const verdict = !turn ? '⚠ 无配对轮（事件后 10s 内没有同会话轮，无法判定）' : hit ? `✓ 转告` : '✗ 未转告';
    const excerpt = hit ? `（命中「${hit[0].slice(0, 40)}」）` : turn ? `（全文 ${text.length} 字无指令形状）` : '';
    console.log(`  ${iso(ev.ts)} trace-turn ${ev.turn} ${ev.id} trigger=${ev.trigger} → ${verdict}${excerpt}`);
  }
  for (const [id, entry] of byId) {
    const rate = ((entry.relayed / entry.fired) * 100).toFixed(0);
    const judge = entry.fired < minSample ? '样本不足，不判决' : `${rate}%`;
    console.log(`  小计 ${id}: 触发 ${entry.fired}，转告 ${entry.relayed}（${judge}）`);
  }
}

// ── 2. outcome ──────────────────────────────────────────────────────────────
console.log(`\noutcome 配对（建议后 ≤${windowTurns} 轮内同会话压缩 或 换会话 = 采纳）:`);
if (proactive.length === 0) {
  console.log('  无样本。');
} else {
  let adopted = 0;
  for (const ev of proactive) {
    const evTs = ev.ts;
    const nextComp = compactions.find((c) => c.session === ev.session && c.ts > evTs);
    const replyTurn = pairedTurn(ev);
    const replyIdx = replyTurn ? turns.indexOf(replyTurn) : -1;
    const nextTurn = replyIdx >= 0 ? turns[replyIdx + 1] : undefined;
    const switched = nextTurn && nextTurn.session_id !== ev.session;

    let verdict;
    if (switched && (!nextComp || nextTurn.started_at <= nextComp.ts)) {
      verdict = `✓ 采纳（换会话 → ${shortSession(nextTurn.session_id)}）`;
      adopted += 1;
    } else if (nextComp) {
      const distance = turnCosts.filter(
        (tc) => tc.session === ev.session && tc.ts > evTs && tc.ts <= nextComp.ts,
      ).length;
      if (distance <= windowTurns) {
        verdict = `✓ 采纳（${iso(nextComp.ts)} 压缩，距离 ${distance} 轮）`;
        adopted += 1;
      } else {
        verdict = `✗ 未采纳（下次压缩 ${iso(nextComp.ts)}，距离 ${distance} 轮超窗）`;
      }
    } else {
      verdict = switched ? '✓ 采纳（换会话）' : '✗ 未观察到压缩或换会话';
      if (switched) adopted += 1;
    }
    console.log(`  ${iso(ev.ts)} ${ev.id} trace-turn ${ev.turn} → ${verdict}`);
  }
  const judge = proactive.length < minSample ? '样本不足，不判决' : `${((adopted / proactive.length) * 100).toFixed(0)}%`;
  console.log(`  小计: 采纳 ${adopted} / 共 ${proactive.length}（${judge}）`);
}

// ── 3. counter-examples ─────────────────────────────────────────────────────
const candidates =
  proactive.length === 0
    ? []
    : turns.filter((t) => {
        if (t.started_at < sinceTs) return false; // default: no gate event had fired yet
        if (!RELAY.test(String(t.assistant_text ?? ''))) return false;
        return !proactive.some(
          (ev) => ev.session === t.session_id && t.started_at >= ev.ts && t.started_at - ev.ts <= PAIR_GAP_MS,
        );
      });
console.log(`\n反例候选（回复含指令形状但该轮无闸门事件——来源是记忆不是闸门，人工 review，精度未验证）:`);
if (proactive.length === 0) {
  console.log('  无样本：还没有闸门事件，无从对比。');
} else {
  console.log(`  ${candidates.length} 个候选`);
  for (const t of candidates.slice(0, 5)) {
    const hit = RELAY.exec(String(t.assistant_text ?? ''));
    console.log(`    turn_no ${t.turn_no} ${iso(t.started_at)} ${shortSession(t.session_id)} 「${(hit?.[0] ?? '').slice(0, 40)}」`);
  }
  if (candidates.length > 5) console.log(`    …其余 ${candidates.length - 5} 个省略`);
}
