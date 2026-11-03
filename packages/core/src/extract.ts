/**
 * Extraction (spec/model.v0.md): turn text → drafts of entities, facts, gaps.
 *
 * Three rules that shape everything here:
 *
 * 1. Drafts, not writes. Extraction produces candidates; committing them is a
 *    separate step with its own gate (entity resolution, dedupe). Drafts are
 *    easy to test and bad drafts never reach the database.
 * 2. Rules first. Most sentences in a conversation are templated ("我同事小林
 *    上周被裁员了"), and a rule is fast, explainable and testable. The model is
 *    only asked when the rules miss — synthesis is the model's job, parsing is
 *    the code's (ADR 0027).
 * 3. Nothing is invented. A rule that cannot decide emits less, not a guess:
 *    an unknown time stays `atText`, an unresolved "她" stays unresolved.
 *
 * Pure functions, no I/O, no dependencies.
 */
import type {
  ThreadAttribution, EntityDraft, ExtractDraft, FactDraft, FactOperation, GapDraft, SlotValue } from './types.ts';
import { renderExtractionPrompt } from './prompts.ts';

/**
 * What a fact's confidence is when the model did not give one.
 *
 * The midpoint is the only honest value: 0 says "probably false" and 1 says
 * "certain", and neither is what "no answer" means. Used by both the text and the
 * JSON paths so the two shapes cannot disagree.
 */
export const UNKNOWN_CONFIDENCE = 0.6;

/** Relations a person is introduced with, longest first so 女同事 wins over 同事. */
const RELATIONS = [
  '女朋友', '男朋友', '老婆', '老公', '对象', '同事', '朋友', '同学', '闺蜜', '室友',
  '老板', '领导', '老师', '妈', '爸', '母亲', '父亲', '儿子', '女儿', '前男友', '前女友',
];

/** Verbs that carry a state change — the part of an event memory keeps. */
const VERBS: Array<{ word: string; passiveSlot: string; activeSlot: string }> = [
  { word: '裁员', passiveSlot: '被裁员者', activeSlot: '裁员方' },
  { word: '辞退', passiveSlot: '被辞退者', activeSlot: '辞退方' },
  { word: '离职', passiveSlot: '离职者', activeSlot: '原所属组织' },
  { word: '辞职', passiveSlot: '辞职者', activeSlot: '原所属组织' },
  { word: '升职', passiveSlot: '升职者', activeSlot: '所属组织' },
  { word: '生', passiveSlot: '生病者', activeSlot: '照顾者' },
  { word: '结婚', passiveSlot: '结婚方', activeSlot: '结婚对象' },
  { word: '分手', passiveSlot: '分手方', activeSlot: '分手对象' },
  { word: '去世', passiveSlot: '去世者', activeSlot: '亲属' },
  { word: '搬家', passiveSlot: '搬家者', activeSlot: '原住地' },
  { word: '吵架', passiveSlot: '当事人', activeSlot: '吵架对象' },
];

const TIME_WORDS = [
  '昨天', '前天', '今天', '明天', '大前天', '后天',
  '上周', '本周', '这周', '下周', '上个月', '这个月', '下个月',
  '去年', '今年', '去年年底', '上周末', '这周末',
];

/** Rough offsets in days; good enough to sort, and `atText` keeps the original. */
const TIME_OFFSET_DAYS: Record<string, number> = {
  昨天: -1, 前天: -2, 大前天: -3, 今天: 0,
  明天: 1, 后天: 2, 上周: -7, 上周末: -5, 本周: 0, 这周: 0, 这周末: 2,
  下周: 7, 上个月: -30, 这个月: 0, 下个月: 30, 去年: -365, 今年: 0,
};

const UNCERTAIN = /(不知道|不清楚|没消息|不知道她|不知道他|后来|怎么样了|是否|还在不在)/;

function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * A calendar date, or nothing.
 *
 * `Date.parse('2026-02-31T00:00:00Z')` does not fail: it rolls to 2026-03-03. A rolled
 * date is worse than a missing one — it is confidently wrong and joins time retrieval
 * as if it were exact. Round-tripping through Date is the only reliable check.
 */
export function calendarDate(year: number, month: number, day: number): number | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  const same = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  return same ? ms : undefined;
}

