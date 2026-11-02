import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
try {
  const queue = JSON.parse(readFileSync(join(HOME, 'pending-classify.json'), 'utf8'));
  console.log(`classify queue: ${Array.isArray(queue) ? queue.length : 0}`);
} catch {
  console.log('classify queue: unreadable');
}

const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const rows = db
  .prepare(
    "SELECT COALESCE(type_name,'-') AS t, COUNT(*) AS n FROM facts WHERE status != 'superseded' GROUP BY type_name ORDER BY n DESC",
  )
  .all();
for (const row of rows) console.log(`${row.t}\t${row.n}`);
db.close();
