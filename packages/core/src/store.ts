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
  FactRole,
  FactSpec,
  FactStatus,
  Gap,
  GapSpec,
  Identity,
  Memory,
  QuerySpec,
  SessionSummary,
  SlotValue,
  TurnPair,
  TurnPairSpec,
  TurnFindResult,
  TurnFindSpec,
  TurnSpec,
  TurnStep,
  TurnThread,
  ThreadSpec,
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
  putTurnPair(pair: TurnPair, steps?: TurnStep[]): void;
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
  /** Open a topic thread. */
  openThread(spec: ThreadSpec): TurnThread;
  /** Put one turn into a thread; a turn belongs to exactly one. */
  attachTurn(turnId: string, threadId: string): void;
  /** Remember the newest turn number seen in a thread (used for ordering). */
  touchThread(id: string, turnNo: number): void;
  /**
   * Replace a thread's one-line topic.
   *
   * The topic is written when the thread opens, so a thread that continues for an hour
   * would otherwise stay labelled with its first (often two-word) turn — and the label
   * is what "上次聊到哪" shows.
   */
  updateThreadTopic(id: string, topic: string): void;
  /** Open threads, most recently used first — the candidate list for attribution. */
  openThreads(soulId: string, userId: string, limit?: number): TurnThread[];
  /**
   * The user text of the turn before `turnNo` in a session, or null.
   *
   * Extraction is per turn; without the previous line it cannot tell "继续" from a
   * new subject, and pronouns have nothing to bind to (ADR 0034).
   */
  previousTurnText(sessionId: string, turnNo: number): string | null;
  thread(id: string): TurnThread | null;
  closeThread(id: string, at: number, summaryFactId?: string): void;
  /** Close threads whose last turn is at least idleTurns behind now; returns the ids. */
  closeIdleThreads(soulId: string, userId: string, sessionId: string, idleTurns: number, idleMs: number, archivedSessionIds: string[], at: number): Array<{ id: string; reason: 'archived' | 'quiet-turns' | 'quiet-time' }>;
  /** Append slots to an existing fact, skipping ones it has. Returns how many were added. */
  addSlots(factId: string, slots: { slot: string; value: SlotValue }[]): number;
  setFactTypeName(factId: string, typeName: string): void;
  /** What the fact is for (config/domains.ts FACT_ROLES); the caller decides. */
  setFactRole(factId: string, role: FactRole): void;
  /** Lifecycle state (config/status.ts); code writes it, never the model. */
  setFactStatus(factId: string, status: FactStatus): void;
  setFactConfidence(factId: string, confidence: number): void;
  /** Count that retrieval surfaced these facts (0019: use slows decay). */
  recordRecalls(factIds: string[], at: number): void;
  /** Facts about one entity, newest event first; predicate narrows within it. */
  latestAbout(soulId: string, userId: string, entityName: string, options?: { predicate?: string; query?: string; limit?: number; now?: number }): Fact[];
  /** A turn by (session, turn number) — how a repeat gets its real id. */
  turnByTurnNo(sessionId: string, turnNo: number): TurnPair | null;
  /** The thread the previous turn belonged to, if any. */
  threadBefore(sessionId: string, turnNo: number): string | null;
  /** The most recently closed thread, or null when none has closed yet. */
  lastClosedThread(soulId: string, userId: string): TurnThread | null;
  /** Every turn of a thread, in order — the chapter, not one page. */
  threadTurns(threadId: string): TurnPair[];
  /** Facts whose source turn belongs to the given turns. */
  factsByTurns(turnIds: string[]): Fact[];
  /** One turn by id, for expanding a fact back into its conversation. */
  turn(id: string): TurnPair | null;
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

  /**
   * Retire a legacy memory whose replacement is not a memory (the migration replaces
   * rows with facts). Same bookkeeping, no cross-table existence check.
   */
  retireMemory(oldId: string, replacedBy?: string, now?: number): boolean;

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
