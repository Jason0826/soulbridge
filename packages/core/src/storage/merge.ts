/**
 * Merge semantics for cross-device sync (ADR 0021).
 *
 * Pure functions, no I/O: the transport (folder sync, git, manual export) is
 * someone else's problem; this file only decides who wins.
 *
 * Rule: higher `updatedAt` wins; on a tie the lexicographically larger
 * `device` wins, so merging is deterministic regardless of arrival order.
 */
export interface SyncRecord {
  id: string;
  device: string;
  at: number;
  updatedAt: number;
  deleted?: boolean;
}

export function pickLatest<T extends SyncRecord>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.device >= b.device ? a : b;
}

/** Union by id, keeping tombstones (deletion must survive a merge). */
export function mergeRecords<T extends SyncRecord>(records: Iterable<T>): T[] {
  const byId = new Map<string, T>();
  for (const record of records) {
    const existing = byId.get(record.id);
    byId.set(record.id, existing ? pickLatest(existing, record) : record);
  }
  return [...byId.values()];
}

/** A record is visible only if the winning version is not a tombstone. */
export function isVisible(record: SyncRecord): boolean {
  return record.deleted !== true;
}

export function liveRecords<T extends SyncRecord>(records: Iterable<T>): T[] {
  return mergeRecords(records).filter(isVisible);
}
