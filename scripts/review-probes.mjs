/**
 * Code-review probes: the claims in docs/audit/2026-11-02-code-review.md that were
 * reproduced on the real code. Run after touching retrieval, extraction or the
 * profile gates — each line below is a bug that shipped once.
 *
 *   node scripts/review-probes.mjs
 *
 * A probe failing means the bug is back, not that the probe is wrong: these were
 * written against the original behaviour.
 */
import { planRetrieval, subjectCandidate } from '../packages/core/src/retrieval.ts';
import { parseProfileMerge } from '../packages/core/src/consolidate.ts';
import { validateDraft, parseLineDraft } from '../packages/core/src/extract.ts';
import { openSqlite } from '../packages/core/src/sqlite.ts';
import { Soul } from '../packages/core/src/index.ts';

const at = Date.parse('2026-11-02T10:00:00Z');
const names = ['a', '用户', '小凌', 'dsh', '情绪', 'handoff 文件', 'soulbridge'];

console.log('--- 检索路由：实体类型与 1 字名都不该劫持普通消息 ---');
{
  // Through the Soul method, not the bare function: it is the method that decides
  // which entity types may be a subject (only person/place/self qualify).
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  store.putEntity({ soulId: 's1', userId: 'u1', type: 'person', name: 'a' });
  store.putEntity({ soulId: 's1', userId: 'u1', type: 'person', name: '小林' });
  store.putEntity({ soulId: 's1', userId: 'u1', type: 'thing', name: '情绪' });
  store.putEntity({ soulId: 's1', userId: 'u1', type: 'thing', name: 'handoff 文件' });
  for (const q of ['把 package.json 的版本号改一下', '我觉得它的情绪不太对', '看一下 handoff 文件的格式', '上次和小林吃饭聊了什么']) {
    const plan = soul.planRetrieval(q);
    console.log(`  ${plan.primitive}${plan.subject ? `(${plan.subject})` : ''}  ← ${q}`);
  }
  store.close();
}

console.log('--- 连词后不该凭空造主语 ---');
for (const q of ['跟上次一样就行', '和数据保持一致', '我和他一起去的']) {
  console.log(`  ${String(subjectCandidate(q))}  ← ${q}`);
}

console.log('--- 合并 prompt 的示例必须能过自己的闸门 ---');
{
  // Read the example out of the prompt itself: a hand-copied example drifts from the
  // one the model sees, and that is exactly how the bug shipped.
  const { renderProfileMergePrompt } = await import('../packages/core/src/profile-prompt.ts');
  const prompt = renderProfileMergePrompt({ items: [{ id: 'fc_a', statement: '占位' }] });
  const example = /<output>\n([\s\S]*?)\n<\/output>/.exec(prompt)?.[1] ?? '';
  const lines = parseProfileMerge(example, new Set(['fc_a', 'fc_b', 'fc_c']));
  console.log(`  示例输出通过 ${lines.length} 行（期望 2）`);
}

console.log('--- 正反两句不能被折叠成一句 ---');
const pair = parseProfileMerge(
  ['画像: 喜欢爬山和露营 | 维度=生活兴趣 | 来源=fc_a', '画像: 不喜欢爬山和露营 | 维度=生活兴趣 | 来源=fc_b'].join('\n'),
  new Set(['fc_a', 'fc_b']),
);
console.log(`  保留 ${pair.length} 条（期望 2）: ${pair.map((p) => p.statement).join(' / ')}`);

console.log('--- JSON 形状的抽取结果必须能落库 ---');
{
  const parsed = validateDraft(
    {
      entities: [{ name: '小林', type: 'person' }],
      facts: [
        {
          statement: '小林在十月被裁员一次',
          at_text: '上周',
          source: 'told',
          confidence: 0.8,
          slots: [{ slot: '被裁员者', entity: '小林' }],
        },
      ],
    },
    at,
    undefined,
  );
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const result = soul.commitDrafts(parsed.draft, { turnId: 't1' });
  console.log(`  落库 ${result.facts.length} 条（期望 1），skipped=${JSON.stringify(result.skipped)}`);
  store.close();
}

console.log('--- 描述性槽位值不该让整条事实被拒 ---');
{
  const parsed = parseLineDraft(
    '事实: 小林在十月的裁员中离开公司 | 裁员 | 2026-10-24 | 上周 | told | 0.8 | 持有=world | 精度=day | 被裁员者=小林;原因=公司裁员',
  );
  const store = openSqlite(':memory:');
  const soul = new Soul({ store, soulId: 's1', userId: 'u1' });
  const draft = validateDraft({ operations: [{ op: 'add', fact: parsed.operations[0].fact }] }, at, undefined);
  const result = soul.commitDrafts(draft.draft, { turnId: 't1' });
  console.log(`  落库 ${result.facts.length} 条（期望 1，未声明实体应先声明）：skipped=${JSON.stringify(result.skipped)}`);
  store.close();
}

console.log('--- 空置信字段应回落默认值而不是 0 ---');
{
  const parsed = parseLineDraft(
    '事实: 用户讨厌重复解释同一件事 | 偏好 | 2026-10-24 | 上周 | told |  | 持有=用户 | 精度=day',
  );
  console.log(`  confidence=${parsed.operations[0].fact.confidence}（期望 0.6）`);
}

console.log('--- 不存在的日期应被拒，而不是滚动 ---');
{
  const parsed = parseLineDraft(
    '事实: 用户在二月底做了某件事 | 事件 | 2026-02-31 | | told | 0.8 | 持有=world | 精度=day',
  );
  console.log(`  2026-02-31 → ${new Date(parsed.operations[0].fact.at).toISOString().slice(0, 10)}（期望被拒）`);
}
