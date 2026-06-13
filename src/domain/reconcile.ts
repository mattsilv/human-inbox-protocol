import type { Store } from "../store/index.js";
import { newId, contentHash } from "../store/index.js";
import { Domain } from "./index.js";
import type { InboundEnvelope, ReconcileResult, Task, HipEvent } from "../types.js";
import { validation, conflict, notFound, stateError } from "./errors.js";

const TERMINAL = new Set(["done", "dropped"]);

/**
 * Map an inbound envelope to a task via deterministic tiers, then attach silently or
 * escalate a one-tap decision. No LLM in the daemon. Idempotency is the SQLite
 * envelope ledger (write-once): a processed envelope returns its original verdict; the
 * file-layer guard is the envelope id echoed into the task thread, so a crash between
 * the thread append and the ledger write converges on resubmit (re-read, skip if the
 * id already landed).
 */
export function reconcile(
  store: Store,
  env: InboundEnvelope,
  actorId: string,
): ReconcileResult {
  if (!env.id) throw validation("envelope id is required (idempotency key)");
  if (!env.content && env.content !== "") throw validation("envelope content is required");

  // Idempotency: replay a processed envelope; reject a same-id-different-content reuse.
  const prior = store.getEnvelope(env.id);
  if (prior) {
    if (prior.contentHash !== contentHash(env.content ?? "")) {
      throw conflict(`envelope ${env.id} already processed with different content`);
    }
    return prior.result;
  }

  const domain = new Domain(store);

  // File-layer idempotency: if this envelope already landed in a task thread (e.g. the
  // ledger write was lost to a crash after the attach), re-converge on that attach
  // instead of re-classifying against now-changed state. Backfill the ledger.
  const landed = store.findTaskIdByThreadEnvelope(env.id);
  if (landed) {
    const result: ReconcileResult = {
      input: env.id,
      verdict: "attached",
      task: landed,
      matchedEntity: null,
    };
    store.commit({ files: [], events: [], derive: (db) => store.putEnvelope(db, env, result) });
    return result;
  }
  const sender = resolveSender(store, env);
  const result = classify(store, domain, env, sender, actorId);

  // Ledger write is its own commit; INSERT OR IGNORE keeps resubmit idempotent.
  store.commit({ files: [], events: [], derive: (db) => store.putEnvelope(db, env, result) });
  return result;
}

function classify(
  store: Store,
  domain: Domain,
  env: InboundEnvelope,
  sender: string | null,
  actorId: string,
): ReconcileResult {
  // Tier 1 — reference globalId points at an existing task.
  if (env.reference?.globalId) {
    const ids = liveTasks(store, store.findTaskIdsByGlobalId(env.reference.globalId));
    if (ids.length === 1) return attach(store, ids[0]!, env, sender, actorId);
    if (ids.length > 1) return escalate(store, domain, env, ids, actorId);
  }

  // Tier 2 — resolved sender is the unique waiting.onActor.
  if (sender) {
    const ids = liveTasks(store, store.findWaitingTaskIdsByActor(sender));
    if (ids.length === 1) return attach(store, ids[0]!, env, sender, actorId);
    if (ids.length > 1) return escalate(store, domain, env, ids, actorId);
  }

  // Tier 3 — entity alias resolves an unknown sender to a linked actor, then re-match.
  if (!sender) {
    const actor = actorFromEntityAlias(store, env.from);
    if (actor) {
      const ids = liveTasks(store, store.findWaitingTaskIdsByActor(actor));
      if (ids.length === 1) return attach(store, ids[0]!, env, actor, actorId);
      if (ids.length > 1) return escalate(store, domain, env, ids, actorId);
    }
  }

  // No confident match → escalate with whatever candidates we can offer (possibly none).
  return escalate(store, domain, env, [], actorId);
}

function attach(
  store: Store,
  taskId: string,
  env: InboundEnvelope,
  sender: string | null,
  actorId: string,
): ReconcileResult {
  const fresh = store.loadTask(taskId);
  if (!fresh) throw notFound(`task ${taskId} not found`);
  const t = fresh.obj;
  if (TERMINAL.has(t.status)) throw stateError(`cannot attach to a ${t.status} task`);

  const thread = (t.thread ??= []);
  // Idempotent: this envelope already landed here — no event-less rewrite.
  if (thread.some((e) => e.envelopeId === env.id)) {
    return { input: env.id, verdict: "attached", task: taskId, matchedEntity: null };
  }

  thread.push({ actor: sender ?? env.from, content: env.content, at: store.nowIso(), envelopeId: env.id });

  // Waiting → open when the matched task was waiting on this sender (reply received).
  const flipped = t.status === "waiting" && t.waiting?.onActor === sender;
  if (flipped) {
    t.status = "open";
    t.waiting = null;
  }
  t.updatedAt = store.nowIso();

  const events: HipEvent[] = [
    ev(store, taskId, actorId, "reconciled", { envelope: env.id, from: env.from, flipped }),
  ];
  store.writeObjects([{ type: "task", obj: t as unknown as Record<string, unknown> }], events);

  return { input: env.id, verdict: "attached", task: taskId, matchedEntity: null };
}

