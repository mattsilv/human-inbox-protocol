import type { Store } from "../store/index.js";
import type { Db } from "../store/db.js";
import { newId } from "../store/index.js";
import type { Decision, DecisionOption, Resolution, HipEvent, Priority, Execution } from "../types.js";
import { validation, conflict, notFound } from "./errors.js";
import { requireActor } from "./util.js";

export interface CreateDecisionInput {
  task?: string | null;
  prompt: string;
  options?: DecisionOption[];
  allowFreeText?: boolean;
  allowChat?: boolean;
  priority?: Priority;
  expiresAt?: string | null;
  kind?: Decision["kind"];
  _meta?: Record<string, unknown>;
}

export function createDecision(store: Store, input: CreateDecisionInput, actorId: string): Decision {
  requireActor(actorId);
  if (!input.prompt) throw validation("decision.prompt is required");
  const now = store.nowIso();
  const d: Decision = {
    id: newId("decision"),
    prompt: input.prompt,
    allowFreeText: input.allowFreeText ?? true,
    allowChat: input.allowChat ?? false,
    resolution: null,
    createdAt: now,
    updatedAt: now,
  };
  if (input.task) d.task = input.task;
  if (input.options) d.options = input.options;
  if (input.priority) d.priority = input.priority;
  if (input.expiresAt !== undefined) d.expiresAt = input.expiresAt;
  if (input.kind) d.kind = input.kind;
  if (input._meta) d._meta = input._meta;

  store.writeObjects(
    [{ type: "decision", obj: d as unknown as Record<string, unknown> }],
    [decisionEvent(store, d.id, d.task ?? null, actorId, "created", { kind: d.kind })],
  );
  return d;
}

export function getDecision(store: Store, id: string): Decision | null {
  const d = store.getDecision(id);
  if (!d) return null;
  return applyExpiry(store, d) ?? d;
}

/** Pending decisions for the inbox: unresolved, not snoozed; lazily expires overdue ones. */
export function listPendingDecisions(store: Store): Decision[] {
  const out: Decision[] = [];
  for (const d of store.listPendingDecisions()) {
    const expired = applyExpiry(store, d);
    if (!expired) out.push(d); // still pending
  }
  return out;
}

/**
 * Resolve a decision (option | freeText | dismissed). Idempotency: re-resolving a
 * resolved decision is a conflict, never a duplicate event. If an execution is
 * blocked on this decision, resolving it clears the block (input-required → working)
 * in the same commit — this is what resumes a `task_block`.
 */
export function resolveDecision(
  store: Store,
  id: string,
  resolution: { kind: Resolution["kind"]; optionId?: string; freeText?: string },
  actorId: string,
): Decision {
  requireActor(actorId);
  const fresh = store.loadDecision(id);
  if (!fresh) throw notFound(`decision ${id} not found`);
  const d = fresh.obj;
  if (d.resolution) throw conflict(`decision ${id} is already resolved (${d.resolution.kind})`);

  if (resolution.kind === "option") {
    if (!resolution.optionId) throw validation("optionId required for option resolution");
    if (!(d.options ?? []).some((o) => o.id === resolution.optionId)) {
      throw validation(`unknown optionId "${resolution.optionId}"`);
    }
  }
  if (resolution.kind === "freeText" && !resolution.freeText) {
    throw validation("freeText required for freeText resolution");
  }

  const now = store.nowIso();
  const res: Resolution = { kind: resolution.kind, at: now, actor: actorId };
  if (resolution.optionId !== undefined) res.optionId = resolution.optionId;
  if (resolution.freeText !== undefined) res.freeText = resolution.freeText;
  d.resolution = res;
  d.updatedAt = now;

  const events: HipEvent[] = [];
  if (store.externalEditDetected("decision", id, fresh.hash)) {
    events.push(decisionEvent(store, id, d.task ?? null, actorId, "external-edit", {}));
  }
  events.push(decisionEvent(store, id, d.task ?? null, actorId, "decision-resolved", { kind: res.kind }));

  // Cross-object: resume any execution blocked on this decision.
  const exe = store.getExecutionBlockedOn(id);
  const extraDerive = exe
    ? (db: Db) => {
        exe.blockedOn = null;
        exe.status = "working";
        exe.updatedAt = now;
        store.upsertExecution(db, exe);
      }
    : undefined;
  if (exe) events.push(decisionEvent(store, null, d.task ?? null, actorId, "execution-updated", { execution: exe.id, resumed: true }));

  store.writeObjects(
    [{ type: "decision", obj: d as unknown as Record<string, unknown> }],
    events,
    extraDerive,
  );
  return d;
}

