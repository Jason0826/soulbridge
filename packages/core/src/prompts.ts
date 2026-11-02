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

export interface KnownThreadPrompt {
  id: string;
  topic: string;
  /** How many turns ago this thread was last seen. */
  ago?: number;
}

export interface ExtractionPromptInput {
  /** The turn's user text. */
  text: string;
  /** Date the turn happened; relative times resolve against it. */
  now: number;
  entities?: KnownEntityPrompt[];
  facts?: KnownFactPrompt[];
  previousUserText?: string;
  /** Open topic threads: the candidate list for attribution. */
  threads?: KnownThreadPrompt[];
  /** Which thread the previous turn belonged to, when known. */
  previousThreadId?: string;
}

const EXTRACTION_ROLE = `<role>
你是记忆抽取器。你只从对话里抽取可验证的事实，不做判断、不给建议、不写总结。
你的输出由一个确定性的程序消费，它不会读你的解释。
</role>`;

const EXTRACTION_SCHEMA = `<output-format>
不要输出 JSON。按下面的表格一行一条填写，字段之间用 | 分隔，没有内容的字段留空。
可以只写其中几行；什么都记不住就只写：无

实体: 名字 | 类型 | 关系
事实: 陈述 | 类型名 | 日期(YYYY-MM-DD) | 时间原文 | 来源 | 置信(0-1) | 持有=world或人名 | 精度=day/range/relative/unknown | 槽位
缺口: 主题 | 张力(0-1) | 相关实体
线索: 继续 <id>        或        线索: 新 | 一句话主题

填写说明：
- 类型只能是 person / thing / place / self；关系可空。
- 陈述要自包含（15–80 字），把代词换成名字，保留数字和专有名词。
- **持有**：世界上发生的事（换了工作、吃了饭、约定了暗号）写「持有=world」；
  某人的看法、偏好、要求、担心（"用户认为…"）写那个人的名字，且这个人必须在本轮声明的实体里。
  人物层的事实不写日期。
- **精度**：日期换算出来写 day；只知道周/月写 range；只有相对说法（"初次见面""上次"）写 relative；
  完全不知道写 unknown。**没有时间就写 unknown，绝不要编日期。**
- 日期换算不出来就留空，把原话写进"时间原文"。
- 来源：experienced（亲历）/ told（听说的）/ inferred（推断的）。
- 槽位写成 名称=值，多个用 ; 隔开；值是数字就写数字，是实体就写实体名。
- 线索：这句话在接着聊 <open-threads> 里的哪一条，就写 继续 <id>；
  开始一个新话题就写 新 | 一句话主题（不超过 20 字）。
  拿不准时写"新"——多开一条只是话题碎一点，接错会把两件事混成一条结论。
  没有任何候选线索时，这一行只可能是"新"。
- 示例：
实体: 小林 | person | 同事
事实: 小林在 2026-10-24 那周被裁员 | 裁员 | 2026-10-24 | 上周 | told | 0.8 | 持有=world | 精度=day | 被裁员者=小林
缺口: 小林后来有着落吗 | 0.6 | 小林
线索: 继续 th_ab12
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
事实: 小林在 2026-10-24 那周被裁员 | 裁员 | 2026-10-24 | 上周 | told | 0.8 | 持有=world | 精度=day | 被裁员者=小林</output>
</example>
<example>
<source>这个 bug 我上周就修好了</source>
<output>事实: 用户说他在 2026-10-24 那周修好了这个 bug | 修复 | 2026-10-24 | 上周 | experienced | 0.7 | 持有=world | 精度=day | 修复者=用户</output>
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
<output>事实: 用户讨厌同一件事反复讲，换工具也不想重复交代 | 偏好 | | | experienced | 0.9 | 持有=用户 | 精度=unknown | 偏好主体=用户</output>
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
  const threads = renderOpenThreads(input.threads ?? [], input.previousThreadId);
  const context = [
    '<context>',
    `  <observation-date>${isoDate(input.now)}</observation-date>`,
    renderKnownEntities(input.entities ?? []),
    renderKnownFacts(input.facts ?? []),
    threads,
    input.previousUserText ? `<previous-user>${input.previousUserText.slice(0, 200)}</previous-user>` : '',
    '</context>',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    EXTRACTION_ROLE,
    '<task>把 <source> 里的信息变成记忆操作，并说明它属于哪条线索。只依据 <source> 与 <previous-user>；<known-facts> 只用于判断冲突与去重。</task>',
    EXTRACTION_SCHEMA,
    EXTRACTION_RULES,
    EXTRACTION_EXAMPLES,
    context,
    `<source>\n${input.text}\n</source>`,
    '<output>',
  ].join('\n\n');
}

/**
 * The candidate list for thread attribution.
 *
 * Five at most, most recently used first, each with an id the model must quote
 * back and a short topic it can compare against. Too many candidates and the
 * model starts keyword-matching; a wrong merge is worse than starting a new
 * thread, so the list stays short on purpose.
 */
function renderOpenThreads(threads: KnownThreadPrompt[], previousThreadId?: string): string {
  if (threads.length === 0) return '<open-threads>（空）</open-threads>';
  const lines = threads.slice(0, 5).map((thread) => {
    const ago = thread.ago === undefined ? '' : ` | ${thread.ago} 轮前`;
    return `  ${thread.id} | ${thread.topic.slice(0, 20)}${ago}`;
  });
  const previous = previousThreadId ? [`  上一轮所属：${previousThreadId}`] : [];
  return ['<open-threads>', ...lines, ...previous, '</open-threads>'].join('\n');
}

/* ------------------------------------------------------------------ *
 * Consolidation: facts → one conclusion, then an independent check
 * ------------------------------------------------------------------ */

export interface ConsolidationPromptInput {
  facts: { id: string; statement: string; atText?: string }[];
  existing: { id: string; statement: string }[];
  /**
   * The thread being closed: its topic and its turns in order.
   *
   * Facts alone lose a resume (A B A) — the turns are what make this a chapter
   * instead of a batch, and the rule below tells the model to read to the end.
   */
  thread?: { topic: string; turns: string[] };
}

export interface VerificationPromptInput {
  conclusion: string;
  facts: { id: string; statement: string }[];
}

const CONSOLIDATION_ROLE = `<role>
你是归纳器。你把若干条关于同一对象的事实，压成一条能被这些事实直接支持的判断。
你不总结对话，不做心理分析，不写建议。你的输出由一个确定性程序消费。
</role>`;

const CONSOLIDATION_RULES = `<rules>
- 一条结论至少要两条证据支持。只有一条证据的，那是事实，不是结论。
- 保留具体对象和情境；不许放大成"一切 / 所有 / 总是 / 从不"。
- 不许引入事实里没有的信息，也不许把两条不同意见合并成"用户有时A有时B"这种废话。
- 与 <existing> 里某条冲突时，用 取代=<id>；只是补充就不要取代。
- 置信按证据条数给：两条 0.6，三条 0.7，五条以上 0.85。不要凭感觉给高分。
- 这组事实撑不起一条判断，就只写：无
</rules>`;

const CONSOLIDATION_CONTRAST = `<contrast>
坏：用户讨厌一切重复劳动            ← 把两件具体的事放大成规律
好：用户讨厌同一件事反复交代        ← 保留具体对象
坏：用户是个急躁的人                ← 事实里没有，属于心理分析
好：用户在切换工具时容易不耐烦      ← 每条都能对回事实
坏：用户有时喜欢重复、有时不喜欢    ← 把矛盾揉成不承担判断的废话
好：无                              ← 撑不起一条判断时，如实说没有
</contrast>`;

const VERIFICATION_ROLE = `<role>
你是证据核查员。你只回答一件事：给定一条结论和一组事实，这些事实是否**直接**支持它。
你不评价结论是否深刻、是否合理，只看证据。
</role>`;

const VERIFICATION_RULES = `<rules>
- 只依据 <facts> 里的原文，不补充常识，不推测，不替它圆场。
- 判定只能是：支持 / 部分支持 / 不支持。
- 部分支持 = 有事实支持，但结论里有一部分是事实没说的。
- 不支持 = 事实说的是另一件事，或者缺乏关键信息。
- 在"理由"里指出具体是哪个片段支撑（或缺失）。
</rules>`;

/**
 * Stage one: write conclusions.
 *
 * The model sees only facts and existing conclusions, never the conversation.
 */
export function renderConsolidationPrompt(input: ConsolidationPromptInput): string {
  const facts = input.facts.map((fact) => {
    const when = fact.atText ? ` | ${fact.atText}` : '';
    return `  ${fact.id}${when} | ${fact.statement}`;
  });
  const existing =
    input.existing.length > 0
      ? input.existing.map((fact) => `  ${fact.id} | ${fact.statement}`).join('\n')
      : '  （空）';
  // The turns are given in order, with the resume marked, so "read to the end"
  // is a rule the model can actually follow rather than one it has to infer.
  const thread = input.thread
    ? [
        '<thread>',
        `  主题：${input.thread.topic}`,
        ...input.thread.turns.map((turn, index) => `  ${index + 1}. ${turn}`),
        '</thread>',
      ].join('\n')
    : '';
  return [
    CONSOLIDATION_ROLE,
    '<task>判断 <facts> 是否共同指向一条判断；能就写一行结论，不能就写 无。</task>',
    CONSOLIDATION_RULES,
    thread
      ? '<thread-rule>这段话是一条完整的话题，可能中间被打断过又回来。<br>结论必须覆盖到最后一次回来时的内容，不能只总结开头。</thread-rule>'
      : '',
    CONSOLIDATION_CONTRAST,
    thread,
    ['<facts>', ...facts, '</facts>'].join('\n'),
    ['<existing>', existing, '</existing>'].join('\n'),
    '<output>',
    '结论: 陈述 | 证据=<id>,<id> | 置信=0.6',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Stage two: check the draft against its evidence.
 *
 * Deliberately does not carry the draft's reasoning: an independent check is the
 * whole point (Chain-of-Verification), and a check that can see the excuse tends
 * to accept it.
 */
export function renderVerificationPrompt(input: VerificationPromptInput): string {
  const facts = input.facts.map((fact) => `  ${fact.id} | ${fact.statement}`).join('\n');
  return [
    VERIFICATION_ROLE,
    VERIFICATION_RULES,
    `<conclusion>${input.conclusion}</conclusion>`,
    ['<facts>', facts, '</facts>'].join('\n'),
    '<output>',
    '判定: 支持 | 依据=<id>,<id> | 理由=哪条事实的哪个片段支撑了它',
  ].join('\n\n');
}

/* ------------------------------------------------------------------ *
 * Duplicate handling: is this conclusion new, or a restatement?
 * ------------------------------------------------------------------ */

const RELATION_ROLE = `<role>
你是结论库的守门人。给出一条新结论和几条已有的结论，你只回答一件事：**新结论和其中哪一条是什么关系**。
你不评价哪条更好，不修改任何一条的措辞。
</role>`;

const RELATION_RULES = `<rules>
- 重复 = 说的是同一件事，只是措辞或证据不同。例如"用户要机制不要 hope"和"用户倾向方法论依据而不是 prompt 的 hope"。
- 细化 = 新结论包含旧结论，但更具体或有新条件。例如旧"用户讨厌重复"、新"用户讨厌同一件事反复交代"。
- 矛盾 = 两者不能同时成立。例如"用户喜欢被反复确认"和"用户讨厌反复确认"。
- 无关 = 说的是不同的事，哪怕话题相近。
- 关系必须在 <existing> 里选一个 id，或者写"无关"。
- 只能引用 <existing> 里出现过的 id，不许编。
</rules>`;

export interface RelationPromptInput {
  conclusion: string;
  existing: { id: string; statement: string; evidence: number }[];
}

/**
 * Stage three: the duplicate check.
 *
 * String matching can only catch the same text; a restatement like "用户要机制
 * 不要 hope" versus "用户倾向方法论依据而不是 prompt 的 hope" needs meaning. The
 * output is a fixed vocabulary so the caller can gate it.
 */
export function renderRelationPrompt(input: RelationPromptInput): string {
  const existing = input.existing.map(
    (fact) => `  ${fact.id} | 证据=${fact.evidence} 条 | ${fact.statement}`,
  );
  return [
    RELATION_ROLE,
    RELATION_RULES,
    `<new>${input.conclusion}</new>`,
    ['<existing>', ...existing, '</existing>'].join('\n'),
    '<output>',
    '关系: 重复 <id> | 理由=…',
    '关系: 细化 <id> | 理由=…',
    '关系: 矛盾 <id> | 理由=…',
    '关系: 无关',
  ].join('\n\n');
}
/* ------------------------------------------------------------------ *
 * Classifying lessons: rule (triggered) or profile (about a person)
 * ------------------------------------------------------------------ */

const CLASSIFY_ROLE = `<role>
你在整理一批"教训"。每条要么是一条**规则**（知道什么时候该做什么），要么是一条**画像**（说的是这个人是什么样）。你只做分类，不改写原文。
</role>`;

const CLASSIFY_RULES = `<rules>
一条一条判断，每种输出一行：
- 规则 = 能回答"什么时候该做什么"。它必须有一个具体的触发场景。
- 画像 = 说的是这个人的偏好、原则、性格，没有触发场景。
- 待修 = 你判断不了是哪一种，或者想不出触发条件。

