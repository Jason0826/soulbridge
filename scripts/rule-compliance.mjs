/**
 * Rule compliance: after a rule fired, did the user have to correct the reply again?
 *
 * This is the only objective signal we have (a correction is a fact, not a judgement), and it
 * measures the wrong direction of a rule being ignored — a repeated correction right after a
 * firing means the injected rule did not change behaviour. It is a proxy, not proof: a
 * correction may be unrelated, so the output says "疑似" and requires a minimum sample before
 * it reports a rate.
 *
 *   node scripts/rule-compliance.mjs [--window-minutes 10] [--min-sample 5]
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
const windowMs = flag('window-minutes', 10) * 60_000;
const minSample = flag('min-sample', 5);
const home = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');

const tracePath = join(home, 'trace.jsonl');
if (!existsSync(tracePath)) {
  console.log('无 trace.jsonl：没有 rule_fired 记录，判定为无样本。');
  process.exit(0);
}

const firings = readFileSync(tracePath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter((event) => event && event.event === 'rule_fired');

const db = new DatabaseSync(join(home, 'soul.db'), { readOnly: true });
const corrections = db.prepare('SELECT at, user_text FROM corrections ORDER BY at ASC').all();
const triggerRows = db
  .prepare(
    `SELECT f.id AS id, s.value_text AS trigger FROM facts f
       JOIN fact_slots s ON s.fact_id = f.id AND s.slot = '触发'
      WHERE f.role = 'rule' AND f.status = 'active'`,
  )
  .all();
db.close();

// Trigger keywords: a correction only counts if it mentions what the rule was about.
// Without this the proxy flags every unrelated question as "the rule was ignored" — the
// first run reported 40–60% on rules whose examples were plainly new topics.
const keywordsByRule = new Map();
for (const row of triggerRows) {
  const words = new Set();
  try {
    const parsed = JSON.parse(String(row.trigger));
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') words.add(item);
    }
  } catch {
    if (String(row.trigger).trim()) words.add(String(row.trigger).trim());
  }
  keywordsByRule.set(String(row.id), [...words]);
}

const mentions = (ruleId, text) => {
  const words = keywordsByRule.get(ruleId) ?? [];
  if (words.length === 0) return true;
  return words.some((word) => text.includes(word));
};

const byRule = new Map();
for (const firing of firings) {
  const ts = Date.parse(firing.ts);
  const nodeCorrections = corrections.filter((correction) => {
    const at = Number(correction.at);
    return at >= ts && at <= ts + windowMs;
  });
  for (const ruleId of firing.rules ?? []) {
    const entry = byRule.get(ruleId) ?? { fired: 0, followedByCorrection: 0, samples: [] };
    entry.fired += 1;
    const later = nodeCorrections.filter((correction) => mentions(ruleId, String(correction.user_text)));
    if (later.length > 0) {
      entry.followedByCorrection += 1;
      entry.samples.push(String(later[0].user_text).slice(0, 24));
    }
    byRule.set(ruleId, entry);
  }
}

console.log(`规则触发 ${firings.length} 次 · 窗口 ${windowMs / 60000} 分钟 · 最少样本 ${minSample}`);
if (byRule.size === 0) {
  console.log('无样本：还没有任何规则触发过。');
  process.exit(0);
}

for (const [ruleId, entry] of byRule) {
  if (entry.fired < minSample) {
    console.log(`  ${ruleId}: 触发 ${entry.fired} 次，样本不足，不判决`);
    continue;
  }
  const rate = (entry.followedByCorrection / entry.fired) * 100;
  console.log(`  ${ruleId}: 触发 ${entry.fired}，随后被纠正 ${entry.followedByCorrection}（疑似未遵守 ${rate.toFixed(0)}%）`);
  for (const sample of entry.samples.slice(0, 2)) console.log(`      例: ${sample}`);
}
