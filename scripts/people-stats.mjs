/**
 * Who do we know, and how thick is what we know about them?
 *
 * "她最近怎么样" is one of the three MVP scenarios, so the question is not whether
 * entities exist but whether anything about the person is stored beyond a name and a
 * relation label. A relation string cannot answer "how close are they now".
 *
 *   node scripts/people-stats.mjs
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });

const byType = db.prepare('SELECT type, COUNT(*) AS n FROM entities GROUP BY type ORDER BY n DESC').all();
console.log('entities by type:', byType.map((row) => `${row.type}=${row.n}`).join(' ') || '(none)');

const withRelation = db
  .prepare(
    `SELECT COUNT(*) AS n FROM entities
     WHERE attrs LIKE '%"relation"%' AND attrs NOT LIKE '%"relation":""%'`,
  )
  .get();
const total = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
console.log(`entities with a relation label: ${withRelation.n}/${total}`);

const person = byType.filter((row) => row.type === 'person').map((row) => row.n).reduce((a, b) => a + b, 0);
console.log(`people known: ${person}`);

const perPerson = db
  .prepare(
    `SELECT e.name, e.attrs, COUNT(s.fact_id) AS facts
     FROM entities e
     LEFT JOIN fact_slots s ON s.entity_id = e.id
     WHERE e.type = 'person'
     GROUP BY e.id ORDER BY facts DESC, e.last_mentioned_at DESC LIMIT 10`,
  )
  .all();
console.log('facts attached per person (top 10):');
for (const row of perPerson) {
  let relation = '';
  try {
    relation = JSON.parse(row.attrs).relation ?? '';
  } catch {
    relation = '';
  }
  console.log(`  ${String(row.facts).padStart(3)}  ${row.name.padEnd(8)} ${relation.slice(0, 20)}`);
}

const affect = db.prepare('SELECT COUNT(*) AS n FROM affect_samples').get().n;
const corrections = db.prepare('SELECT COUNT(*) AS n FROM corrections').get().n;
const gaps = db.prepare('SELECT COUNT(*) AS n FROM gaps').get().n;
console.log(`affect samples: ${affect}  corrections: ${corrections}  gaps: ${gaps}`);
db.close();
