/**
 * Output-side style measurement.
 *
 * This is the instrument for the emotion→behaviour experiment (ADR 0017): we
 * measure what the agent actually wrote, never what it says about itself.
 */
import { SEED_LEXICON } from '../affect/seed-lexicon.ts';
import { normalizeForAffect, tokenizeForAffect } from '../affect/analyze.ts';
import type { Lexicon } from '../affect/lexicon.ts';

export interface StyleMetrics {
  /** Characters in the raw reply. */
  length: number;
  /** Hedge words per 100 characters. */
  hedgeRate: number;
  /** Question marks (full-width normalised). */
  questions: number;
  /** Whether the reply opens by restating or confirming the request. */
  confirmFirst: boolean;
}

const CONFIRM_OPENERS = ['好的', '好', '我先', '让我先', '我理解', '先确认', '确认一下', '明白'];

export function measureStyle(text: string, lexicon: Lexicon = SEED_LEXICON): StyleMetrics {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const normalized = normalizeForAffect(text);

  let hedges = 0;
  if (lexicon.hedges.length > 0) {
    const dict = new Set(lexicon.hedges);
    const maxLen = lexicon.hedges.reduce((n, w) => Math.max(n, w.length), 1);
    hedges = tokenizeForAffect(normalized, dict, maxLen).filter((t) => dict.has(t)).length;
  }

  const questions = (normalized.match(/\?/g) ?? []).length;
  const head = normalized.trim().slice(0, 24);

  return {
    length: text.length,
    hedgeRate: normalized.length > 0 ? Math.round(((hedges * 100) / normalized.length) * 100) / 100 : 0,
    questions,
    confirmFirst: CONFIRM_OPENERS.some((opener) => head.startsWith(opener)),
  };
}
