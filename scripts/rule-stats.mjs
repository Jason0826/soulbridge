/**
 * How many rules did we produce, and how many ever fired?
 *
 * The literature on memory consolidation says an experience becomes a stable
 * belief through *reinstatement* — repeated replay across episodes — not on its
 * first occurrence. If most rules came from a single lesson and almost none ever
 * fires, the rule layer is over-producing promotion, not under-retrieving.
 *
 *   node scripts/rule-stats.mjs
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });

const byType = db
  .prepare("SELECT type_name, COUNT(*) AS n FROM facts WHERE status != 'superseded' GROUP BY type_name ORDER BY n DESC")
  .all();
console.log('active facts by type:', byType.map((row) => `${row.type_name}=${row.n}`).join(' '));

const rules = db
  .prepare(
    `SELECT f.id, f.statement,
            (SELECT s.value_text FROM fact_slots s WHERE s.fact_id = f.id AND s.slot = '触发' LIMIT 1) AS trigger,
            (SELECT COUNT(*) FROM fact_slots s WHERE s.fact_id = f.id AND s.slot = '来源') AS sources
     FROM facts f WHERE f.type_name = '规则' AND f.status != 'superseded'`,
  )
  .all();
console.log(`active rules: ${rules.length}, with a trigger: ${rules.filter((r) => r.trigger).length}`);
console.log(`rules citing >=1 source: ${rules.filter((r) => r.sources > 0).length}`);

// Firing history: a rule that never fires is a rule that was promoted too early.
const fired = new Map();
const traceFile = join(HOME, 'trace.jsonl');
if (existsSync(traceFile)) {
  const reader = createInterface({ input: createReadStream(traceFile), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.includes('rule_fired')) continue;
    try {
      const event = JSON.parse(line);
      if (event.event !== 'rule_fired') continue;
      for (const id of event.rules ?? (event.rule ? [event.rule] : [])) {
        fired.set(id, (fired.get(id) ?? 0) + 1);
      }
    } catch {
      /* a truncated line is not a firing */
    }
  }
}
const known = new Set(rules.map((rule) => rule.id));
const firedKnown = [...fired.keys()].filter((id) => known.has(id));
console.log(`distinct rules fired in trace: ${firedKnown.length}/${rules.length}`);
const never = rules.filter((rule) => !fired.has(rule.id));
console.log(`rules that never fired: ${never.length}`);
for (const rule of never.slice(0, 8)) {
  console.log(`  ${rule.id} | ${rule.statement.slice(0, 36)} | trigger=${(rule.trigger ?? '').slice(0, 40)}`);
}

const profiles = db
  .prepare(
    `SELECT COUNT(*) AS n FROM facts WHERE type_name = '画像' AND status != 'superseded'
     AND NOT EXISTS (SELECT 1 FROM fact_slots s WHERE s.fact_id = facts.id AND s.slot = '来源')`,
  )
  .get();
console.log(`profile lines with no source (promoted from one impression): ${profiles.n}`);
db.close();
