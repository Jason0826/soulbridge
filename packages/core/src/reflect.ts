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
  re: RegExp;
  type: MemoryType;
  importance: number;
}

/** Cheap, synchronous, no model. Deliberately conservative: false positives cost trust. */
const RULES: Rule[] = [
  { re: /(记住|别忘了|remember|don'?t forget)/i, type: 'fact', importance: 7 },
  { re: /(我喜欢|我习惯|我偏好|我倾向|i prefer|i like)/i, type: 'trait', importance: 6 },
  { re: /(以后|下次|每次|从现在起|from now on|always)/i, type: 'strategy', importance: 7 },
  { re: /(我决定|就这么定|原则是|i decided|my rule)/i, type: 'cognition', importance: 7 },
];

const CORRECTION = /(不对|不是这样|错了|你搞错|wrong|that'?s not right|incorrect)/i;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function ruleExtract(turns: Turn[]): Draft[] {
  const drafts: Draft[] = [];
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    for (const rule of RULES) {
      if (rule.re.test(turn.content)) {
        drafts.push({ type: rule.type, content: turn.content.trim(), importance: rule.importance });
        break;
      }
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
