/**
 * Rule-based affect analyzer (ADR 0016 budget: 8 rules, no narrow phrases).
 *
 * Rules implemented here:
 *   R1 lexicon hit           R2 negation window (3 tokens)
 *   R3 degree window (2)     R4 punctuation emphasis (!! ?? ……)
 *   R5 repeated characters   R6 withdrawal phrases (abstain, never injected)
 *   R7 code fences skipped   R8 very short input halves confidence
 *
 * Pure function: no I/O, no model, no globals besides a per-lexicon cache.
 */
import type { AffectCategory, AffectHit, AffectSignal, AffectPolarity } from '../types.ts';
import { EMPTY_AFFECT } from '../types.ts';
import { ABSTAIN_TERMS, DEGREE_DELTA, NEGATORS } from './lexicon.ts';
import type { Lexicon, LexiconEntry } from './lexicon.ts';
import { SEED_LEXICON } from './seed-lexicon.ts';

export const MAX_INPUT_CHARS = 32_000;
export const NEGATION_WINDOW = 3;
export const DEGREE_WINDOW = 2;

export class AffectBudgetError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(length: number) {
    super(`affect input too large: ${length} chars (max ${MAX_INPUT_CHARS})`);
    this.name = 'AffectBudgetError';
  }
}

interface Prepared {
  entries: Map<string, LexiconEntry>;
  fillers: Set<string>;
  hedges: Set<string>;
  vague: Set<string>;
  degree: Map<string, number>;
  dict: Set<string>;
  maxLen: number;
}

const cache = new WeakMap<Lexicon, Prepared>();

function prepare(lexicon: Lexicon): Prepared {
  const cached = cache.get(lexicon);
  if (cached) return cached;

  const entries = new Map(Object.entries(lexicon.entries));
  const fillers = new Set(lexicon.fillers);
  const hedges = new Set(lexicon.hedges);
  const vague = new Set(Object.keys(lexicon.vague));
  const degree = new Map<string, number>();
  for (const level of Object.keys(DEGREE_DELTA) as Array<keyof typeof DEGREE_DELTA>) {
    for (const word of lexicon.degree[level]) degree.set(word, DEGREE_DELTA[level]);
  }

  const dict = new Set<string>([
    ...entries.keys(),
    ...fillers,
    ...hedges,
    ...vague,
    ...degree.keys(),
    ...NEGATORS,
    ...ABSTAIN_TERMS,
  ]);

  let maxLen = 1;
  for (const word of dict) maxLen = Math.max(maxLen, word.length);
  const prepared: Prepared = { entries, fillers, hedges, vague, degree, dict, maxLen };
  cache.set(lexicon, prepared);
  return prepared;
}

/** Full-width punctuation → ASCII, strip code fences and shell lines, drop emoji. */
export function normalizeForAffect(text: string): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ');
  const lines = withoutCode
    .split(/\r?\n/)
    .filter((line) => !/^\s*\$\s/.test(line))
    .join('\n');

  return lines
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u{1f000}-\u{1faff}\u{2600}-\u{27bf}\u{fe0f}\u{200d}]/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .toLowerCase();
}

/** Max forward match over the lexicon dictionary; punctuation and spaces are separators. */
export function tokenizeForAffect(text: string, dict: Set<string>, maxLen: number): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/[\s\p{P}\p{S}]/u.test(ch)) {
      i += 1;
      continue;
    }
    let matched = '';
    for (let len = Math.min(maxLen, text.length - i); len >= 1; len -= 1) {
      const candidate = text.slice(i, i + len);
      if (dict.has(candidate)) {
        matched = candidate;
        break;
      }
    }
    if (matched) {
      tokens.push(matched);
      i += matched.length;
    } else {
      tokens.push(ch);
      i += 1;
    }
  }
  return tokens;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Negating a positive emotion turns it negative ("不开心"), but negating a
 * negative one does not turn it positive ("不生气" is relief, not joy) — it
 * becomes neutral. This is a deliberate, testable simplification.
 */
function flip(polarity: AffectPolarity): AffectPolarity {
  if (polarity === 'positive') return 'negative';
  return 'neutral';
}

export interface AnalyzeOptions {
  lexicon?: Lexicon;
}

