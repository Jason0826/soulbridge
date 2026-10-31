/**
 * Retrieval scoring. Pure functions, no I/O.
 *
 * score = 0.35*relevance + 0.25*importance + 0.20*recency + 0.15*vividness + 0.05*recall
 *
 * The weights are a claim, not a truth: changing them changes behaviour, so they
 * live here (one place) and are covered by tests.
 *
 * relevance 有两种算法：
 *   - `relevance()`：命中比例。只看"命中了几个 query 词"，不看稀有度、不看长度。
 *   - `bm25()`：IDF + 长度归一化 + 词频饱和。
 *
 * rank() 用 bm25。原因（真机 60 条记忆 / 298 条真实 query 实测）：
 *   旧算法下，一条 18202 字的聊天记录在 85% 的 query 里进 top3，top1 平均 12150 字；
 *   换 bm25 后降到 17%，top1 平均 1294 字。文档长度在这个库里差三个数量级
 *   （4 字 ~ 18202 字），长度归一化是决定性的——这一点在长度均匀的语料上测不出来。
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

/** BM25 constants. k1 = term-frequency saturation, b = length normalization. */
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

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

/** Token list of one memory, duplicates kept (BM25 needs term frequency). */
function memoryTokens(memory: Memory): string[] {
  return [...tokenize(memory.content), ...memory.keywords.map((k) => k.toLowerCase())];
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

/** Corpus statistics BM25 needs. Must be built over the candidate set, not one memory. */
export interface CorpusStats {
  idf: Map<string, number>;
  avgdl: number;
}

/** Build idf / average length over a batch of tokenized documents. Call once per query. */
export function buildCorpusStats(docs: string[][]): CorpusStats {
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const tokens of docs) {
    totalLen += tokens.length;
    for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const n = Math.max(1, docs.length);
  const idf = new Map<string, number>();
  for (const [token, count] of df) {
    // +1 keeps idf positive so a shared rare token never becomes a penalty.
    idf.set(token, Math.log((n + 1) / (count + 1)) + 1);
  }
  return { idf, avgdl: totalLen / n };
}

/** BM25 over pre-tokenized document tokens. Length normalization is why this replaced plain recall. */
export function bm25(tokens: string[], docTokens: string[], stats: CorpusStats): number {
  if (tokens.length === 0) return 0;
  if (docTokens.length === 0) return 0;

  const tf = new Map<string, number>();
  for (const token of docTokens) tf.set(token, (tf.get(token) ?? 0) + 1);

  const dl = docTokens.length;
  const norm = 1 - BM25_B + (BM25_B * dl) / Math.max(1, stats.avgdl);

  let score = 0;
  for (const token of new Set(tokens)) {
    const f = tf.get(token) ?? 0;
    if (f === 0) continue;
    const idf = stats.idf.get(token) ?? 1;
    score += (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * norm);
  }
  return score;
}

export function recency(reference: number, now: number): number {
  const days = Math.max(0, (now - reference) / 86_400_000);
  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * @param relOverride 归一化到 0–1 的相关性。rank() 传 BM25 的归一化值；
 *                    省略时退回旧的命中比例，保持单独调用的行为不变。
 */
export function scoreMemory(
  memory: Memory,
  queryTokens: string[],
  now: number,
  relOverride?: number,
): number {
  const rel = relOverride ?? relevance(queryTokens, memory);
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
  if (tokens.length === 0) {
    return memories
      .map((memory) => ({ memory, score: scoreMemory(memory, tokens, now) }))
      .sort((a, b) => b.score - a.score);
  }

  const stats = buildCorpusStats(memories.map(memoryTokens));
  const scored = memories.map((memory) => ({ memory, raw: bm25(tokens, memoryTokens(memory), stats) }));
  const best = scored.reduce((max, s) => Math.max(max, s.raw), 0);
  if (best <= 0) return [];

  // Normalize to 0–1 so the weighted sum below keeps its original scale.
  return scored
    .filter((s) => s.raw > 0)
    .map(({ memory, raw }) => ({ memory, score: scoreMemory(memory, tokens, now, raw / best) }))
    .sort((a, b) => b.score - a.score);
}
