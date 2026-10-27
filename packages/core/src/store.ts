/**
 * The only port. Six methods on purpose: every added method is a storage
 * engine's opinion leaking into the domain.
 */
import type { Emotion, Identity, Memory, QuerySpec } from './types.ts';

export interface SoulStore {
  ensureSoul(identity: Identity): void;
  identity(soulId: string): Identity | null;

  emotion(soulId: string, userId: string): Emotion;
  saveEmotion(soulId: string, userId: string, emotion: Emotion): void;

  put(memory: Memory): void;
  /** Active memories visible to `userId` (own private + shared). */
  query(spec: QuerySpec): Memory[];
  /** Recall bookkeeping: recallCount++, lastRecalledAt = now. */
  touch(ids: string[], now?: number): void;

  count(soulId: string, userId: string): number;
  close(): void;
}