填写规则那一行时，字段用 key=value，不要写 JSON：
  关键词=json,package.json       消息里出现任意一个就触发（1–3 个，要具体）
  正则=\.json\b                  关键词不够具体时用
  状态=long-session              会话状态（长会话、连续空回复）
  动作=用 edit 工具改 JSON        祈使句，一句话
  至少给一个触发条件；一个都没有就写"待修"。

- 关键词不要用"代码""工作"这种大词，它们每天都会出现。
- 只能输出 <input> 里出现过的 id，不许编。
</rules>`;

const CLASSIFY_EXAMPLE = `<example>
<input>
- fc_a | PowerShell 的 Set-Content 会写入 BOM，改 JSON 一律用 edit 工具
- fc_b | 用户讨厌同一件事反复讲，换工具又要重新交代
</input>
<output>
规则: fc_a | 关键词=json,package.json,配置 | 动作=用 edit 工具或 BOM 安全写入，不要用字符串替换
画像: fc_b
</output>
</example>`;

export interface RuleClassifyPromptInput {
  items: { id: string; statement: string }[];
}

/** Classify a batch of lessons into rules (with a trigger) or profile items. */
export function renderRuleClassifyPrompt(input: RuleClassifyPromptInput): string {
  const items = input.items.map((item) => `- ${item.id} | ${item.statement.slice(0, 120)}`);
  return [
    CLASSIFY_ROLE,
    CLASSIFY_RULES,
    CLASSIFY_EXAMPLE,
    '<format>每行：规则: id | 关键词=… | 动作=… / 画像: id / 待修: id | 原因=…</format>',
    ['<input>', ...items, '</input>'].join('\n'),
    '<output>',
  ].join('\n\n');
}