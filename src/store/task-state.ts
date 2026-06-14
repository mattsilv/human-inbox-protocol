import type { Task, TaskState, TaskStatus, Waiting, WireTask } from "../types.js";

// The single place the "two flat fields ↔ one union" mapping lives. Lifts a flat
// task (disk read) into the internal union; lowers the union back to flat where a
// flat projection must leave TypeScript (disk write, MCP wire). The SQLite index
// derives its flat columns directly from the union discriminant (indexer.ts) —
// type-safe at the source, so it reads `state` rather than re-lowering. Replacing
// the four hand-maintained "waitingOn present iff status == waiting" sites.

const STATUSES: readonly TaskStatus[] = ["open", "waiting", "done", "dropped"];

function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

/** A waiting payload is usable only if it carries the required `onActor`. */
function isWaitingPayload(v: unknown): v is Waiting {
  return typeof v === "object" && v !== null && typeof (v as { onActor?: unknown }).onActor === "string";
}

/**
 * Flat → union. Trusts `status` as the discriminant (the one spot that absorbs
 * hand-edited or legacy files):
 *   - non-waiting status: drop any stray `waitingOn` payload (illegal pair → kind only).
 *   - `status: "waiting"` with no usable payload: degrade to `open` — the union
 *     forbids a payload-less waiting variant, so it cannot be represented.
 */
export function liftTaskState(wire: WireTask | Record<string, unknown>): Task {
  const { status, waitingOn, ...rest } = wire as Record<string, unknown> & {
    status?: unknown;
    waitingOn?: unknown;
  };
  return { ...rest, state: toState(status, waitingOn) } as Task;
}

function toState(status: unknown, waitingOn: unknown): TaskState {
  const kind = isTaskStatus(status) ? status : "open";
  if (kind === "waiting") {
    return isWaitingPayload(waitingOn) ? { kind: "waiting", ...waitingOn } : { kind: "open" };
  }
  return { kind };
}

/**
 * Union → flat. `status = state.kind`; `waitingOn` carries the payload only for
 * the waiting variant, `null` otherwise (no `state` key crosses the boundary).
 */
export function lowerTaskState(task: Task): WireTask {
  const { state, ...rest } = task;
  if (state.kind === "waiting") {
    const { kind, ...waitingOn } = state;
    return { ...rest, status: kind, waitingOn };
  }
  return { ...rest, status: state.kind, waitingOn: null };
}
