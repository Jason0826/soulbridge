/**
 * Lexicon contract (ADR 0013).
 *
 * We adopt the *structure* of the DUTIR taxonomy (7 categories, intensity 1-9,
 * polarity) because structures are not copyrightable. We do NOT ship any word
 * list derived from an academic lexicon: the seed list in seed-lexicon.ts is
 * written for this project. Users may import their own lexicon and carry the
 * licensing consequences themselves.
 */
import type { AffectCategory, AffectPolarity } from '../types.ts';

export interface LexiconEntry {
  category: AffectCategory;
  /** 1..9 */
  intensity: number;
  polarity: AffectPolarity;
}

export interface DegreeWords {
  weak: string[];
  medium: string[];
  strong: string[];
  extreme: string[];
}

export interface Lexicon {
  version: string;
  lang: string;
  entries: Record<string, LexiconEntry>;
  fillers: string[];
  hedges: string[];
  vague: Record<string, string[]>;
  degree: DegreeWords;
}

/** Multiplicative-ish adjustment applied to a hit's intensity. */
export const DEGREE_DELTA: Record<keyof DegreeWords, number> = {
  weak: -1,
  medium: 1,
  strong: 2,
  extreme: 3,
};

/** Words that flip polarity when they precede an emotion word. */
export const NEGATORS = ['不', '没', '别', '无', '未', '不是', '没有', '不再', '不用', '不太'];

/** Withdrawal phrases: no explicit emotion word, but the affect is negative and weak. */
export const ABSTAIN_TERMS = ['行吧', '随便', '算了', '随你', '都行', '无所谓', '你定', '看着办', '再说吧'];

const CATEGORIES: AffectCategory[] = ['joy', 'anger', 'sadness', 'fear', 'disgust', 'surprise'];
const POLARITIES: AffectPolarity[] = ['positive', 'negative', 'neutral'];

/**
 * Validate an externally supplied lexicon. Returns human-readable problems;
 * an empty array means the lexicon is usable.
 */
export function validateLexicon(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) return ['lexicon must be an object'];
  const lex = value as Partial<Lexicon>;

  if (typeof lex.version !== 'string') errors.push('version must be a string');
  if (typeof lex.lang !== 'string') errors.push('lang must be a string');

  if (typeof lex.entries !== 'object' || lex.entries === null) {
    errors.push('entries must be an object');
  } else {
    for (const [word, entry] of Object.entries(lex.entries)) {
      if (!word.trim()) errors.push('entries: empty word');
      const e = entry as Partial<LexiconEntry>;
      if (!CATEGORIES.includes(e.category as AffectCategory)) {
        errors.push(`entries["${word}"].category is invalid`);
      }
      if (typeof e.intensity !== 'number' || e.intensity < 1 || e.intensity > 9) {
        errors.push(`entries["${word}"].intensity must be 1..9`);
      }
      if (!POLARITIES.includes(e.polarity as AffectPolarity)) {
        errors.push(`entries["${word}"].polarity is invalid`);
      }
    }
  }

  for (const key of ['fillers', 'hedges'] as const) {
    if (!Array.isArray(lex[key])) errors.push(`${key} must be an array`);
  }
  if (typeof lex.vague !== 'object' || lex.vague === null) errors.push('vague must be an object');
  if (typeof lex.degree !== 'object' || lex.degree === null) {
    errors.push('degree must be an object');
  } else {
    for (const level of ['weak', 'medium', 'strong', 'extreme'] as const) {
      if (!Array.isArray(lex.degree[level])) errors.push(`degree.${level} must be an array`);
    }
  }

  return errors;
}