export function dismissDecision(store: Store, id: string, actorId: string): Decision {
  return resolveDecision(store, id, { kind: "dismissed" }, actorId);
}

/**
 * Inverse of `resolveDecision`: clear a decision's `resolution` AND `snoozedUntil` so it
 * returns to the inbox (pending), and — where resolve had resumed a blocked execution —
 * re-block that execution (`working → input-required`, `blockedOn` restored) in the same
 * commit. No-op on an already-open decision. Re-block is best-effort: it targets the single
 * `working` execution on the decision's task; a task-less decision, or one whose execution
 * already moved on, reopens with no execution change (never fails on a missing execution).
 */
export function reopenDecision(store: Store, id: string, actorId: string): Decision {
  requireActor(actorId);
  const fresh = store.loadDecision(id);
  if (!fresh) throw notFound(`decision ${id} not found`);
  const d = fresh.obj;
  if (!d.resolution && !d.snoozedUntil) return d; // already open — idempotent no-op

  const wasResolved = Boolean(d.resolution);
  const now = store.nowIso();
  d.resolution = null;
  d.snoozedUntil = null;
  d.updatedAt = now;

  const events: HipEvent[] = [
    decisionEvent(store, id, d.task ?? null, actorId, "commented", { reopened: true }),
  ];

  // Re-block the execution that resolve resumed (best-effort): the single `working` one
  // on the task. Only resolved (not merely snoozed) decisions ever resumed an execution.
  const exe: Execution | undefined =
    wasResolved && d.task
      ? store.listExecutionsByTask(d.task).find((e) => e.status === "working")
      : undefined;
  const extraDerive = exe
    ? (db: Db) => {
        exe.blockedOn = id;
        exe.status = "input-required";
        exe.updatedAt = now;
        store.upsertExecution(db, exe);
      }
    : undefined;
  if (exe) {
    events.push(decisionEvent(store, null, d.task ?? null, actorId, "execution-updated", { execution: exe.id, reblocked: true }));
  }

  store.writeObjects(
    [{ type: "decision", obj: d as unknown as Record<string, unknown> }],
    events,
    extraDerive,
  );
  return d;
}

/** snooze is non-terminal — delays re-delivery until `until`, does not resolve. */
export function snoozeDecision(store: Store, id: string, until: string, actorId: string): Decision {
  const fresh = store.loadDecision(id);
  if (!fresh) throw notFound(`decision ${id} not found`);
  const d = fresh.obj;
  if (d.resolution) throw conflict(`decision ${id} is already resolved`);
  if (Number.isNaN(Date.parse(until))) throw validation("snooze 'until' must be an ISO timestamp");
  d.snoozedUntil = until;
  d.updatedAt = store.nowIso();
  store.writeObjects(
    [{ type: "decision", obj: d as unknown as Record<string, unknown> }],
    [decisionEvent(store, id, d.task ?? null, actorId, "commented", { snoozedUntil: until })],
  );
  return d;
}

// ---- expiry ---------------------------------------------------------------

/**
 * If a decision is unresolved and past `expiresAt`, resolve it as `expired` and
 * persist (the learning substrate keeps it; expiry is never silent deletion).
 * Returns the expired decision, or null if no change.
 */
export function applyExpiry(store: Store, d: Decision): Decision | null {
  if (d.resolution || !d.expiresAt) return null;
  if (store.clock.now() <= Date.parse(d.expiresAt)) return null;
  const now = store.nowIso();
  d.resolution = { kind: "expired", at: now };
  d.updatedAt = now;
  store.writeObjects(
    [{ type: "decision", obj: d as unknown as Record<string, unknown> }],
    [decisionEvent(store, d.id, d.task ?? null, "act_system", "decision-resolved", { kind: "expired" })],
  );
  return d;
}

// ---- helpers --------------------------------------------------------------

export function decisionEvent(
  store: Store,
  decisionId: string | null,
  taskId: string | null,
  actorId: string,
  kind: HipEvent["kind"],
  payload?: Record<string, unknown>,
): HipEvent {
  const e: HipEvent = {
    id: newId("event"),
    decision: decisionId,
    task: taskId,
    actor: actorId,
    kind,
    at: store.nowIso(),
  };
  if (payload) e.payload = payload;
  return e;
}
