/**
 * Whitelisted style directives (ADR 0014).
 *
 * The prompt may only ever contain text from this catalog. There is no code
 * path that turns free-form analysis into prose, because a wrong "you seem
 * angry" is worse than saying nothing.
 */
import type { AffectSignal } from '../types.ts';

export type DirectiveId = 'hedging' | 'fragmented' | 'negative_high' | 'positive_high' | 'vague_terms';

export interface Directive {
  id: DirectiveId;
  text: string;
}

export const DIRECTIVE_CATALOG: readonly Directive[] = [
  { id: 'negative_high', text: '对方情绪偏负面：先承接，再给方案；不要急着讲道理' },
  { id: 'positive_high', text: '对方情绪偏正面：回答可以更简短' },
  { id: 'hedging', text: '对方表达里犹豫词偏多：给结论，少加限定语' },
  { id: 'fragmented', text: '对方表达较碎片：先复述你的理解，再回答' },
  { id: 'vague_terms', text: '对方用词较笼统：必要时确认具体所指' },
] as const;

const per100 = (count: number, tokens: number): number => (tokens > 0 ? (count * 100) / tokens : 0);

/** Which catalog entries the signal justifies, in priority order, capped at `max`. */
export function selectDirectives(signal: AffectSignal, max = 2): Directive[] {
  if (signal.hits.length === 0 || signal.confidence < 0.6) return [];

  const triggered = new Set<DirectiveId>();
  if (signal.valence <= -0.4 && signal.intensity >= 6) triggered.add('negative_high');
  if (signal.valence >= 0.4 && signal.intensity >= 6) triggered.add('positive_high');
  // Absolute minimums stop a single "这个" in a ten-token sentence from
  // reading as "fragmented" — rate alone is misleading on short inputs.
  if (signal.features.hedges >= 2 && per100(signal.features.hedges, signal.features.tokens) >= 6) {
    triggered.add('hedging');
  }
  if (signal.features.fillers >= 3 && per100(signal.features.fillers, signal.features.tokens) >= 8) {
    triggered.add('fragmented');
  }
  if (signal.features.vague >= 3) triggered.add('vague_terms');

  return DIRECTIVE_CATALOG.filter((d) => triggered.has(d.id)).slice(0, max);
}
