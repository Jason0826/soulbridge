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

const EXTRACTION_SCHEMA = `<output-schema>
{"entities":[{"name":"小林","type":"person","aliases":["小林姐"],"attrs":{"relation":"同事"}}],
 "operations":[
   {"op":"add","fact":{"statement":"小林在 2026-10-24 那周被裁员","type_name":"裁员",
      "at":"2026-10-24","at_text":"上周","source":"told","confidence":0.8,
      "slots":[{"slot":"被裁员者","entity":"小林"},{"slot":"裁员人数","number":300}]}},
   {"op":"supersede","target":"fc_ab12","fact":{"statement":"小林在 2026-10-31 找到新工作",
      "at":"2026-10-31","at_text":"今天","source":"told","confidence":0.8,
      "slots":[{"slot":"入职者","entity":"小林"}]}},
   {"op":"noop"}
 ],
 "gaps":[{"topic":"她后来有着落吗","about":"小林","tension":0.6}]}
</output-schema>`;

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
- 问句、请求、同意、拒绝本身也是事件，要抽成 fact（type_name 用“提问/请求/同意/拒绝”）。
- 不要抽助手对自己的描述，也不要重复用户刚落的话（回声不算新事实）。
</rules>`;

const EXTRACTION_EXAMPLES = `<examples>
<example>
<source>我同事小林上周被裁员了，挺难受的</source>
<output>{"entities":[{"name":"小林","type":"person","attrs":{"relation":"同事"}}],
"operations":[{"op":"add","fact":{"statement":"小林在 2026-10-24 那周被裁员",
"type_name":"裁员","at":"2026-10-24","at_text":"上周","source":"told","confidence":0.8,
"slots":[{"slot":"被裁员者","entity":"小林"}]}}],"gaps":[]}</output>
</example>
<example>
<source>这个 bug 我上周就修好了</source>
<output>{"entities":[],"operations":[{"op":"add","fact":{
"statement":"用户说他上周修好了这个 bug","at_text":"上周","source":"experienced","confidence":0.7,
"slots":[{"slot":"修复者","entity":"用户"}]}}],"gaps":[]}</output>
</example>
<example>
<source>好的，谢谢</source>
<output>{"entities":[],"operations":[{"op":"noop"}],"gaps":[]}</output>
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
