/**
 * The two decisions every reader used to make for itself, in one place.
 *
 * During the rebuild the `facts` table changes shape in a way that cannot be flipped at once:
 *   - `role` is a new closed field; old rows have none, and their role lives in the Chinese
 *     `type_name` label;
 *   - `status` moves from none/superseded to raw/candidate/active/retracted, but old rows keep
 *     their old values until the migration runs.
 *
 * If each call site guessed, they would guess differently — the exact failure mode that made
 * "规则/画像/待修" both a type and a state. So: one decoder, used everywhere, written to accept
 * both vocabularies until the fallback is deleted in the contract step.
 */
import type { Fact } from './types.ts';
import { FACT_STATE_MIGRATION, LEGACY_ROLE_BY_TYPE } from './config/domains.ts';
import { FACT_STATUS } from './config/status.ts';
import type { FactRole } from './types.ts';

const LEGACY_ROLES: Record<string, FactRole> = LEGACY_ROLE_BY_TYPE;

/** Old and new status values that mean "this is in use". */
const ACTIVE_STATES = new Set(['active', 'none', 'kept', 'open']);

export function roleOf(fact: Pick<Fact, 'role' | 'typeName'>): FactRole {
  if (fact.role) return fact.role;
  return LEGACY_ROLES[fact.typeName ?? ''] ?? 'observation';
}

export function isActive(fact: Pick<Fact, 'status'>): boolean {
  return ACTIVE_STATES.has(String(fact.status));
}

export function isRetracted(fact: Pick<Fact, 'status'>): boolean {
  const mapped = (FACT_STATE_MIGRATION as Record<string, string>)[String(fact.status)] ?? String(fact.status);
  return mapped === 'retracted' || String(fact.status) === FACT_STATUS.superseded;
}
