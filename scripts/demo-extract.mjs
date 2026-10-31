/**
 * 抽取演示：一句话 → 草案 → 闸门 → 库。
 * 用法：node --experimental-strip-types scripts/demo-extract.mjs
 */
import { Soul } from '../packages/core/src/index.ts';
import { openSqlite } from '../packages/core/src/sqlite.ts';

const store = openSqlite(':memory:');
const soul = new Soul({ store, soulId: 'demo', userId: 'demo' });

const lines = [
  '我同事小林上周被裁员了，挺难受的。不知道她后来怎么样了',
  '今天下雨了',
];

for (const text of lines) {
  const draft = await soul.extract(text);
  console.log(`\n输入: ${text}`);
  console.log(
    `草案: 人 ${draft.entities.map((e) => `${e.name}(${e.attrs?.relation ?? '?'})`).join('、') || '无'}` +
      ` · 事 ${draft.facts.map((f) => `${f.statement}${f.atText ? `[${f.atText}]` : ''}`).join('；') || '无'}` +
      ` · 缺口 ${draft.gaps.map((g) => g.topic).join('；') || '无'}`,
  );
  const result = soul.commitDrafts(draft);
  console.log(
    `写入: 人 ${result.entities.length} · 事 ${result.facts.length} · 缺口 ${result.gaps.length}` +
      (result.skipped.length ? ` · 拒绝 ${result.skipped.map((s) => `${s.what}(${s.reason})`).join(',')}` : ''),
  );
}

const her = soul.findEntities('小林')[0];
console.log(`\n关于小林 → ${soul.factsAbout(her.id).map((f) => f.statement).join(' / ') || '空'}`);
console.log(`开着的缺口 → ${soul.openGaps().map((g) => g.topic).join(' / ') || '空'}`);
store.close();