/** Parse `YYYY-MM-DD`; anything that is not a real day on the calendar returns undefined. */
export function parseIsoDate(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return undefined;
  return calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** First time expression in the sentence, with a rough timestamp. */
function findTime(sentence: string, now: number): { at?: number; atText?: string } {
  for (const word of TIME_WORDS) {
    if (sentence.includes(word)) {
      const days = TIME_OFFSET_DAYS[word];
      return days === undefined ? { atText: word } : { atText: word, at: now + days * 86400000 };
    }
  }
  const explicit = sentence.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (explicit) {
    const month = Number(explicit[1]);
    const day = Number(explicit[2]);
    const year = new Date(now).getUTCFullYear();
    // "2月31日" is not a date; keep the words and let the precision stay unknown.
    const at = calendarDate(year, month, day);
    return at === undefined ? { atText: explicit[0] } : { atText: explicit[0], at };
  }
  const yearMonth = sentence.match(/(\d{4})年(\d{1,2})月/);
  if (yearMonth) {
    const at = calendarDate(Number(yearMonth[1]), Number(yearMonth[2]), 1);
    return at === undefined ? { atText: yearMonth[0] } : { atText: yearMonth[0], at };
  }
  return {};
}

/**
 * People in one sentence: `我同事小林` gives 同事 (relation) and 小林 (name); a bare
 * `我妈` gives 妈 as both. No pronoun resolution — "她" is deliberately not a name.
 */
/** Characters that start a time word or a verb — a name never ends with one. */
const NAME_STOP_TAIL = new Set(
  [...'上下今明昨前后本这去每被就已会在要想说很挺不没也还了着过的得'.split('')],
);

function findPeople(sentence: string): EntityDraft[] {
  const out: EntityDraft[] = [];
  for (const relation of RELATIONS) {
    const index = sentence.indexOf(relation);
    if (index < 0) continue;
    const after = sentence.slice(index + relation.length);
    // Chinese names are 2-3 characters and are followed directly by the rest of
    // the sentence ("小林上周"), so take the longest run and give back a trailing
    // function character — otherwise 小林上周 becomes the name 小林上.
    const run = after.match(/^([\u4e00-\u9fa5]{2,3})/);
    let name = run?.[1];
    if (name && name.length === 3 && NAME_STOP_TAIL.has(name[2])) name = name.slice(0, 2);
    if (name) {
      out.push({ type: 'person', name, aliases: [], attrs: { relation } });
    } else if (!out.some((e) => e.name === relation)) {
      out.push({ type: 'person', name: relation, aliases: [], attrs: { relation } });
    }
  }
  return out;
}

/** The verb that names what happened, if the lexicon knows it. */
function findVerb(sentence: string): { word: string; passive: boolean; slot: string } | null {
  for (const verb of VERBS) {
    if (!sentence.includes(verb.word)) continue;
    const passive = sentence.includes(`被${verb.word}`) || sentence.includes(`遭${verb.word}`);
    return { word: verb.word, passive, slot: passive ? verb.passiveSlot : verb.activeSlot };
  }
  return null;
}

/** Trim a sentence into a statement: the memory's own line, not the whole paragraph. */
function toStatement(sentence: string): string {
  return sentence.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Rule extraction. Returns drafts for one turn's user text; may return an empty
 * list, which is a valid answer (small talk is not a fact).
 *
 * Pronouns are resolved only inside the same turn, and only to the most recent
 * explicit person: "我同事小林被裁了。不知道她后来怎么样" can bind 她→小林 because
 * the turn itself said who she is. Across turns we do not guess — an unresolved
 * "她" stays unresolved instead of being attached to the wrong person.
 */
export function extractByRules(text: string, at = Date.now()): ExtractDraft {
  const entities: EntityDraft[] = [];
  const facts: FactDraft[] = [];
  const gaps: GapDraft[] = [];
  let recentPerson: EntityDraft | null = null;

  for (const sentence of splitSentences(text)) {
    const explicit = findPeople(sentence);
    if (explicit.length > 0) recentPerson = explicit[explicit.length - 1];
    const pronoun = /(她|他|他们|她们)/.test(sentence);
    // Same-turn binding only: with no explicit person in this sentence but a
    // pronoun and a person earlier in the turn, the pronoun refers to them.
    const people = explicit.length > 0 ? explicit : pronoun && recentPerson ? [recentPerson] : [];
    const boundByPronoun = explicit.length === 0 && people.length > 0;

    const verb = findVerb(sentence);
    const time = findTime(sentence, at);

    // A sentence with neither a person nor a known verb carries no structure;
    // it may still be worth keeping as a fact with no slots (e.g. "今天下雨了").
    const slots: FactDraft['slots'] = [];
    for (const person of people) {
      entities.push(person);
      slots.push({
        slot: verb ? verb.slot : '当事人',
        value: { kind: 'entity', entityName: person.name, entityType: person.type },
      });
    }

    const hasStructure = people.length > 0 || verb !== null || time.at !== undefined || time.atText !== undefined;
    if (!hasStructure) continue;

    facts.push({
      statement: toStatement(sentence),
      typeName: verb?.word,
      at: time.at,
      atText: time.atText,
      // Precision follows what the rules actually resolved: a parsed date is `day`, a
      // bare expression ("上次") is `relative`. Without this every rules fact claimed
      // unknown and could not join time retrieval even when it had a date.
      atPrecision: time.at !== undefined ? 'day' : time.atText !== undefined ? 'relative' : 'unknown',
      source: boundByPronoun ? 'inferred' : 'told',
      confidence: people.length > 0 ? (boundByPronoun ? 0.5 : 0.7) : 0.5,
      slots,
    });

    // "不知道她后来怎么样了" opens a gap instead of asserting a fact.
    if (UNCERTAIN.test(sentence) && people.length > 0) {
      gaps.push({
        topic: toStatement(sentence),
        aboutEntityName: people[0].name,
        tension: 0.5,
      });
    }
  }

  // The same person appears once per sentence; the draft keeps one of them.
  const unique = new Map<string, EntityDraft>();
  for (const entity of entities) unique.set(`${entity.type}:${entity.name}`, entity);
  return { entities: [...unique.values()], facts, gaps, by: 'rules' };
}

interface ModelParseResult {
  draft: ExtractDraft | null;
  error?: string;
}

/** What the model is allowed to know about the store before extracting. */
export interface ExtractionContext {
  entities: Array<{ id: string; name: string; aliases?: string[]; relation?: string }>;
  facts: Array<{ id: string; statement: string; atText?: string }>;
  previousUserText?: string;
  /** Open threads, for attribution (labels plus their last lines, ADR 0034). */
  threads?: Array<{
    id: string;
    topic: string;
    ago?: number;
    recent?: Array<{ role: 'user' | 'assistant'; text: string }>;
  }>;
  previousThreadId?: string;
}

/**
 * Model extraction: one call, strict JSON, validated afterwards.
 *
 * The model sees the entities and facts already stored, so it can reuse a name
 * instead of inventing a duplicate and can supersede a fact that the new
 * sentence contradicts. That merge decision is the difference between "a log of
 * sentences" and memory (Mem0's ADD/UPDATE/DELETE, Graphiti's invalidation).
 *
 * The prompt itself is rendered from `prompts.ts`, not written here.
 */
export async function extractWithModel(
  text: string,
  llm: (prompt: string) => Promise<string> | string,
  at = Date.now(),
  context?: ExtractionContext,
): Promise<ModelParseResult> {
  const prompt = renderExtractionPrompt({
    text,
    now: at,
    entities: context?.entities,
    facts: context?.facts,
    previousUserText: context?.previousUserText,
    threads: context?.threads,
    previousThreadId: context?.previousThreadId,
  });
  let raw: string;
  try {
    raw = await llm(prompt);
  } catch (error) {
    return { draft: null, error: error instanceof Error ? error.message : String(error) };
  }
  // Lines first: one bad record is one bad record. JSON is the fallback for a
  // model that ignores the template and answers in JSON anyway.
  const threadRead = readThreadLine(raw);
  const thread = threadRead.kind === 'continue' || threadRead.kind === 'new' ? threadRead : null;
  const threadLine = threadRead.kind === 'continue' || threadRead.kind === 'new' ? 'present' : threadRead.kind;
  const fromLines = parseLineDraft(raw);
  if (fromLines) {
    const result = validateDraft(fromLines, at, context);
    if (result.draft) {
      if (thread) result.draft.thread = thread;
      result.draft.threadLine = threadLine;
    }
    return result;
  }
  const json = extractJson(raw);
  if (!json) return { draft: null, error: `unparseable output: ${String(raw).slice(0, 60)}` };
  const result = validateDraft(json, at, context);
  if (result.draft) {
    if (thread) result.draft.thread = thread;
    result.draft.threadLine = threadLine;
  }
  return result;
}

/**
 * Parse the attribution line.
 *
 *  线索: 继续 th_ab12
 *  线索: 新 | 在聊 cookie 与认证
 */
export function parseThreadLine(raw: string): ThreadAttribution | null {
  const read = readThreadLine(raw);
  // `topic` is omitted rather than set to undefined: callers compare the attribution
  // object, and an explicit undefined key makes two equivalent answers unequal.
  if (read.kind === 'continue') return read.topic ? { kind: 'continue', id: read.id, topic: read.topic } : { kind: 'continue', id: read.id };
  if (read.kind === 'new') return read.topic ? { kind: 'new', topic: read.topic } : { kind: 'new' };
  return null;
}

/**
 * What the model's thread line said, including whether it said anything.
 *
 * `parseThreadLine` collapses "no line" and "a line I cannot read" into null, which made
 * the fallback rate unmeasurable — 75% of attributions arrived as `fallback-previous`
 * with no way to tell whether the model was silent or unparseable. The kinds are kept
 * apart here; only `continue` and `new` are usable attributions.
 */
export function readThreadLine(
  raw: string,
):
  | { kind: 'continue'; id: string; topic?: string }
  | { kind: 'new'; topic?: string }
  | { kind: 'absent' }
  | { kind: 'invalid'; line: string } {
  let sawLine = false;
  let unreadable = '';
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const match = /^线索\s*[:：]\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    sawLine = true;
    const body = match[1].trim();
    if (/^(无|none|nothing)[。.]?$/i.test(body)) return { kind: 'absent' };
    // `继续 <id>` with an optional new topic, for when the subject moved inside the
    // same thread: the stored topic would otherwise stay at the first turn forever.
    const continued = /^继续\s*[:：]?\s*([A-Za-z0-9_-]+)\s*(?:[|｜]\s*主题\s*[=:：]\s*(.*))?$/.exec(body);
    if (continued) {
      const topic = (continued[2] ?? '').trim();
      return { kind: 'continue', id: continued[1], topic: topic || undefined };
    }
    const fresh = /^新\s*(?:[|｜:：]\s*(.*))?$/.exec(body);
    if (fresh) return { kind: 'new', topic: (fresh[1] ?? '').trim() || undefined };
    unreadable = `线索: ${body}`;
  }
  return sawLine && unreadable ? { kind: 'invalid', line: unreadable } : { kind: 'absent' };
}

/** Models wrap JSON in prose or fences; take the outermost object. */
function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

const ENTITY_TYPES = new Set(['person', 'thing', 'place', 'self']);
const PRECISIONS = new Set(['day', 'range', 'relative', 'unknown']);

const SOURCES = new Set(['experienced', 'told', 'inferred']);
const OPS = new Set(['add', 'supersede', 'update', 'noop']);

/** One fact payload, shared by the legacy `facts` array and the operations. */
function parseFactDraft(obj: Record<string, unknown>): FactDraft | null {
  const statement = String(obj?.statement ?? '').trim();
  if (!statement) return null;
  const slots: FactDraft['slots'] = [];
  for (const rawSlot of asArray(obj.slots)) {
    const s = rawSlot as Record<string, unknown>;
    const slot = String(s?.slot ?? '').trim();
    if (!slot) continue;
    if (typeof s.entity === 'string' && s.entity.trim()) {
      slots.push({ slot, value: { kind: 'entity', entityName: s.entity.trim(), entityType: 'person' } });
    } else if (typeof s.number === 'number' && Number.isFinite(s.number)) {
      slots.push({ slot, value: { kind: 'number', value: s.number } });
    } else if (typeof s.text === 'string' && s.text.trim()) {
      slots.push({ slot, value: { kind: 'text', value: s.text.trim() } });
    }
  }
  const source = String(obj.source ?? 'told');
  const holderRaw = typeof obj.holder === 'string' ? obj.holder.trim() : '';
  const precisionRaw = typeof obj.at_precision === 'string' ? obj.at_precision.trim() : '';
  const at = typeof obj.at === 'number' ? obj.at : undefined;
  const atText = typeof obj.at_text === 'string' ? obj.at_text : undefined;
  const precision =
    precisionRaw && PRECISIONS.has(precisionRaw)
      ? (precisionRaw as FactDraft['atPrecision'])
      : at !== undefined
        ? 'day'
        : atText
          ? 'relative'
          : 'unknown';
  return {
    statement,
    // `world` unless the model named a mind; the commit gate resolves the name.
    holder: holderRaw || 'world',
    typeName: typeof obj.type_name === 'string' ? obj.type_name : undefined,
    at,
    atText,
    atPrecision: precision,
    source: (SOURCES.has(source) ? source : 'told') as FactDraft['source'],
    confidence: typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : UNKNOWN_CONFIDENCE,
    // Only an explicit yes counts: the field is read by the promotion rules, and a
    // default-yes would promote every observation to a lesson.
    ...(obj.principle === true ? { principle: true } : {}),
    slots,
  };
}

/**
 * Validate and normalise a model answer. Anything malformed is dropped rather
 * than repaired: a missing statement cannot be invented, and a bad entity type
 * would poison retrieval later.
 *
 * `supersede` / `update` must point at a fact the model was actually shown —
 * otherwise it could retire a memory it never read.
 */
export function validateDraft(
  json: unknown,
  at = Date.now(),
  context?: ExtractionContext,
): ModelParseResult {
  if (!json || typeof json !== 'object') return { draft: null, error: 'not an object' };
  const input = json as Record<string, unknown>;
  const knownFactIds = new Set((context?.facts ?? []).map((f) => f.id));

  const entities: EntityDraft[] = [];
  for (const item of asArray(input.entities)) {
    const name = String((item as Record<string, unknown>)?.name ?? '').trim();
    const type = String((item as Record<string, unknown>)?.type ?? 'person');
    if (!name || !ENTITY_TYPES.has(type)) continue;
    const attrs = (item as Record<string, unknown>)?.attrs;
    entities.push({
      name,
      type: type as EntityDraft['type'],
      aliases: [],
      attrs: attrs && typeof attrs === 'object' ? (attrs as Record<string, unknown>) : {},
    });
  }

  const facts: FactDraft[] = [];
  for (const item of asArray(input.facts)) {
    const parsed = parseFactDraft(item as Record<string, unknown>);
    if (parsed) facts.push(parsed);
  }

  const operations: FactOperation[] = [];
  for (const item of asArray(input.operations)) {
    const obj = item as Record<string, unknown>;
    const op = String(obj?.op ?? '').trim();
    if (!OPS.has(op)) continue;
    const parsed = parseFactDraft((obj.fact ?? {}) as Record<string, unknown>);
    const targetId = typeof obj.target === 'string' ? obj.target.trim() : undefined;
    if (op === 'noop') {
      // A noop carries no fact; keep it so the trace can show "nothing to store".
      operations.push({ op: 'noop', targetId, fact: parsed ?? { statement: '', source: 'told', confidence: 0, slots: [] } });
      continue;
    }
    if (!parsed) continue;
    if ((op === 'supersede' || op === 'update') && (!targetId || !knownFactIds.has(targetId))) {
      // Unknown target: fall back to add rather than silently dropping the news.
      operations.push({ op: 'add', fact: parsed });
      continue;
    }
    operations.push({ op: op as FactOperation['op'], targetId, fact: parsed });
    // Keep `facts` as a flat view of the adds: older callers and the commit
    // gate's skip report read it, and operations are the source of truth.
    if (op === 'add') facts.push(parsed);
  }

  const gaps: GapDraft[] = [];
  for (const item of asArray(input.gaps)) {
    const obj = item as Record<string, unknown>;
    const topic = String(obj?.topic ?? '').trim();
    if (!topic) continue;
    gaps.push({
      topic,
      aboutEntityName: typeof obj.about === 'string' ? obj.about.trim() : undefined,
      tension: typeof obj.tension === 'number' ? Math.min(1, Math.max(0, obj.tension)) : 0.5,
    });
  }

  const hasOps = operations.some((o) => o.op !== 'noop');
  // An explicit noop is an answer, not an empty one: the model looked and found
  // nothing worth storing. Without this the caller falls back to rules and
  // reports a failure that never happened.
  const hasNoop = operations.some((o) => o.op === 'noop');
  if (!hasOps && !hasNoop && facts.length === 0 && entities.length === 0 && gaps.length === 0) {
    return { draft: null, error: 'model returned nothing usable' };
  }
  void at;
  return { draft: { entities, facts, gaps, operations, by: 'llm' }, error: undefined };
}

/**
 * Parse the line template the model is asked to fill in.
 *
 * Requiring valid JSON makes the whole extraction hinge on one character:
 * a missing brace turns a correct answer into "model-failed". A line template
 * fails per line instead, so one malformed record costs one record. The shape it
 * builds is the same object `validateDraft` already checks, so there is one gate,
 * not two.
 *
 *   实体: 小林 | person | 同事
 *   事实: 陈述 | 类型名 | 2026-10-24 | 上周 | told | 0.8 | 被裁员者=小林
 *   缺口: 怎么了 | 0.6 | 小林
 *   无
 */
export function parseLineDraft(raw: string): Record<string, unknown> | null {
  const entities: Record<string, unknown>[] = [];
  const operations: Record<string, unknown>[] = [];
  const gaps: Record<string, unknown>[] = [];
  let sawRecord = false;

  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(无|none|noop|无记录|没有)[。.]?$/i.test(trimmed)) {
      operations.push({ op: 'noop' });
      sawRecord = true;
      continue;
    }
    const match = /^(实体|事实|缺口)\s*[:：]\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    const [, kind, body] = match;
    const parts = body.split('|').map((part) => part.trim());

    if (kind === '实体') {
      const [name, type, relation] = parts;
      if (!name) continue;
      entities.push({
        name,
        type: ENTITY_TYPES.has(type ?? '') ? type : 'person',
        attrs: relation ? { relation } : {},
      });
      sawRecord = true;
      continue;
    }

    if (kind === '事实') {
      const [statement, typeName, at, atText, source, confidence, ...rest] = parts;
      if (!statement) continue;
      const fact: Record<string, unknown> = { statement };
      if (typeName) fact.type_name = typeName;
      // A date that is not a real day on the calendar is dropped, not rolled:
      // '2026-02-31' used to become 03-03 and still claim precision=day.
      const parsedAt = at ? parseIsoDate(at) : undefined;
      if (parsedAt !== undefined) fact.at = parsedAt;
      if (atText) fact.at_text = atText;
      if (source) fact.source = source;
      // An empty field is "the model did not say", not "the model said zero".
      // `Number('')` is 0, so an empty confidence used to rank the fact last — the
      // opposite of an honest unknown. An explicit number (including 0) is honoured.
      if (confidence !== undefined) {
        const parsed = confidence.trim() === '' ? Number.NaN : Number(confidence);
        fact.confidence = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : UNKNOWN_CONFIDENCE;
      }

      // 持有= / 精度= / 原则候选= are keyed so the positional fields stay backward
      // compatible; anything else in the tail is the slot list.
      let slotText: string | undefined;
      for (const part of rest) {
        const keyed = /^(持有|精度|原则候选|槽位)\s*[=＝]\s*(.*)$/.exec(part);
        if (keyed) {
          if (keyed[1] === '持有') fact.holder = keyed[2].trim();
          else if (keyed[1] === '精度') fact.at_precision = keyed[2].trim();
          else if (keyed[1] === '原则候选') {
            // Only 是 promotes. "否" and anything else is the safe default.
            if (/^(是|yes|true)$/i.test(keyed[2].trim())) fact.principle = true;
          } else slotText = keyed[2].trim();
          continue;
        }
        if (part && slotText === undefined) slotText = part;
      }

      const slots: Record<string, unknown>[] = [];
      for (const pair of (slotText ?? '').split(/[;；]/).map((item) => item.trim()).filter(Boolean)) {
        const [slot, value] = pair.split(/[=＝]/).map((item) => item.trim());
        if (!slot || !value) continue;
        // Numbers stay numbers; everything else is a name the gate resolves.
        slots.push(/^-?\d+(\.\d+)?$/.test(value) ? { slot, number: Number(value) } : { slot, entity: value });
      }
      if (slots.length > 0) fact.slots = slots;
      // Precision must agree with what survived: a model that wrote 精度=day for a date
      // we rejected would otherwise claim exactness it does not have.
      const precision = typeof fact.at_precision === 'string' ? fact.at_precision : '';
      if (fact.at === undefined && precision === 'day') {
        fact.at_precision = fact.at_text ? 'relative' : 'unknown';
      } else if (fact.at !== undefined && !precision) {
        fact.at_precision = 'day';
      }
      operations.push({ op: 'add', fact });
      sawRecord = true;
      continue;
    }

    // 缺口
    const [topic, tension, about] = parts;
    if (!topic) continue;
    const gap: Record<string, unknown> = { topic };
    const value = Number(tension);
    if (Number.isFinite(value)) gap.tension = value;
    if (about) gap.about = about;
    gaps.push(gap);
    sawRecord = true;
  }

  if (!sawRecord) return null;
  return { entities, operations, gaps };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
