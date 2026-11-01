/**
 * Every prompt lives here, once.
 *
 * Prompts are product surface: they decide what the soul remembers, so they are
 * versioned with the code and rendered from structured inputs rather than
 * concatenated at the call site. One definition, many renderers.
 *
 * Convention (from the extraction-prompt patterns review):
 *   - narrow the role, and say who consumes the output
 *   - schema in the prompt, with the allowed values spelled out
 *   - "omit if uncertain" rather than a bare "do not invent"
 *   - few-shot examples, cleanest last
 *   - wrap the data, never inline it next to the instructions
 *   - end with the output anchor
 */

export interface KnownEntityPrompt {
  id: string;
  name: string;
  aliases?: string[];
  relation?: string;
}

export interface KnownFactPrompt {
  id: string;
  statement: string;
  atText?: string;
}

export interface ExtractionPromptInput {
  /** The turn's user text. */
  text: string;
  /** Date the turn happened; relative times resolve against it. */
  now: number;
  entities?: KnownEntityPrompt[];
  facts?: KnownFactPrompt[];
  previousUserText?: string;
}

const EXTRACTION_ROLE = `<role>
你是记忆抽取器。你只从对话里抽取可验证的事实，不做判断、不给建议、不写总结。
你的输出由一个确定性的程序消费，它不会读你的解释。
</role>`;

const EXTRACTION_SCHEMA = `<output-format>
不要输出 JSON。按下面的表格一行一条填写，字段之间用 | 分隔，没有内容的字段留空。
可以只写其中几行；什么都记不住就只写：无

实体: 名字 | 类型 | 关系
事实: 陈述 | 类型名 | 日期(YYYY-MM-DD) | 时间原文 | 来源 | 置信(0-1) | 槽位
缺口: 主题 | 张力(0-1) | 相关实体

填写说明：
- 类型只能是 person / thing / place / self；关系可空。
- 陈述要自包含（15–80 字），把代词换成名字，保留数字和专有名词。
- 日期换算不出来就留空，把原话写进"时间原文"。
- 来源：experienced（亲历）/ told（听说的）/ inferred（推断的）。
- 槽位写成 名称=值，多个用 ; 隔开；值是数字就写数字，是实体就写实体名。
- 示例：
实体: 小林 | person | 同事
事实: 小林在 2026-10-24 那周被裁员 | 裁员 | 2026-10-24 | 上周 | told | 0.8 | 被裁员者=小林
缺口: 小林后来有着落吗 | 0.6 | 小林
</output-format>`;

const EXTRACTION_RULES = `<rules>
- op 只有三种值：add / supersede / update / noop。supersede 与 update 必须给 target（<known-facts> 里的 id）。
- 实体：一个真实的人或物只出现一次；同一个名字只给一个 type。type 只能是 person / thing / place / self。
  技术名词、以“和/与/或”连接的两个词、代词（她/他/这个/那个）都不是人名。
- type 判定：会说话、有意图的 → person；机构、物件、产品、技术概念 → thing；地理位置 → place；助手自己 → self。
- 陈述（statement）：自包含，15–80 字；把代词换成名字；保留专有名词、职位、数字、具体属性等细节，不要泛化。
- 时间：先按 <observation-date> 把“昨天/上周/上个月”换算成 YYYY-MM-DD 填入 at，同时把原文写进 at_text。
  换算不了（如“以前”“最近”）就只填 at_text，不要猜。
- 来源：用户亲历 experienced；听别人说的 told；你推断的 inferred。
- 合并：与 <known-facts> 语义相同 → noop；互相矛盾 → supersede 并给 target；是补充 → update。
  相关但独立 → add。不要用 <known-facts> 里没有的新事实去 supersede。
- 不确定就省略字段，绝不编造数字、日期、关系。
- 不要抽助手对自己的描述，也不要重复用户刚落的话（回声不算新事实）。
</rules>

<when-to-write>
只在这四种情况下写事实：
1. 某个人或某件事的状态、经历（“小林换了工作”“那个项目黄了”）
2. 一个决定，以及做这个决定的理由
3. 用户表达的偏好、原则或习惯（“我讨厌反复讲同一件事”）
4. 我给出的承诺（“我明天把表补上”）

**不要写**（这是最常见的噪声）：
- 用户对我的要求、提问、催促、同意、否定——这些是对话动作，对话原文已经保存，再写一份只会变成噪声
- 我问用户的澄清问题
- 寒暄、我的自我介绍、我对能力的说明
- 用户正在问我的事，不是“关于用户的事实”
</when-to-write>

<gaps>
只有两种情况建缺口：
1. 用户说自己不知道、没消息、想知道某件事（“她后来怎么样了”“不知道还在不在”）
2. 我说过要做、但状态仍未完成的事

用户只是在问我一个问题时**不要**建缺口——那是他在提问，不是他缺信息。
</gaps>`;

