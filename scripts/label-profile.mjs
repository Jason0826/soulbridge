/**
 * Label the profile lines written before dimensions existed (one-off, 2026-11-02).
 *
 * The assignment is by reading each line, not by keyword guessing: a wrong dimension
 * decides when the line gets injected, and a wrong injection is worse than none.
 *
 *   node scripts/label-profile.mjs --dry-run
 *   node scripts/label-profile.mjs --apply
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const apply = process.argv.includes('--apply');
if (!apply && !process.argv.includes('--dry-run')) {
  console.error('pass --dry-run or --apply');
  process.exit(2);
}

/** id → dimension, decided by reading the statement. */
const LABELS = {
  fc_lg_mem_mvyny3vm_snq6: '工作方式', // dsh 归档 session 即结束
  fc_mvz5rlau_1: '价值观', // 思想比落地更宝贵
  fc_mvz5rlb5_2: '人际关系', // 了解人靠具体事件
  fc_mvz5rlbk_3: '工作方式', // 根本、架构、设计入手
  fc_mvz5rlbx_4: '工作方式', // 整体大局、真实世界
  fc_mvz5rlca_5: '工作方式', // 目的实现为准、假设求证
  fc_mvz5rlck_6: '工作方式', // 教训、记忆衰减
  fc_mvz5rlcw_7: '沟通偏好', // 讨厌重复交代
  fc_mvz5rlf0_8: '沟通偏好', // 整轮有效
};

const db = new DatabaseSync(join(HOME, 'soul.db'));
const rows = db
  .prepare(
    `SELECT f.id, f.statement,
            (SELECT s.value_text FROM fact_slots s WHERE s.fact_id = f.id AND s.slot = '维度' LIMIT 1) AS dimension
     FROM facts f
     WHERE f.type_name = '画像' AND f.status != 'superseded'`,
  )
  .all();

let labelled = 0;
for (const row of rows) {
  const dimension = LABELS[row.id];
  if (row.dimension || !dimension) {
    if (!row.dimension) console.log(`skip (no mapping): ${row.id} | ${row.statement.slice(0, 30)}`);
    continue;
  }
  console.log(`${row.id} → ${dimension} | ${row.statement.slice(0, 34)}`);
  if (apply) {
    db.prepare(
      "INSERT INTO fact_slots (fact_id, slot, value_type, value_text) VALUES (?, '维度', 'text', ?)",
    ).run(row.id, dimension);
  }
  labelled += 1;
}
console.log(`${apply ? 'labelled' : 'would label'} ${labelled} of ${rows.length}`);
db.close();
