/**
 * soulbridge core — the personality layer.
 *
 * Public surface is deliberately tiny: a facade (`Soul`) over four verbs.
 * Anything a host needs beyond this belongs in an adapter.
 */
export * from './types.ts';
export type { SoulStore } from './store.ts';
export { openSqlite, SCHEMA_VERSION, AFFECT_RETENTION_MS, DbNewerThanBinaryError } from './sqlite.ts';
export {
  buildContext,
  styleDirectives,
  DEFAULT_MAX_CHARS,
  AFFECT_BUDGET,
  AFFECT_WINDOW_MS,
} from './context.ts';
export {
  reflect,
  ruleExtract,
  nextEmotion,
  isCorrection,
  correctionRule,
  detectCorrection,
  isQuestion,
} from './reflect.ts';
export type { CorrectionLayer, CorrectionSignal, CorrectionVerdict } from './reflect.ts';
export { rank, scoreMemory, tokenize, relevance, bm25, buildCorpusStats } from './scoring.ts';
export * from './affect/index.ts';
export { measureStyle } from './style/measure.ts';
export type { StyleMetrics } from './style/measure.ts';
export * from './storage/config.ts';
export * from './storage/merge.ts';
export * from './storage/steering.ts';
export * from './storage/transcript.ts';

import type {
  AffectSignal,
  ContextRequest,
  Correction,
  Memory,
  ContextResult,
  Emotion,
  LlmFn,
  MemoryType,
  ObserveResult,
  ReflectResult,
  ScoredMemory,
  Turn,
  CommitResult,
  Entity,
  EntityDraft,
  ExtractDraft,
  Fact,
  FactSpec,
  Gap,
  GapSpec,
  SessionHandoff,
  TurnFindResult,
  SessionSummary,
  TurnPair,
  Visibility,
} from './types.ts';
import type { SoulStore } from './store.ts';
import type { AffectAnalyzer } from './affect/port.ts';
import { buildContext } from './context.ts';
import { reflect, ruleExtract, nextEmotion } from './reflect.ts';
import { rank, tokenize } from './scoring.ts';
import { analyzeAffect, emptyAffect, lexiconAnalyzer } from './affect/analyze.ts';
import { gateDrafts, llmExtractTurn } from './reflect.ts';
import { extractByRules, extractWithModel } from './extract.ts';
export { gateDrafts } from './reflect.ts';

export interface SoulOptions {
  store: SoulStore;
  soulId: string;
  userId: string;
  name?: string;
  /** When the soul was born. Defaults to now; backdate it to demo long relationships. */
  createdAt?: number;
  /** Device identity for sync bookkeeping (ADR 0021). Optional in local use. */
  deviceId?: string;
  /** Defaults to the lexicon analyzer; pass an LLM-backed one to opt in (ADR 0015). */
  analyzer?: AffectAnalyzer;
  /**
   * Optional model access, injected the same way as `analyzer`. Adapters supply
   * it from their host's own model (an in-process service, a CLI subprocess, an
   * HTTP endpoint). Omit it and every verb stays rule-only.
   */
  llm?: LlmFn;
  /** Messages longer than this are not sent to the model. Defaults to 2000. */
  llmMaxChars?: number;
  /**
   * A paraphrase written this many ms after a similar memory is treated as a
   * duplicate rather than a second row. Set 0 to disable. Defaults to 30s.
   */
  dedupeWindowMs?: number;
  /**
   * Receives the model's raw reply, complete. Diagnostics belong to the adapter,
   * not to core, which stays free of I/O; the DSH adapter appends it to a file
   * so a parse failure is explainable instead of silent.
   */
  onLlmRaw?: (raw: string) => void;
}

export class Soul {
  readonly store: SoulStore;
  readonly soulId: string;
  readonly userId: string;
  readonly name: string;
  readonly deviceId: string;
  readonly analyzer: AffectAnalyzer;
  readonly llm?: LlmFn;
  readonly llmMaxChars: number;
  readonly dedupeWindowMs: number;
  readonly onLlmRaw?: (raw: string) => void;

