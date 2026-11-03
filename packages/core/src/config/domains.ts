/**
 * Value domains that both the code and the model must agree on — data only.
 *
 * ADR 0027 splits work by *who decides*: the model decides meaning, the code decides
 * shape. The failures that motivated this file were all shape decisions the code made
 * on the model's behalf: a slot value that "looks like a name" became an entity, an
 * entity without a type defaulted to `person`, and the same holder column carried both
 * keywords and entity ids.
 *
 * Rules that come from this file (checked by health-check §12):
 *   1. A domain's values are listed here once; other modules import them.
 *   2. No semantic field may have a default value in code — a default *is* a decision,
 *      and decisions belong to the model or to the caller.
 *   3. A slot value becomes an entity reference only when it is explicitly marked with
 *      SLOT_ENTITY_MARKER. Syntax never implies semantics.
 *
 * Keep this module free of functions: it is rendered into prompts and compared against
 * live data, so it must stay inert.
 */

/** What an entity can be. The same set the store accepts. */
export const ENTITY_TYPES = ['person', 'thing', 'place', 'self'] as const;

/** `holder` either names a layer or points at the entity whose mind holds the fact. */
export const HOLDER_WORDS = ['world', 'self'] as const;

/** A slot value is text unless it starts with this marker. */
export const SLOT_ENTITY_MARKER = '@';

/**
 * What a fact is *for* — chosen by the model from a closed set.
 *
 * `type_name` stays free text ("裁员", "BOM 教训"); this field is the structural answer to
 * "which consumer reads it", so code no longer routes by matching a Chinese label:
 *   observation → retrieval
 *   judgment    → retrieval + profile input
 *   rule        → injected when its trigger fires
 *   profile     → injected every turn (after merge)
 *   promise     → commitment tracking
 *   lesson      → rule candidate / anchor
 */
export const FACT_ROLES = ['observation', 'judgment', 'rule', 'profile', 'promise', 'lesson'] as const;

/**
 * Where a fact is in its life — written by code, never by the model.
 *
 * `raw` is the exchange itself (turns), `candidate` is held but not injected, `active` is in
 * use, `retracted` is kept for the record and read by nothing. `superseded` was the old name
 * for `retracted`; the migration maps it.
 */
export const FACT_STATES = ['raw', 'candidate', 'active', 'retracted'] as const;

/** Old status values → new ones. Kept here so the migration and the reader agree. */
export const FACT_STATE_MIGRATION = {
  none: 'active',
  open: 'active',
  kept: 'active',
  broken: 'retracted',
  superseded: 'retracted',
} as const;
