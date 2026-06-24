import type { Store } from "./store.js";
import type { Task } from "../types.js";

// The recycling display-id allocator. A short id is a small positive integer leased to
// an *active* (open/waiting) task so a human tracks `#42`, not `tsk_mqmyg7yrqt7pv0`. It
// is display-only: never canonical, never a foreign key, and never written to the
// append-only event log. Freed numbers (terminal tasks) are reused lowest-first, so the
// live set stays small. Single local process + synchronous better-sqlite3 → the
// read-active-set → pick-lowest-gap → write sequence has no race.

/** Lowest positive integer not present in `used`. */
export function lowestFree(used: Iterable<number>): number {
  const set = used instanceof Set ? used : new Set(used);
  let n = 1;
  while (set.has(n)) n++;
  return n;
}

/** The lowest free display number among currently-active tasks. */
export function allocateShortId(store: Store): number {
  return lowestFree(store.activeShortIds());
}

/**
 * One-time-ish repair: give every active task that lacks a display number the lowest
 * free one, deterministically (by createdAt then id), persisting file+index with NO
 * event (R4: display ids never enter the event log). Idempotent — tasks that already
 * carry a shortId keep it, so re-running fills only genuine gaps. Run from reindex so
 * an upgraded store (existing active tasks predate the feature) gets numbered.
 */
export function backfillShortIds(store: Store): number {
  // Read only the active tasks (via the indexed status filter — terminal files are never
  // touched), not every task file on disk.
  const active: Task[] = [...store.listTasks({ status: "open" }), ...store.listTasks({ status: "waiting" })];

  const used = new Set<number>();
  for (const t of active) if (typeof t.shortId === "number") used.add(t.shortId);

  const missing = active
    .filter((t) => typeof t.shortId !== "number")
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
    );

  for (const t of missing) {
    const n = lowestFree(used);
    used.add(n);
    t.shortId = n;
  }

  // One commit for the whole backfill, not one per task. Empty event list: a display-number
  // assignment is not a domain state change (R4).
  if (missing.length) {
    store.writeObjects(
      missing.map((t) => ({ type: "task" as const, obj: t as unknown as Record<string, unknown> })),
      [],
    );
  }
  return missing.length;
}
