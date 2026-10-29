/**
 * Reflection: turn a finished session into durable memory + an emotion update.
 *
 * `core` never calls a model itself. If the caller passes an `LlmFn`, richer
 * extraction is possible later; today the rule path is the default, which keeps
 * the whole loop runnable offline.
 */
import { randomUUID } from 'node:crypto';
import type { DraftRejection, Emotion, LlmFn, Memory, MemoryType, ReflectResult, Turn } from './types.ts';
import type { SoulStore } from './store.ts';
import { tokenize } from './scoring.ts';

interface Draft {
  type: MemoryType;
  content: string;
  importance: number;
}

interface Rule {
  /** Stable id for tests and diagnostics. */
  id: string;
  type: MemoryType;
  importance: number;
  match: (text: string) => boolean;
  /** Optional rewrite: keep the instruction, drop the surrounding discussion. */
  distill?: (text: string) => string | null;
}

/**
 * A standing instruction needs both halves: when it applies, and what it asks
 * for. A bare "每次" is usually a complaint ("每次都不能用"), so the trigger
 * alone must not create a strategy.
 */
const TIME_TRIGGER = /(以后|下次|每次|从现在起|在.{0,12}之前|from now on|always)/i;
const DIRECTIVE = /(先|需要|要|必须|应该|请|别|不要|务必|记得|need to|should|must|please)/i;

/** Long strategies are noise in a prompt; keep the instruction, not the essay. */
export const MAX_STRATEGY_CHARS = 80;
/** How far after a trigger the request may sit and still belong to it. */
const DIRECTIVE_WINDOW = 40;

/**
 * Cut a standing instruction down to the clause that carries it.
 *
 * A user explains for two lines and states the rule once; storing the whole
 * paragraph repeats the discussion into every future prompt. Find the trigger
 * whose neighbourhood also carries a request, and keep from there.
 */
export function distillStrategy(text: string): string | null {
  const trigger = new RegExp(TIME_TRIGGER.source, 'gi');
  let match = trigger.exec(text);
  let start = -1;
  // The rule usually closes the paragraph ("...比如你每次…都需要…"), so the
  // last qualifying trigger is the instruction, not the setup.
  while (match !== null) {
    const rest = text.slice(match.index);
    if (DIRECTIVE.test(rest.slice(0, DIRECTIVE_WINDOW))) start = match.index;
    match = trigger.exec(text);
  }
  if (start < 0) return null;

  let clause = text.slice(start).replace(/^[\s，,、：:]+/, '');
  clause = clause.replace(/^(比如|例如|就像|也就是说|你|我)\s*/g, '');
  if (clause.length > MAX_STRATEGY_CHARS) clause = clause.slice(0, MAX_STRATEGY_CHARS);
  clause = clause.trim();
  return clause.length > 0 ? clause : null;
}

