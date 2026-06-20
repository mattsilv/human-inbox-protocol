import type { Store } from "../store/index.js";
import { newId } from "../store/index.js";
import type {
  Task,
  TaskStatus,
  Waiting,
  DelegatedBy,
  Reference,
  Priority,
  ThreadEntry,
  HipEvent,
  Execution,
} from "../types.js";
import { validation, stateError } from "./errors.js";
import { mutateMarkdown, requireActor } from "./util.js";
import { maybeCleanDemo } from "./demo-cleanup.js";
import { payloadHash, resolveCreationKey } from "./idempotency.js";

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: Priority;
  nextActionOn?: string;
  watcher?: string;
  due?: string | null;
  place?: string;
  delegatedBy: DelegatedBy;
  references?: Reference[];
  tags?: string[];
  waitingOn?: Waiting;
  _meta?: Record<string, unknown>;
  /** Optional client idempotency key: a retried create with the same key returns the original task. */
  clientKey?: string;
}

// task_update may touch content only; transitions go through dedicated verbs.
const CONTENT_FIELDS = new Set([
  "title",
  "description",
  "priority",
  "nextActionOn",
  "watcher",
  "due",
  "place",
  "references",
  "_meta",
]);

/** Read helper: a task in a terminal state cannot transition further. */
export function isTerminal(task: Task): boolean {
  return task.state.kind === "done" || task.state.kind === "dropped";
}

export function createTask(store: Store, input: CreateTaskInput, actorId: string): Task {
  requireActor(actorId);
  if (!input.title) throw validation("task.title is required");
  if (!input.delegatedBy?.actor) throw validation("task.delegatedBy.actor is required (provenance)");

  // Idempotency (KTD4): a retried create with the same clientKey + payload returns the
  // original task; a same-key-different-payload reuse throws conflict. `clientKey` is
  // excluded from the fingerprint so it does not perturb its own hash.
  let keyHash: string | undefined;
  if (input.clientKey) {
    const payload = { ...input };
    delete payload.clientKey;
    keyHash = payloadHash(payload);
    const existingId = resolveCreationKey(store, actorId, input.clientKey, keyHash, "task");
    if (existingId) {
      const existing = store.getTask(existingId);
      if (existing) return existing; // short-circuit: no second write, no demo re-sweep
    }
  }

  const now = store.nowIso();
  const id = newId("task");
  const waitingOn = input.waitingOn;
  const task: Task = {
    id,
    title: input.title,
    state: waitingOn ? { kind: "waiting", ...normalizeWaiting(waitingOn, now) } : { kind: "open" },
    delegatedBy: input.delegatedBy,
    createdAt: now,
    updatedAt: now,
  };
  if (input.description !== undefined) task.description = input.description;
  if (input.priority) task.priority = input.priority;
  if (input.nextActionOn) task.nextActionOn = input.nextActionOn;
  if (input.watcher) task.watcher = input.watcher;
  if (input.due !== undefined) task.due = input.due;
  if (input.place) task.place = input.place;
  if (input.references) task.references = input.references;
  // De-duplicate tags, preserving first-occurrence order; drop empty to keep the
  // optional-field convention (absent, not []).
  if (input.tags?.length) {
    const tags = [...new Set(input.tags.filter((t) => t))];
    if (tags.length) task.tags = tags;
  }
  if (input._meta) task._meta = input._meta;

  store.writeObjects(
    [{ type: "task", obj: task as unknown as Record<string, unknown> }],
    [event(store, id, actorId, "created", { delegatedBy: input.delegatedBy })],
    input.clientKey
      ? (db) => store.putCreationKey(db, actorId, input.clientKey!, "task", id, keyHash!)
      : undefined,
  );
  // First real task created after a `hip demo` run sweeps the demo seed. Guarded on the
  // demo flag so seeding's own task_create calls never trigger a recursive cleanup.
  if (!input._meta?.demo) maybeCleanDemo(store);
  return task;
}

/** Content-only update. Rejects status/waitingOn/provenance — those have their own verbs. */
export function updateTask(
  store: Store,
  id: string,
  patch: Record<string, unknown>,
  actorId: string,
): Task {
  for (const key of Object.keys(patch)) {
    if (!CONTENT_FIELDS.has(key)) {
      throw validation(`task_update cannot change "${key}" — use a transition verb (task_wait/task_done/task_drop)`);
    }
  }
  return mutateMarkdown<Task>(store, "task", id, actorId, (i) => store.loadTask(i), (t) => {
    Object.assign(t, patch);
    return [event(store, id, actorId, "commented", { fields: Object.keys(patch) })];
  });
}

/** A loose waiting input (zod optionals carry `| undefined`); normalized before storage. */
export type WaitingInput = {
  onActor: string;
  since?: string;
  via?: string;
  cadence?: string | null;
  lastNudge?: string | null;
  _meta?: Record<string, unknown>;
};

