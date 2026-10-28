/**
 * Reflection: turn a finished session into durable memory + an emotion update.
 *
 * `core` never calls a model itself. If the caller passes an `LlmFn`, richer
 * extraction is possible later; today the rule path is the default, which keeps
 * the whole loop runnable offline.
 */
import { randomUUID } from 'node:crypto';
import type { Emotion, LlmFn, Memory, MemoryType, ReflectResult, Turn } from './types.ts';
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

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function ruleExtract(turns: Turn[]): Draft[] {
  const drafts: Draft[] = [];
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
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
  /** Reserved for richer extraction; unused in v0. */
  llm?: LlmFn;
}

export async function reflect(store: SoulStore, options: ReflectOptions): Promise<ReflectResult> {
  const now = options.now ?? Date.now();
  const drafts = ruleExtract(options.turns);
  const existing = store.query({ soulId: options.soulId, userId: options.userId });
  const seen = new Set(existing.map((m) => m.content));

  let written = 0;
  for (const draft of drafts) {
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

  const emotion = nextEmotion(store.emotion(options.soulId, options.userId), options.turns);
  store.saveEmotion(options.soulId, options.userId, emotion);

  return { memories: written, superseded: 0, emotion };
}
