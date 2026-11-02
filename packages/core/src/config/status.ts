/**
 * Fact lifecycle vocabulary — declared once, imported everywhere.
 *
 * "superseded" used to be typed out in three files, so renaming it would have left
 * one filter silently admitting retired facts. Config modules hold data only; the
 * decoding (SQL binding, filters, prompts) lives in the code that imports this.
 *
 * Values match the column defaults in sqlite.ts; changing one is a schema migration,
 * not a rename.
 */
export const FACT_STATUS = {
  /** Written, no lifecycle decision yet. */
  none: 'none',
  /** Being worked on (promises, plans). */
  open: 'open',
  /** Held. */
  kept: 'kept',
  /** Broken (a promise that did not happen). */
  broken: 'broken',
  /** Replaced by another fact; kept for the record, never injected. */
  superseded: 'superseded',
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
