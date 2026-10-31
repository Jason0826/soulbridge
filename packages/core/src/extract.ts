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
import type { EntityDraft, ExtractDraft, FactDraft, GapDraft, SlotValue } from './types.ts';

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
    const year = new Date(now).getFullYear();
    return { atText: explicit[0], at: new Date(year, month - 1, day).getTime() };
  }
  const yearMonth = sentence.match(/(\d{4})年(\d{1,2})月/);
  if (yearMonth) {
    return {
      atText: yearMonth[0],
      at: new Date(Number(yearMonth[1]), Number(yearMonth[2]) - 1, 1).getTime(),
    };
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

const MODEL_INSTRUCTIONS = `从这段对话里抽出事实。只输出 JSON，不要解释。格式：
{"entities":[{"name":"小林","type":"person","attrs":{"relation":"同事"}}],
 "facts":[{"statement":"小林上周被裁员了","type_name":"裁员","at_text":"上周",
           "source":"told","confidence":0.8,
           "slots":[{"slot":"被裁员者","entity":"小林"},
                    {"slot":"裁员人数","number":300},
                    {"slot":"内容","text":"整个部门"}]}],
 "gaps":[{"topic":"她后来有着落吗","about":"小林","tension":0.6}]}
规则：
- type 只能是 person / thing / place / self
- source 只能是 experienced（用户亲历）/ told（转述）/ inferred（推断）
- 不知道的不要编，时间不确定只填 at_text
- 没有人物或事件的闲聊，返回空数组`;

interface ModelParseResult {
  draft: ExtractDraft | null;
  error?: string;
}

/**
 * Model extraction: one call, strict JSON, validated afterwards.
 *
 * The model is better at slots and implicit relations than a rule can be, but
 * it also hallucinates, so its answer is a draft like any other — the caller
 * still commits through the gate.
 */
export async function extractWithModel(
  text: string,
  llm: (prompt: string) => Promise<string> | string,
  at = Date.now(),
): Promise<ModelParseResult> {
  let raw: string;
  try {
    raw = await llm(`${MODEL_INSTRUCTIONS}\n\n对话/句子：\n${text}`);
  } catch (error) {
    return { draft: null, error: error instanceof Error ? error.message : String(error) };
  }
  const json = extractJson(raw);
  if (!json) return { draft: null, error: 'no json in model output' };
  return validateDraft(json, at);
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
const SOURCES = new Set(['experienced', 'told', 'inferred']);

/**
 * Validate and normalise a model answer. Anything malformed is dropped rather
 * than repaired: a missing statement cannot be invented, and a bad entity type
 * would poison retrieval later.
 */
export function validateDraft(json: unknown, at = Date.now()): ModelParseResult {
  if (!json || typeof json !== 'object') return { draft: null, error: 'not an object' };
  const input = json as Record<string, unknown>;

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
    const obj = item as Record<string, unknown>;
    const statement = String(obj?.statement ?? '').trim();
    if (!statement) continue;
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
    facts.push({
      statement,
      typeName: typeof obj.type_name === 'string' ? obj.type_name : undefined,
      at: typeof obj.at === 'number' ? obj.at : undefined,
      atText: typeof obj.at_text === 'string' ? obj.at_text : undefined,
      source: (SOURCES.has(source) ? source : 'told') as FactDraft['source'],
      confidence: typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0.6,
      slots,
    });
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

  if (facts.length === 0 && entities.length === 0 && gaps.length === 0) {
    return { draft: null, error: 'model returned nothing usable' };
  }
  void at;
  return { draft: { entities, facts, gaps, by: 'llm' }, error: undefined };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
