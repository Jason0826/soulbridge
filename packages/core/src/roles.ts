/**
 * The two decisions every reader used to make for itself, in one place.
 *
 * `role` says what a fact is for; `status` says how far it has come. Both used to be read by
 * matching Chinese type labels and status strings at each call site, which is how one filter
 * ended up admitting retired facts after a rename.
 *
 * This is the contract step: the dual-vocabulary fallback is gone. The migration normalises
 * old rows (none/open/kept → active, broken/superseded → retracted) and the writer always
 * stores a role, so a reader sees exactly one vocabulary.
 */
import type { Fact } from './types.ts';
import { FACT_STATUS } from './config/status.ts';
import type { FactRole } from './types.ts';

/** Rows written before the role column existed cannot appear after the migration. */
export function roleOf(fact: Pick<Fact, 'role'>): FactRole {
  return fact.role ?? 'observation';
}

export function isActive(fact: Pick<Fact, 'status'>): boolean {
  return String(fact.status) === FACT_STATUS.active;
}

export function isRetracted(fact: Pick<Fact, 'status'>): boolean {
  return String(fact.status) === FACT_STATUS.retracted;
}
