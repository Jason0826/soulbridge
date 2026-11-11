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
export { INFERRED_MARKER, SOURCE_NOTES } from './config/labels.ts';
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
export type { TimeWindow } from './time.ts';
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
  ThreadSpan,
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
  PortableBundle,
  Visibility,
  FactRole,
  FactStatus,
} from './types.ts';
import { buildPortableBundle } from './portable.ts';
import type { SoulStore } from './store.ts';
import { FACT_STATUS, MEMORY_STATUS, WINDOW_PRECISIONS } from './config/status.ts';
import { HOLDER_WORDS } from './config/domains.ts';
import { isActive, isRetracted, roleOf } from './roles.ts';
import type { AffectAnalyzer } from './affect/port.ts';
import { parseTrigger } from './rules.ts';
import type { Rule } from './rules.ts';
import { planRetrieval } from './retrieval.ts';
import type { RetrievalPlan } from './retrieval.ts';
import { gateConclusion, conclusionSlots, isDerivedProfileLine, PROFILE_DIMENSIONS } from './consolidate.ts';
import { buildContext } from './context.ts';
import { reflect, ruleExtract, nextEmotion } from './reflect.ts';
import { bm25, buildCorpusStats, rank, tokenize } from './scoring.ts';
import { analyzeAffect, emptyAffect, lexiconAnalyzer } from './affect/analyze.ts';
import { extractByRules, extractThreadWithModel, extractWithModel } from './extract.ts';
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
 * The lifecycle state a fact is *written* with, from its role (config/status.ts).
 *
 * A lesson is a candidate: held, injected nowhere, waiting for the classifier that
 * turns it into a rule or a profile line (0018 §九 3). A rule is a candidate for the
 * same reason from the other end: it only becomes a rule once its 触发 slot exists,
 * and the classifier is the only writer of that slot. Stored active without one, the
 * row sat in the rule layer that `rules()` must skip — injected nowhere, counted
 * nowhere, and invisible as debt until it was counted by hand (56 rows in production,
 * 11 written the day before they were found). So both roles start as candidates; the
 * classifier is what puts either one in use.
 *
 * Every other role starts in use — `undefined` lets the column default stay the single
 * declaration of "active". This is the code's decision, never the model's: the model
 * supplies the role.
 */
