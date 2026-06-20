import type { Store } from "../store/index.js";
import { newId } from "../store/index.js";
import type { Execution, ExecutionStatus, Decision, HipEvent } from "../types.js";
import { validation, notFound, conflict } from "./errors.js";
import { requireActor } from "./util.js";
import { decisionEvent } from "./decisions.js";
import { payloadHash, resolveCreationKey } from "./idempotency.js";

export interface RegisterExecutionInput {
  task: string;
  actor: string;
  runtime?: { system: string; externalId?: string };
  status?: ExecutionStatus;
  expectedNextHeartbeatAt?: string;
  /** Optional client idempotency key: a retried register with the same key returns the original execution. */
  clientKey?: string;
}

export function registerExecution(store: Store, input: RegisterExecutionInput, actorId: string): Execution {
  requireActor(actorId);
  if (!store.getTask(input.task)) throw notFound(`task ${input.task} not found`);

  // Idempotency (KTD4): a retried register with the same clientKey + payload returns the
  // original execution; a same-key-different-payload reuse throws conflict.
  let keyHash: string | undefined;
  if (input.clientKey) {
    const payload = { ...input };
    delete payload.clientKey;
    keyHash = payloadHash(payload);
    const existingId = resolveCreationKey(store, actorId, input.clientKey, keyHash, "execution");
    if (existingId) {
      const existing = store.getExecution(existingId);
      if (existing) return existing; // short-circuit: no second write
    }
  }

  const now = store.nowIso();
  const exe: Execution = {
    id: newId("execution"),
    task: input.task,
    actor: input.actor,
    status: input.status ?? "working",
    blockedOn: null,
    createdAt: now,
    updatedAt: now,
  };
  if (input.runtime) exe.runtime = input.runtime;
  if (input.expectedNextHeartbeatAt) exe.expectedNextHeartbeatAt = input.expectedNextHeartbeatAt;

  store.commit({
    files: [],
    events: [execEvent(store, exe, actorId, "execution-registered")],
    derive: (db) => {
      store.upsertExecution(db, exe);
      if (input.clientKey) store.putCreationKey(db, actorId, input.clientKey, "execution", exe.id, keyHash!);
    },
  });
  return exe;
}

export function getExecution(store: Store, id: string): Execution | null {
  return store.getExecution(id);
}

/** Liveness ping — records heartbeat fields without flooding the event log. */
export function heartbeat(store: Store, id: string, expectedNextHeartbeatAt?: string): Execution {
  const exe = store.getExecution(id);
  if (!exe) throw notFound(`execution ${id} not found`);
  const now = store.nowIso();
  exe.lastHeartbeatAt = now;
  if (expectedNextHeartbeatAt) exe.expectedNextHeartbeatAt = expectedNextHeartbeatAt;
  exe.updatedAt = now;
  store.commit({ files: [], events: [], derive: (db) => store.upsertExecution(db, exe) });
  return exe;
}

export function setExecutionStatus(
  store: Store,
  id: string,
  status: ExecutionStatus,
  actorId: string,
): Execution {
  const exe = store.getExecution(id);
  if (!exe) throw notFound(`execution ${id} not found`);
  if (status === "input-required") {
    throw validation("use task_block to move an execution to input-required");
  }
  exe.status = status;
  exe.blockedOn = null; // input-required is excluded above; any other status clears the block
  exe.updatedAt = store.nowIso();
  store.commit({
    files: [],
    events: [execEvent(store, exe, actorId, "execution-updated", { status })],
    derive: (db) => store.upsertExecution(db, exe),
  });
  return exe;
}

/**
 * task_block: the calling execution pauses on a human decision. Files a decision
 * (kind:block) linked to the task and points the execution's `blockedOn` at it,
 * status → input-required — all in one commit. Resolving that decision (U6/CLI)
 * clears the block and resumes the execution. The two-state-machines rule holds:
 * the task's own status is untouched; only the execution pauses.
 */
export function block(
  store: Store,
  input: { task: string; execution: string; reason: string; options?: Decision["options"] },
  actorId: string,
): { decision: Decision; execution: Execution } {
  requireActor(actorId);
  if (!store.getTask(input.task)) throw notFound(`task ${input.task} not found`);
  const exe = store.getExecution(input.execution);
  if (!exe) throw notFound(`execution ${input.execution} not found`);
  if (exe.status === "input-required") throw conflict(`execution ${exe.id} is already blocked`);
  if (exe.task !== input.task) throw validation("execution does not belong to that task");

  const now = store.nowIso();
  const decision: Decision = {
    id: newId("decision"),
    task: input.task,
    prompt: input.reason,
    allowFreeText: true,
    allowChat: false,
    resolution: null,
    kind: "block",
    createdAt: now,
    updatedAt: now,
  };
  if (input.options) decision.options = input.options;

  exe.blockedOn = decision.id;
  exe.status = "input-required";
  exe.updatedAt = now;

  store.writeObjects(
    [{ type: "decision", obj: decision as unknown as Record<string, unknown> }],
    [
      decisionEvent(store, decision.id, input.task, actorId, "blocked", { execution: exe.id }),
      decisionEvent(store, null, input.task, actorId, "execution-updated", { execution: exe.id, status: "input-required" }),
    ],
    (db) => store.upsertExecution(db, exe),
  );
  return { decision, execution: exe };
}

function execEvent(
  store: Store,
  exe: Execution,
  actorId: string,
  kind: HipEvent["kind"],
  payload?: Record<string, unknown>,
): HipEvent {
  return {
    id: newId("event"),
    task: exe.task,
    actor: actorId,
    kind,
    at: store.nowIso(),
    payload: { execution: exe.id, ...payload },
  };
}