/** task_wait: set or clear waitingOn; status follows (waitingOn present iff status == "waiting"). */
export function setWaiting(
  store: Store,
  id: string,
  waitingOn: WaitingInput | null,
  actorId: string,
): Task {
  return mutateMarkdown<Task>(store, "task", id, actorId, (i) => store.loadTask(i), (t) => {
    if (isTerminal(t)) throw stateError(`cannot change waiting on a ${t.state.kind} task`);
    t.state = waitingOn
      ? { kind: "waiting", ...normalizeWaiting(waitingOn, store.nowIso()) }
      : { kind: "open" };
    return [event(store, id, actorId, "status-changed", { to: t.state.kind })];
  });
}

export function markDone(store: Store, id: string, actorId: string): Task {
  return transition(store, id, "done", actorId);
}

export function markDropped(store: Store, id: string, actorId: string): Task {
  return transition(store, id, "dropped", actorId);
}

function transition(store: Store, id: string, to: "done" | "dropped", actorId: string): Task {
  return mutateMarkdown<Task>(store, "task", id, actorId, (i) => store.loadTask(i), (t) => {
    if (t.state.kind === to) throw stateError(`task is already ${to}`);
    if (isTerminal(t)) throw stateError(`task is ${t.state.kind} and cannot transition to ${to}`);
    t.state = { kind: to };
    return [event(store, id, actorId, "status-changed", { to })];
  });
}

/**
 * Append an inbound or human comment to the task thread. Conversation content — kept
 * separate from the event log (the event records that a comment was added). When a
 * reconcile envelope drives the append, `envelopeId` makes it idempotent across a
 * crash/resubmit (the file-layer idempotency key).
 */
export function appendThread(
  store: Store,
  id: string,
  entry: { actor: string; content: string; envelopeId?: string },
  actorId: string,
  eventKind: HipEvent["kind"] = "commented",
): { task: Task; appended: boolean } {
  let appended = false;
  const task = mutateMarkdown<Task>(store, "task", id, actorId, (i) => store.loadTask(i), (t) => {
    if (isTerminal(t) && entry.envelopeId === undefined) {
      // comments allowed on terminal tasks, but reconcile attaches are guarded elsewhere
    }
    const thread = (t.thread ??= []);
    if (entry.envelopeId && thread.some((e) => e.envelopeId === entry.envelopeId)) {
      return []; // idempotent: this envelope already landed in the thread
    }
    const te: ThreadEntry = { actor: entry.actor, content: entry.content, at: store.nowIso() };
    if (entry.envelopeId) te.envelopeId = entry.envelopeId;
    thread.push(te);
    appended = true;
    return [event(store, id, actorId, eventKind, { thread: true })];
  });
  return { task, appended };
}

/**
 * Advance the nudge timer after a fire (or to repair a crashed fire): stamp
 * waitingOn.lastNudge = now, which recomputes next_fire_at to now + cadence on reindex.
 * No-op if the task is no longer waiting. Emits a nudge-fired event.
 */
export function recordNudge(store: Store, id: string, actorId: string): Task | null {
  const fresh = store.loadTask(id);
  if (!fresh) return null;
  const t = fresh.obj;
  if (t.state.kind !== "waiting") return t;
  t.state.lastNudge = store.nowIso();
  t.updatedAt = store.nowIso();
  store.writeObjects(
    [{ type: "task", obj: t as unknown as Record<string, unknown> }],
    [event(store, id, actorId, "nudge-fired", { lastNudge: t.state.lastNudge })],
  );
  return t;
}

/** Orient-first read: everything an agent needs to start work in one call. */
export interface TaskView {
  task: Task;
  executions: Execution[];
  events: HipEvent[];
}

export function orient(store: Store, id: string): TaskView | null {
  const task = store.getTask(id);
  if (!task) return null;
  return {
    task,
    executions: store.listExecutionsByTask(id),
    events: store.events.forTask(id).slice(-50),
  };
}

export function listTasks(store: Store, filter?: { status?: TaskStatus; tag?: string }): Task[] {
  return store.listTasks(filter);
}

// ---- helpers --------------------------------------------------------------

function normalizeWaiting(w: WaitingInput, now: string): Waiting {
  if (!w.onActor) throw validation("waitingOn.onActor is required");
  const out: Waiting = {
    onActor: w.onActor,
    since: w.since ?? now.slice(0, 10),
  };
  if (w.via) out.via = w.via;
  if (w.cadence !== undefined) out.cadence = w.cadence;
  out.lastNudge = w.lastNudge ?? null;
  if (w._meta) out._meta = w._meta;
  return out;
}

function event(
  store: Store,
  taskId: string,
  actorId: string,
  kind: HipEvent["kind"],
  payload?: Record<string, unknown>,
): HipEvent {
  const e: HipEvent = { id: newId("event"), task: taskId, actor: actorId, kind, at: store.nowIso() };
  if (payload) e.payload = payload;
  return e;
}
