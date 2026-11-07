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
// Memory lifecycle lives in config/status.ts too (the legacy layer uses the same word).
export type { MemoryStatus } from './config/status.ts';
import type { MemoryStatus } from './config/status.ts';

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

/** One step of a turn, flattened for the archive. */
export interface PortableStep extends TurnStep {
  turnId: string;
}

/** Everything the portable bundle needs, scoped to one soul/user. */
export interface PortableDump {
  entities: Entity[];
  facts: Fact[];
  threads: TurnThread[];
  gaps: Gap[];
  turns: TurnPair[];
  steps: PortableStep[];
  corrections: Correction[];
}

/** The three layers of the portability contract (spec/vocabulary.v1 §7). */
export interface PortableBundle {
  schemaVersion: number;
  exportedAt: number;
  soulId: string;
  userId: string;
  /** Human-readable: rules, profile, conclusions, promises, entities, open gaps. */
  summary: string;
  /** What the model would see right now. */
  injection: string;
  /** One JSON object per line, including raw turns — the source of truth. */
  archive: string[];
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

export type EntityType = (typeof ENTITY_TYPES)[number];

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
  /**
   * Which turn of the thread this fact came from (1-based, as the prompt numbers them).
   * Provenance for a thread-level extraction: a fact synthesising several turns still
   * names the turn a reader can go back to. Absent = the last turn of the thread.
   */
  sourceTurnNo?: number;
  /** Structured role, chosen by the model (config/domains.ts FACT_ROLES). */
  role?: FactRole;
  /** world or a person's name — where the fact holds (ADR 0032). */
  holder?: string;
  typeName?: string;
  /** When the content starts to hold. The model decides it (brief 0027). */
  validFrom?: number;
  /** The words the time was said in ("上周三"), kept as evidence. */
  validFromText?: string;
  validFromPrecision?: AtPrecision;
  /** When the content stops holding; absent means it still holds (brief 0027). */
  validTo?: number;
  source: FactSource;
  confidence: number;
  /**
   * The model's yes/no answer to "is this an experience about how to work?".
   *
   * A classification input, not a score: the promotion rules (brief 0023) read it to
   * decide whether the experience may be promoted to a rule or a profile line.
   * Absent means no — a wrongly promoted lesson is worse than an unrecorded one.
   */
  principle?: boolean;
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
  /**
   * Candidates the extractor dropped, with the reason.
   *
   * A drop is a decision. Without this list "the sentence was forgettable" and "the
   * extractor ignored it" look identical in every log and every metric (rule 18).
   */
  skipped?: Array<{ what: string; reason: string }>;
  /**
   * Which thread each span of this unit belongs to, when the model said (0028 ③).
   *
   * One segment can hold two topics, so the answer is a list of runs, not a single
   * thread. An absent list is not "no opinion": the caller falls back per turn
   * (ADR 0034), which is the same chain a single-turn extraction has always used.
   */
  spans?: ThreadSpan[];
  /**
   * What the model's thread line was: a usable answer, absent, or present but
   * unparseable. Without this the fallback rate is inferred from behaviour instead of
   * measured, and "the model stopped answering" looks identical to "the model chose
   * to continue".
   */
  threadLine?: 'present' | 'absent' | 'invalid';
}

/**
 * Where a turn belongs. `continue` must name a thread the model was shown; it may also
 * carry a new topic when the subject has moved inside the same thread.
 *
 * An unparseable or unknown answer is not evidence for a new topic: the caller falls
 * back to the previous turn's thread (ADR 0034), because a wrong split leaves fragments
 * that starve consolidation while a wrong merge can be split later.
 */
export type ThreadAttribution =
  | { kind: 'continue'; id: string; topic?: string }
  | { kind: 'new'; topic?: string };

/**
 * A run of consecutive turns of one extracted unit that belongs to one thread.
 *
 * `from`/`to` are the prompt's numbering inside the unit (1..n), not host turn
 * numbers — the model only ever sees the prompt's numbering. `to` omitted means
 * "through the last turn", which is exactly what a single line without a range
 * produces: the shape a single-topic segment has always had.
 */
