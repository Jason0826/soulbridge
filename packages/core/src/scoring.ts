/**
 * Retrieval scoring. Pure functions, no I/O.
 *
 * score = 0.35*relevance + 0.25*importance + 0.20*recency + 0.15*vividness + 0.05*recall
 *
 * The weights are a claim, not a truth: changing them changes behaviour, so they
 * live here (one place) and are covered by tests.
 */
import type { Memory } from './types.ts';

/** A memory's relevance halves every 30 days without being recalled. */
export const RECENCY_HALF_LIFE_DAYS = 30;

export const WEIGHTS = {
  relevance: 0.35,
  importance: 0.25,
  recency: 0.2,
  vividness: 0.15,
  recall: 0.05,
} as const;

/**
 * CJK text has no spaces, so single characters are too coarse and the whole
 * sentence is too fine: use character bigrams. Latin runs become words.
 */
export function tokenize(input: string): string[] {
  const lower = input.toLowerCase();
  const out = new Set<string>();

  for (const word of lower.match(/[a-z0-9_]{2,}/g) ?? []) out.add(word);

  for (const run of lower.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2));
  }

  return [...out];
}

export function relevance(queryTokens: string[], memory: Memory): number {
  if (queryTokens.length === 0) return 0;
  const pool = new Set<string>([
    ...tokenize(memory.content),
    ...memory.keywords.map((k) => k.toLowerCase()),
  ]);
  let hit = 0;
  for (const token of queryTokens) if (pool.has(token)) hit += 1;
  return hit / queryTokens.length;
}

export function recency(reference: number, now: number): number {
  const days = Math.max(0, (now - reference) / 86_400_000);
  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function scoreMemory(memory: Memory, queryTokens: string[], now: number): number {
  const rel = relevance(queryTokens, memory);
  const imp = clamp01(memory.importance / 10);
  const rec = recency(memory.lastRecalledAt ?? memory.createdAt, now);
  const viv = clamp01(memory.vividness);
  const recall = clamp01(memory.recallCount / 10);

  return (
    rel * WEIGHTS.relevance +
    imp * WEIGHTS.importance +
    rec * WEIGHTS.recency +
    viv * WEIGHTS.vividness +
    recall * WEIGHTS.recall
  );
}

export function rank(memories: Memory[], query: string, now: number): Array<{ memory: Memory; score: number }> {
  const tokens = tokenize(query);

  // A query is a selection: with one, a memory that shares no token is noise,
  // no matter how important it is. Without one (session start), rank by weight alone.
  const pool = tokens.length === 0 ? memories : memories.filter((m) => relevance(tokens, m) > 0);

  return pool
    .map((memory) => ({ memory, score: scoreMemory(memory, tokens, now) }))
    .sort((a, b) => b.score - a.score);
}
