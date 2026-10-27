/**
 * soulbridge core — the personality layer.
 *
 * Public surface is deliberately tiny: a facade (`Soul`) over four verbs.
 * Anything a host needs beyond this belongs in an adapter.
 */
export * from './types.ts';
export type { SoulStore } from './store.ts';
export { openSqlite } from './sqlite.ts';
export { buildContext, styleDirectives, DEFAULT_MAX_CHARS } from './context.ts';
export { reflect, ruleExtract, nextEmotion } from './reflect.ts';
export { rank, scoreMemory, tokenize, relevance } from './scoring.ts';

import type {
  ContextRequest,
  ContextResult,
  Emotion,
  LlmFn,
  MemoryType,
  ObserveResult,
  ReflectResult,
  ScoredMemory,
  Turn,
  Visibility,
} from './types.ts';
import type { SoulStore } from './store.ts';
import { buildContext } from './context.ts';
import { reflect, ruleExtract, nextEmotion } from './reflect.ts';
import { rank, tokenize } from './scoring.ts';

export interface SoulOptions {
  store: SoulStore;
  soulId: string;
  userId: string;
  name?: string;
  /** When the soul was born. Defaults to now; backdate it to demo long relationships. */
  createdAt?: number;
}

export class Soul {
  readonly store: SoulStore;
  readonly soulId: string;
  readonly userId: string;
  readonly name: string;

  constructor(options: SoulOptions) {
    this.store = options.store;
    this.soulId = options.soulId;
    this.userId = options.userId;
    this.name = options.name ?? '小灵';

    if (!this.store.identity(this.soulId)) {
      this.store.ensureSoul({
        soulId: this.soulId,
        name: this.name,
        createdAt: options.createdAt ?? Date.now(),
      });
    }
  }

  /** Verb 1: session start. */
  context(request: Partial<ContextRequest> = {}): ContextResult {
    return buildContext(this.store, {
      soulId: this.soulId,
      userId: this.userId,
      query: request.query,
      maxChars: request.maxChars,
    });
  }

  /** Verb 3: on demand. */
  recall(query: string, limit = 5): ScoredMemory[] {
    const memories = this.store.query({ soulId: this.soulId, userId: this.userId });
    const ranked = rank(memories, query, Date.now()).slice(0, limit);
    this.store.touch(ranked.map((r) => r.memory.id));
    return ranked;
  }

  /** Verb 2: after each turn. Cheap and synchronous by design. */
  observe(turn: Turn): ObserveResult {
    const now = turn.at ?? Date.now();
    const drafts = ruleExtract([turn]);
    for (const draft of drafts) {
      this.store.put({
        id: `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        soulId: this.soulId,
        userId: this.userId,
        type: draft.type,
        content: draft.content,
        importance: draft.importance,
        vividness: 0.8,
        recallCount: 0,
        status: 'active',
        visibility: 'private',
        keywords: [],
        createdAt: now,
        validFrom: now,
      });
    }

    const emotion = nextEmotion(this.store.emotion(this.soulId, this.userId), [turn]);
    this.store.saveEmotion(this.soulId, this.userId, emotion);
    return { written: drafts.length, emotion };
  }

  /**
   * Explicit form of `observe`: the host decided this is worth keeping.
   * Same write path, no extraction heuristics.
   */
  remember(
    content: string,
    options: { type?: MemoryType; importance?: number; visibility?: Visibility } = {},
  ): string {
    const now = Date.now();
    const id = `mem_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.store.put({
      id,
      soulId: this.soulId,
      userId: this.userId,
      type: options.type ?? 'fact',
      content,
      importance: options.importance ?? 6,
      vividness: 0.9,
      recallCount: 0,
      status: 'active',
      visibility: options.visibility ?? 'private',
      keywords: tokenize(content),
      createdAt: now,
      validFrom: now,
    });
    return id;
  }

  /** Verb 4: session end. */
  async reflect(turns: Turn[], llm?: LlmFn): Promise<ReflectResult> {
    return reflect(this.store, { soulId: this.soulId, userId: this.userId, turns, llm });
  }

  stats(): { memories: number; emotion: Emotion; name: string } {
    return {
      name: this.name,
      memories: this.store.count(this.soulId, this.userId),
      emotion: this.store.emotion(this.soulId, this.userId),
    };
  }
}
