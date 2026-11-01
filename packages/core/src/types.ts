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

/**
 * One exchange: what the user said and what the assistant answered.
 * The unit of memory (RFC 0007). Both sides are original text, never truncated
 * here — injection drops a whole pair rather than cutting one in half.
 */
export interface TurnPair {
  id: string;
  soulId: string;
  userId: string;
  /** Host session id. Together with `turn` it makes writes idempotent. */
  sessionId: string;
  turn: number;
  /** When the user message arrived. */
  at: number;
  userText: string;
  assistantText: string;
  /** Open container for fields not decided yet (briefs/0010 §8). */
  metadata: Record<string, unknown>;
  createdAt: number;
}

/** What a recall call may narrow by. Everything is optional. */
export interface TurnPairSpec {
  soulId: string;
  userId: string;
  /** Text to score against. Empty means "no query": rank by recency only. */
  query?: string;
  limit?: number;
  /** Only pairs at or after this timestamp. */
  since?: number;
}

/**
 * One conversation, derived from `turn_pairs` (briefs/0011). It is a boundary,
 * not a stored entity: the same data regrouped, so nothing new to migrate.
 */
export interface SessionSummary {  sessionId: string;
  /** First and last exchange times in this session. */
  start: number;
  end: number;
  /** Number of exchanges recorded for this session. */
  turns: number;
}

/**
 * What a new session inherits from the previous one: when it happened, and the
 * first plus last exchanges. Boundaries and the tail are what recall hangs on
 * (event segmentation), not the middle.
 */
export interface SessionHandoff {
  session: SessionSummary;
  first: TurnPair;
  last: TurnPair[];
}

/* ------------------------------------------------------------------ *
 * Turns and steps (briefs/0014): a turn is the unit, its steps the shape
 * ------------------------------------------------------------------ */

/**
 * What happened inside one turn, in order. A DSH turn averages 5.2 steps and
 * 70% of them call tools, so `user + assistant text` is the outline, not the
 * turn. Steps keep the shape without keeping the reasoning text.
 */
export interface TurnStep {
  idx: number;
  kind: 'reasoning' | 'text' | 'tool';
  /** Text for `text` steps; never the reasoning content (only its size). */
  text?: string;
  toolName?: string;
  toolArgsChars?: number;
  toolResultChars?: number;
  ok?: boolean;
  at: number;
}

export interface TurnSpec {
  id?: string;
  soulId: string;
  userId: string;
  sessionId: string;
  turnNo: number;
  startedAt: number;
  endedAt?: number;
  userText: string;
  /** What changed by the end of the turn (decision, artifact, open item). */
  outcome?: string;
  status?: 'open' | 'closed';
  steps: TurnStep[];
  createdAt?: number;
}

/** A turn read back with its steps. */
export interface TurnRecord {
  id: string;
  soulId: string;
  userId: string;
  sessionId: string;
  turnNo: number;
  startedAt: number;
  endedAt?: number;
  userText: string;
  /** Concatenated text steps, kept for search and back-compat. */
  assistantText: string;
  outcome?: string;
  status: 'open' | 'closed';
  steps: TurnStep[];
  createdAt: number;
}

/**
 * Exhaustive fetch (ADR 0027 + eval-boundary-0027): for questions whose answer
 * is a count or an overview, ranking is the wrong tool — the caller needs every
 * row that matches, and the model does the counting.
 */
export interface TurnFindSpec {
  soulId: string;
  userId: string;
  /** Substring over user and assistant text. No tokenizer, no ranking. */
  text?: string;
  sessionId?: string;
  since?: number;
  until?: number;
  /** Hard cap, so a broad filter cannot return the whole history. */
  limit?: number;
}

export interface TurnFindResult {
  turns: TurnPair[];
  /** How many rows match, before the cap. */
  total: number;
  /** True when `total` exceeded the cap. */
  truncated: boolean;
}

/* ------------------------------------------------------------------ *
 * Entities, facts, slots, gaps (spec/model.v0.md)
 *
 * A fact is the connection between things; a slot is one of its ends. Slots
 * hold an entity, a number, a piece of text, or another fact — the last one is
 * how replies and causes stay connected without a new table.
 * ------------------------------------------------------------------ */

