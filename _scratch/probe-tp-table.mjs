/** 只读：tp_ id 落在哪张表 + 最近抽取有无 sup>0（辨别样本） */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(join(homedir(), '.soulbridge', 'soul.db'), { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
console.log('tables:', tables.join(', '));
for (const t of tables) {
  if (!/pair|turn|link/i.test(t)) continue;
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  console.log(` ${t}: ${cols.join(', ')}`);
}
db.close();
