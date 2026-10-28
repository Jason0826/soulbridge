/**
 * The only port. Every added method is a storage engine's opinion leaking into
 * the domain, so the surface stays deliberately small.
 */
import type { AffectSignal, Emotion, Identity, Memory, QuerySpec } from './types.ts';

export interface SoulStore {
  ensureSoul(identity: Identity): void;
  identity(soulId: string): Identity | null;

  emotion(soulId: string, userId: string): Emotion;
  saveEmotion(soulId: string, userId: string, emotion: Emotion, now?: number): void;

  put(memory: Memory): void;
  /** Active, non-deleted memories visible to `userId` (own private + shared). */
  query(spec: QuerySpec): Memory[];
  /** Recall bookkeeping: recallCount++, lastRecalledAt = now. */
  touch(ids: string[], now?: number): void;

  /** Persist one affect sample (payload only; no raw text). */
  saveAffect(soulId: string, userId: string, signal: AffectSignal, at: number, deviceId?: string): void;
  /** Samples newer than `sinceMs`, newest first. */
  recentAffect(soulId: string, userId: string, sinceMs: number): AffectSignal[];
  /** Drop samples older than `beforeMs`; returns rows removed. */
  purgeAffect(beforeMs: number): number;

  count(soulId: string, userId: string): number;
  close(): void;
}