  constructor(options: SoulOptions) {
    this.store = options.store;
    this.soulId = options.soulId;
    this.userId = options.userId;
    this.name = options.name ?? '小灵';
    this.deviceId = options.deviceId ?? 'dev_local';
    this.analyzer = options.analyzer ?? lexiconAnalyzer;
    this.llm = options.llm;
    this.llmMaxChars = options.llmMaxChars ?? 2000;
    this.dedupeWindowMs = options.dedupeWindowMs ?? 30_000;
    this.onLlmRaw = options.onLlmRaw;

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
      track: request.track,
      types: request.types,
      minImportance: request.minImportance,
      maxItems: request.maxItems,
    });
  }

  /**
   * Audit view: every non-deleted row, including superseded and expired ones.
   * Prompt builders use `context`, which filters both out.
   */
  list(limit = 50): Memory[] {
    return this.store.query({
      soulId: this.soulId,
      userId: this.userId,
      status: ['active', 'superseded'],
      includeExpired: true,
      limit,
    });
  }

  /** Tombstone one memory so it never reaches a prompt again. */
  forget(id: string): boolean {
    return this.store.forget(id);
  }

  /** Mark `oldId` replaced by `newId`; neither row is deleted (RFC 0004). */
  supersede(oldId: string, newId: string): boolean {
    return this.store.supersede(oldId, newId);
  }

  /**
   * Record a user correction as evidence (RFC 0003 phase A). Nothing here
   * reaches a prompt; distillation to a strategy is a later phase.
   */
  recordCorrection(input: { userText: string; assistantText?: string; rule?: string }): string {
    const now = Date.now();
    const id = `cor_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.store.saveCorrection({
      id,
      soulId: this.soulId,
      userId: this.userId,
      at: now,
      userText: input.userText,
      assistantText: input.assistantText,
      rule: input.rule,
      deviceId: this.deviceId,
    });
    return id;
  }

  corrections(limit = 20): Correction[] {
    return this.store.recentCorrections(this.soulId, this.userId, limit);
  }

  /**
   * Store one exchange (RFC 0007). Idempotent on `(sessionId, turn)`: a repeat is
   * ignored by the store, so this returns nothing — there is no id worth handing
   * back that would also be correct on a repeat.
   */
  recordTurnPair(input: {
    sessionId: string;
    turn: number;
    userText: string;
    assistantText: string;
    at?: number;
    metadata?: Record<string, unknown>;
  }): void {
    const at = input.at ?? Date.now();
    this.store.putTurnPair({
      id: `tp_${at.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      soulId: this.soulId,
      userId: this.userId,
      sessionId: input.sessionId,
      turn: input.turn,
      at,
      userText: input.userText,
      assistantText: input.assistantText,
      metadata: input.metadata ?? {},
      createdAt: at,
    });
  }

  /** Recall exchanges, scored against `query` when it is non-empty. */
  recallTurnPairs(query: string, limit = 5): TurnPair[] {
    return this.store.recallTurnPairs({
      soulId: this.soulId,
      userId: this.userId,
      query,
      limit,
    });
  }

  countTurnPairs(): number {
    return this.store.countTurnPairs(this.soulId, this.userId);
  }

  /**
   * Every turn that matches, not the best few: for "how many times" and "what
   * did we decide overall" the count matters more than the ranking, and the
   * model does the counting (ADR 0027). `truncated` tells the caller the answer
   * would be incomplete.
   */
  /* ---------------- the model proper (spec/model.v0.md) ---------------- */

  /**
   * Turn text → drafts.
   *
   * Extraction is the model's job (ADR 0029: Generative Agents, Mem0 and
   * Graphiti all extract with an LLM and keep code for validation and storage).
   * The rules are a floor, not a ceiling: they matter when no model is
   * configured and they cross-check the answer when one is. A model answer with
   * no usable draft falls back to the rules instead of losing the turn.
   */
  async extract(
    text: string,
    options: {
      at?: number;
      llm?: (prompt: string) => Promise<string> | string;
      /** 'auto' (default) uses the model then falls back; 'rules' forces rules. */
      mode?: 'auto' | 'rules';
    } = {},
  ): Promise<ExtractDraft> {
    const at = options.at ?? Date.now();
    const byRules = extractByRules(text, at);
    // Pre-filter: "好的" / "嗯" cannot carry a fact, so it is not worth a call.
    if (options.mode === 'rules' || !options.llm || text.trim().length < 4) return byRules;
    const result = await extractWithModel(text, options.llm, at);
    return result.draft ?? byRules;
  }

  /**
   * Drafts → database, through the gate.
   *
   * Entities are resolved by (type, name) and never guessed; a fact without a
   * statement is refused; a repeated statement with the same time expression is
   * treated as the same fact. Everything refused is reported, not swallowed.
   */
  commitDrafts(draft: ExtractDraft, options: { turnId?: string; at?: number } = {}): CommitResult {
    const entities = new Map<string, Entity>();
    const skipped: CommitResult['skipped'] = [];
    const at = options.at ?? Date.now();

    const ensureEntity = (name: string, type: EntityDraft['type'] = 'person'): Entity => {
      const key = `${type}:${name}`;
      const existing = entities.get(key);
      if (existing) return existing;
      const written = this.store.putEntity({
        soulId: this.soulId,
        userId: this.userId,
        type,
        name,
        seenAt: at,
        attrs: draft.entities.find((e) => e.name === name)?.attrs,
        aliases: draft.entities.find((e) => e.name === name)?.aliases,
      });
      entities.set(key, written);
      return written;
    };

    for (const draftEntity of draft.entities) ensureEntity(draftEntity.name, draftEntity.type);

    const facts: Fact[] = [];
    const recent = this.store.facts({ soulId: this.soulId, userId: this.userId, limit: 50 });
    for (const factDraft of draft.facts) {
      const statement = factDraft.statement.trim();
      if (!statement) {
        skipped.push({ what: 'fact', reason: 'empty statement' });
        continue;
      }
      if (factDraft.slots.length === 0 && factDraft.at === undefined && factDraft.atText === undefined) {
        skipped.push({ what: statement, reason: 'no slots and no time' });
        continue;
      }
      const duplicate = recent.some(
        (f) =>
          f.statement === statement &&
          (f.atText ?? '') === (factDraft.atText ?? '') &&
          Math.abs((f.at ?? f.createdAt) - (factDraft.at ?? at)) < 86400000,
      );
      if (duplicate) {
        skipped.push({ what: statement, reason: 'duplicate' });
        continue;
      }

      const slots = factDraft.slots.map((s) => {
        if (s.value.kind === 'entity') {
          const entity = ensureEntity(s.value.entityName, s.value.entityType ?? 'person');
          return { slot: s.slot, value: { kind: 'entity' as const, entityId: entity.id } };
        }
        return { slot: s.slot, value: s.value };
      });

      const written = this.store.putFact({
        soulId: this.soulId,
        userId: this.userId,
        statement,
        typeName: factDraft.typeName,
        at: factDraft.at,
        atText: factDraft.atText,
        source: factDraft.source,
        confidence: factDraft.confidence,
        sourceTurnId: options.turnId,
        slots,
      });
      facts.push(written);
    }

    const gaps: Gap[] = [];
    for (const gapDraft of draft.gaps) {
      const about = gapDraft.aboutEntityName
        ? ensureEntity(gapDraft.aboutEntityName)
        : undefined;
      gaps.push(
        this.store.putGap({
          soulId: this.soulId,
          userId: this.userId,
          aboutEntityId: about?.id,
          aboutFactId: facts.length === 1 ? facts[0].id : undefined,
          topic: gapDraft.topic,
          tension: gapDraft.tension,
          openedAt: at,
        }),
      );
    }

    return { entities: [...entities.values()], facts, gaps, skipped };
  }

  /** Remember a person/thing/place; calling again just refreshes "last mentioned". */
  rememberEntity(
    name: string,
    type: Entity['type'] = 'person',
    options: { aliases?: string[]; attrs?: Record<string, unknown>; seenAt?: number } = {},
  ): Entity {
    return this.store.putEntity({
      soulId: this.soulId,
      userId: this.userId,
      type,
      name,
      aliases: options.aliases,
      attrs: options.attrs,
      seenAt: options.seenAt,
    });
  }

  findEntities(name: string, limit = 20): Entity[] {
    return this.store.findEntities({ soulId: this.soulId, userId: this.userId, name, limit });
  }

  /** Write one connection between things. */
  recordFact(spec: Omit<FactSpec, 'soulId' | 'userId'>): Fact {
    return this.store.putFact({ ...spec, soulId: this.soulId, userId: this.userId });
  }

  /** Everything that happened to or around one entity — the "about her" path. */
  factsAbout(entityId: string, options: { since?: number; until?: number; limit?: number } = {}): Fact[] {
    return this.store.facts({
      soulId: this.soulId,
      userId: this.userId,
      entityId,
      since: options.since,
      until: options.until,
      limit: options.limit,
    });
  }

  /** Open questions, highest tension first. */
  openGaps(limit = 20): Gap[] {
    return this.store.openGaps(this.soulId, this.userId, limit);
  }

  recordGap(spec: Omit<GapSpec, 'soulId' | 'userId'>): Gap {
    return this.store.putGap({ ...spec, soulId: this.soulId, userId: this.userId });
  }

  closeGap(id: string, closedByFactId?: string): void {
    this.store.closeGap(id, closedByFactId);
  }

  findTurns(
    text: string,
    options: { sessionId?: string; since?: number; until?: number; limit?: number } = {},
  ): TurnFindResult {
    return this.store.findTurns({
      soulId: this.soulId,
      userId: this.userId,
      text,
      sessionId: options.sessionId,
      since: options.since,
      until: options.until,
      limit: options.limit,
    });
  }

  /** Conversations, most recent first, derived from the recorded exchanges. */
  sessions(limit = 5): SessionSummary[] {
    return this.store.listSessions(this.soulId, this.userId, limit);
  }

  /**
   * What a new session inherits from the previous conversation.
   *
   * Measured: naive first/last picked "ok" and "停" — boundaries are not the
   * same as signals. So the topic is the longest user message of that session
   * (shortest messages carry no topic), and the tail is the last few exchanges
   * whose user message has substance.
   */
  handoff(currentSessionId: string, tail = 2): SessionHandoff | null {
    const sessions = this.store.listSessions(this.soulId, this.userId, 20);
    const previous = sessions.find((s) => s.sessionId !== currentSessionId);
    if (!previous) return null;
    const pairs = this.store.sessionPairs(previous.sessionId, this.soulId, this.userId, 500);
    if (pairs.length === 0) return null;

    const SUBSTANTIVE = 4;
    const substantial = pairs.filter((p) => p.userText.trim().length >= SUBSTANTIVE);
    const topic = [...substantial].sort((a, b) => b.userText.length - a.userText.length)[0] ?? pairs[0];
    const last = (substantial.length > 0 ? substantial : pairs).slice(-tail);
    return { session: previous, first: topic, last };
  }

  /** Verb 3: on demand. */
  recall(query: string, limit = 5): ScoredMemory[] {
    const memories = this.store.query({ soulId: this.soulId, userId: this.userId });
    const ranked = rank(memories, query, Date.now()).slice(0, limit);
    this.store.touch(ranked.map((r) => r.memory.id));
    return ranked;
  }

  /** Pure analysis, no storage. Async because the analyzer may call a model. */
  async analyze(text: string): Promise<AffectSignal> {
    return this.analyzeTurn(text);
  }

  /**
   * Verb 2: after each turn.
   *
   * The analyzer may be async (a model); any failure degrades to the lexicon
   * analyzer. Emotion is computed from the turn only — never from affect.
   */
  async observe(turn: Turn): Promise<ObserveResult> {
    const now = turn.at ?? Date.now();
    const affect = turn.role === 'user' ? await this.analyzeTurn(turn.content) : emptyAffect();

    // Rules first: they are precise and cheap. Only when they find nothing does
    // the optional model get a chance, so it can add recall without overriding
    // a rule that already fired.
    let drafts = ruleExtract([turn]);
    let extractedBy: 'rules' | 'llm' | 'none' = drafts.length > 0 ? 'rules' : 'none';
    // A model that says "nothing to keep" and a model that answers garbage used
    // to be indistinguishable; keep them apart for measurement.
    let llmOutcome: 'off' | 'skipped-rules' | 'skipped-long' | 'stored' | 'null' | 'failed' = this.llm
      ? 'skipped-rules'
      : 'off';
    if (drafts.length === 0 && turn.role === 'user' && this.llm) {
      if (turn.content.length <= this.llmMaxChars) {
        try {
          const draft = await llmExtractTurn(turn.content, this.llm, this.onLlmRaw);
          if (draft) {
            drafts = [draft];
            extractedBy = 'llm';
            llmOutcome = 'stored';
          } else {
            llmOutcome = 'null';
          }
        } catch {
          // The model is an enhancement; a transport or parse failure leaves the
          // rule result (nothing) in place.
          llmOutcome = 'failed';
        }
      } else {
        llmOutcome = 'skipped-long';
      }
    }
    // Deterministic write gates: shape -> semantics -> per-turn budget. Whatever
    // they refuse is reported, so written: 0 always has a reason.
    const gated = gateDrafts(drafts);

    // observe runs every turn; repeating a sentence must not create a second row.
    const seen = new Set(
      this.store.query({ soulId: this.soulId, userId: this.userId, limit: 10_000 }).map((m) => m.content.trim()),
    );
    let written = 0;
    for (const draft of gated.accepted) {
      if (seen.has(draft.content.trim())) continue;
      seen.add(draft.content.trim());
      written += 1;
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
        keywords: tokenize(draft.content),
        createdAt: now,
        updatedAt: now,
        validFrom: now,
      });
    }

    if (turn.role === 'user') {
      try {
        this.store.saveAffect(this.soulId, this.userId, affect, now, this.deviceId);
      } catch {
        // Affect is an enhancement; storage trouble must not break the session.
      }
    }

    const emotion = nextEmotion(this.store.emotion(this.soulId, this.userId), [turn]);
    this.store.saveEmotion(this.soulId, this.userId, emotion, now);
    return {
      written,
      committed: written > 0,
      rejections: gated.rejected,
      llmOutcome,
      emotion,
      affect,
      extractedBy: written > 0 ? extractedBy : 'none',
    };
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
      updatedAt: now,
      validFrom: now,
    });
    return id;
  }

  /**
   * Explicit write requested by a host or its model (RFC 0005). Unlike
   * `remember`, it passes the same gates as `observe` and dedupes by content,
   * so a tool cannot bypass shape/semantics or flood duplicates.
   */
  rememberExplicit(input: { content: string; type?: MemoryType; importance?: number }): {
    ok: boolean;
    id?: string;
    duplicate?: boolean;
    reason?: string;
  } {
    const type = input.type ?? 'fact';
    const importance = Math.min(10, Math.max(1, input.importance ?? 7));
    const { accepted, rejected } = gateDrafts([{ type, content: input.content, importance }]);
    if (accepted.length === 0) {
      return { ok: false, reason: rejected[0]?.reason ?? 'rejected by write gates' };
    }
    const content = accepted[0].content;
    const now = Date.now();

    const candidates = this.store.query({
      soulId: this.soulId,
      userId: this.userId,
      status: ['active'],
      includeExpired: true,
      limit: 50,
    });

    // Same content anywhere: the exact duplicate.
    const same = candidates.find((memory) => memory.content.trim() === content);
    if (same) return { ok: true, id: same.id, duplicate: true };

    // A paraphrase of something just written (usually the automatic observer
    // moments earlier) must not become a second row: a shared run of characters
    // inside the dedupe window is treated as the same statement.
    const window = this.dedupeWindowMs;
    if (window > 0) {
      const recent = candidates.filter((memory) => now - memory.createdAt <= window);
      const overlapping = recent.find((memory) => sharesRun(memory.content, content, MIN_SHARED_RUN));
      if (overlapping) {
        return { ok: true, id: overlapping.id, duplicate: true, reason: 'already recorded this turn' };
      }
    }

    const id = this.remember(content, { type, importance });
    return { ok: true, id };
  }

  /** Verb 4: session end. */
  async reflect(turns: Turn[], options: { updateEmotion?: boolean } = {}): Promise<ReflectResult> {
    return reflect(this.store, {
      soulId: this.soulId,
      userId: this.userId,
      turns,
      llm: this.llm,
      updateEmotion: options.updateEmotion,
    });
  }

  stats(): { memories: number; emotion: Emotion; name: string } {
    return {
      name: this.name,
      memories: this.store.count(this.soulId, this.userId),
      emotion: this.store.emotion(this.soulId, this.userId),
    };
  }

  private async analyzeTurn(content: string): Promise<AffectSignal> {
    try {
      const signal = await this.analyzer.analyze(content);
      return { ...signal, analyzer: this.analyzer.id };
    } catch {
      try {
        return analyzeAffect(content);
      } catch {
        return emptyAffect();
      }
    }
  }
}

/** Shortest shared character run that means "the same statement" (RFC 0005). */
const MIN_SHARED_RUN = 4;

function sharesRun(a: string, b: string, minRun: number): boolean {
  const left = a.trim();
  const right = b.trim();
  if (left.length === 0 || right.length === 0) return false;
  const window = Math.min(left.length, right.length);
  for (let len = window; len >= minRun; len -= 1) {
    for (let i = 0; i + len <= right.length; i += 1) {
      if (left.includes(right.slice(i, i + len))) return true;
    }
  }
  return false;
}
