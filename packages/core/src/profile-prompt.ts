/* ------------------------------------------------------------------ *
 * Profile merging: many judgments → a few that hold up
 * ------------------------------------------------------------------ */

import { PROFILE_DIMENSIONS, dimensionChoices, renderDimensionDefinitions } from './dimensions.ts';

const PROFILE_ROLE = `<role>
你在整理一组"关于这个人的判断"。它们现在又碎又重复，你要把它们合并成更少、更准的句子。
你不添加新判断，只压缩已有的。
</role>`;

/**
 * The merge operations, named.
 *
 * "合并一下" is not an instruction a model can follow reliably; naming the six
 * operations is. The two failure modes seen in a real run — an inverted direction
 * (先→后) and a fragment ("每次因为…") — are called out explicitly because a model
 * that is only told "merge similar items" produces both.
 */
const PROFILE_METHOD = `<method>
合并是把"同一件事的多种说法"收成一句，不是把不同的事拼成一句。可以做的六种操作：

1. 合并同义：两条说同一件事 → 一条，用更具体的那个说法。
2. 提升抽象：两条是同一原则的两个例子 → 提成原则，但必须仍被这两条支持。
3. 保留方向：原文有"先/后""要/不要""多/少""该/不该"，合并后方向必须不变。
   方向反了比漏掉更糟——那是把人写反了。
4. 拆开无关：一句里有两个不相干的点 → 拆成两条，不要用"并且"硬连。
5. 丢弃残句：没有主语、只有半个意思的（"每次…""因为…"）→ 丢弃，不要补全。
6. 排序：${PROFILE_DIMENSIONS.join(' > ')}。
</method>`;

/**
 * What each dimension admits — rendered from the declaration in dimensions.ts.
 *
 * Two model stages ask about dimensions (the merge and the classifier) and they must
 * mean the same thing. Generating the block means a new dimension appears in both
 * prompts automatically instead of drifting in whichever copy was not edited.
 */
export const PROFILE_DIMENSIONS_BLOCK = renderDimensionDefinitions();

const PROFILE_RULES = `<rules>
- 每条 6–32 字，一句一个判断，不编号。
- 一条只讲一件事。禁止用分号把几件事连成一条——那等于没拆。
- 不许出现"有时候/有时/通常/大部分时候"——含糊说明没有真的合并。
- 不许出现"一切/所有/总是/从不"，除非来源原文里就有。
- 每行给一个维度：${dimensionChoices()}
- 一行只讲一个维度。不同维度必须分行——跨维度拼成一句就是没拆。
- 每条必须给来源：来源=fc_xxx,fc_yyy，只能引用 <input> 里出现过的 id；没有来源的整行不要。
- 合并后 5–8 条；宁少不凑。
- 输入里没有的新判断，不许出现。
</rules>`;

const PROFILE_EXAMPLES = `<examples>
<bad>做事后再验证   ← 来源是"做事之前先验证再动手"，方向被写反了</bad>
<good>动手前先验证，不靠推测</good>

<bad>每次因为换工具，换模型而要重复去讲   ← 残句，不是判断</bad>
<good>讨厌为换工具、换模型重复交代</good>

<bad>有时候希望先讨论   ← "有时候"等于没合并</bad>
<good>先讨论清楚再动手</good>

<bad>设指标促成长；记忆衰减想起概率；教训按作用域衰减   ← 分号硬拼三件事</bad>
<good>拆成三条：设指标促成长 / 记忆按想起概率衰减 / 教训按作用域和复现衰减</good>

<bad>要机制并且讨厌重复并且喜欢爬山   ← 三件事硬拼</bad>
<good>拆成三条：要机制不靠自觉 / 讨厌重复交代 / 喜欢爬山</good>
</examples>`;

const PROFILE_EXAMPLE = `<example>
<input>
- fc_a | 用户认为改 prompt 不能有效让模型输出 JSON，主张用工具解析
- fc_b | 结构化输出优先工具解析/模板填充，不靠 prompt 直出 JSON
- fc_c | 用户很讨厌一件事反复讲，换工具又要重新交代
</input>
<output>
画像: 要机制，不要靠 prompt 的自觉 | 维度=${PROFILE_DIMENSIONS[1]} | 来源=fc_a,fc_b
画像: 讨厌重复交代，工具换了也不该重讲 | 维度=${PROFILE_DIMENSIONS[2]} | 来源=fc_c
</output>
</example>`;

export interface ProfileMergePromptInput {
  items: { id: string; statement: string }[];
  /** When set, this batch is already one dimension and the output must stay in it. */
  dimension?: string;
}

/**
 * One dimension per batch.
 *
 * Splitting the input is what actually stops cross-dimension welding; this block
 * only stops the model from re-widening the batch it was handed. The parser rejects
 * a line that leaves the dimension anyway, so this is the explanation, not the guard.
 */
function scopeBlock(dimension: string): string {
  return `<scope>
这一批输入已经按维度分好：全部是「${dimension}」维度的判断。
输出每行都必须是 维度=${dimension}。不要输出别的维度，也不要把别的维度的内容并进来。
如果某条判断其实不属于「${dimension}」，直接丢掉它，不要改写它的维度。
</scope>`;
}

/** Compress a pile of judgments about the person into a few that hold. */
export function renderProfileMergePrompt(input: ProfileMergePromptInput): string {
  const items = input.items.map((item) => `- ${item.id} | ${item.statement.slice(0, 120)}`);
  return [
    PROFILE_ROLE,
    PROFILE_METHOD,
    PROFILE_DIMENSIONS_BLOCK,
    PROFILE_RULES,
    ...(input.dimension ? [scopeBlock(input.dimension)] : []),
    PROFILE_EXAMPLES,
    PROFILE_EXAMPLE,
    ['<input>', ...items, '</input>'].join('\n'),
    '<output>',
  ].join('\n\n');
}