export interface ThreadSpan {
  from: number;
  to?: number;
  attribution: ThreadAttribution;
}

/** What a commit actually created or merged. */
export interface CommitResult {
  entities: Entity[];
  facts: Fact[];
  gaps: Gap[];
  /** Drafts refused outright: unreadable statements and exact duplicates. */
  skipped: Array<{ what: string; reason: string }>;
  /**
   * Slots that named something undeclared: the words are kept as text and no entity
   * is created. Recorded so degradation is visible instead of silent.
   */
  droppedSlots: Array<{ fact: string; slot: string; value: string }>;
  /** Holders that were not known: the fact stays, in the world layer. */
  holderFallbacks: Array<{ fact: string; holder: string }>;
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

// Vocabulary is declared in config/ and only referenced here: one declaration point,
// so a status rename cannot leave an old copy behind in another filter. Entity types and
// the holder vocabulary live in config/domains.ts for the same reason.
export type { FactStatus, FactSource, AtPrecision } from './config/status.ts';
import type { FactStatus, FactSource, AtPrecision } from './config/status.ts';
import { ENTITY_TYPES } from './config/domains.ts';

/** One of FACT_ROLES; declared with the values so the two cannot drift. */
export type FactRole = (typeof import('./config/domains.ts').FACT_ROLES)[number];

export interface Fact {
  id: string;
  soulId: string;
  userId: string;
  statement: string;
  /** Free text ("裁员" / "道歉" / "请求"); code never branches on it. */
  typeName?: string;
  /**
   * What the fact is *for* (closed set in config/domains.ts). Optional during the transition:
   * older rows have no role, and readers fall back to typeName through `roleOf()`.
   */
  role?: FactRole;
  /** Where it holds: `world`, `self`, or an entity id (in someone's mind). */
  holder: string;
  /**
   * When this content starts to hold (brief 0027). The model decides it: an event's
   * occurrence, a state's beginning, the day a claim was made. Absent when the model
   * could not place it — that is a value, not a gap to be filled by the code.
   */
  validFrom?: number;
  /** The fuzzy time expression as said ("上周三"), kept as evidence. */
  validFromText?: string;
  /** Locatability, not precision: unknown is a value (ADR 0032). */
  validFromPrecision?: AtPrecision;
  /** When it stopped holding; undefined means it still holds. */
  validTo?: number;
  placeId?: string;
  status: FactStatus;
  confidence: number;
  source: FactSource;
  sourceTurnId?: string;
  supersededBy?: string;
  createdAt: number;
  /** How many times retrieval has surfaced it. Decay slows with use (0019). */
  recallCount: number;
  /** Last time retrieval surfaced it. */
  lastRecalledAt?: number;
  slots: FactSlot[];
}

// How exactly a fact is located in time (ADR 0032) — declared in config/status.ts.

export interface FactSpec {
  id?: string;
  soulId: string;
  userId: string;
  statement: string;
  typeName?: string;
  /** Structural role (config/domains.ts FACT_ROLES); the writer derives it if omitted. */
  role?: FactRole;
  holder?: string;
  /** When the content starts to hold; the model supplies it (brief 0027). */
  validFrom?: number;
  validFromText?: string;
  validFromPrecision?: AtPrecision;
  /** When it stops holding; absent means it still holds. */
  validTo?: number;
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
  /** Lower bound on `valid_from`, inclusive. */
  since?: number;
  /** Upper bound on `valid_from`, exclusive: a window's end is the next window's start. */
  until?: number;
  /**
   * Only these `valid_from_precision` values. A time-window query passes the
   * declared WINDOW_PRECISIONS; `relative` / `unknown` must never enter a range.
   */
  precisions?: readonly AtPrecision[];
  status?: FactStatus;
  /** Only facts whose role is this (config/domains.ts FACT_ROLES). */
  role?: FactRole;
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
   * Include the affect block. Defaults to true.
   *
   * Same reason as includeStyle: the affect sample changes almost every turn, so a
   * host that puts context() output into a stable system prompt must exclude it —
   * otherwise every turn appends a new prompt version. Affects belong in the
   * per-turn message channel, which is where the adapter puts them.
   */
  includeAffect?: boolean;
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