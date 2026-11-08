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
import { extractionRole, extractionTerms, extractionSchema, extractionRules, extractionExamples } from './prompts.generated.ts';
import { PROFILE_DIMENSIONS_BLOCK } from './profile-prompt.ts';
import { dimensionChoices } from './dimension-text.ts';

export interface KnownEntityPrompt {
  id: string;
  name: string;
  aliases?: string[];
  relation?: string;
}

export interface KnownFactPrompt {
  id: string;
  statement: string;
  /** The words the fact's start was said in ("上周"), when it had any. */
  validFromText?: string;
}

export interface KnownThreadPrompt {
  id: string;
  topic: string;
  /** How many turns ago this thread was last seen. */
  ago?: number;
  /**
   * The thread's most recent lines, oldest first.
   *
   * A topic label alone cannot answer "does this turn continue that conversation" —
   * the model would be keyword-matching the label. The words are the evidence, so a
   * candidate carries its last turns (ADR 0034).
   */
  recent?: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface ThreadTurnPrompt {
  /** 1-based position inside the thread; the model quotes this number as 轮次=N. */
  turnNo: number;
  userText: string;
  assistantText?: string;
  /** When the turn happened; shown as `<turn ... at="YYYY-MM-DD">`, not a fact's validity. */
  startedAt?: number;
}

export interface ExtractionPromptInput {
  /** The whole thread, in order (0025). Takes precedence over the single-turn fields. */
  turns?: ThreadTurnPrompt[];
  /** @deprecated single-turn input; the switch to thread-only lands with the queue change. */
  text?: string;
  /** @deprecated see `text`. */
  assistantText?: string;
  /** Date the extraction runs; relative times resolve against it. */
  now: number;
  entities?: KnownEntityPrompt[];
  facts?: KnownFactPrompt[];
  previousUserText?: string;
  /** Open topic threads: the candidate list for attribution. */
  threads?: KnownThreadPrompt[];
  /** Which thread the previous turn belonged to, when known. */
  previousThreadId?: string;
}


/**
 * Every term, defined once, with the boundary that decides it.
 *
 * Terms used to be explained in three places (format notes, rules, examples) and the
 * copies disagreed: a slot value was "a name" in one paragraph and "a description" in
 * another, so the model filled slots with topics and the parser called them entities.
 * One definition per term, each with 算/不算 examples, is the only version a model can
 * apply consistently.
 */




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
  const lines = facts.slice(0, 20).map((f) => `  - [${f.id}] ${f.statement}${f.validFromText ? `（${f.validFromText}）` : ''}`);
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
    // The previous line is evidence for binding "继续/那个/她". Cutting it at an
    // arbitrary length can remove the very referent the model needs, so it goes in
    // whole; its size is bounded by the previous user message, not by us.
    input.previousUserText ? `<previous-user>${input.previousUserText}</previous-user>` : '',
    '</context>',
  ]
    .filter(Boolean)
    .join('\n');

  // The whole thread, one labelled block per turn (0025). Reading the topic as a whole is
  // what lets "10-24 被裁员" become "小林 2024-10-24 被裁员": the subject is in an earlier
  // turn, and a per-turn extraction never saw it.
  const turns = input.turns?.length
    ? input.turns
    : input.text !== undefined
      ? [{ turnNo: 1, userText: input.text, assistantText: input.assistantText, startedAt: input.now }]
      : [];
  const source = [
    '<source>',
    ...turns.map((turn) => {
      const when = turn.startedAt ? ` at="${isoDate(turn.startedAt)}"` : '';
      const head = `  <turn n="${turn.turnNo}"${when}>`;
      const lines = [`用户：${turn.userText}`];
      if (turn.assistantText) lines.push(`我：${turn.assistantText}`);
      return `${head}\n${lines.map((line) => `    ${line}`).join('\n')}\n  </turn>`;
    }),
    '</source>',
  ].join('\n');

  return [
    extractionRole,
    '<task>把 <source> 里的信息变成记忆操作，并说明它属于哪条线索。只依据 <source> 与 <previous-user>；<known-facts> 只用于判断冲突与去重。</task>',
    extractionTerms,
    extractionSchema,
    extractionRules,
    extractionExamples,
    context,
    source,
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
 *
 * Each candidate also carries its last lines verbatim: the question "does this turn
 * continue that conversation" cannot be answered from a label, and ADR 0034 makes
 * continuing the default, so the evidence has to be there.
 */
function renderOpenThreads(threads: KnownThreadPrompt[], previousThreadId?: string): string {
  if (threads.length === 0) return '<open-threads>（空）</open-threads>';
  const lines = threads.map((thread) => {
    const ago = thread.ago === undefined ? '' : ` | ${thread.ago} 轮前`;
    // Whole lines, never a mid-sentence prefix (ADR 0034): a cut candidate line is
    // exactly the case where "继续" and "换个话题" become indistinguishable.
    const head = `  ${thread.id} | ${thread.topic}${ago}`;
    const recent = (thread.recent ?? []).map((line) => {
      const who = line.role === 'user' ? '用户' : '我';
      return `    ${who}：${line.text}`;
    });
    return [head, ...recent].join('\n');
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
你在整理一批候选条目（模型自己标的教训、规则、决定，都还没安置）。每条要么是一条**规则**（知道什么时候该做什么），要么是一条**画像**（说的是这个人是什么样）。你只做分类，不改写原文。
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
- 画像那一行必须带维度：${dimensionChoices()}。
  维度决定这条判断以后跟谁合并，选错等于把它归到别的类别里，所以拿不准时按下面 <dimensions> 的定义选，不要自己造词。
</rules>`;

const CLASSIFY_EXAMPLE = `<example>
<input>
- fc_a | PowerShell 的 Set-Content 会写入 BOM，改 JSON 一律用 edit 工具
- fc_b | 用户讨厌同一件事反复讲，换工具又要重新交代
</input>
<output>
规则: fc_a | 关键词=json,package.json,配置 | 动作=用 edit 工具或 BOM 安全写入，不要用字符串替换
画像: fc_b | 维度=沟通偏好
</output>
</example>`;

export interface RuleClassifyPromptInput {
  items: { id: string; statement: string }[];
}

/** Classify a batch of lessons into rules (with a trigger) or profile items. */
export function renderRuleClassifyPrompt(input: RuleClassifyPromptInput): string {
  // Whole statements: classification reads the judgement itself, and a 120-char
  // prefix can hide the qualifier that decides rule vs profile.
  const items = input.items.map((item) => `- ${item.id} | ${item.statement}`);
  return [
    CLASSIFY_ROLE,
    CLASSIFY_RULES,
    // The definitions are rendered from dimensions.ts, never retyped here: a second
    // copy of the admission criteria is a copy that stops matching after one edit.
    PROFILE_DIMENSIONS_BLOCK,
    CLASSIFY_EXAMPLE,
    '<format>每行：规则: id | 关键词=… | 动作=… ／ 画像: id | 维度=… ／ 待修: id | 原因=…</format>',
    ['<input>', ...items, '</input>'].join('\n'),
    '<output>',
  ].join('\n\n');
}
export { renderProfileMergePrompt } from './profile-prompt.ts';
export type { ProfileMergePromptInput } from './profile-prompt.ts';
