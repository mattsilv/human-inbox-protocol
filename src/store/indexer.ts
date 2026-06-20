import type { Db } from "./db.js";
import type { Task, Decision, Entity, Actor } from "../types.js";
import { addDuration } from "./duration.js";

// Derived-index maintenance. Every function here is idempotent (DELETE+INSERT or
// INSERT OR REPLACE) so reindex and incremental updates share one code path.

export function indexTask(db: Db, task: Task, hash: string): void {
  // Derive the flat index columns from the internal union (KTD4 lower-at-index).
  const status = task.state.kind;
  const waitingActor = task.state.kind === "waiting" ? task.state.onActor : null;
  const isDemo = task._meta?.demo === true ? 1 : 0;
  db.prepare(
    `INSERT OR REPLACE INTO task_index
     (id, title, status, next_action_on, waiting_on_actor, priority, content_hash, created_at, updated_at, is_demo)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    task.id,
    task.title ?? null,
    status,
    task.nextActionOn ?? null,
    waitingActor,
    task.priority ?? null,
    hash,
    task.createdAt ?? null,
    task.updatedAt ?? null,
    isDemo,
  );

  db.prepare(`DELETE FROM task_reference WHERE task_id = ?`).run(task.id);
  const insRef = db.prepare(
    `INSERT OR IGNORE INTO task_reference (task_id, global_id) VALUES (?, ?)`,
  );
  for (const ref of task.references ?? []) {
    if (ref.globalId) insRef.run(task.id, ref.globalId);
  }

  db.prepare(`DELETE FROM task_tag WHERE task_id = ?`).run(task.id);
  const insTag = db.prepare(`INSERT OR IGNORE INTO task_tag (task_id, tag) VALUES (?, ?)`);
  for (const tag of task.tags ?? []) {
    if (tag) insTag.run(task.id, tag);
  }

  // Reconcile idempotency markers: every envelope id that landed in this thread.
  db.prepare(`DELETE FROM thread_envelope WHERE task_id = ?`).run(task.id);
  const insEnv = db.prepare(
    `INSERT OR IGNORE INTO thread_envelope (envelope_id, task_id) VALUES (?, ?)`,
  );
  for (const entry of task.thread ?? []) {
    if (entry.envelopeId) insEnv.run(entry.envelopeId, task.id);
  }

  reindexTimerForTask(db, task);
}

/** A waiting task with a valid cadence owns exactly one timer row; else none. */
export function reindexTimerForTask(db: Db, task: Task): void {
  db.prepare(`DELETE FROM timers WHERE task_id = ?`).run(task.id);
  if (task.state.kind !== "waiting") return;
  const { cadence, lastNudge, since } = task.state;
  if (!cadence) return;
  const base = lastNudge ?? since;
  const baseMs = base ? Date.parse(base) : NaN;
  if (Number.isNaN(baseMs)) return;
  const next = addDuration(baseMs, cadence);
  if (next === null) return;
  db.prepare(
    `INSERT OR REPLACE INTO timers (task_id, next_fire_at, cadence, last_nudge, since)
     VALUES (?,?,?,?,?)`,
  ).run(task.id, next, cadence, lastNudge ?? null, since ?? null);
}

export function indexDecision(db: Db, d: Decision, hash: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO decision_index
     (id, task_id, prompt, kind, resolved, snoozed_until, expires_at, content_hash, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    d.id,
    d.task ?? null,
    d.prompt ?? null,
    d.kind ?? null,
    d.resolution ? 1 : 0,
    d.snoozedUntil ?? null,
    d.expiresAt ?? null,
    hash,
    d.createdAt ?? null,
    d.updatedAt ?? null,
  );
}

export function indexEntity(db: Db, e: Entity, hash: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO entity_index (id, kind, content_hash, updated_at) VALUES (?,?,?,?)`,
  ).run(e.id, e.kind, hash, e.updatedAt ?? null);
  db.prepare(`DELETE FROM entity_alias WHERE entity_id = ?`).run(e.id);
  const ins = db.prepare(`INSERT OR IGNORE INTO entity_alias (entity_id, alias) VALUES (?, ?)`);
  for (const alias of e.aliases ?? []) {
    if (alias) ins.run(e.id, alias.toLowerCase());
  }
}

export function indexActor(db: Db, a: Actor, hash: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO actor_index (id, kind, display_name, address, content_hash, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(a.id, a.kind, a.displayName ?? null, a.address ?? null, hash, a.updatedAt ?? null);
}

export function deindex(db: Db, type: string, id: string): void {
  switch (type) {
    case "task":
      db.prepare(`DELETE FROM task_index WHERE id = ?`).run(id);
      db.prepare(`DELETE FROM task_reference WHERE task_id = ?`).run(id);
      db.prepare(`DELETE FROM task_tag WHERE task_id = ?`).run(id);
      db.prepare(`DELETE FROM thread_envelope WHERE task_id = ?`).run(id);
      db.prepare(`DELETE FROM timers WHERE task_id = ?`).run(id);
      break;
    case "decision":
      db.prepare(`DELETE FROM decision_index WHERE id = ?`).run(id);
      break;
    case "entity":
      db.prepare(`DELETE FROM entity_index WHERE id = ?`).run(id);
      db.prepare(`DELETE FROM entity_alias WHERE entity_id = ?`).run(id);
      break;
    case "actor":
      db.prepare(`DELETE FROM actor_index WHERE id = ?`).run(id);
      break;
  }
}