function escalate(
  store: Store,
  domain: Domain,
  env: InboundEnvelope,
  candidateIds: string[],
  actorId: string,
): ReconcileResult {
  const options = candidateIds.map((id) => {
    const t = store.getTask(id);
    return { id, label: t ? `Attach to: ${t.title}` : id };
  });
  options.push({ id: "new", label: "Create a new task" });
  options.push({ id: "ignore", label: "Ignore this message" });

  const decision = domain.createDecision(
    {
      prompt: `New message from ${env.from}: "${truncate(env.content, 140)}" — where does this go?`,
      options,
      kind: "escalation",
      _meta: { envelope: env, candidates: candidateIds },
    },
    actorId,
  );

  return {
    input: env.id,
    verdict: "escalated",
    decision: decision.id,
    matchedEntity: null,
  };
}

/**
 * Resolve an escalation decision into a steered action. Decisions stay generic; this
 * is reconcile-domain behavior (answers the deferred question). optionId is a candidate
 * task id, "new", or "ignore". Records a `steered` event — the learning substrate.
 */
export function resolveEscalation(
  store: Store,
  decisionId: string,
  optionId: string,
  actorId: string,
): ReconcileResult {
  const domain = new Domain(store);
  const decision = store.getDecision(decisionId);
  if (!decision) throw notFound(`decision ${decisionId} not found`);
  if (decision.kind !== "escalation") throw validation(`decision ${decisionId} is not an escalation`);
  if (decision.resolution) throw conflict(`decision ${decisionId} already resolved`);

  const meta = (decision._meta ?? {}) as { envelope?: InboundEnvelope };
  const env = meta.envelope;
  if (!env) throw stateError("escalation decision is missing its envelope");

  domain.resolveDecision(decisionId, { kind: "option", optionId }, actorId);

  let result: ReconcileResult;
  if (optionId === "ignore") {
    result = { input: env.id, verdict: "escalated", decision: decisionId, matchedEntity: null };
  } else if (optionId === "new") {
    const task = domain.createTask(
      {
        title: truncate(env.content, 80) || `Message from ${env.from}`,
        delegatedBy: { actor: actorId, role: "creator" },
      },
      actorId,
    );
    domain.appendThread(task.id, { actor: env.from, content: env.content, envelopeId: env.id }, actorId, "reconciled");
    store.events.append(ev(store, task.id, actorId, "steered", { decision: decisionId, action: "new", envelope: env.id }));
    result = { input: env.id, verdict: "created", task: task.id, matchedEntity: null };
  } else {
    // Attach to a chosen task (guards against it having gone terminal meanwhile).
    const sender = resolveSender(store, env);
    result = attach(store, optionId, env, sender, actorId);
    store.events.append(ev(store, optionId, actorId, "steered", { decision: decisionId, action: "attach", envelope: env.id }));
  }

  // Update the ledger with the steered outcome.
  store.commit({ files: [], events: [], derive: (db) => store.putEnvelope(db, env, result) });
  return result;
}

// ---- helpers --------------------------------------------------------------

function resolveSender(store: Store, env: InboundEnvelope): string | null {
  if (env.from.startsWith("act_")) return env.from;
  const actor = store.findActorByAddress(env.from);
  return actor?.id ?? null;
}

function actorFromEntityAlias(store: Store, alias: string): string | null {
  const ents = store.findEntityIdsByAlias(alias);
  if (ents.length !== 1) return null;
  const entity = store.getEntity(ents[0]!);
  const linked = entity?._meta?.["actor"];
  return typeof linked === "string" ? linked : null;
}

function liveTasks(store: Store, ids: string[]): string[] {
  return ids.filter((id) => {
    const t = store.getTask(id);
    return t !== null && !TERMINAL.has(t.status);
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function ev(
  store: Store,
  taskId: string | null,
  actorId: string,
  kind: HipEvent["kind"],
  payload?: Record<string, unknown>,
): HipEvent {
  const e: HipEvent = { id: newId("event"), task: taskId, actor: actorId, kind, at: store.nowIso() };
  if (payload) e.payload = payload;
  return e;
}

export type { Task };
