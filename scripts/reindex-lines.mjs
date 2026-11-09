/**
 * Hand-fix catalog lines the human judge flagged (0029 §五).
 *
 * The classifier writes index lines from the statement with a fixed prompt. When the
 * judge marks a line ✗ and re-asking that same prompt would repeat the fault, the fix
 * is written here instead: drafted by hand, approved by the judge, applied through the
 * same delete+insert transaction `markRuleIndex` uses — a rewrite must replace, not
 * stack (`addSlots` once left two 目录句 rows and rules() read whichever came first).
 *
 * This path carries no form gate on purpose. The gate exists to stop the *model*
 * writing pointer-lines; here the judge is the gate. The JSON file passed with --file
 * is the review artifact: --dry-run prints before/after, and the approved lines land
 * in state.md.
 *
 *   node scripts/reindex-lines.mjs --file fix.json --dry-run
 *   node scripts/reindex-lines.mjs --file fix.json --apply
 *
 * fix.json: [{ "id": "fc_…", "line": "中性陈述，≤30 字" }, …]
 *
 * Exit: 0 wrote (or dry-run printed), 1 a row failed validation or the write did not
 * take, 2 usage.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run');
if (apply === dryRun) {
  console.error('pass exactly one of --dry-run or --apply');
  process.exit(2);
}
const fileAt = process.argv.indexOf('--file');
const filePath = fileAt >= 0 ? process.argv[fileAt + 1] : undefined;
if (!filePath || !existsSync(filePath)) {
  console.error('--file <json> 需要指向一个存在的文件');
  process.exit(2);
}

let plan;
try {
  plan = JSON.parse(readFileSync(filePath, 'utf8'));
} catch (error) {
  console.error(`读不了 ${filePath}：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (!Array.isArray(plan) || plan.length === 0) {
  console.error('计划是空的：需要 [{ id, line }, …]');
  process.exit(1);
}
for (const item of plan) {
  if (!item || typeof item.id !== 'string' || typeof item.line !== 'string' || !item.line.trim()) {
    console.error(`计划项缺 id 或 line：${JSON.stringify(item)}`);
    process.exit(1);
  }
}

const db = new DatabaseSync(join(HOME, 'soul.db'));
// The host writes constantly; wait for the write lock instead of failing on it.
db.exec('PRAGMA busy_timeout = 5000');
const factOf = db.prepare('SELECT id, role, status FROM facts WHERE id = ?');
const linesOf = db.prepare(`SELECT value_text FROM fact_slots WHERE fact_id = ? AND slot = '目录句'`);

const resolved = [];
for (const item of plan) {
  const fact = factOf.get(item.id);
  if (!fact) {
    console.error(`✗ ${item.id}：库里没有这条`);
    process.exit(1);
  }
  if (fact.role !== 'rule') {
    console.error(`✗ ${item.id}：role=${fact.role} 不是规则——目录句只属于规则层`);
    process.exit(1);
  }
  resolved.push({ id: item.id, line: item.line.trim(), status: fact.status, current: linesOf.all(item.id).map((r) => r.value_text) });
}

console.log(`${dryRun ? '[dry-run]' : '[apply]'} 计划 ${resolved.length} 条`);
for (const row of resolved) {
  const now = row.current.join(' ｜ ') || '(无)';
  const unchanged = row.current.length === 1 && row.current[0] === row.line;
  console.log(`  ${row.id}（${row.status}）`);
  console.log(`    旧：${now}`);
  console.log(`    新：${row.line}${unchanged ? '   ← 与现值相同' : ''}${row.current.length > 1 ? `   ← ⚠ 现有 ${row.current.length} 条，本次收敛成 1 条` : ''}`);
}
if (dryRun) {
  console.log('dry-run：没有写库。');
  db.close();
  process.exit(0);
}

// The whole plan is one transaction: every line lands or none does (rule 40), and a
// write that affects 0 rows is a failure, not a success (rule 42).
const del = db.prepare(`DELETE FROM fact_slots WHERE fact_id = ? AND slot = '目录句'`);
const ins = db.prepare(
  `INSERT INTO fact_slots (fact_id, slot, value_type, entity_id, value_num, value_text, ref_fact_id)
   VALUES (?, '目录句', 'text', NULL, NULL, ?, NULL)`,
);
db.exec('BEGIN IMMEDIATE');
try {
  for (const row of resolved) {
    del.run(row.id);
    const written = ins.run(row.id, row.line);
    if (written.changes !== 1) throw new Error(`${row.id}：INSERT 影响 ${written.changes} 行`);
  }
  db.exec('COMMIT');
} catch (error) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // The transaction is already gone; the original error is what matters.
  }
  console.error(`写失败，已回滚：${error instanceof Error ? error.message : String(error)}`);
  db.close();
  process.exit(1);
}

// Read back: the write that is not verified is a claim, not a result.
for (const row of resolved) {
  const after = linesOf.all(row.id).map((r) => r.value_text);
  const ok = after.length === 1 && after[0] === row.line;
  console.log(`${ok ? '✓' : '✗'} ${row.id} → ${after.join(' ｜ ') || '(空)'}`);
  if (!ok) {
    db.close();
    process.exit(1);
  }
}
console.log(`已写 ${resolved.length} 条（每个 id 恰好 1 条目录句）。`);
db.close();
