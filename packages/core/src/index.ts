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
export { reflect, ruleExtract, nextEmotion, isCorrection, correctionRule } from './reflect.ts';
export { rank, scoreMemory, tokenize, relevance } from './scoring.ts';
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
  Visibility,
} from './types.ts';
import type { SoulStore } from './store.ts';
import type { AffectAnalyzer } from './affect/port.ts';
import { buildContext } from './context.ts';
import { reflect, ruleExtract, nextEmotion } from './reflect.ts';
import { rank, tokenize } from './scoring.ts';
import { analyzeAffect, emptyAffect, lexiconAnalyzer } from './affect/analyze.ts';
import { gateDrafts, llmExtractTurn } from './reflect.ts';

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

  constructor(options: SoulOptions) {
    this.store = options.store;
    this.soulId = options.soulId;
    this.userId = options.userId;
    this.name = options.name ?? '小灵';
    this.deviceId = options.deviceId ?? 'dev_local';
    this.analyzer = options.analyzer ?? lexiconAnalyzer;
    this.llm = options.llm;
    this.llmMaxChars = options.llmMaxChars ?? 2000;

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
    if (drafts.length === 0 && turn.role === 'user' && this.llm) {
      if (turn.content.length <= this.llmMaxChars) {
        try {
          const draft = await llmExtractTurn(turn.content, this.llm);
          if (draft) {
            drafts = [draft];
            extractedBy = 'llm';
          }
        } catch {
          // The model is an enhancement; a transport or parse failure leaves the
          // rule result (nothing) in place.
        }
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