export function analyzeAffect(text: string, options: AnalyzeOptions = {}): AffectSignal {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (text.length > MAX_INPUT_CHARS) throw new AffectBudgetError(text.length);

  const lexicon = options.lexicon ?? SEED_LEXICON;
  const prepared = prepare(lexicon);
  const normalized = normalizeForAffect(text);
  const tokens = tokenizeForAffect(normalized, prepared.dict, prepared.maxLen);

  const hits: AffectHit[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = prepared.entries.get(tokens[i]);
    if (!entry) continue;

    let negated = false;
    for (let back = 1; back <= NEGATION_WINDOW && i - back >= 0; back += 1) {
      const prev = tokens[i - back];
      if (NEGATORS.includes(prev)) {
        negated = true;
        break;
      }
      if (prepared.entries.has(prev)) break;
    }

    let degree = 0;
    for (let back = 1; back <= DEGREE_WINDOW && i - back >= 0; back += 1) {
      const delta = prepared.degree.get(tokens[i - back]);
      if (delta !== undefined) {
        degree = delta;
        break;
      }
    }

    let intensity = clamp(entry.intensity + degree, 1, 9);
    let polarity: AffectPolarity = entry.polarity;
    if (negated) {
      polarity = flip(polarity);
      intensity = Math.max(1, Math.round(intensity * 0.8));
    }

    hits.push({
      term: tokens[i],
      category: entry.category,
      intensity,
      polarity,
      negated,
      position: i,
    });
  }

  const byCategory = new Map<AffectCategory, number>();
  let weighted = 0;
  let total = 0;
  for (const hit of hits) {
    byCategory.set(hit.category, (byCategory.get(hit.category) ?? 0) + hit.intensity);
    const sign = hit.polarity === 'positive' ? 1 : hit.polarity === 'negative' ? -1 : 0;
    weighted += sign * hit.intensity;
    total += hit.intensity;
  }

  let dominant: AffectCategory | null = null;
  let best = 0;
  for (const [category, sum] of byCategory) {
    if (sum > best) {
      best = sum;
      dominant = category;
    }
  }

  const emphasis =
    (normalized.match(/[!?]{2,}|…{2,}/g) ?? []).length + (normalized.match(/(.)\1{2,}/gu) ?? []).length;

  let intensity = hits.length > 0 ? Math.max(...hits.map((h) => h.intensity)) : 0;
  if (hits.length > 0 && emphasis > 0) intensity = clamp(intensity + Math.min(2, emphasis), 1, 9);

  const fillers = tokens.filter((t) => prepared.fillers.has(t)).length;
  const hedges = tokens.filter((t) => prepared.hedges.has(t)).length;
  const vague = tokens.filter((t) => prepared.vague.has(t)).length;
  const abstain = hits.length === 0 && ABSTAIN_TERMS.some((term) => normalized.includes(term));

  // No hits means no judgement at all — length alone must never produce confidence.
  let confidence = 0;
  if (hits.length > 0) {
    confidence =
      0.4 * Math.min(1, hits.length / 2) +
      0.2 * Math.min(1, tokens.length / 20) +
      0.25 * (dominant ? 1 : 0) +
      0.15 * (intensity / 9);
    if (tokens.length <= 3) confidence *= 0.5;
  }
  if (abstain) confidence = Math.min(confidence, 0.5);

  return {
    analyzer: 'lexicon',
    hits,
    dominant,
    intensity: Math.round(intensity * 10) / 10,
    valence: total > 0 ? Math.round((weighted / total) * 100) / 100 : 0,
    arousal: clamp(intensity / 9 + 0.1 * emphasis, 0, 1),
    features: {
      fillers,
      hedges,
      vague,
      tokens: tokens.length,
      density: tokens.length > 0 ? (tokens.length - fillers - hedges) / tokens.length : 1,
    },
    confidence: clamp(Math.round(confidence * 100) / 100, 0, 1),
    abstain,
  };
}

/** Lexicon analyzer as a port implementation (ADR 0015). */
export const lexiconAnalyzer = {
  id: 'lexicon',
  analyze(text: string): AffectSignal {
    return analyzeAffect(text);
  },
};

/** Empty signal helper so callers do not reach for the shared constant by accident. */
export function emptyAffect(analyzer = 'none'): AffectSignal {
  return { ...EMPTY_AFFECT, analyzer, features: { ...EMPTY_AFFECT.features } };
}
