#!/usr/bin/env node
/**
 * 合成注入实验 · 读侧窗口写入（truth §5）。
 *
 *   node scripts/synthetic-inject.mjs [--db <harness.db>] [--ids <out.json>] [--soul book-synth]
 *
 * 把 harness.db 里【写侧已验证】的行整体复制进生产库 xiaoling——不重演抽取：
 * 读侧考的是"送达"，库内容必须是写侧判定过的状态，不引入模型方差。
 * 复制出的全部行 id 写进 ids 文件，cleanup 按它精确删除（truth §7）。
 *
 * 不复制 turn_pairs：feed 的问答对里有原文，若进生产，<related> 会召回原始
 * 故事文本——那测的是召回通道，不是事实注入，会把结论带偏。
 *
 * 目标写死为 <home>/soul.db（本脚本存在的意义就是开这个窗口），无参数可改道；
 * 源侧走 harness-db.mjs（拒绝生产库）——两个脚本的护栏互为镜像。
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { resolveHarnessDb, soulbridgeHome } from './harness-db.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};

const srcPath = resolveHarnessDb(arg('db', null));
const soulId = arg('soul', 'book-synth');
const targetSoul = 'xiaoling';
const idsPath = arg('ids', join(process.cwd(), '_scratch', 'synthetic-injected-ids.json'));
mkdirSync(dirname(idsPath), { recursive: true }); // 目录不假设存在：写清单在 COMMIT 之后，ENOENT 会留下“已注入、无清单”的半截状态
const prodPath = join(soulbridgeHome(), 'soul.db');

if (existsSync(idsPath)) {
  console.error(`refused: ${idsPath} exists — a previous window was not cleaned up; run synthetic-cleanup.mjs first`);
  process.exit(2);
}

const src = new DatabaseSync(srcPath, { readOnly: true });
const srcSoul = src.prepare('select soul_id from souls where soul_id=?').get(soulId);
if (!srcSoul) { console.error(`refused: soul "${soulId}" not in ${srcPath}`); process.exit(2); }
const n = (db, table, where, ...a) => db.prepare(`select count(*) c from ${table} where ${where}`).get(...a).c;
if (n(src, 'facts', 'soul_id=?', soulId) === 0) { console.error('refused: source soul has 0 facts — run the write side first (truth §4)'); process.exit(2); }

const prod = new DatabaseSync(prodPath); // rw；WAL 下与 host 并发安全
const has = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

// 复制顺序 = 依赖序：turns → 引用它们的 steps → facts/entities → slots 最后
const plan = [
  { table: 'turns', filter: (db) => ['soul_id=?', soulId] },
  { table: 'steps', filter: () => null, via: { table: 'turns', col: 'turn_id' } },
  { table: 'facts', filter: () => ['soul_id=?', soulId] },
  { table: 'entities', filter: () => ['soul_id=?', soulId] },
  { table: 'gaps', filter: () => ['soul_id=?', soulId] },
  { table: 'threads', filter: () => ['soul_id=?', soulId] },
  { table: 'fact_slots', filter: () => null, via: { table: 'facts', col: 'fact_id' } },
];

const baseline = {
  facts: n(prod, 'facts', 'soul_id=?', targetSoul),
  entities: n(prod, 'entities', 'soul_id=?', targetSoul),
  turns: n(prod, 'turns', 'soul_id=?', targetSoul),
};
const ids = {};
const owned = { turns: [], facts: [] };

prod.exec('BEGIN');
try {
  for (const step of plan) {
    const { table } = step;
    let rows;
    if (step.via) {
      const parents = owned[step.via.table === 'turns' ? 'turns' : 'facts'];
      if (!parents.length) { ids[table] = []; continue; }
      const ph = parents.map(() => '?').join(',');
      rows = src.prepare(`select * from ${table} where ${step.via.col} in (${ph})`).all(...parents);
    } else {
      const [where, ...a] = step.filter();
      rows = src.prepare(`select * from ${table} where ${where}`).all(...a);
    }
    ids[table] = rows.map((r) => r.id);
    if (table === 'turns') owned.turns = ids[table];
    if (table === 'facts') owned.facts = ids[table];
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const sql = `insert into ${table} (${cols.join(',')}) values (${cols.map(() => '?').join(',')})`;
    const stmt = prod.prepare(sql);
    for (const row of rows) {
      const out = { ...row };
      if (has(prod, table, 'soul_id')) out.soul_id = targetSoul;
      stmt.run(...cols.map((c) => out[c]));
    }
    console.log(`copied ${table}: ${rows.length}`);
  }
  prod.exec('COMMIT');
} catch (error) {
  prod.exec('ROLLBACK');
  console.error(`inject failed, rolled back: ${error.message}`);
  process.exit(1);
}

const payload = {
  at: new Date().toISOString(),
  source: srcPath,
  target: prodPath,
  soul: soulId,
  targetSoul,
  baseline,
  ids,
};
writeFileSync(idsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
const total = Object.values(ids).reduce((sum, list) => sum + list.length, 0);
console.log(`\ninjected ${total} rows → ${targetSoul}@${prodPath}`);
console.log(`baseline(xiaoling): facts=${baseline.facts} entities=${baseline.entities} turns=${baseline.turns}`);
console.log(`ids → ${idsPath}`);
console.log('NOW: open a fresh session and ask all questions in the first turn (truth §5, §6-B)');
console.log('then: node scripts/synthetic-cleanup.mjs');
src.close();
prod.close();
