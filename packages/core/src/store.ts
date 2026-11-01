/**
 * The only port. Every added method is a storage engine's opinion leaking into
 * the domain, so the surface stays deliberately small.
 */
import type {
  AffectSignal,
  Correction,
  Emotion,
  Entity,
  EntityQuery,
  EntitySpec,
  Fact,
  FactQuery,
  FactSpec,
  Gap,
  GapSpec,
  Identity,
  Memory,
  QuerySpec,
  SessionSummary,
  TurnPair,
  TurnPairSpec,
  TurnFindResult,
  TurnFindSpec,
  TurnSpec,
  TurnStep,
} from './types.ts';

export interface SoulStore {
  ensureSoul(identity: Identity): void;
  identity(soulId: string): Identity | null;

  emotion(soulId: string, userId: string): Emotion;
  saveEmotion(soulId: string, userId: string, emotion: Emotion, now?: number): void;

  put(memory: Memory): void;
  /** Active, non-deleted memories visible to `userId` (own private + shared). */
  query(spec: QuerySpec): Memory[];

  /**
   * Store one exchange. Idempotent on `(soul, user, session, turn)`: a repeat is
   * ignored, never merged — the original text is immutable (RFC 0007).
   */
  putTurnPair(pair: TurnPair): void;
  /** Write one turn with its ordered steps (briefs/0014). */
  putTurn(spec: TurnSpec): void;
  /** Steps of one turn, in order. */
  stepsOf(turnId: string): TurnStep[];
  /** Exhaustive fetch by substring/filters — for counts and overviews. */
  findTurns(spec: TurnFindSpec): TurnFindResult;
  /** Create or refresh a person/thing/place/self; keys on name within a type. */
  putEntity(spec: EntitySpec): Entity;
  entity(id: string): Entity | null;
  findEntities(query: EntityQuery): Entity[];
  /** One connection between things, with its ends. */
  putFact(spec: FactSpec): Fact;
  fact(id: string): Fact | null;
  facts(query: FactQuery): Fact[];
  /** Retire a fact: the new one replaces it, the old row stays for the record. */
  supersedeFact(oldId: string, newId: string): void;
  /** Something wanted but not known; the highest tension is worth asking about. */
  putGap(spec: GapSpec): Gap;
  openGaps(soulId: string, userId: string, limit?: number): Gap[];
  closeGap(id: string, closedByFactId?: string, at?: number): void;
  /** Exchanges visible to `userId`; scored against `spec.query` when given. */
  recallTurnPairs(spec: TurnPairSpec): TurnPair[];
  countTurnPairs(soulId: string, userId: string, sessionId?: string): number;
  /** Conversations derived from pairs, most recent first. */
  listSessions(soulId: string, userId: string, limit: number): SessionSummary[];
  /** Exchanges of one conversation, oldest first. */
  sessionPairs(sessionId: string, soulId: string, userId: string, limit: number): TurnPair[];
  /** Last exchanges of one conversation, oldest first. */
  sessionTail(sessionId: string, soulId: string, userId: string, limit: number): TurnPair[];

  /** Recall bookkeeping: recallCount++, lastRecalledAt = now. */
  touch(ids: string[], now?: number): void;
  /**
   * Tombstone a memory so it never surfaces again (sync-safe: the row stays for
   * merge, the deletion wins by updatedAt). Returns false when no such active row.
   */
  forget(id: string, now?: number): boolean;
  /**
   * Mark `oldId` as replaced by `newId` (status superseded, supersededBy set).
   * Both rows stay; returns false when the replacement is missing or the old row
   * is not active.
   */
  supersede(oldId: string, newId: string, now?: number): boolean;

  /** Persist one affect sample (payload only; no raw text). */
  saveAffect(soulId: string, userId: string, signal: AffectSignal, at: number, deviceId?: string): void;
  /** Samples newer than `sinceMs`, newest first. */
  recentAffect(soulId: string, userId: string, sinceMs: number): AffectSignal[];
  /** Drop samples older than `beforeMs`; returns rows removed. */
  purgeAffect(beforeMs: number): number;

  /** Evidence, not memory: a user correction plus the reply it targeted. */
  saveCorrection(correction: Correction): void;
  recentCorrections(soulId: string, userId: string, limit: number): Correction[];
  countCorrections(soulId: string, userId: string): number;

  count(soulId: string, userId: string): number;
  close(): void;
}
