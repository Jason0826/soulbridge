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
  /** Written on create; no code filters by it yet (roadmap N3). */
  validFrom?: number;
  /** Reserved for expiry filtering; not enforced yet (roadmap N3). */
  validUntil?: number;
  /** Reserved for conflict replacement; not written yet (roadmap N3). */
  supersededBy?: string;
  /** Last-writer-wins clock for cross-device merge (ADR 0021). */
  updatedAt?: number;
  /** Tombstone; deletion is never physical on the first pass. */
  deletedAt?: number;
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
  /**
   * Whether this call counts as a recall (increments recallCount / lastRecalledAt).
   * Host adapters assemble prompts repeatedly per turn; pass false to preview
   * context without inflating recall statistics. Defaults to true.
   */
  track?: boolean;
  /** Only these memory types may be injected. Defaults to every type. */
  types?: MemoryType[];
  /** Skip memories below this importance (1..10). */
  minImportance?: number;
  /** Cap the number of injected memory lines. */
  maxItems?: number;
}

export interface ContextResult {
  text: string;
  used: string[];
  dropped: number;
  chars: number;
  /** Present only when the affect section was actually injected. */
  affect?: { confidence: number; directives: string[] };
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
  /** Clock for expiry checks; defaults to now. */
  now?: number;
  /**
   * Audit views (`list`) need to see expired rows; prompt builders must not.
   * Defaults to false, so expiry applies unless a caller asks otherwise.
   */
  includeExpired?: boolean;
}

export interface ReflectResult {
  memories: number;
  /**
   * How many older memories were replaced by a newer conflicting one.
   * 
ull` means this build does not track supersession yet — it used to report
   * a hardcoded 0, which claimed a capability that did not exist.
   */
  superseded: number | null;
  emotion: Emotion;
  /** True when at least one memory was durably written by this call. */
  committed: boolean;
  /** Drafts refused before writing, with the gate that refused them. */
  rejections: DraftRejection[];
}

export type GateName = 'shape' | 'semantic' | 'budget';

export interface DraftRejection {
  gate: GateName;
  reason: string;
  content: string;
}

export interface ObserveResult {
  written: number;
  /** True when at least one memory was durably written by this call. */
  committed: boolean;
  /** Drafts refused before writing, with the gate that refused them. */
  rejections: DraftRejection[];
  emotion: Emotion;
  /** Analysis of the user turn. Empty signal for assistant turns or on failure. */
  affect: AffectSignal;
  /** Which extractor produced the memory, for measurement. */
  extractedBy: 'rules' | 'llm' | 'none';
}

/** Injected by the caller. `core` never imports a model SDK. */
export type LlmFn = (prompt: string) => Promise<string> | string;

/* ------------------------------------------------------------------ *
 * Affect (input-side emotion of the *user*)
 * ------------------------------------------------------------------ */

export type AffectCategory = 'joy' | 'anger' | 'sadness' | 'fear' | 'disgust' | 'surprise';
export type AffectPolarity = 'positive' | 'negative' | 'neutral';

export interface AffectHit {
  term: string;
  category: AffectCategory;
  /** 1..9, already adjusted by degree modifiers. */
  intensity: number;
  polarity: AffectPolarity;
  negated: boolean;
  position: number;
}

export interface AffectFeatures {
  fillers: number;
  hedges: number;
  vague: number;
  tokens: number;
  /** meaningful tokens / all tokens, 0..1 */
  density: number;
}

export interface AffectSignal {
  /** Which analyzer produced this: 'lexicon' | 'llm' | 'none'. */
  analyzer: string;
  hits: AffectHit[];
  dominant: AffectCategory | null;
  intensity: number;
  valence: number;
  arousal: number;
  features: AffectFeatures;
  confidence: number;
  /** True when the text looks like withdrawal ("行吧", "随便") but no explicit emotion word. */
  abstain: boolean;
}

export const EMPTY_AFFECT: AffectSignal = {
  analyzer: 'none',
  hits: [],
  dominant: null,
  intensity: 0,
  valence: 0,
  arousal: 0,
  features: { fillers: 0, hedges: 0, vague: 0, tokens: 0, density: 1 },
  confidence: 0,
  abstain: false,
};

/** Wire version of the four verbs. Additive changes bump MINOR (ADR 0005). */
export const PROTOCOL_VERSION = '0.2';

/**
 * Evidence, not memory: a user correction captured with the reply it targeted.
 * Stored separately so it never reaches a prompt; distillation (RFC 0003 phase B)
 * is what turns evidence into a strategy.
 */
export interface Correction {
  id: string;
  soulId: string;
  userId: string;
  at: number;
  /** The user's own words, complete. */
  userText: string;
  /** The reply the correction targeted, complete; undefined when unknown. */
  assistantText?: string;
  /** Which marker matched (for statistics). */
  rule?: string;
  deviceId?: string;
}