function writeStatus(role: FactRole | undefined): FactStatus | undefined {
  return role === 'lesson' || role === 'rule' ? FACT_STATUS.candidate : undefined;
}

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

  /**
   * Everything a host needs to carry this soul to another machine or tool:
   * the full archive, a readable summary, and the injection the model would see.
   */
  portableBundle(now = Date.now()): PortableBundle {
    const dump = this.store.dump(this.soulId, this.userId);
    const injection = this.context({}).text;
    return buildPortableBundle(dump, this.soulId, this.userId, injection, now);
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
      .filter((fact) => isActive(fact))
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
   * The experiences of one turn that still owe a classification decision, and nothing else.
   *
   * Promotion reads the flag, never the statement: whether a sentence is "about how
   * to work" is the semantic call the extractor already made, and re-deriving it in
   * code would be the guess ADR 0027 forbids.
   *
   * The filter is the status, not the role: a candidate is a row held out of every
   * layer because nobody has placed it yet, and the queue's job is to place rows, not
   * to re-check the model's guess at a role. Filtering on `role === 'lesson'` is what
   * left 56 `角色=rule` rows invisible — they were candidates in fact and lessons in
   * filter (0018 §九 3 B).
   */
  promotionCandidates(turnId: string): Fact[] {
    return this.store
      .factsByTurns([turnId], { includeCandidates: true })
      .filter((fact) => fact.status === 'candidate');
  }

  /**
   * Every candidate still waiting to be placed, oldest first.
   *
   * The queue's live producer feeds one drained turn at a time, so lessons extracted
   * before the producer existed never reach the classifier. This is the inventory one
   * pass puts back in the queue (0018 §九 3 A, 存量), not a ranking: all of them are
   * owed the same second look. Same filter as `promotionCandidates`: the status.
   */
  promotionBacklog(limit = 400): Fact[] {
    return this.store
      .facts({ soulId: this.soulId, userId: this.userId, status: 'candidate', limit: 1000 })
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, Math.max(0, limit));
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
      now?: number;
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
      /**
       * The whole topic (0025). When given, the prompt carries every turn and the model
       * sees the conversation as one unit; `text`/`assistantText` are then ignored.
       */
      turns?: Array<{ turnNo: number; userText: string; assistantText?: string; startedAt?: number }>;
    } = {},
  ): Promise<ExtractDraft> {
    const now = options.now ?? Date.now();
    // Rules work on one message; for a thread that is the last turn (the rules floor
    // exists for "no model", not for reconstructing a topic).
    const fallbackText = options.turns?.length ? options.turns[options.turns.length - 1].userText : text;
    const byRules = extractByRules(fallbackText, now);
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
    const result = options.turns?.length
      ? await extractThreadWithModel(options.turns, wrapped, now, context)
      : await extractWithModel(text, wrapped, now, context, options.assistantText);
    return result.draft ?? { ...byRules, reason: `model-${result.error ? 'failed' : 'empty'}` };
  }

  /** The turns of one thread, in order, as the extraction input (0025). */
  threadTurns(threadId: string): Array<{ turnNo: number; userText: string; assistantText?: string; startedAt?: number; id: string }> {
    return this.store.threadTurns(threadId).map((turn, index) => ({
      id: turn.id,
      turnNo: index + 1,
      userText: turn.userText,
      assistantText: turn.assistantText,
      startedAt: turn.at,
    }));
  }

  /** Which thread a turn belongs to, if any — the bridge from a turn trigger to a topic. */
  turnThreadId(turnId: string): string | null {
    return this.store.turnThreadId(turnId);
  }

  /** The slice of the store the extractor is allowed to know about. */
  extractionContext(
    limit = 20,
    options: { turnNo?: number; sessionId?: string; text?: string } = {},
  ): ExtractionContext {
    const entities = this.store
      .findEntities({ soulId: this.soulId, userId: this.userId, limit })
      .map((e) => ({
        id: e.id,
        name: e.name,
        aliases: e.aliases,
        relation: typeof e.attrs.relation === 'string' ? e.attrs.relation : undefined,
      }));
    const { facts, factCandidates } = this.extractionFactCandidates(options);
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
    return { entities, facts, threads, previousUserText, factCandidates };
  }

  /**
   * Which old facts the extractor is shown, and why.
   *
   * `<known-facts>` answers exactly one question — "is this sentence already known?" —
   * so the candidates are the facts about the same thing, never simply the newest rows:
   * the entities this text names, the thread it continues, then what reads like it
   * (BM25 over character bigrams), and the newest rows only as a floor when those came
   * back thin. The stop rule is a character budget, not a row count; truncation keeps a
   * group whole, because half of one subject's facts turns "these two disagree" into
   * "nothing here". See EXTRACTION_FACT_BUDGET_CHARS for why characters.
   */
  extractionFactCandidates(options: { turnNo?: number; sessionId?: string; text?: string } = {}): {
    facts: ExtractionContext['facts'];
    factCandidates: NonNullable<ExtractionContext['factCandidates']>;
  } {
    const active = this.store
      .facts({ soulId: this.soulId, userId: this.userId, limit: 100_000 })
      .filter(isActive);
    const text = (options.text ?? '').trim();
    const groups: Array<{ key: string; tier: number; facts: Fact[] }> = [];

    // Tier 0: one group per named entity, so truncation can drop a subject without
    // splitting it.
    if (text) {
      for (const entity of this.store.findEntities({ soulId: this.soulId, userId: this.userId, limit: 500 })) {
        const names = [entity.name, ...(entity.aliases ?? [])].filter((name) => name.trim().length >= 2);
        if (!names.some((name) => text.includes(name))) continue;
        const ofEntity = this.store
          .facts({ soulId: this.soulId, userId: this.userId, entityId: entity.id, limit: 200 })
          .filter(isActive);
        if (ofEntity.length > 0) groups.push({ key: `entity:${entity.name}`, tier: 0, facts: ofEntity });
      }
    }

    // Tier 1: the thread the previous turn belonged to — the topic being continued.
    const threadId =
      options.sessionId !== undefined && options.turnNo !== undefined
        ? this.threadBefore(options.sessionId, options.turnNo)
        : null;
    if (threadId) {
      const turnIds = this.store.threadTurns(threadId).map((turn) => turn.id);
      const ofThread = this.store.factsByTurns(turnIds).filter(isActive);
      if (ofThread.length > 0) groups.push({ key: 'thread', tier: 1, facts: ofThread });
    }

    // Tier 2: lexical look-alikes. BM25 rather than shared substrings because length
    // normalisation is what keeps one 18k-character row from "matching" everything.
    if (text) {
      const picked = new Set(groups.flatMap((group) => group.facts.map((fact) => fact.id)));
      const pool = active.filter((fact) => !picked.has(fact.id));
      if (pool.length > 0) {
        const query = tokenize(text);
        const docs = pool.map((fact) => tokenize(fact.statement));
        const stats = buildCorpusStats(docs);
        const scored = pool
          .map((fact, at) => ({ fact, score: bm25(query, docs[at] as string[], stats) }))
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score || right.fact.createdAt - left.fact.createdAt);
        // Relative cut-off, not just a count: "发布那事" should fill the set with the
        // release cluster, while "今天天气不错" should bring almost nothing (any shared
        // bigram scores above zero, so an absolute count would always return its cap).
        const best = scored[0]?.score ?? 0;
        const strong = scored.filter((entry) => entry.score >= best * EXTRACTION_SIMILAR_FLOOR_RATIO);
        for (const entry of strong.slice(0, EXTRACTION_SIMILAR_FACTS)) {
          groups.push({ key: `similar:${entry.fact.id}`, tier: 2, facts: [entry.fact] });
        }
      }
    }

    // Tier 3: the floor. The old `limit: 12` survives only here, and only when the
    // subject-driven tiers came back thin: when the text clearly matched something,
    // recent-but-unrelated rows would spend the budget on noise.
    const named = new Set(groups.flatMap((group) => group.facts.map((fact) => fact.id)));
    const specific = groups.filter((group) => group.tier < 3).reduce((sum, group) => sum + group.facts.length, 0);
    if (specific < EXTRACTION_RECENT_FACTS) {
      const recent = active
        .filter((fact) => !named.has(fact.id))
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, EXTRACTION_RECENT_FACTS - specific);
      if (recent.length > 0) groups.push({ key: 'recent', tier: 3, facts: recent });
    }

    const chosen: Fact[] = [];
    const taken = new Set<string>();
    const droppedGroups: Array<{ group: string; facts: number }> = [];
    const byTier = { entity: 0, thread: 0, similar: 0, recent: 0 };
    let chars = 0;
    for (const group of groups.sort((left, right) => left.tier - right.tier)) {
      // Tiers overlap on purpose (one row can be both the entity's and the thread's);
      // the prompt must still see it once.
      const fresh = group.facts.filter((fact) => !taken.has(fact.id));
      if (fresh.length === 0) continue;
      const cost = fresh.reduce((sum, fact) => sum + fact.statement.length, 0);
      // The first group is taken even when oversized: an empty candidate set is not
      // "no duplicates", it is "the model was not allowed to look".
      if (chosen.length > 0 && chars + cost > EXTRACTION_FACT_BUDGET_CHARS) {
        droppedGroups.push({ group: group.key, facts: fresh.length });
        continue;
      }
      for (const fact of fresh) {
        chosen.push(fact);
        taken.add(fact.id);
      }
      chars += cost;
      const tier = group.tier === 0 ? 'entity' : group.tier === 1 ? 'thread' : group.tier === 2 ? 'similar' : 'recent';
      byTier[tier] += fresh.length;
    }

    return {
      facts: chosen.map((fact) => ({ id: fact.id, statement: fact.statement, validFromText: fact.validFromText })),
      factCandidates: { chosen: chosen.length, chars, droppedGroups, byTier },
    };
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
   * Put every turn of an extracted segment into its thread (0028 ③).
   *
   * The model answers with spans in the prompt's numbering; each turn is applied
   * through `applyThread` in turn order, so the existing chain — continue → new →
   * fallback to the previous turn's thread (ADR 0034) — does the work per turn. A
   * turn no span covers lands where the previous turn did, and the first turn of a
   * segment falls back to `previousThreadId`, which is the thread the segment
   * started inside.
   *
   * This only fans the single-turn primitive over the unit; it re-decides nothing.
   * That is also why the head-only gap closes: before, one attribution attached one
   * turn and the rest of the segment carried no thread.
   *
   * `turnNo` is the host's real turn number (threads count turns, and host numbers
   * jump by 10–30); `promptNo` is the numbering the model saw and the only thing
   * spans match against.
   */
  applyThreadSpans(
    spans: ThreadSpan[] | undefined,
    spec: {
      sessionId: string;
      turns: Array<{ promptNo: number; turnNo: number; turnId: string; at: number; fallbackTopic?: string }>;
      previousThreadId?: string;
    },
  ): Array<{ turnId: string; threadId: string; created: boolean; topic: string; joinReason: string; topicUpdated: boolean }> {
    let previous = spec.previousThreadId;
    const applied: Array<{ turnId: string; threadId: string; created: boolean; topic: string; joinReason: string; topicUpdated: boolean }> = [];
    // A `new` span opens ONE thread, not one per turn: the model named a topic for a
    // run of turns, and applying its answer per turn would fragment that run into
    // same-topic clones — the exact failure 0028 exists to remove. The first turn
    // opens it; the rest of the span continues what was just opened.
    const openedBySpan = new Map<ThreadSpan, string>();
    for (const turn of spec.turns) {
      const span = spans?.find((candidate) => candidate.from <= turn.promptNo && (candidate.to === undefined || turn.promptNo <= candidate.to));
      let attribution = span?.attribution;
      if (span && attribution?.kind === 'new') {
        const opened = openedBySpan.get(span);
        if (opened) attribution = { kind: 'continue', id: opened };
      }
      const result = this.applyThread(attribution, {
        sessionId: spec.sessionId,
        turnNo: turn.turnNo,
        turnId: turn.turnId,
        at: turn.at,
        fallbackTopic: turn.fallbackTopic,
        previousThreadId: previous,
      });
      if (span && !openedBySpan.has(span)) openedBySpan.set(span, result.threadId);
      applied.push({
        turnId: turn.turnId,
        threadId: result.threadId,
        created: result.created,
        topic: result.topic,
        joinReason: result.joinReason,
        topicUpdated: result.topicUpdated,
      });
      previous = result.threadId;
    }
    return applied;
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
  commitDrafts(
    draft: ExtractDraft,
    options: { turnId?: string; now?: number; turnIds?: Record<number, string> } = {},
  ): CommitResult {
    const entities = new Map<string, Entity>();
    const skipped: CommitResult['skipped'] = [];
    const droppedSlots: CommitResult['droppedSlots'] = [];
    const holderFallbacks: CommitResult['holderFallbacks'] = [];
    const actions: CommitResult['actions'] = { add: 0, supersede: 0, update: 0, noop: 0 };
    const now = options.now ?? Date.now();

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

    // No default type: choosing person/thing is a meaning decision, and a default here
    // would let the code make it silently (ADR 0027, health-check §12). Every caller
    // passes the type the model declared.
    const ensureEntity = (name: string, type: EntityDraft['type']): Entity => {
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
        seenAt: now,
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
        // Only a declared or already-known name is a reference; the declaration carries
        // the type, so the code never has to guess one.
        const known = byName.get(name);
        const fromDraft = declared.has(name) ? draft.entities.find((entity) => entity.name === name) : undefined;
        const type = known?.type ?? fromDraft?.type;
        if (fromDraft || known) {
          const entity = known ?? ensureEntity(name, type as EntityDraft['type']);
          slots.push({ slot: slot.slot, value: { kind: 'entity', entityId: entity.id } });
          continue;
        }
        slots.push({ slot: slot.slot, value: { kind: 'text', value: name } });
        droppedSlots.push({ fact: statement, slot: slot.slot, value: name });
      }
      // Where the fact holds (ADR 0032): `world`, `self`, or a named mind. The holder is
      // a reference to an entity that already exists (declared entities are created
      // above), never a new entity created from a holder string.
      const holderName = factDraft.holder?.trim() || HOLDER_WORDS[0];
      let holder: string = HOLDER_WORDS[0];
      let holderEntity: Entity | undefined;
      if (holderName !== HOLDER_WORDS[0]) {
        if (holderName === HOLDER_WORDS[1]) {
          holder = HOLDER_WORDS[1];
        } else {
          holderEntity = byName.get(holderName);
          if (holderEntity) holder = holderEntity.id;
          else holderFallbacks.push({ fact: statement, holder: holderName });
        }
      }
      // 0025: a fact that holds in someone's mind must name that person. "10-24 被裁员"
      // with holder=小林 but no 小林 in the sentence is unreadable a month later; a role
      // slot (提出者/对象) is not the subject and is not required to appear.
      if (holderEntity) {
        const names = [holderEntity.name, ...(holderEntity.aliases ?? [])];
        if (!names.some((name) => statement.includes(name))) {
          skipped.push({ what: statement, reason: `not-self-contained:${holderEntity.name}` });
          return null;
        }
      }

      const duplicated = recent.some(
        (f) =>
          f.statement === statement &&
          (f.validFromText ?? '') === (factDraft.validFromText ?? '') &&
          Math.abs((f.validFrom ?? f.createdAt) - (factDraft.validFrom ?? now)) < 86400000,
      );
      if (duplicated) {
        skipped.push({ what: statement, reason: 'duplicate' });
        return null;
      }

      // An unclassified lesson is a candidate: a lesson the model flagged but did not
      // place in a role. It is held and shown to the classifier, injected nowhere.
      // This replaced the old `原则候选` slot, which was the same decision stored as text.
      const role = factDraft.principle && !factDraft.role ? 'lesson' : factDraft.role;
      // ...and the same holds when the model named the role itself: `角色=lesson` and
      // `原则候选=是` are two ways of saying it, but only the flag used to reach the
      // queue. A roled lesson went straight to `active`, where it was injected as
      // background text and never classified into a rule (0018 §九 3 A).
      const status = writeStatus(role);
      // Which turn this fact came from: the model's 轮次=N when it named one, else the
      // turn the caller passed. A thread-level extraction needs the per-fact answer.
      const sourceTurnId = factDraft.sourceTurnNo
        ? options.turnIds?.[factDraft.sourceTurnNo] ?? options.turnId
        : options.turnId;
      // ADR 0035: a fact from my side of the exchange is `inferred`, and inferred
      // claims must carry their evidence. The turn id is the evidence available here —
      // claims that need a tool or test result are kept out by the prompt instead.
      if (factDraft.source === 'inferred' && sourceTurnId && !slots.some((slot) => slot.slot === '依据')) {
        slots.push({ slot: '依据', value: { kind: 'text', value: sourceTurnId } });
      }

      const written = this.store.putFact({
        soulId: this.soulId,
        userId: this.userId,
        statement,
        holder,
        role,
        status,
        typeName: factDraft.typeName,
        validFrom: factDraft.validFrom,
        validFromText: factDraft.validFromText,
        validFromPrecision: factDraft.validFromPrecision,
        validTo: factDraft.validTo,
        source: factDraft.source,
        confidence: factDraft.confidence,
        sourceTurnId,
        slots,
      });
      facts.push(written);
      // A missing time is a property of the fact (`validFromPrecision: unknown`), not an
      // open question. Turning every undated fact into a gap produced 223 open gaps in two
      // days, of which 78% were '日期不明：…' — they can never be closed, and they bury the
      // gaps that are worth asking about. The fact stays; the question is not created.
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
      // Intent, counted before any write can degrade it: "the model saw the pool and
      // chose to merge" must survive even when the target id turns out missing.
      actions[operation.op] += 1;
      if (operation.op === 'noop') continue;
      const written = writeFact(operation.fact);
      if (!written) continue;
      if (operation.op === 'supersede' || operation.op === 'update') {
        // The model may name any id; only a row we actually hold may be retired. A
        // missing target degrades to a plain add and is reported — the sentence is never
        // lost, and "the fact changed" is never claimed without a real predecessor.
        const target = operation.targetId ? this.store.fact(operation.targetId) : null;
        const sameScope = target && target.soulId === this.soulId && target.userId === this.userId;
        if (target && sameScope && isActive(target)) {
          this.store.supersedeFact(target.id, written.id);
        } else {
          skipped.push({
            what: written.statement,
            reason: target ? `supersede-target-${target.status}` : `unknown-supersede-target: ${operation.targetId ?? '(missing)'}`,
          });
        }
      }
    }

    for (const gapDraft of draft.gaps) {
      // A gap about a known entity only; no type guessing, and no entity minted from a
      // gap's wording (that is how "仅在电话里说" became a person).
      const about = gapDraft.aboutEntityName ? byName.get(gapDraft.aboutEntityName) : undefined;
      gaps.push(
        this.store.putGap({
          soulId: this.soulId,
          userId: this.userId,
          aboutEntityId: about?.id,
          aboutFactId: facts.length === 1 ? facts[0].id : undefined,
          topic: gapDraft.topic,
          tension: gapDraft.tension,
          openedAt: now,
        }),
      );
    }

    return { entities: [...entities.values()], facts, gaps, skipped, droppedSlots, holderFallbacks, actions };
  }

  /** Remember a person/thing/place; calling again just refreshes "last mentioned". */
  rememberEntity(
    name: string,
    // No default type: person/thing/place is a meaning decision, and a default would let
    // every caller silently decide "person" (ADR 0027, health-check §9.5).
    type: Entity['type'],
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
    // The same write rule as extraction: a lesson is a candidate until classified.
    // An explicit status still wins — this is a port, not a policy of its own.
    return this.store.putFact({
      ...spec,
      status: spec.status ?? writeStatus(spec.role),
      soulId: this.soulId,
      userId: this.userId,
    });
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
      role: 'judgment',
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
   * wallpaper, and wallpaper is how a lesson gets ignored. Skipping is also how such a
   * row used to hide: written active with no trigger it was counted in the layer but
   * could never fire. The writers keep that from happening now (role `rule` is stored
   * as a candidate, schema v17 demotes the rows that predate it), so a row skipped here
   * is a tell, not a normal case.
   *
   * Reads the rule layer itself, not "the newest N facts": a lesson from last week can
   * be classified into a rule today, and scanning a newest-window silently dropped it
   * (0018 §九 3 A classifies exactly the older backlog). The ceiling is a bound, not a
   * budget — ADR 0033 keeps this layer small; hitting it means the classifier is
   * over-promoting, which `rule-stats.mjs` is there to notice.
   *
   * `index` and `recallCount` are carried for the catalog (0029): the rule layer is
   * already read once per turn, so the always-on directory is a projection of this
   * same query instead of a second scan.
   */
  rules(): Rule[] {
    const out: Rule[] = [];
    const rows = this.store.facts({
      soulId: this.soulId,
      userId: this.userId,
      role: 'rule',
      status: FACT_STATUS.active,
      limit: 2000,
    });
    for (const fact of rows) {
      const triggerSlot = fact.slots.find((slot) => slot.slot === '触发' && slot.value.kind === 'text');
      const trigger = parseTrigger(triggerSlot?.value.kind === 'text' ? triggerSlot.value.value : '');
      if (!trigger) continue;
      // Stored as 目录句, not 索引: extraction also writes slot names from what the
      // conversation talks about, and 索引 already occurs as a slot name in the wild
      // (facts about index files). A catalog line that silently loses to a noise slot
      // would be an entry nobody can explain.
      const indexSlot = fact.slots.find((slot) => slot.slot === '目录句' && slot.value.kind === 'text');
      out.push({
        id: fact.id,
        statement: fact.statement,
        trigger,
        confidence: fact.confidence,
        ...(indexSlot?.value.kind === 'text' && indexSlot.value.value.trim()
          ? { index: indexSlot.value.value.trim() }
          : {}),
        recallCount: fact.recallCount ?? 0,
      });
    }
    return out;
  }

  /**
   * The always-on catalog (0029 stage 1): one neutral line per rule, with the id
   * needed to expand it.
   *
   * Ordered by `recallCount` — how often the situation reproduced — then confidence.
   * Scope is not modelled, so it is not pretended: open question 4 in 0029 stays open
   * and this ordering is the computable part. A rule without an index line is left
   * out and counted in `missingIndex`; filling it with a cut-down statement is the
   * mistake the brief exists to avoid (an imperative is not an index).
   */
  catalog(limit = 20): { entries: Rule[]; total: number; missingIndex: number } {
    const all = this.rules();
    const indexed = all.filter((rule) => rule.index);
    const entries = indexed
      .sort((a, b) => (b.recallCount ?? 0) - (a.recallCount ?? 0) || (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, Math.max(0, limit));
    return { entries, total: all.length, missingIndex: all.length - indexed.length };
  }

  /**
   * Apply a rule classification (ADR 0033): retag as 规则 and store its trigger.
   *
   * The trigger is what makes the rule injectable later; a rule without one would
   * have to be always-on, which is exactly what this split exists to avoid.
   */
  markRule(factId: string, classification: { trigger: string; action?: string; index?: string }): void {
    this.store.setFactRole(factId, 'rule');
    this.store.setFactTypeName(factId, '规则');
    const slots: { slot: string; value: { kind: 'text'; value: string } }[] = [
      { slot: '触发', value: { kind: 'text', value: classification.trigger } },
    ];
    if (classification.action) slots.push({ slot: '动作', value: { kind: 'text', value: classification.action } });
    if (classification.index) slots.push({ slot: '目录句', value: { kind: 'text', value: classification.index } });
    this.store.addSlots(factId, slots);
    this.activatePlaced(factId);
  }

  /**
   * Give an already-placed rule its catalog line (0029), or rewrite one (0029 §五).
   *
   * Returns false when the id is not an active rule: the answer is skipped and
   * reported, never applied to a lesson (an index on a parked row would put a
   * candidate into the always-on block) and never demoting it either.
   *
   * A rewrite **replaces** the line instead of appending: `addSlots` skips only exact
   * duplicates, so a different line would sit next to the old one in the same slot and
   * `rules()` would keep returning whichever it read first — the rewrite would look
   * applied and change nothing.
   */
  markRuleIndex(factId: string, index: string): boolean {
    const line = String(index ?? '').trim();
    if (!line) return false;
    const fact = this.store.fact(factId);
    if (!fact || fact.role !== 'rule' || !isActive(fact)) return false;
    this.store.replaceSlot(factId, '目录句', { kind: 'text', value: line });
    return true;
  }

  /**
   * Classification is the decision the candidate was waiting for: the row is in use now.
   *
   * Without this the queue drained and every classified rule stayed a candidate —
   * `rules()` reads active rows only, so the rule would never fire (0018 §九 3 A).
   * A row retired while it sat in the queue is not resurrected: being classified is
   * not evidence that it became true again.
   */
  private activatePlaced(factId: string): void {
    const fact = this.store.fact(factId);
    if (!fact || isRetracted(fact)) return;
    this.store.setFactStatus(factId, FACT_STATUS.active);
  }

  /** Apply a profile classification: it is about the person, not a triggered rule. */
  markProfile(factId: string, options: { dimension?: string } = {}): void {
    this.store.setFactRole(factId, 'profile');
    this.store.setFactTypeName(factId, '画像');
    // The dimension is written here because this is the moment the model decided
    // which lens the judgment belongs to. The merge step cuts its batches along
    // this value later, so a missing dimension is a judgment that can never be
    // merged — visible in the merge log as 未标注, not silently guessed.
    const dimension = options.dimension;
    if (dimension && (PROFILE_DIMENSIONS as readonly string[]).includes(dimension)) {
      this.store.addSlots(factId, [{ slot: '维度', value: { kind: 'text', value: dimension } }]);
    }
    this.activatePlaced(factId);
  }

  /**
   * Park a lesson that could not be classified.
   *
   * Neither bucket is safe for it: as a rule it would fire every turn, and as a
   * profile line it would put an imperative into the description of a person. It
   * becomes a candidate — held in the store, injected nowhere — and shows up in a review count.
   */
  markUnclassified(factId: string): void {
    this.store.setFactStatus(factId, 'candidate');
  }

  /**
   * The judgments about the person that are waiting to be merged.
   *
   * Reads the profile layer itself: a line classified from an old lesson is about the
   * person today, and the newest-window scan dropped it for the same reason it dropped
   * old rules (0018 §九 3 A).
   */
  profileItems(limit = 60): Fact[] {
    return this.store
      .facts({ soulId: this.soulId, userId: this.userId, role: 'profile', status: FACT_STATUS.active, limit: 2000 })
      .filter(
        (fact) =>
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
        role: 'profile',
        typeName: '画像',
        holder: 'self',
        // More sources means more observations behind the line, so it ranks first.
        confidence: Math.min(0.95, 0.6 + 0.05 * line.sources.length),
        slots: [
          ...line.sources.map((id) => ({ slot: '证据', value: { kind: 'fact' as const, factId: id } })),
          // A merged line is not an original: re-merging merged lines loses detail.
          { slot: '合并', value: { kind: 'text' as const, value: '1' } },
          { slot: '维度', value: { kind: 'text' as const, value: line.dimension } },
        ],
      });
      written.push(fact);
      for (const sourceId of line.sources) {
        const source = this.store.fact(sourceId);
        if (source && isActive(source)) this.store.supersedeFact(sourceId, fact.id);
      }
    }
    return written;
  }

  /**
   * The merged profile, strongest first — what is injected every turn.
   *
   * Same rule as `rules()`: read the layer, not the newest facts. A profile line
   * merged from an old lesson is still about the person, and a newest-window scan
   * dropped it silently (0018 §九 3 A).
   */
  profile(limit = 8): Fact[] {
    return this.store
      .facts({ soulId: this.soulId, userId: this.userId, role: 'profile', status: FACT_STATUS.active, limit: 2000 })
      .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /** Which primitive this question needs (0020).
   *
   * The subject is resolved against the entities we hold, so "上次和 a 吃饭" can
   * never be answered with the last closed topic.
   */
  planRetrieval(text: string, now = Date.now()): RetrievalPlan {
    // Only people and places can be a question's subject. A concept entity like 情绪
    // or a product like dsh matches ordinary technical messages, and routing to it
    // suppresses the related-conversation block — which is how "把 package.json 改
    // 一下" ended up asking about entity "a".
    const names = this.store
      .findEntities({ soulId: this.soulId, userId: this.userId, limit: 500 })
      .filter((entity) => entity.type === 'person' || entity.type === 'place' || entity.type === 'self')
      .map((entity) => entity.name);
    return planRetrieval(text, names, now);
  }

  /**
   * What happened in one span of time — the time-window primitive (0027 §八).
   *
   * Only facts with a located date enter: filtering `valid_from` alone would answer
   * "what happened last week" with "what was recorded last week", because an
   * unknown-precision fact's `valid_from` is often the record day. The window is
   * half-open `[from, to)`, and it is read in event order — a window is a story.
   */
  factsInWindow(window: { from: number; to: number }, options: { limit?: number } = {}): Fact[] {
    return this.store.facts({
      soulId: this.soulId,
      userId: this.userId,
      since: window.from,
      until: window.to,
      precisions: WINDOW_PRECISIONS,
      status: FACT_STATUS.active,
      order: 'asc',
      limit: options.limit ?? 200,
    });
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

  /**
   * Housekeeping that should run once per turn: close open questions nobody answered.
   *
   * A gap is only worth asking about while it is fresh; 14 days of silence means the moment
   * passed. Closing is not deleting — the row keeps its topic, opened_at and the reason.
   */
  sweep(now = Date.now(), options: { gapMaxAgeDays?: number } = {}): { gapsClosed: number } {
    const maxAgeDays = options.gapMaxAgeDays ?? 14;
    const gapsClosed = this.store.closeStaleGaps(
      this.soulId,
      this.userId,
      now - maxAgeDays * 86_400_000,
      'expired',
    );
    return { gapsClosed };
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
    if (!isActive(target)) return { ok: false, reason: 'target-superseded' };

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
      .filter((fact) => roleOf(fact) === 'judgment' && isActive(fact))
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

  /**
   * What we know about one person right now: their record, the recent events, and the
   * questions about them that are still open.
   *
   * This is the reading side of the person layer. It deliberately does not summarise with a
   * model — the caller asks "how is she" and the model decides how to use these lines.
   */
  personCard(
    nameOrId: string,
    options: { limit?: number } = {},
  ): { entity: Entity | null; recent: Fact[]; openGaps: Gap[] } {
    const entity = this.store.entity(nameOrId) ?? this.findEntities(nameOrId, 1)[0] ?? null;
    if (!entity) return { entity: null, recent: [], openGaps: [] };
    const recent = this.store.facts({
      soulId: this.soulId,
      userId: this.userId,
      entityId: entity.id,
      limit: options.limit ?? 8,
    });
    const openGaps = this.openGapsAbout(entity.id);
    return { entity, recent, openGaps };
  }

  /** The open questions still attached to one person (the ones worth asking about). */
  openGapsAbout(entityId: string): Gap[] {
    return this.store
      .openGaps(this.soulId, this.userId, 500)
      .filter((gap) => gap.aboutEntityId === entityId);
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
      .filter((fact) => isActive(fact));
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
      .filter((fact) => isActive(fact));

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

/**
 * Budget for the `<known-facts>` candidate set, in characters of statement text.
 *
 * Not a row count: statements in this store run 24..18,205 characters, so a row count
 * is not a budget at all. 2400 characters ≈ 30 median facts (p50 = 53), which is
 * enough that "the same thing said three days ago" can be in the set and small enough
 * to stay a rounding error in a 5331-character prompt. Characters stand in for tokens
 * (1 CJK char ≈ 0.6–1 token) because no tokenizer ships here: it is a stop rule, and
 * the tiered selection above is what decides which rows deserve the room.
 */
export const EXTRACTION_FACT_BUDGET_CHARS = 2400;
/** How many BM25 look-alikes may enter when the entity/thread tiers are thin. */
export const EXTRACTION_SIMILAR_FACTS = 60;
/**
 * A look-alike is kept only when it scores at least this fraction of the best one.
 * Any shared character bigram scores above zero, so an absolute count alone would
 * always return its cap — a generic sentence would fill the pool with noise.
 */
export const EXTRACTION_SIMILAR_FLOOR_RATIO = 0.35;
/** The floor tier: newest rows, only when nothing in the text named a subject. */
export const EXTRACTION_RECENT_FACTS = 12;

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
