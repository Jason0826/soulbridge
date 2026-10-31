/**
 * 主线演示：一个人、一件事、一个缺口，然后按"关于她"取数。
 * 用法：node --experimental-strip-types scripts/demo-people.mjs [db-path]
 */
import { Soul } from '../packages/core/src/index.ts';
import { openSqlite } from '../packages/core/src/sqlite.ts';

const path = process.argv[2] ?? ':memory:';
const store = openSqlite(path);

// 一个全新的 soul（演示用，不碰真机数据）
const soul = new Soul({ store, soulId: 'demo', userId: 'demo' });

const her = soul.rememberEntity('小林', 'person', { aliases: ['小林姐'], attrs: { relation: '同事' } });
const self = soul.rememberEntity('小灵', 'self');
const company = soul.rememberEntity('某公司', 'thing');

const layoff = soul.recordFact({
  statement: '小林上周被裁员了',
  typeName: '裁员',
  at: Date.now() - 7 * 86400000,
  atText: '上周',
  status: 'none',
  source: 'told',
  slots: [
    { slot: '被裁员者', value: { kind: 'entity', entityId: her.id } },
    { slot: '裁员方', value: { kind: 'entity', entityId: company.id } },
    { slot: '告知者', value: { kind: 'entity', entityId: self.id } },
  ],
});

const gap = soul.recordGap({
  aboutEntityId: her.id,
  aboutFactId: layoff.id,
  topic: '她后来有着落吗',
  tension: 0.6,
});

console.log('人物:', her.name, '/', her.attrs.relation, '/ 别名:', her.aliases.join(','));
console.log('事实:', layoff.statement, '/ 类型:', layoff.typeName, '/ 时间:', layoff.atText, '/ 来源:', layoff.source);
console.log('槽位:', layoff.slots.map((s) => `${s.slot}=${JSON.stringify(s.value)}`).join('  '));
console.log('缺口:', gap.topic, '/ 张力', gap.tension);

const about = soul.factsAbout(her.id);
console.log('\n「关于小林」的取数 →', about.length, '条');
for (const f of about) {
  const when = f.atText ?? new Date(f.at ?? f.createdAt).toISOString().slice(0, 10);
  console.log('  -', f.statement, `(${when})`);
}

console.log('\n未闭合缺口 →', soul.openGaps().map((g) => g.topic).join(' / '));
store.close();