export type EntityType = 'person' | 'thing' | 'place' | 'self';

export interface Entity {
  id: string;
  soulId: string;
  userId: string;
  /** person / thing / place / self. `self` is the soul itself. */
  type: EntityType;
  name: string;
  aliases: string[];
  /** Open container: whatever the events taught us, no fixed columns (0010 §8). */
  attrs: Record<string, unknown>;
  firstSeenAt: number;
  lastMentionedAt: number;
  createdAt: number;
}

export interface EntitySpec {
  id?: string;
  soulId: string;
  userId: string;
  type: EntityType;
  name: string;
  aliases?: string[];
  attrs?: Record<string, unknown>;
  /** When it was mentioned; defaults to now. Updates lastMentionedAt. */
  seenAt?: number;
}

export interface EntityQuery {
  soulId: string;
  userId: string;
  /** Substring over name and aliases. */
  name?: string;
  type?: EntityType;
  limit?: number;
}

/* ------------------------------------------------------------------ *
 * Extraction drafts (extract.ts): candidates, not writes
 * ------------------------------------------------------------------ */

export interface EntityDraft {
  name: string;
  type: EntityType;
  aliases?: string[];
  attrs?: Record<string, unknown>;
}

/** A slot as drafted: it can name an entity that may not exist yet. */
export type DraftSlotValue =
  | { kind: 'entity'; entityName: string; entityType?: EntityType }
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string };

export interface FactDraft {
  statement: string;
  typeName?: string;
  at?: number;
  atText?: string;
  source: FactSource;
  confidence: number;
  slots: Array<{ slot: string; value: DraftSlotValue }>;
}

export interface GapDraft {
  topic: string;
  aboutEntityName?: string;
  tension: number;
}

/** What the model decided to do with one piece of information. */
export type FactOpKind = 'add' | 'supersede' | 'update' | 'noop';

export interface FactOperation {
  op: FactOpKind;
  /** The existing fact this operation acts on (supersede / update). */
  targetId?: string;
  fact: FactDraft;
}

export interface ExtractDraft {
  entities: EntityDraft[];
  facts: FactDraft[];
  /** Model output: operations instead of raw facts, so merging is explicit. */
  operations?: FactOperation[];
  gaps: GapDraft[];
  by: 'rules' | 'llm';
  /** Why the rules path was used, so a silent fallback cannot hide. */
  reason?: string;
  /** Which topic thread this turn belongs to, when the model said. */
  thread?: ThreadAttribution;
}

/**
 * Where a turn belongs. continue must name a thread the model was shown;
 * anything unparseable or unknown degrades to a new thread, because a wrong split
 * leaves fragments while a wrong merge poisons a conclusion.
 */
export type ThreadAttribution = { kind: 'continue'; id: string } | { kind: 'new'; topic?: string };

/** What a commit actually created or merged. */
export interface CommitResult {
  entities: Entity[];
  facts: Fact[];
  gaps: Gap[];
  /** Drafts refused by the gate, with the reason. */
  skipped: Array<{ what: string; reason: string }>;
}

export type SlotValue =
  | { kind: 'entity'; entityId: string }
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'fact'; factId: string };

/** One named end of a fact, e.g. `离职者` → 小林, `裁员人数` → 300. */
export interface FactSlot {
  slot: string;
  value: SlotValue;
}

export type FactStatus = 'open' | 'kept' | 'broken' | 'superseded' | 'none';
export type FactSource = 'experienced' | 'told' | 'inferred';

export interface Fact {
  id: string;
  soulId: string;
  userId: string;
  statement: string;
  /** Free text ("裁员" / "道歉" / "请求"); code never branches on it. */
  typeName?: string;
  /** Where it holds: `world`, `self`, or an entity id (in someone's mind). */
  holder: string;
  /** Event time. Optional: a preference is a standing fact without one. */
  at?: number;
  /** The fuzzy time expression as said ("上周三"), when `at` is approximate. */
  atText?: string;
  atEnd?: number;
  placeId?: string;
  status: FactStatus;
  confidence: number;
  source: FactSource;
  sourceTurnId?: string;
  supersededBy?: string;
  createdAt: number;
  slots: FactSlot[];
}

