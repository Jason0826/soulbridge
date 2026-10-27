/**
 * Domain model. Pure types + constants, no logic, no dependencies.
 *
 * Rule: if a field only makes sense for one storage engine, it does not belong here.
 * (No `vector`, no `embeddingId`, no `rowid`.)
 */

export type MemoryType =
  | 'semantic'
  | 'episodic'
  | 'strategy'
  | 'cognition'
  | 'relationship'
  | 'trait'
  | 'fact';

export type Visibility = 'private' | 'shared';
export type MemoryStatus = 'active' | 'superseded' | 'archived';

export interface Memory {
  id: string;
  soulId: string;
  userId: string;
  type: MemoryType;
  content: string;
  /** 1..10. How much this is worth remembering at all. */
  importance: number;
  /** 0..1. Decays over time; a vivid memory surfaces more easily. */
  vividness: number;
  recallCount: number;
  status: MemoryStatus;
  visibility: Visibility;
  keywords: string[];
  createdAt: number;
  lastRecalledAt?: number;
  validFrom?: number;
  validUntil?: number;
  supersededBy?: string;
}

export interface Identity {
  soulId: string;
  name: string;
  creator?: string;
  createdAt: number;
}

/** Six dimensions, each -2..+2. Baseline is slightly positive. */
export interface Emotion {
  passion: number;
  bond: number;
  tension: number;
  selfRegard: number;
  curiosity: number;
  contentment: number;
}

export const DEFAULT_EMOTION: Emotion = {
  passion: 0.3,
  bond: 0.3,
  tension: 0.1,
  selfRegard: 0.3,
  curiosity: 0.3,
  contentment: 0.3,
};

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  at?: number;
}

export interface ContextRequest {
  soulId: string;
  userId: string;
  query?: string;
  maxChars?: number;
}

export interface ContextResult {
  text: string;
  used: string[];
  dropped: number;
  chars: number;
}

export interface RecallRequest {
  soulId: string;
  userId: string;
  q: string;
  limit?: number;
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
}

export interface QuerySpec {
  soulId: string;
  userId: string;
  status?: MemoryStatus[];
  types?: MemoryType[];
  limit?: number;
}

export interface ReflectResult {
  memories: number;
  superseded: number;
  emotion: Emotion;
}

export interface ObserveResult {
  written: number;
  emotion: Emotion;
}

/** Injected by the caller. `core` never imports a model SDK. */
export type LlmFn = (prompt: string) => Promise<string> | string;
