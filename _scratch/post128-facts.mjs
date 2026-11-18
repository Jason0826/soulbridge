/** 只读：0.0.128 后 3 条新事实全文（目的/归属生产首验） */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const live = Date.parse('2026-11-16T08:02:16Z');
const db = new DatabaseSync(join(homedir(), '.soulbridge', 'soul.db'), { readOnly: true });
const rows = db
  .prepare('SELECT id, type_name, statement, role, holder, created_at FROM facts WHERE created_at >= ? ORDER BY created_at')
  .all(live);
for (const r of rows) {
  console.log(`${new Date(r.created_at).toISOString().slice(5, 16)} [${r.type_name}/${r.role}/${r.holder}] ${r.id}`);
  console.log(`  ${r.statement}`);
}
db.close();
