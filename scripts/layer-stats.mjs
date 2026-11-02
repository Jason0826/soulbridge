/**
 * The two-layer distribution (ADR 0032), for judging whether extraction behaves.
 *
 * World facts must be locatable (or honestly unknown); a mind's opinions must carry
 * that mind as holder and no event time. This prints the numbers that tell whether
 * the prompt is doing that, instead of guessing from a few samples.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const one = (sql, ...args) => db.prepare(sql).get(...args).n;

const facts = one("SELECT COUNT(*) n FROM facts WHERE status != 'superseded' AND COALESCE(type_name,'') != '结论'");
const world = one("SELECT COUNT(*) n FROM facts WHERE status != 'superseded' AND holder = 'world' AND COALESCE(type_name,'') != '结论'");
const mind = facts - world;
const unknownTime = one(
  "SELECT COUNT(*) n FROM facts WHERE status != 'superseded' AND holder = 'world' AND at_precision = 'unknown' AND COALESCE(type_name,'') != '结论'",
);
const conclusions = one("SELECT COUNT(*) n FROM facts WHERE type_name = '结论' AND status != 'superseded'");
const entities = one('SELECT COUNT(*) n FROM entities');
const gaps = one("SELECT COUNT(*) n FROM gaps WHERE status = 'open'");
const timeGaps = one("SELECT COUNT(*) n FROM gaps WHERE status = 'open' AND topic LIKE '日期不明%'");

const pct = (part, whole) => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(0)}%`);

console.log('两层记忆分布（ADR 0032）');
console.log('');
console.log(`事实           ${facts}`);
console.log(`  世界层       ${world}    （其中时间未知 ${unknownTime} = ${pct(unknownTime, world)}）`);
console.log(`  人物层       ${mind}    = ${pct(mind, facts)}`);
console.log(`结论           ${conclusions}`);
console.log(`实体           ${entities}`);
console.log(`缺口           ${gaps}    （其中时间不明 ${timeGaps}）`);
console.log('');
console.log('目标：人物层 > 0；世界层时间未知率下降；时间不明的缺口可被追问');
db.close();
