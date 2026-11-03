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
export { parseThreadLine } from './extract.ts';
export {
  renderConsolidationPrompt,
  renderVerificationPrompt,
  renderRelationPrompt,
  renderRuleClassifyPrompt,
  renderProfileMergePrompt,
  renderExtractionPrompt,
} from './prompts.ts';
export type {
  ConsolidationPromptInput,
  VerificationPromptInput,
  RelationPromptInput,
  RuleClassifyPromptInput,
  ProfileMergePromptInput,
  ExtractionPromptInput,
} from './prompts.ts';
export {
  gateConclusion,
  conclusionSlots,
  normalizeStatement,
  parseConclusionDraft,
  parseVerificationDraft,
  parseRelationDraft,
  readVerification,
  parseProfileMerge,
  groupProfileCandidates,
  isDerivedProfileLine,
  PROFILE_DIMENSIONS,
} from './consolidate.ts';
export type { VerificationDraft, ConclusionRelation } from './consolidate.ts';
export type { ProfileLine, ProfileCandidate, ProfileGroup } from './consolidate.ts';
import type { ProfileLine } from './consolidate.ts';
export { fires, parseRuleClassifications, parseTrigger, selectRules } from './rules.ts';
export type { Rule, RuleTrigger, RuleClassification } from './rules.ts';
export { planRetrieval } from './retrieval.ts';
export type { RetrievalPlan, RetrievalPrimitive } from './retrieval.ts';
export * from './affect/index.ts';
export { escapeBlockText, escapeAttr } from './inject-text.ts';
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
  SlotValue,
  ConclusionDraft,
  Fact,
  ThreadAttribution,
  TurnThread,
  FactDetail,
  FactSpec,
  Gap,
  GapSpec,
  SessionHandoff,
  TurnFindResult,
  SessionSummary,
  TurnPair,
  TurnStep,
  Visibility,
} from './types.ts';
import type { SoulStore } from './store.ts';
import { FACT_STATUS, MEMORY_STATUS } from './config/status.ts';
import type { AffectAnalyzer } from './affect/port.ts';
import { parseTrigger } from './rules.ts';
import type { Rule } from './rules.ts';
import { planRetrieval } from './retrieval.ts';
import type { RetrievalPlan } from './retrieval.ts';
import { gateConclusion, conclusionSlots, isDerivedProfileLine, PROFILE_DIMENSIONS } from './consolidate.ts';
import { buildContext } from './context.ts';
import { reflect, ruleExtract, nextEmotion } from './reflect.ts';
import { rank, tokenize } from './scoring.ts';
import { analyzeAffect, emptyAffect, lexiconAnalyzer } from './affect/analyze.ts';
import { extractByRules, extractWithModel } from './extract.ts';
import type { ExtractionContext } from './extract.ts';
export { gateDrafts } from './reflect.ts';

/** The fact type a legacy MemoryType maps to. One vocabulary at rest: type_name. */
const MEMORY_TYPE_TO_FACT: Record<MemoryType, string> = {
  semantic: '事实',
  episodic: '事件',
  strategy: '教训',
  cognition: '原则',
  relationship: '关系',
  trait: '性格',
  fact: '事实',
};

/** Longest statement accepted from a host; matches the extractor's ceiling. */
const MAX_FACT_CHARS = 200;

/**
 * Read a fact as the shape `recall()` has always returned.
 *
 * Callers (the adapter's `soul_recall` tool) only read id/type/content/score, but the
 * type must stay honest: return the fact's own type name rather than inventing a
 * MemoryType it never had.
 */
