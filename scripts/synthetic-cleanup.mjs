#!/usr/bin/env node
/**
 * 合成注入实验 · 窗口清理（truth §7，三条断言全过才收窗口）。
 *
 *   node scripts/synthetic-cleanup.mjs [--ids <out.json>]
 *
 * 只按 ids 清单删（id 是引用、名字是属性——不按名字/前缀扫，防误伤）：
 * ① 清单内行数归零   ② xiaoling 存量只增不减   ②b 没有清单外的行引用我们的实体
 * 锚词回 0（断言③）由 _scratch/q-synth-words.mjs 复跑。
 * 任一断言失败 = FAIL 停手申报，不硬删（truth §7）。
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const idsPath = arg('ids', join(process.cwd(), '_scratch', 'synthetic-injected-ids.json'));
if (!existsSync(idsPath)) { console.error(`refused: ${idsPath} not found — nothing to clean`); process.exit(2); }
const payload = JSON.parse(readFileSync(idsPath, 'utf8'));

const db = new DatabaseSync(payload.target); // 生产库（inject 写死的同一路径）
const n = (table, where, ...a) => db.prepare(`select count(*) c from ${table} where ${where}`).get(...a).c;
const listed = (table) => payload.ids[table] ?? [];
const existsNow = (table) => {
  const list = listed(table);
  if (!list.length) return 0;
  const ph = list.map(() => '?').join(',');
  return db.prepare(`select count(*) c from ${table} where id in (${ph})`).get(...list).c;
};

// —— 前查：清单行必须全在（部分存在 = 上次窗口没清干净或被人动过，停手）——
let missing = 0;
for (const table of Object.keys(payload.ids)) {
  const expect = listed(table).length;
  const now = existsNow(table);
  if (now !== expect) { console.log(`precheck ${table}: listed=${expect} present=${now}`); missing += expect - now; }
}
if (missing !== 0) { console.error(`FAIL: ${missing} listed rows missing — refusing partial cleanup, human review needed`); process.exit(1); }

// —— 删除：依赖逆序 ——
const order = ['fact_slots', 'steps', 'gaps', 'threads', 'facts', 'entities', 'turns'];
db.exec('BEGIN');
try {
  for (const table of order) {
    const list = listed(table);
    if (!list.length) continue;
    const ph = list.map(() => '?').join(',');
    db.prepare(`delete from ${table} where id in (${ph})`).run(...list);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  console.error(`cleanup failed, rolled back: ${error.message}`);
  process.exit(1);
}

// —— 断言 ——
let fail = 0;
for (const table of Object.keys(payload.ids)) {
  const left = existsNow(table);
  if (left !== 0) { console.log(`FAIL ① ${table}: ${left} listed rows remain`); fail = 1; }
}
// ②b 清单外的行不许引用我们的实体（真实抽取在窗口里提到了合成实体 → 停手）
const ourEntities = payload.ids.entities ?? [];
if (ourEntities.length) {
  const ph = ourEntities.map(() => '?').join(',');
  const extRefs = db
    .prepare(`select count(*) c from fact_slots where entity_id in (${ph})`)
    .get(...ourEntities).c;
  // 我们自己的 slots 已随清单删除；剩 0 才干净
  if (extRefs !== 0) { console.log(`FAIL ②b: ${extRefs} slots outside our list reference our entities`); fail = 1; }
}
// ② xiaoling 存量只增不减
const after = {
  facts: n('facts', 'soul_id=?', payload.targetSoul),
  entities: n('entities', 'soul_id=?', payload.targetSoul),
  turns: n('turns', 'soul_id=?', payload.targetSoul),
};
for (const key of Object.keys(after)) {
  if (after[key] < payload.baseline[key]) {
    console.log(`FAIL ② ${key}: ${after[key]} < baseline ${payload.baseline[key]}`);
    fail = 1;
  }
}
console.log(`after xiaoling: facts=${after.facts} entities=${after.entities} turns=${after.turns} (baseline ${JSON.stringify(payload.baseline)})`);
db.close();

if (fail) { console.log('RESULT: FAIL — 停手申报（truth §7），ids 文件保留供人工复核'); process.exit(1); }
unlinkSync(idsPath); // 断言全过才销毁清单
console.log('RESULT: PASS — 窗口关闭；复跑 _scratch/q-synth-words.mjs 完成断言③');