export interface FactSpec {
  id?: string;
  soulId: string;
  userId: string;
  statement: string;
  typeName?: string;
  holder?: string;
  at?: number;
  atText?: string;
  atEnd?: number;
  placeId?: string;
  status?: FactStatus;
  confidence?: number;
  source?: FactSource;
  sourceTurnId?: string;
  supersededBy?: string;
  slots?: FactSlot[];
}

/**
 * One fact plus the conversation it came from: the memory's hook on top, the
 * detail underneath. The model reads hooks first and asks for this only when it
 * needs the original words.
 */
export interface FactDetail {
  fact: Fact;
  turn?: { id: string; userText: string; assistantText: string; at: number };
}

export interface FactQuery {
  soulId: string;
  userId: string;
  /** Only facts that have a slot pointing at this entity. */
  entityId?: string;
  since?: number;
  until?: number;
  status?: FactStatus;
  /** Only facts whose holder is this (world / self / entity id). */
  holder?: string;
  /** Sort by event time. Default desc (newest first); asc gives the earliest. */
  order?: 'asc' | 'desc';
  limit?: number;
}

export type GapStatus = 'open' | 'closed' | 'dropped';

/** Something the soul wants to know and does not (0009 §4.6.1). */
export interface Gap {
  id: string;
  soulId: string;
  userId: string;
  aboutEntityId?: string;
  aboutFactId?: string;
  topic: string;
  /** Grows with time; the highest one is the one worth asking about. */
  tension: number;
  status: GapStatus;
  openedAt: number;
  closedAt?: number;
  closedByFactId?: string;
}

export interface GapSpec {
  id?: string;
  soulId: string;
  userId: string;
  aboutEntityId?: string;
  aboutFactId?: string;
  topic: string;
  tension?: number;
  status?: GapStatus;
  openedAt?: number;
  closedAt?: number;
  closedByFactId?: string;
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
  /** Include the identity block. Defaults to true. */
  includeSoul?: boolean;
  /** Include the style block. Defaults to true. */
  includeStyle?: boolean;
  /**
   * Include the anchor memories block. Defaults to true.
   *
   * Hosts put this in the system prompt, which DSH appends as a new prompt
   * version whenever the text changes; anchors drift as recency shifts, so a
   * long session accumulates versions. Passing false keeps the stable part only.
   */
  includeAnchors?: boolean;
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
  /**
   * What the optional model did, kept apart from `extractedBy` because a null
   * answer and a broken answer used to look identical in the logs.
   */
  llmOutcome: 'off' | 'skipped-rules' | 'skipped-long' | 'stored' | 'null' | 'failed';
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


/**
 * One conclusion the model proposes. `evidence` holds fact ids: the gate refuses
 * anything citing fewer than two, because one observation is a fact, not a
 * conclusion.
 */
export interface ConclusionDraft {
  statement: string;
  evidence: string[];
  confidence: number;
  /** Old conclusion this replaces, when the new evidence contradicts it. */
  supersedes?: string;
  /** The evidence text, used only to tell quoting from over-generalising. */
  evidenceText?: string;
}
/**
 * A topic thread: the unit of "understanding" a conversation.
 *
 * Deliberately not a contiguous segment — a conversation interleaves (A B A),
 * and a segment model would cut A in half. A thread's turns need not be adjacent.
 */
export interface TurnThread {
  id: string;
  soulId: string;
  userId: string;
  sessionId: string;
  topic: string;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt?: number;
  /** Last turn number seen in this thread; used to order candidates. */
  lastTurnNo?: number;
  /** The conclusion written when the thread closed. */
  summaryFactId?: string;
}

export interface ThreadSpec {
  id?: string;
  soulId: string;
  userId: string;
  sessionId: string;
  topic: string;
  openedAt: number;
  turnNo?: number;
}