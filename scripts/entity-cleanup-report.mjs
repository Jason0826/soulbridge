import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';

const db = new DatabaseSync(join(homedir(), '.soulbridge', 'soul.db'), { readOnly: true });
const rows = db.prepare(
  `SELECT e.id, e.name, e.type, e.aliases,
          (SELECT COUNT(*) FROM fact_slots s WHERE s.entity_id = e.id) AS mentions
     FROM entities e
    ORDER BY mentions DESC, e.name`,
).all();

const suspiciousName = (name) => name.length > 12 || /[的和与]/.test(name);
const byName = new Map();
for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);

const lines = [];
lines.push('# 实体池清理候选（只读提案，未改动数据）');
lines.push('');
lines.push(`共 ${rows.length} 个实体；以下是按规则挑出来的候选，**等你确认后再动**。`);
lines.push('');
lines.push('## 1. 同名但类型不同（可能是同一个人/物被记成两类）');
lines.push('');
let dupes = 0;
for (const [name, group] of byName) {
  if (group.length < 2) continue;
  dupes += 1;
  lines.push(`- **${name}**: ${group.map((row) => `${row.type}(${row.mentions})`).join(' / ')}`);
}
if (dupes === 0) lines.push('- 无');
lines.push('');
lines.push('## 2. 名字像句子（长度 >12 或含“的/和/与”）');
lines.push('');
let bad = 0;
for (const row of rows) {
  if (!suspiciousName(row.name)) continue;
  bad += 1;
  lines.push(`- ${row.name} · ${row.type} · ${row.mentions} 次`);
  if (bad >= 30) break;
}
if (bad === 0) lines.push('- 无');
lines.push('');
lines.push('## 3. 提及次数最多（先看这些值不值得留）');
lines.push('');
for (const row of rows.slice(0, 20)) {
  const aliases = JSON.parse(row.aliases ?? '[]');
  lines.push(`- ${row.name} · ${row.type} · ${row.mentions} 次${aliases.length ? ` · 别名 ${aliases.join('、')}` : ''}`);
}
lines.push('');
lines.push('## 判定标准（我的建议）');
lines.push('');
lines.push('| 情况 | 处理 |');
lines.push('|---|---|');
lines.push('| 同一个人的名字/别名分裂 | 合并到提及最多的一条，别名并集 |');
lines.push('| 术语被当成实体（"注入""结论"） | 删除实体，槽位里的引用改文字；术语不进实体池 |');
lines.push('| 名字是句子 | 删除或改成一个短名词，槽位指向它的事实保留 |');
lines.push('| 只是很久没提 | 不删。实体是身份不是热度，删了历史事实会失去主语 |');

writeFileSync('docs/audit/entity-cleanup-candidates.md', `${lines.join('\n')}\n`, 'utf8');
console.log(`entities=${rows.length} dupes=${dupes} suspicious=${bad}`);
db.close();
