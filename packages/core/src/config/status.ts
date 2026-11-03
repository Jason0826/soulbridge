/**
 * Fact lifecycle vocabulary — declared once, imported everywhere.
 *
 * These four replaced none/open/kept/broken/superseded. The older set mixed "what kind of
 * fact" with "how far it has come", so every reader had to remember which values counted as
 * live. The four below are the only ones written now: `raw` is the exchange itself,
 * `candidate` is held but not injected, `active` is in use, `retracted` is kept for the
 * record and read by nothing.
 *
 * Values match the column defaults in sqlite.ts; changing one is a schema migration, not a
 * rename.
 */
export const FACT_STATUS = {
  /** The exchange itself; not a distilled fact. */
  raw: 'raw',
  /** Held, not injected: unverified inference or an unconfirmed rule. */
  candidate: 'candidate',
  /** In use: retrieval, rules, profile, evidence. */
  active: 'active',
  /** Replaced or withdrawn; kept for the audit trail, injected nowhere. */
  retracted: 'retracted',
} as const;

export type FactStatus = (typeof FACT_STATUS)[keyof typeof FACT_STATUS];

/** Where a fact came from, in the trust sense (not a type). */
export const FACT_SOURCE = {
  experienced: 'experienced',
  told: 'told',
  inferred: 'inferred',
} as const;

export type FactSource = (typeof FACT_SOURCE)[keyof typeof FACT_SOURCE];

/** How precise a time is. `unknown` is an honest answer, not a failure. */
export const AT_PRECISION = {
  day: 'day',
  range: 'range',
  relative: 'relative',
  unknown: 'unknown',
} as const;

export type AtPrecision = (typeof AT_PRECISION)[keyof typeof AT_PRECISION];

/**
 * The legacy `memories` layer's lifecycle.
 *
 * It shares the word "superseded" with facts on purpose: one lifecycle concept, one
 * set of values, one declaration. The table retires (see retirements.json), the
 * vocabulary does not fork before it does.
 */
export const MEMORY_STATUS = {
  active: 'active',
  superseded: 'superseded',
  archived: 'archived',
} as const;

export type MemoryStatus = (typeof MEMORY_STATUS)[keyof typeof MEMORY_STATUS];