/** Cheap, synchronous, no model. Deliberately conservative: false positives cost trust. */
export const RULES: Rule[] = [
  {
    id: 'remember',
    type: 'fact',
    importance: 7,
    match: (text) => /(记住|别忘了|remember|don'?t forget)/i.test(text),
  },
  {
    id: 'preference',
    type: 'trait',
    importance: 6,
    match: (text) => /(我喜欢|我习惯|我偏好|我倾向|i prefer|i like)/i.test(text),
  },
  {
    id: 'standing-instruction',
    type: 'strategy',
    importance: 7,
    match: (text) => TIME_TRIGGER.test(text) && DIRECTIVE.test(text),
    distill: distillStrategy,
  },
  {
    id: 'decision',
    type: 'cognition',
    importance: 7,
    match: (text) => /(我决定|就这么定|原则是|i decided|my rule)/i.test(text),
  },
];

const CORRECTION = /(不对|不是这样|错了|你搞错|wrong|that'?s not right|incorrect)/i;

/** Is this user turn a correction? Evidence for RFC 0003, not a memory by itself. */
export function isCorrection(text: string): boolean {
  return CORRECTION.test(text);
}

/** Which marker matched, for statistics; null when the turn is not a correction. */
export function correctionRule(text: string): string | null {
  const match = CORRECTION.exec(text);
  return match ? match[0] : null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Types an extractor may produce; episodic/relationship are host-local. */
export const EXTRACTABLE_TYPES: MemoryType[] = ['strategy', 'trait', 'fact', 'cognition'];
export const MAX_CONTENT_CHARS = 500;
/** A single turn should not flood the store. */
export const MAX_DRAFTS_PER_TURN = 3;

/**
 * Deterministic write gates. A draft must pass shape, then semantics, then the
 * per-turn budget; anything refused is reported with the gate that refused it,
 * so a "written: 0" is explainable rather than mysterious.
 */
export function gateDrafts(drafts: Draft[]): { accepted: Draft[]; rejected: DraftRejection[] } {
  const accepted: Draft[] = [];
  const rejected: DraftRejection[] = [];
  for (const draft of drafts) {
    const content = draft.content.trim();
    if (!EXTRACTABLE_TYPES.includes(draft.type)) {
      rejected.push({ gate: 'shape', reason: `type ${draft.type} is not extractable`, content });
      continue;
    }
    if (content.length < 2 || content.length > MAX_CONTENT_CHARS) {
      rejected.push({ gate: 'shape', reason: `length ${content.length} (2..${MAX_CONTENT_CHARS})`, content });
      continue;
    }
    if (content.replace(/[\s\p{P}\p{S}]/gu, '').length < 2) {
      rejected.push({ gate: 'semantic', reason: 'no word characters', content });
      continue;
    }
    if (accepted.length >= MAX_DRAFTS_PER_TURN) {
      rejected.push({ gate: 'budget', reason: `more than ${MAX_DRAFTS_PER_TURN} drafts in one turn`, content });
      continue;
    }
    accepted.push({ ...draft, content });
  }
  return { accepted, rejected };
}

/**
 * A question is not a statement to remember.
 *
 * Measured case: "我们这个记忆会记住日常生活吗？" was stored as a fact because a
 * trigger word matched before anything looked at the sentence type.
 */
export function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith('？') || trimmed.endsWith('?')) return true;
  return /(吗|呢)[。.!！~～]?$/.test(trimmed);
}

export function ruleExtract(turns: Turn[]): Draft[] {
  const drafts: Draft[] = [];
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    if (isQuestion(turn.content)) continue;
    for (const rule of RULES) {
      if (!rule.match(turn.content)) continue;
      // A rule may rewrite the turn; a strategy we cannot phrase is not stored.
      const content = rule.distill ? rule.distill(turn.content) : turn.content.trim();
      if (content) drafts.push({ type: rule.type, content, importance: rule.importance });
      break;
    }
  }
  return drafts;
}

/** Corrections raise tension and lower passion; an ordinary session lets tension decay. */
export function nextEmotion(current: Emotion, turns: Turn[]): Emotion {
  const corrected = turns.some((t) => t.role === 'user' && CORRECTION.test(t.content));
  if (corrected) {
    return {
      passion: round2(clamp(current.passion - 0.1, -2, 2)),
      bond: round2(current.bond),
      tension: round2(clamp(current.tension + 0.3, -2, 2)),
      selfRegard: round2(clamp(current.selfRegard - 0.05, -2, 2)),
      curiosity: round2(current.curiosity),
      contentment: round2(clamp(current.contentment - 0.05, -2, 2)),
    };
  }
  return {
    passion: round2(current.passion),
    bond: round2(clamp(current.bond + 0.02, -2, 2)),
    tension: round2(clamp(current.tension * 0.85, -2, 2)),
    selfRegard: round2(current.selfRegard),
    curiosity: round2(current.curiosity),
    contentment: round2(current.contentment),
  };
}

export interface ReflectOptions {
  soulId: string;
  userId: string;
  turns: Turn[];
  now?: number;
  /**
   * Whether this call also advances emotion (default true). A caller that runs
   * reflect per turn, alongside observe(), must pass false or the turn is
   * counted twice.
   */
  updateEmotion?: boolean;
  /** Reserved for richer extraction; unused in v0. */
  llm?: LlmFn;
}