function factAsMemory(fact: Fact): Memory {
  return {
    id: fact.id,
    soulId: fact.soulId,
    userId: fact.userId,
    type: 'fact',
    content: fact.statement,
    importance: Math.round(fact.confidence * 10),
    vividness: 0.8,
    recallCount: fact.recallCount ?? 0,
    status: 'active',
    visibility: 'private',
    keywords: tokenize(fact.statement),
    createdAt: fact.createdAt,
    lastRecalledAt: fact.lastRecalledAt,
    updatedAt: fact.createdAt,
  };
}

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
    // Spread, not a field list: an explicit list silently dropped every option
    // added later (includeAnchors stayed dead for a whole release).
    return buildContext(this.store, {
      ...request,
      soulId: this.soulId,
      userId: this.userId,
    });
  }

  /**
   * Audit view: every non-deleted row, including superseded and expired ones.
   * Prompt builders use `context`, which filters both out.
   */
  /**
   * The recent holdings, as the shape hosts already consume.
   *
   * Reads facts: the legacy table is inert after the migration, and a list that kept
   * reading it would look empty while the system clearly remembers things.
   */
  list(limit = 50): Memory[] {
    return this.store
      .facts({ soulId: this.soulId, userId: this.userId, limit })
      .filter((fact) => fact.status !== FACT_STATUS.superseded)
      .map(factAsMemory);
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
   * Was this turn one the user corrected?
   *
   * A correction is the highest-signal moment a lesson has: being told you were
   * wrong is the consequence the experience comes with (brief 0023, T1). The link
   * is the user's own words — corrections do not carry a turn id, and inventing a
   * time window would misattribute a nearby turn.
   */
  wasCorrectedTurn(turnId: string): boolean {
    const turn = this.store.turn(turnId);
    const text = (turn?.userText ?? '').trim();
    if (!text) return false;
    return this.store
      .recentCorrections(this.soulId, this.userId, 50)
      .some((correction) => (correction.userText ?? '').trim() === text);
  }

  /**
   * The experiences of one turn that were flagged as lessons, and nothing else.
   *
   * Promotion reads the flag, never the statement: whether a sentence is "about how
   * to work" is the semantic call the extractor already made, and re-deriving it in
   * code would be the guess ADR 0027 forbids.
   */
  promotionCandidates(turnId: string): Fact[] {
    return this.store.factsByTurns([turnId]).filter((fact) =>
      fact.slots.some(
        (slot) => slot.slot === '原则候选' && slot.value.kind === 'text' && slot.value.value === '是',
      ),
    );
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
    /**
     * The real shape of the reply: reasoning / text / tool steps in order.
     *
     * Stored, never injected. Reasoning is a draft, so recall and prompts read
     * `kind === 'text'` only; it is kept because "why did you say that" and
     * consolidation both need it.
     */
    steps?: TurnStep[];
  }): string {
    const at = input.at ?? Date.now();
    // The generated id is the row id in `turns`; callers must use it for
    // facts.source_turn_id, otherwise a hook cannot expand back to its turn.
    const id = `tp_${at.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.store.putTurnPair({
      id,
      soulId: this.soulId,
      userId: this.userId,
      sessionId: input.sessionId,
      turn: input.turn,
      at,
      userText: input.userText,
      assistantText: input.assistantText,
      metadata: input.metadata ?? {},
      createdAt: at,
    }, input.steps);
    // A repeat is dropped by the unique (session, turn) index, so the generated id
    // may be a phantom. Return the id that is actually stored: the caller enqueues
    // extraction with it, and a phantom id made the queue drop the turn as missing.
    return this.store.turnByTurnNo(input.sessionId, input.turn)?.id ?? id;
  }

  /**
   * One turn by id, for adapters that only kept the id (extraction queue,
   * handoff). Returns null when the row is gone, so callers can drop the item
   * instead of retrying forever.
   */
  turn(id: string): TurnPair | null {
    return this.store.turn(id);
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
      /** What the model may see; defaults to the recent store state. */
      context?: ExtractionContext;
      /**
       * My reply in the same turn. The unit of memory is the exchange (ADR 0035):
       * without this half, "my promises" is a rule the model can never use.
       */
      assistantText?: string;
    } = {},
  ): Promise<ExtractDraft> {
    const at = options.at ?? Date.now();
    const byRules = extractByRules(text, at);
    // No length gate here: "做" and "重来" are one and two characters and are
    // real decisions. The host decides what is worth a model call; core only
    // reports which path it took.
    if (options.mode === 'rules') return { ...byRules, reason: 'rules-mode' };
    if (!options.llm) return { ...byRules, reason: 'no-model' };
    // The model has to know what is already stored, or it cannot reuse a name
    // and cannot tell that new information contradicts an old fact.
    const context = options.context ?? this.extractionContext();
    // A parse failure is unreadable without the text the model actually sent:
    // "model-failed" alone hid a 54-character reply for an hour today.
    const wrapped = this.onLlmRaw
      ? async (prompt: string) => {
          const raw = await options.llm!(prompt);
          this.onLlmRaw!(raw);
          return raw;
        }
      : options.llm;
    const result = await extractWithModel(text, wrapped, at, context, options.assistantText);
    return result.draft ?? { ...byRules, reason: `model-${result.error ? 'failed' : 'empty'}` };
  }

  /** The slice of the store the extractor is allowed to know about. */
  extractionContext(limit = 20, options: { turnNo?: number; sessionId?: string } = {}): ExtractionContext {
    const entities = this.store
      .findEntities({ soulId: this.soulId, userId: this.userId, limit })
      .map((e) => ({
        id: e.id,
        name: e.name,
        aliases: e.aliases,
        relation: typeof e.attrs.relation === 'string' ? e.attrs.relation : undefined,
      }));
    const facts = this.store
      .facts({ soulId: this.soulId, userId: this.userId, limit: 12 })
      .map((f) => ({ id: f.id, statement: f.statement, atText: f.atText }));
    // Candidate threads, most recently used first. "How many turns ago" is what
    // lets the model tell "just now" from "a while back" without counting. Each
    // candidate also carries its last lines: a label cannot answer "does this turn
    // continue that conversation", and continuing is now the default (ADR 0034).
    const threads = this.store.openThreads(this.soulId, this.userId, 5).map((thread) => {
      const turns = this.store.threadTurns(thread.id).slice(-2);
      const recent = turns.flatMap((turn) => {
        const lines: Array<{ role: 'user' | 'assistant'; text: string }> = [];
        if (turn.userText.trim()) lines.push({ role: 'user', text: turn.userText });
        if (turn.assistantText.trim()) lines.push({ role: 'assistant', text: turn.assistantText });
        return lines;
      });
      return {
        id: thread.id,
        topic: thread.topic,
        ago:
          options.turnNo !== undefined && thread.lastTurnNo !== undefined
            ? Math.max(0, options.turnNo - thread.lastTurnNo)
            : undefined,
        recent: recent.slice(-3),
      };
    });
    // The previous user line is what "继续 / 那个 / 她" refers to. Extraction is per
    // turn; without it the model has nothing to bind to.
    const previousUserText =
      options.sessionId !== undefined && options.turnNo !== undefined
        ? (this.store.previousTurnText(options.sessionId, options.turnNo) ?? undefined)
        : undefined;
    return { entities, facts, threads, previousUserText };
  }

  /**
   * Put a turn into a thread.
   *
   * Default is continuity (ADR 0034): a named thread joins when it exists and is open;
   * an unreadable answer, a hallucinated id, or no answer at all joins the previous
   * turn's thread instead of opening a new one — fragmentation is what starves
   * consolidation, and threads can be split later while a lost topic cannot.
   */
  applyThread(
    attribution: ThreadAttribution | undefined,
    spec: {
      sessionId: string;
      turnNo: number;
      turnId: string;
      at: number;
      fallbackTopic?: string;
      /** The thread the previous turn belonged to; the default when unsure. */
      previousThreadId?: string;
    },
  ): { threadId: string; created: boolean; topic: string; joinReason: string; topicUpdated: boolean } {
    const join = (id: string, reason: string, nextTopic?: string) => {
      const thread = this.store.thread(id);
      if (!thread || thread.status !== 'open') return null;
      this.store.attachTurn(spec.turnId, thread.id);
      this.store.touchThread(thread.id, spec.turnNo);
      // A continued thread may have moved on within itself: keep the label honest.
      const topic = nextTopic?.trim();
      const updated = Boolean(topic) && topic !== thread.topic;
      if (updated) this.store.updateThreadTopic(thread.id, topic as string);
      return {
        threadId: thread.id,
        created: false,
        topic: updated ? (topic as string) : thread.topic,
        joinReason: reason,
        topicUpdated: updated,
      };
    };
    if (attribution?.kind === 'continue') {
      const existing = join(attribution.id, 'continue', attribution.topic);
      if (existing) return existing;
      // A named thread that does not exist (or is closed) is not evidence for a new
      // topic — fall through to the previous thread, then to a new one.
    }
    if (attribution?.kind === 'new') {
      return this.openThreadFor(spec, 'explicit-new', attribution.topic);
    }
    if (spec.previousThreadId) {
      const previous = join(spec.previousThreadId, 'fallback-previous');
      if (previous) return previous;
    }
    // `attribution === undefined` covers "无" and unparseable output.
    return this.openThreadFor(
      spec,
      attribution?.kind === 'continue' ? 'fallback-unknown-id' : 'no-context',
    );
  }

  private openThreadFor(
    spec: { sessionId: string; turnNo: number; turnId: string; at: number; fallbackTopic?: string },
    joinReason: string,
    topicFromModel?: string,
  ): { threadId: string; created: boolean; topic: string; joinReason: string; topicUpdated: boolean } {
    const topic = topicFromModel ?? spec.fallbackTopic ?? '未命名话题';
    const thread = this.store.openThread({
      soulId: this.soulId,
      userId: this.userId,
      sessionId: spec.sessionId,
      // Whole topic: a label cut at 20 characters loses the end, which is where the
      // qualifier usually sits. The prompt asks for one short sentence; storage does
      // not cut one (ADR 0034 keeps truncation out of evidence).
      topic,
      openedAt: spec.at,
      turnNo: spec.turnNo,
    });
    this.store.attachTurn(spec.turnId, thread.id);
    return { threadId: thread.id, created: true, topic: thread.topic, joinReason, topicUpdated: false };
  }

  /**
   * Drafts → database.
   *
   * The gate is a labeller, not a filter. A sentence that parses is kept: an
   * undeclared entity in a slot is kept as text (no entity is created), an unknown
   * holder falls back to the world layer, and only an unreadable statement or an
   * exact duplicate is refused. Everything degraded or refused is reported, so the
   * loss is visible instead of silent.
   */
  commitDrafts(draft: ExtractDraft, options: { turnId?: string; at?: number } = {}): CommitResult {
    const entities = new Map<string, Entity>();
    const skipped: CommitResult['skipped'] = [];
    const droppedSlots: CommitResult['droppedSlots'] = [];
    const holderFallbacks: CommitResult['holderFallbacks'] = [];
    const at = options.at ?? Date.now();

    // One entity per name, whatever its declared type: the same 核桃 appearing as
    // both person and thing splits every recall that mentions it. Existing rows
    // win, so a wrongly typed first sighting is reused rather than duplicated.
    // Aliases are the same entity: without them "阿林" reads as undeclared and the
    // slot degrades to text even though the person is known.
    const byName = new Map<string, Entity>();
    for (const known of this.store.findEntities({ soulId: this.soulId, userId: this.userId, limit: 500 })) {
      if (!byName.has(known.name)) byName.set(known.name, known);
      for (const alias of known.aliases ?? []) {
        if (alias && !byName.has(alias)) byName.set(alias, known);
      }
    }

    const declared = new Set(draft.entities.map((entity) => entity.name));

    const ensureEntity = (name: string, type: EntityDraft['type'] = 'person'): Entity => {
      const existing = byName.get(name);
      if (existing) return existing;
      const key = `${type}:${name}`;
      const pending = entities.get(key);
      if (pending) return pending;
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
      byName.set(name, written);
      return written;
    };

    for (const draftEntity of draft.entities) ensureEntity(draftEntity.name, draftEntity.type);

    const facts: Fact[] = [];
    // Declared before writeFact: a fact whose time is unknown opens a gap inside it.
    const gaps: Gap[] = [];
    const recent = this.store.facts({ soulId: this.soulId, userId: this.userId, limit: 50 });

    /** One gate for every write path: legacy facts and operation payloads share it. */
    const writeFact = (factDraft: ExtractDraft['facts'][number]): Fact | null => {
      const statement = factDraft.statement.trim();
      if (!statement) {
        skipped.push({ what: 'fact', reason: 'empty statement' });
        return null;
      }
      // Every readable sentence is kept. The gate used to reject a fact when one of
      // its slots named an undeclared entity (40 of 45 refusals in a live trace) or
      // when it had no slot and no time (5 more) — one bad slot deleted the sentence.
      //
      // A slot names an entity only when that name was declared or is already known.
      // Otherwise the words are kept as text: the sentence survives, the store does
      // not fill up with "仅在电话里说" as a person, and nothing is invented.
      const slots: Array<{ slot: string; value: SlotValue }> = [];
      for (const slot of factDraft.slots) {
        if (slot.value.kind !== 'entity') {
          slots.push({ slot: slot.slot, value: slot.value });
          continue;
        }
        const name = slot.value.entityName.trim();
        if (declared.has(name) || byName.has(name)) {
          const entity = ensureEntity(name, slot.value.entityType ?? 'person');
          slots.push({ slot: slot.slot, value: { kind: 'entity', entityId: entity.id } });
          continue;
        }
        slots.push({ slot: slot.slot, value: { kind: 'text', value: name } });
        droppedSlots.push({ fact: statement, slot: slot.slot, value: name });
      }
      // Where the fact holds (ADR 0032): `world`, or a named mind. An unknown holder
      // means the layer is unknown, which is not a reason to lose the sentence.
      const holderName = factDraft.holder?.trim() || 'world';
      let holder = 'world';
      if (holderName !== 'world') {
        if (declared.has(holderName) || byName.has(holderName)) {
          holder = ensureEntity(holderName).id;
        } else {
          holderFallbacks.push({ fact: statement, holder: holderName });
        }
      }

      const duplicated = recent.some(
        (f) =>
          f.statement === statement &&
          (f.atText ?? '') === (factDraft.atText ?? '') &&
          Math.abs((f.at ?? f.createdAt) - (factDraft.at ?? at)) < 86400000,
      );
      if (duplicated) {
        skipped.push({ what: statement, reason: 'duplicate' });
        return null;
      }

      // The promotion rules read this slot; they must not re-read the statement to
      // guess whether it was a lesson, because that is the semantic call the model
      // already made.
      if (factDraft.principle) slots.push({ slot: '原则候选', value: { kind: 'text', value: '是' } });
      // ADR 0035: a fact from my side of the exchange is `inferred`, and inferred
      // claims must carry their evidence. The turn id is the evidence available here —
      // claims that need a tool or test result are kept out by the prompt instead.
      if (factDraft.source === 'inferred' && options.turnId && !slots.some((slot) => slot.slot === '依据')) {
        slots.push({ slot: '依据', value: { kind: 'text', value: options.turnId } });
      }

      const written = this.store.putFact({
        soulId: this.soulId,
        userId: this.userId,
        statement,
        holder,
        typeName: factDraft.typeName,
        at: factDraft.at,
        atText: factDraft.atText,
        atPrecision: factDraft.atPrecision,
        source: factDraft.source,
        confidence: factDraft.confidence,
        sourceTurnId: options.turnId,
        slots,
      });
      facts.push(written);
      // Known to have happened, unknown when: keep the memory and turn the missing
      // date into something to ask about later, instead of inventing one.
      if (holder === 'world' && written.atPrecision === 'unknown') {
        const subject = slots.find((slot) => slot.value.kind === 'entity');
        gaps.push(
          this.store.putGap({
            soulId: this.soulId,
            userId: this.userId,
            aboutEntityId: subject?.value.kind === 'entity' ? subject.value.entityId : undefined,
            aboutFactId: written.id,
            // Whole statement: the gap asks "when did this happen", so the sentence it
            // refers to cannot be a prefix of itself.
            topic: `日期不明：${statement}`,
            tension: 0.3,
            openedAt: at,
          }),
        );
      }
      return written;
    };

    // Operations carry the merge decision (Mem0's ADD/UPDATE/DELETE); plain facts are
    // the legacy shape and every one of them is an add.
    // `validateDraft` always returns an operations array, so `??` alone left it empty
    // and every legacy fact was written nowhere — silently, with no skipped entry.
    const operations =
      draft.operations && draft.operations.length > 0
        ? draft.operations
        : draft.facts.map((fact) => ({ op: 'add' as const, fact }));
    for (const operation of operations) {
      if (operation.op === 'noop') continue;
      const written = writeFact(operation.fact);
      if (!written) continue;
      if ((operation.op === 'supersede' || operation.op === 'update') && operation.targetId) {
        this.store.supersedeFact(operation.targetId, written.id);
      }
    }

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

    return { entities: [...entities.values()], facts, gaps, skipped, droppedSlots, holderFallbacks };
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

  /**
   * Store one conclusion if the deterministic gate accepts it.
   *
   * A conclusion is not a new kind of record: it is a fact whose type is 结论,
   * held by the soul itself, with one `fact` slot per citation. That way recall,
   * export and supersede keep working, and the evidence can be followed back to
   * the observation that produced it.
   */
  recordConclusion(
    draft: ConclusionDraft,
    options: { allowed: string[]; mergeInto?: string },
  ): { ok: boolean; reason?: string; fact?: Fact; superseded?: string; merged?: string } {
    const allowed = new Set(options.allowed);
    // A restatement is merged, not written again: the held conclusion keeps its
    // wording and gains the evidence, so it gets stronger instead of duplicated.
    // Only evidence from this batch counts — a merge must be backed the same way
    // a new conclusion would be.
    if (options.mergeInto) {
      const evidence = draft.evidence.filter((id) => allowed.has(id));
      if (evidence.length >= 2) {
        const merge = this.mergeEvidence(options.mergeInto, evidence);
        if (merge.ok) return { ok: true, merged: options.mergeInto };
        // A merge target that moved on is not an error; fall through and write the
        // conclusion normally rather than losing it.
      }
    }

    const old = draft.supersedes ? this.store.fact(draft.supersedes) : null;
    const gate = gateConclusion({ draft, allowed, existing: old });
    if (!gate.ok) return { ok: false, reason: gate.reason };

    const fact = this.store.putFact({
      soulId: this.soulId,
      userId: this.userId,
      statement: gate.statement,
      typeName: '结论',
      holder: 'self',
      confidence: gate.confidence,
      slots: conclusionSlots(gate.evidence, this.entitiesOfFacts(gate.evidence)),
    });
    // Superseding an unknown row would silently claim a revision that never
    // happened; the gate already checked the target is a conclusion we hold.
    let superseded: string | undefined;
    if (old?.typeName === '结论') {
      this.store.supersedeFact(old.id, fact.id);
      superseded = old.id;
    }
    return { ok: true, fact, superseded };
  }

  /**
   * The rules we hold (ADR 0033): facts whose type is 规则 and whose 触发 slot parses.
   *
   * A rule without a usable trigger is skipped, not injected — an always-on rule is
   * wallpaper, and wallpaper is how a lesson gets ignored.
   */
  rules(): Rule[] {
    const out: Rule[] = [];
    for (const fact of this.store.facts({ soulId: this.soulId, userId: this.userId, limit: 500 })) {
      if (fact.typeName !== '规则' || fact.status === FACT_STATUS.superseded) continue;
      const triggerSlot = fact.slots.find((slot) => slot.slot === '触发' && slot.value.kind === 'text');
      const trigger = parseTrigger(triggerSlot?.value.kind === 'text' ? triggerSlot.value.value : '');
      if (!trigger) continue;
      out.push({
        id: fact.id,
        statement: fact.statement,
        trigger,
        confidence: fact.confidence,
      });
    }
    return out;
  }

  /**
   * Apply a rule classification (ADR 0033): retag as 规则 and store its trigger.
   *
   * The trigger is what makes the rule injectable later; a rule without one would
   * have to be always-on, which is exactly what this split exists to avoid.
   */
  markRule(factId: string, classification: { trigger: string; action?: string }): void {
    this.store.setFactTypeName(factId, '规则');
    const slots: { slot: string; value: { kind: 'text'; value: string } }[] = [
      { slot: '触发', value: { kind: 'text', value: classification.trigger } },
    ];
    if (classification.action) slots.push({ slot: '动作', value: { kind: 'text', value: classification.action } });
    this.store.addSlots(factId, slots);
  }

  /** Apply a profile classification: it is about the person, not a triggered rule. */
  markProfile(factId: string, options: { dimension?: string } = {}): void {
    this.store.setFactTypeName(factId, '画像');
    // The dimension is written here because this is the moment the model decided
    // which lens the judgment belongs to. The merge step cuts its batches along
    // this value later, so a missing dimension is a judgment that can never be
    // merged — visible in the merge log as 未标注, not silently guessed.
    const dimension = options.dimension;
    if (dimension && (PROFILE_DIMENSIONS as readonly string[]).includes(dimension)) {
      this.store.addSlots(factId, [{ slot: '维度', value: { kind: 'text', value: dimension } }]);
    }
  }

  /**
   * Park a lesson that could not be classified.
   *
   * Neither bucket is safe for it: as a rule it would fire every turn, and as a
   * profile line it would put an imperative into the description of a person. It
   * goes to 待修, which nothing injects, and shows up in a review count.
   */
  markUnclassified(factId: string): void {
    this.store.setFactTypeName(factId, '待修');
  }

  /** The judgments about the person that are waiting to be merged. */
  profileItems(limit = 60): Fact[] {
    return this.store
      .facts({ soulId: this.soulId, userId: this.userId, limit: 500 })
      .filter(
        (fact) =>
          fact.typeName === '画像' &&
          fact.status !== FACT_STATUS.superseded &&
          // A line that cites sources is derived: merging it again compresses a
          // compression, and the second round is thinner than the first.
          !isDerivedProfileLine(fact),
      )
      .slice(0, limit);
  }

  /**
   * Replace a pile of judgments with the merged ones.
   *
   * Each merged line becomes a 画像 fact citing its sources, and every source it
   * covers is superseded — not deleted, so the audit trail survives the compression.
   */
  applyProfileMerge(lines: ProfileLine[]): Fact[] {
    const written: Fact[] = [];
    for (const line of lines) {
      const fact = this.store.putFact({
        soulId: this.soulId,
        userId: this.userId,
        statement: line.statement,
        typeName: '画像',
        holder: 'self',
        // More sources means more observations behind the line, so it ranks first.
        confidence: Math.min(0.95, 0.6 + 0.05 * line.sources.length),
        slots: [
          ...line.sources.map((id) => ({ slot: '来源', value: { kind: 'fact' as const, factId: id } })),
          // A merged line is not an original: re-merging merged lines loses detail.
          { slot: '合并', value: { kind: 'text' as const, value: '1' } },
          { slot: '维度', value: { kind: 'text' as const, value: line.dimension } },
        ],
      });
      written.push(fact);
      for (const sourceId of line.sources) {
        const source = this.store.fact(sourceId);
        if (source && source.status !== FACT_STATUS.superseded) this.store.supersedeFact(sourceId, fact.id);
      }
    }
    return written;
  }

  /** The merged profile, strongest first — what is injected every turn. */
  profile(limit = 8): Fact[] {
    return this.store
      .facts({ soulId: this.soulId, userId: this.userId, limit: 500 })
      .filter((fact) => fact.typeName === '画像' && fact.status !== FACT_STATUS.superseded)
      .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /** Which primitive this question needs (0020).
   *
   * The subject is resolved against the entities we hold, so "上次和 a 吃饭" can
   * never be answered with the last closed topic.
   */
  planRetrieval(text: string): RetrievalPlan {
    // Only people and places can be a question's subject. A concept entity like 情绪
    // or a product like dsh matches ordinary technical messages, and routing to it
    // suppresses the related-conversation block — which is how "把 package.json 改
    // 一下" ended up asking about entity "a".
    const names = this.store
      .findEntities({ soulId: this.soulId, userId: this.userId, limit: 500 })
      .filter((entity) => entity.type === 'person' || entity.type === 'place' || entity.type === 'self')
      .map((entity) => entity.name);
    return planRetrieval(text, names);
  }

  /** The entity timeline: what is known about one person/thing, newest first. */
  latestAbout(entityName: string, options: { predicate?: string; query?: string; limit?: number } = {}): Fact[] {
    return this.store.latestAbout(this.soulId, this.userId, entityName, options);
  }

  /** Mark facts as surfaced; retrieval practice slows their decay (0019). */
  recordRecalls(factIds: string[], at = Date.now()): void {
    this.store.recordRecalls(factIds, at);
  }

  /**
   * Close topics the conversation has moved past.
   *
   * Three signals, in order of strength: the host's archive list (the user said
   * this session is done), turns elapsed inside the running session, and — only
   * as a fallback — silence in another session.
   */
  closeIdleThreads(
    sessionId: string,
    options: { idleTurns?: number; idleMs?: number; archivedSessionIds?: string[]; at?: number } = {},
  ): Array<{ id: string; reason: 'archived' | 'quiet-turns' | 'quiet-time' }> {
    return this.store.closeIdleThreads(
      this.soulId,
      this.userId,
      sessionId,
      options.idleTurns ?? 6,
      options.idleMs ?? 24 * 60 * 60_000,
      options.archivedSessionIds ?? [],
      options.at ?? Date.now(),
    );
  }

  /** The thread the previous turn belonged to, for the attribution candidate list. */
  threadBefore(sessionId: string, turnNo: number): string | null {
    return this.store.threadBefore(sessionId, turnNo);
  }
  /**
   * Everything a closed thread needs for consolidation: the topic, the turns in
   * order (as text), and the facts extracted from those turns.
   *
   * The turns are what makes this a chapter rather than a batch: A B A means the
   * facts alone have lost the resume.
   */
  threadContext(threadId: string): {
    thread: TurnThread;
    turns: Array<{ turnNo: number; userText: string; assistantText: string }>;
    facts: Fact[];
  } | null {
    const thread = this.store.thread(threadId);
    if (!thread) return null;
    const turns = this.store.threadTurns(threadId);
    const facts = this.store.factsByTurns(turns.map((turn) => turn.id));
    return {
      thread,
      turns: turns.map((turn) => ({ turnNo: turn.turn, userText: turn.userText, assistantText: turn.assistantText })),
      facts,
    };
  }
  /**
   * What "where were we" means: the last topic that actually finished, its
   * conclusion, and the last couple of turns.
   *
   * A session boundary is not a topic boundary, so this is keyed on the closed
   * thread, not on the previous session.
   */
  lastClosedThread(): {
    thread: TurnThread;
    conclusion: Fact | null;
    /** Both sides of the last turns (ADR 0035): "where were we" includes what I said. */
    turns: Array<{ turnNo: number; userText: string; assistantText: string }>;
  } | null {
    const thread = this.store.lastClosedThread(this.soulId, this.userId);
    if (!thread) return null;
    const conclusion = thread.summaryFactId ? this.store.fact(thread.summaryFactId) : null;
    const turns = this.store
      .threadTurns(thread.id)
      .slice(-2)
      .map((turn) => ({ turnNo: turn.turn, userText: turn.userText, assistantText: turn.assistantText }));
    return { thread, conclusion, turns };
  }
  /** The entities a set of facts mentions — the key a conclusion is recalled by. */
  entitiesOfFacts(factIds: string[]): string[] {
    const ids = new Set<string>();
    for (const factId of factIds) {
      const fact = this.store.fact(factId);
      for (const slot of fact?.slots ?? []) {
        if (slot.value.kind === 'entity') ids.add(slot.value.entityId);
      }
    }
    return [...ids];
  }

  /**
   * Conclusions worth comparing a new one against.
   *
   * Ordered by shared evidence first, then recency: two conclusions drawn from
   * the same facts are the likeliest restatements, and the recency tail catches
   * the ones whose evidence was reworded.
   */
  conclusionCandidates(evidence: string[], limit = 8): Array<{ id: string; statement: string; evidence: number }> {
    const wanted = new Set(evidence);
    const wantedEntities = new Set(this.entitiesOfFacts(evidence));
    return this.conclusions(200)
      .map((fact) => {
        const ids = evidenceOf(fact);
        const sharedEntities = fact.slots.filter(
          (slot) => slot.slot === '关于' && slot.value.kind === 'entity' && wantedEntities.has(slot.value.entityId),
        ).length;
        // Shared evidence first, then the same person/thing: two conclusions about
        // the same entity are the likeliest restatements even when their evidence
        // happens to be disjoint.
        const shared = ids.filter((id) => wanted.has(id)).length * 2 + sharedEntities;
        return { fact, shared, evidence: ids.length };
      })
      .sort((a, b) => b.shared - a.shared)
      .slice(0, limit)
      .map((entry) => ({ id: entry.fact.id, statement: entry.fact.statement, evidence: entry.evidence }));
  }

  /**
   * Fold new evidence into a held conclusion.
   *
   * The statement is not rewritten: keeping it makes the merge auditable, and a
   * richer statement is the model's job at the next natural revision, not this
   * function's.
   */
  mergeEvidence(into: string, evidence: string[]): { ok: boolean; reason?: string; added?: number } {
    const target = this.store.fact(into);
    if (!target) return { ok: false, reason: 'target-missing' };
    if (target.typeName !== '结论') return { ok: false, reason: 'target-not-conclusion' };
    if (target.status === FACT_STATUS.superseded) return { ok: false, reason: 'target-superseded' };

    const held = evidenceOf(target);
    const heldSet = new Set(held);
    const added = this.store.addSlots(
      into,
      conclusionSlots(
        evidence.filter((id) => !heldSet.has(id)),
        this.entitiesOfFacts(evidence),
      ),
    );
    // Confidence follows evidence count, as the gate does; never lower it.
    const total = new Set([...held, ...evidence]).size;
    const confidence = total >= 5 ? 0.85 : total >= 3 ? 0.7 : target.confidence;
    this.store.setFactConfidence(into, Math.max(target.confidence, confidence));
    return { ok: true, added };
  }

  /** Current conclusions, newest first. Superseded ones are history, not state. */
  conclusions(limit = 20): Fact[] {
    return this.store
      .facts({ soulId: this.soulId, userId: this.userId, holder: 'self', limit: 200 })
      .filter((fact) => fact.typeName === '结论' && fact.status !== FACT_STATUS.superseded)
      .slice(0, limit);
  }

  /**
   * The newest facts, newest first — the input batch for consolidation.
   *
   * Observations only: conclusions share the same table, and feeding a conclusion
   * back as evidence would let the model cite its own guess.
   */
  recentFacts(limit = 8): Fact[] {
    return this.store
      .facts({ soulId: this.soulId, userId: this.userId, limit: limit + 20 })
      .filter((fact) => fact.typeName !== '结论')
      .slice(0, limit);
  }

  /** How many observations exist; consolidation triggers on growth, not time. */
  factTotal(): number {
    return this.store
      .facts({ soulId: this.soulId, userId: this.userId, limit: 100_000 })
      .filter((fact) => fact.typeName !== '结论').length;
  }

  /**
   * Everything that happened to or around one entity — the "about her" path.
   *
   * `order: 'asc'` gives the earliest fact, which is how "when we first met"
   * is answered without storing a special label: the model reads the timeline.
   */
  factsAbout(
    entityId: string,
    options: { since?: number; until?: number; limit?: number; order?: 'asc' | 'desc' } = {},
  ): Fact[] {
    return this.store.facts({
      soulId: this.soulId,
      userId: this.userId,
      entityId,
      since: options.since,
      until: options.until,
      order: options.order,
      limit: options.limit,
    });
  }

  /** A fact plus the conversation behind it: hook first, detail on demand. */
  factDetail(factId: string): FactDetail | null {
    const fact = this.store.fact(factId);
    if (!fact) return null;
    const turn = fact.sourceTurnId ? this.store.turn(fact.sourceTurnId) : null;
    return {
      fact,
      turn: turn
        ? { id: turn.id, userText: turn.userText, assistantText: turn.assistantText, at: turn.at }
        : undefined,
    };
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

  /**
   * Verb 3: on demand.
   *
   * Reads facts, not the legacy `memories` table: after the migration that table is
   * inert, and a recall that still read it would stay empty forever.
   */
  recall(query: string, limit = 5): ScoredMemory[] {
    const facts = this.store
      .facts({ soulId: this.soulId, userId: this.userId, limit: 500 })
      .filter((fact) => fact.status !== FACT_STATUS.superseded);
    const ranked = rank(facts.map(factAsMemory), query, Date.now()).slice(0, limit);
    return ranked;
  }

  /** Pure analysis, no storage. Async because the analyzer may call a model. */
  async analyze(text: string): Promise<AffectSignal> {
    return this.analyzeTurn(text);
  }

  /**
   * Verb 2: after each turn. Affect and emotion only.
   *
   * Memory writing moved to `extract()` + `commitDrafts()` (facts), which is the one
   * representation the rest of the system reads. This method used to run a second
   * model pass (`llmExtractTurn`) behind a second gate (`gateDrafts`) into the legacy
   * `memories` table — two prompts, two gates, two model calls for the same message.
   */
  async observe(turn: Turn): Promise<ObserveResult> {
    const now = turn.at ?? Date.now();
    const affect = turn.role === 'user' ? await this.analyzeTurn(turn.content) : emptyAffect();

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
      written: 0,
      committed: false,
      rejections: [],
      llmOutcome: 'off',
      emotion,
      affect,
      extractedBy: 'none',
    };
  }

  /**
   * Explicit form of `observe`: the host decided this is worth keeping.
   *
   * Writes a fact, like every other write path. This used to be a row in the legacy
   * `memories` table, which meant "remember this" produced something the rest of the
   * system (anchors, recall, conclusions) had to be told about separately.
   */
  remember(
    content: string,
    options: { type?: MemoryType; importance?: number; visibility?: Visibility } = {},
  ): string {
    const fact = this.recordFact({
      statement: content,
      typeName: MEMORY_TYPE_TO_FACT[options.type ?? 'fact'],
      holder: 'self',
      source: 'told',
      confidence: Math.min(1, Math.max(0, (options.importance ?? 6) / 10)),
      // Explicit writes are anchors by definition: the host asked for this to be kept.
      slots: [{ slot: '锚点', value: { kind: 'text', value: '是' } }],
    });
    return fact.id;
  }

  /**
   * Explicit write requested by a host or its model (RFC 0005).
   *
   * Writes a fact and keeps the old dedupe contract: exact duplicate returns the
   * existing id, and a paraphrase inside the dedupe window is treated as the same
   * statement. Shape checks are the statement checks (non-empty, short enough);
   * the old `gateDrafts` layer existed only to protect the retired table.
   */
  rememberExplicit(input: { content: string; type?: MemoryType; importance?: number }): {
    ok: boolean;
    id?: string;
    duplicate?: boolean;
    reason?: string;
  } {
    const type = input.type ?? 'fact';
    const importance = Math.min(10, Math.max(1, input.importance ?? 7));
    const content = String(input.content ?? '').trim();
    if (content.length < 2) return { ok: false, reason: `length ${content.length} (2..${MAX_FACT_CHARS})` };
    if (content.length > MAX_FACT_CHARS) return { ok: false, reason: `length ${content.length} (2..${MAX_FACT_CHARS})` };
    // Punctuation alone is not a statement; the old shape gate rejected it and that
    // rule is worth keeping even though its table is gone.
    if (!/[\p{L}\p{N}]/u.test(content)) return { ok: false, reason: 'no letters or digits' };
    const now = Date.now();

    const candidates = this.store
      .facts({ soulId: this.soulId, userId: this.userId, limit: 200 })
      .filter((fact) => fact.status !== FACT_STATUS.superseded);

    // Same content anywhere: the exact duplicate.
    const same = candidates.find((fact) => fact.statement.trim() === content);
    if (same) return { ok: true, id: same.id, duplicate: true };

    // A paraphrase of something just written must not become a second row: a shared
    // run of characters inside the dedupe window is treated as the same statement.
    const window = this.dedupeWindowMs;
    if (window > 0) {
      const recent = candidates.filter((fact) => now - fact.createdAt <= window);
      const overlapping = recent.find((fact) => sharesRun(fact.statement, content, MIN_SHARED_RUN));
      if (overlapping) {
        return { ok: true, id: overlapping.id, duplicate: true, reason: 'already recorded this turn' };
      }
    }

    const id = this.remember(content, { type, importance });
    return { ok: true, id };
  }

  /**
   * One-off: move the legacy `memories` rows into facts (ADR 0032), then retire them.
   *
   * The old rows are the only description of the soul's own lessons that exists, so
   * they are copied — never rewritten — and marked superseded pointing at the new
   * fact. Re-running is safe: a statement that already has a fact is linked, not
   * copied again.
   */
  migrateLegacyMemories(): { migrated: number; linked: number; skipped: number } {
    const memories = this.store.query({ soulId: this.soulId, userId: this.userId, limit: 10_000 });
    const existing = new Map(
      this.store
        .facts({ soulId: this.soulId, userId: this.userId, limit: 10_000 })
        .map((fact) => [fact.statement.trim(), fact] as const),
    );
    let migrated = 0;
    let linked = 0;
    let skipped = 0;
    for (const memory of memories) {
      if (memory.status !== 'active') {
        skipped += 1;
        continue;
      }
      const statement = memory.content.trim();
      const known = existing.get(statement);
      const fact =
        known ??
        this.recordFact({
          statement,
          typeName: MEMORY_TYPE_TO_FACT[memory.type] ?? '事实',
          holder: 'self',
          source: 'told',
          confidence: Math.min(1, Math.max(0, memory.importance / 10)),
          // Migrated rows were explicit memories; keep them as anchors.
          slots: [{ slot: '锚点', value: { kind: 'text', value: '是' } }],
        });
      if (known) linked += 1;
      else {
        existing.set(statement, fact);
        migrated += 1;
      }
      this.store.retireMemory(memory.id, fact.id);
    }
    return { migrated, linked, skipped };
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

/** The fact ids a conclusion cites, in slot order. */
function evidenceOf(fact: Fact): string[] {
  return fact.slots
    .filter((slot) => slot.slot === '证据' && slot.value.kind === 'fact')
    .map((slot) => (slot.value.kind === 'fact' ? slot.value.factId : ''))
    .filter(Boolean);
}