const EXTRACTION_EXAMPLES = `<examples>
<example>
<source>我同事小林上周被裁员了，挺难受的</source>
<output>实体: 小林 | person | 同事
事实: 小林在 2026-10-24 那周被裁员 | 裁员 | 2026-10-24 | 上周 | told | 0.8 | 被裁员者=小林</output>
</example>
<example>
<source>这个 bug 我上周就修好了</source>
<output>事实: 用户说他在 2026-10-24 那周修好了这个 bug | 修复 | 2026-10-24 | 上周 | experienced | 0.7 | 修复者=用户</output>
</example>
<example>
<source>好的，谢谢</source>
<output>无</output>
</example>
<example>
<source>你帮我把那个表重新跑一遍</source>
<output>无</output>
</example>
<example>
<source>我讨厌同一件事反复讲，换个工具又要重新说一遍</source>
<output>事实: 用户讨厌同一件事反复讲，换工具也不想重复交代 | 偏好 | | | experienced | 0.9 | 偏好主体=用户</output>
</example>
</examples>`;

function isoDate(at: number): string {
  const d = new Date(at);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function renderKnownEntities(entities: KnownEntityPrompt[]): string {
  if (entities.length === 0) return '<known-entities>（空）</known-entities>';
  const lines = entities.slice(0, 30).map((e) => {
    const aliases = e.aliases?.length ? `（别名：${e.aliases.join('、')}）` : '';
    const relation = e.relation ? `，${e.relation}` : '';
    return `  - ${e.name}${aliases}${relation}`;
  });
  return ['<known-entities>', ...lines, '</known-entities>'].join('\n');
}

function renderKnownFacts(facts: KnownFactPrompt[]): string {
  if (facts.length === 0) return '<known-facts>（空）</known-facts>';
  const lines = facts.slice(0, 20).map((f) => `  - [${f.id}] ${f.statement}${f.atText ? `（${f.atText}）` : ''}`);
  return ['<known-facts>', ...lines, '</known-facts>'].join('\n');
}

/**
 * The extraction prompt. Every piece comes from a named block above, so a rule
 * is edited in one place and shows up in every host's extraction call.
 */
export function renderExtractionPrompt(input: ExtractionPromptInput): string {
  const context = [
    '<context>',
    `  <observation-date>${isoDate(input.now)}</observation-date>`,
    renderKnownEntities(input.entities ?? []),
    renderKnownFacts(input.facts ?? []),
    input.previousUserText ? `<previous-user>${input.previousUserText.slice(0, 200)}</previous-user>` : '',
    '</context>',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    EXTRACTION_ROLE,
    '<task>把 <source> 里的信息变成记忆操作。只依据 <source> 与 <previous-user>；<known-facts> 只用于判断冲突与去重。</task>',
    EXTRACTION_SCHEMA,
    EXTRACTION_RULES,
    EXTRACTION_EXAMPLES,
    context,
    `<source>\n${input.text}\n</source>`,
    '<output>',
  ].join('\n\n');
}