export async function reflect(store: SoulStore, options: ReflectOptions): Promise<ReflectResult> {
  const now = options.now ?? Date.now();
  const drafts: Draft[] = [];
  if (options.llm) {
    for (const turn of options.turns) {
      if (turn.role !== 'user') continue;
      try {
        const draft = await llmExtractTurn(turn.content, options.llm);
        // A deliberate null means the model decided this is not worth storing.
        if (draft) drafts.push(draft);
      } catch {
        // Transport or parse failure: fall back to rules for this turn.
        drafts.push(...ruleExtract([turn]));
      }
    }
  } else {
    drafts.push(...ruleExtract(options.turns));
  }
  const existing = store.query({ soulId: options.soulId, userId: options.userId });
  const seen = new Set(existing.map((m) => m.content));

  const { accepted, rejected } = gateDrafts(drafts);
  let written = 0;
  for (const draft of accepted) {
    if (seen.has(draft.content)) continue;
    seen.add(draft.content);
    const memory: Memory = {
      id: `mem_${randomUUID().slice(0, 8)}`,
      soulId: options.soulId,
      userId: options.userId,
      type: draft.type,
      content: draft.content,
      importance: draft.importance,
      vividness: 0.8,
      recallCount: 0,
      status: 'active',
      visibility: draft.type === 'relationship' ? 'private' : 'private',
      keywords: tokenize(draft.content),
      createdAt: now,
      validFrom: now,
    };
    store.put(memory);
    written += 1;
  }

  let emotion = store.emotion(options.soulId, options.userId);
  if (options.updateEmotion !== false) {
    emotion = nextEmotion(emotion, options.turns);
    store.saveEmotion(options.soulId, options.userId, emotion);
  }

  return { memories: written, superseded: null, emotion, committed: written > 0, rejections: rejected };
}

/* ------------------------------------------------------------------ *
 * LLM distillation port (optional)
 *
 * Core owns the prompt, the JSON contract and the fallback; adapters own the
 * transport. A DSH adapter wraps `ctx.llm.stream`, a CLI adapter calls an
 * OpenAI-compatible endpoint, and both satisfy the same `LlmFn`.
 * ------------------------------------------------------------------ */

/** Only these types travel over the port; episodic/relationship stay host-local. */
export const LLM_MEMORY_TYPES: MemoryType[] = ['strategy', 'trait', 'fact', 'cognition'];

export const LLM_PROMPT = [
  '你是记忆提炼器。输入是用户的一段话，判断其中有没有值得长期记住的内容。',
  '只输出 JSON，二选一：',
  '{"type":"strategy|trait|fact|cognition|null","text":"不超过 40 字的记忆"}',
  '规则：',
  '1. 只保留长期有效的要求、偏好或事实；一次性的抱怨、讨论、玩笑都输出 null；',
  '2. 保留条件（什么时候）和动作（做什么）；',
  '3. 不要解释，不要编造原文没有的内容。',
].join('\n');

export interface LlmDraft {
  type: MemoryType;
  content: string;
  importance: number;
}

function parseLlmJson(raw: string): { type?: unknown; text?: unknown } | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Ask the model for one memory. Returns null when the model deliberately says
 * "nothing worth storing"; throws when the transport or the output is unusable,
 * so the caller can fall back to rules.
 */
export async function llmExtractTurn(
  text: string,
  llm: LlmFn,
  onRaw?: (raw: string) => void,
): Promise<LlmDraft | null> {
  const raw = await llm(`${LLM_PROMPT}\n\n用户：${text}`);
  onRaw?.(String(raw));
  const parsed = parseLlmJson(String(raw));
  if (!parsed) throw new Error('llm returned no JSON');
  const type = parsed.type;
  if (type === 'null' || parsed.text === undefined || parsed.text === null) return null;
  if (typeof type !== 'string' || !LLM_MEMORY_TYPES.includes(type as MemoryType)) {
    throw new Error(`llm returned an unsupported type: ${String(type)}`);
  }
  const content = String(parsed.text).trim();
  if (content.length === 0) return null;
  return {
    type: type as MemoryType,
    content: content.slice(0, 120),
    importance: type === 'strategy' ? 7 : 6,
  };
}