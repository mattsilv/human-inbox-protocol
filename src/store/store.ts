import { existsSync, readdirSync } from "node:fs";
import type {
  ObjectType,
  Task,
  TaskStatus,
  Decision,
  Entity,
  Actor,
  Execution,
  HipEvent,
  InboundEnvelope,
  ReconcileResult,
} from "../types.js";
import { atomicWrite, contentHash, readIfExists } from "./atomic.js";
import { openDb, type Db } from "./db.js";
import { EventLog } from "./events.js";
import { dataPaths, filePath, dirForType, type DataPaths } from "./paths.js";
import { serialize, deserialize } from "./markdown.js";
import { indexTask, indexDecision, indexEntity, indexActor } from "./indexer.js";

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export interface FileWrite {
  type: ObjectType;
  id: string;
  content: string;
}

export interface CommitParams {
  /** Markdown files to atomically write, applied in array order (rename order). */
  files: FileWrite[];
  /** Write-ahead intent + history; appended (fsynced) before any file is renamed. */
  events: HipEvent[];
  /** Index + authoritative-table writes, run inside one IMMEDIATE transaction. */
  derive: (db: Db) => void;
}

const INDEXERS: Record<ObjectType, (db: Db, obj: never, hash: string) => void> = {
  task: indexTask as never,
  decision: indexDecision as never,
  entity: indexEntity as never,
  actor: indexActor as never,
};

/**
 * The single durable write path for the whole daemon. Markdown files are truth;
 * SQLite holds derived index/timers plus authoritative envelopes/executions; the
 * JSONL event log is the write-ahead intent. One process, one writer.
 */
export class Store {
  readonly paths: DataPaths;
  readonly db: Db;
  readonly events: EventLog;
  readonly clock: Clock;

  constructor(opts: { root?: string; clock?: Clock } = {}) {
    this.paths = dataPaths(opts.root);
    this.db = openDb(this.paths.dbFile);
    this.events = new EventLog(this.paths.eventsFile);
    this.clock = opts.clock ?? systemClock;
  }

  close(): void {
    this.db.close();
  }

  nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  // ---- low-level commit -------------------------------------------------

  commit(params: CommitParams): void {
    // 1. event intent (durable, fsynced) — guarantees no state change without an event.
    for (const ev of params.events) this.events.append(ev);
    // 2. atomic markdown renames, in the defined order.
    for (const f of params.files) atomicWrite(filePath(this.paths, f.type, f.id), f.content);
    // 3. one IMMEDIATE txn for all derived + authoritative effects.
    this.db.transaction(params.derive).immediate(this.db);
  }

  // ---- typed reads ------------------------------------------------------

  private readDoc<T>(type: ObjectType, id: string): { obj: T; hash: string } | null {
    const raw = readIfExists(filePath(this.paths, type, id));
    if (raw === null) return null;
    return { obj: deserialize<T>(type, raw), hash: contentHash(raw) };
  }

  getTask(id: string): Task | null {
    return this.readDoc<Task>("task", id)?.obj ?? null;
  }
  getDecision(id: string): Decision | null {
    return this.readDoc<Decision>("decision", id)?.obj ?? null;
  }
  getEntity(id: string): Entity | null {
    return this.readDoc<Entity>("entity", id)?.obj ?? null;
  }
  getActor(id: string): Actor | null {
    return this.readDoc<Actor>("actor", id)?.obj ?? null;
  }

  loadTask(id: string): { obj: Task; hash: string } | null {
    return this.readDoc<Task>("task", id);
  }
  loadDecision(id: string): { obj: Decision; hash: string } | null {
    return this.readDoc<Decision>("decision", id);
  }

  /** Hash recorded in the derived index at the last daemon write, if any. */
  indexedHash(type: ObjectType, id: string): string | null {
    const table =
      type === "task"
        ? "task_index"
        : type === "decision"
          ? "decision_index"
          : type === "entity"
            ? "entity_index"
            : "actor_index";
    const row = this.db.prepare(`SELECT content_hash AS h FROM ${table} WHERE id = ?`).get(id) as
      | { h: string }
      | undefined;
    return row?.h ?? null;
  }

  /**
   * True when the on-disk file differs from what the index last recorded — i.e. it
   * was edited outside the daemon ($EDITOR). Callers append an `external-edit` event
   * and apply their mutation onto the fresh content (revalidation, never blind copy).
   */
  externalEditDetected(type: ObjectType, id: string, freshHash: string): boolean {
    const known = this.indexedHash(type, id);
    return known !== null && known !== freshHash;
  }

  // ---- typed write helpers ---------------------------------------------

  serializeWith(type: ObjectType, obj: Record<string, unknown>): FileWrite {
    return { type, id: obj.id as string, content: serialize(type, obj) };
  }

  /** Index a freshly-written object inside the current commit's derive txn. */
  indexInDerive(db: Db, type: ObjectType, obj: Record<string, unknown>): void {
    INDEXERS[type](db, obj as never, contentHash(serialize(type, obj)));
  }

  /**
   * Write one or more markdown objects atomically with their events, indexing each
   * in the derive txn. `objs` order is the file rename order. `extraDerive` runs in
   * the same txn for authoritative-table effects (executions, envelopes).
   */
  writeObjects(
    objs: { type: ObjectType; obj: Record<string, unknown> }[],
    events: HipEvent[],
    extraDerive?: (db: Db) => void,
  ): void {
    const files = objs.map((o) => this.serializeWith(o.type, o.obj));
    this.commit({
      files,
      events,
      derive: (db) => {
        for (const o of objs) this.indexInDerive(db, o.type, o.obj);
        extraDerive?.(db);
      },
    });
  }

  // ---- listing & query (derived index) ----------------------------------

  listObjectIds(type: ObjectType): string[] {
    const dir = dirForType(this.paths, type);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  }

  listTasks(filter?: { status?: TaskStatus }): Task[] {
    const rows = filter?.status
      ? (this.db
          .prepare(`SELECT id FROM task_index WHERE status = ? ORDER BY created_at`)
          .all(filter.status) as { id: string }[])
      : (this.db.prepare(`SELECT id FROM task_index ORDER BY created_at`).all() as {
          id: string;
        }[]);
    return rows.map((r) => this.getTask(r.id)).filter((t): t is Task => t !== null);
  }

  /** Pending = unresolved and not currently snoozed past `now`. */
  listPendingDecisions(): Decision[] {
    const nowIso = this.nowIso();
    const rows = this.db
      .prepare(
        `SELECT id FROM decision_index
         WHERE resolved = 0 AND (snoozed_until IS NULL OR snoozed_until <= ?)
         ORDER BY created_at`,
      )
      .all(nowIso) as { id: string }[];
    return rows.map((r) => this.getDecision(r.id)).filter((d): d is Decision => d !== null);
  }

  findWaitingTaskIdsByActor(actorId: string): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM task_index WHERE status = 'waiting' AND waiting_on_actor = ?`)
      .all(actorId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  findTaskIdsByGlobalId(globalId: string): string[] {
    const rows = this.db
      .prepare(`SELECT task_id FROM task_reference WHERE global_id = ?`)
      .all(globalId) as { task_id: string }[];
    return rows.map((r) => r.task_id);
  }

  findEntityIdsByAlias(alias: string): string[] {
    const rows = this.db
      .prepare(`SELECT entity_id FROM entity_alias WHERE alias = ?`)
      .all(alias.toLowerCase()) as { entity_id: string }[];
    return rows.map((r) => r.entity_id);
  }

  /** The task a processed envelope already landed in (reconcile idempotency marker). */
  findTaskIdByThreadEnvelope(envelopeId: string): string | null {
    const row = this.db
      .prepare(`SELECT task_id FROM thread_envelope WHERE envelope_id = ?`)
      .get(envelopeId) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }

  findActorByAddress(address: string): Actor | null {
    const row = this.db.prepare(`SELECT id FROM actor_index WHERE address = ?`).get(address) as
      | { id: string }
      | undefined;
    return row ? this.getActor(row.id) : null;
  }

  // ---- timers (derived) -------------------------------------------------

  dueTimers(nowMs: number): { task_id: string; next_fire_at: number }[] {
    return this.db
      .prepare(`SELECT task_id, next_fire_at FROM timers WHERE next_fire_at <= ? ORDER BY next_fire_at`)
      .all(nowMs) as { task_id: string; next_fire_at: number }[];
  }

  allTimers(): { task_id: string; next_fire_at: number }[] {
    return this.db
      .prepare(`SELECT task_id, next_fire_at FROM timers ORDER BY next_fire_at`)
      .all() as { task_id: string; next_fire_at: number }[];
  }

  /** Drop a stale timer row directly (engine cleanup when a task left `waiting`). */
  removeTimer(taskId: string): void {
    this.db.prepare(`DELETE FROM timers WHERE task_id = ?`).run(taskId);
  }

  /** Unresolved decisions whose expiresAt has passed — the nudge sweep target. */
  unresolvedDecisionIdsWithExpiry(nowMs: number): string[] {
    const nowIso = new Date(nowMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id FROM decision_index WHERE resolved = 0 AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(nowIso) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** A still-pending nudge decision for this task (dedupe substrate for U5). */
  pendingNudgeDecisionId(taskId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM decision_index
         WHERE task_id = ? AND kind = 'nudge' AND resolved = 0
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  // ---- executions (SQLite-authoritative) --------------------------------

  upsertExecution(db: Db, e: Execution): void {
    db.prepare(
      `INSERT OR REPLACE INTO executions
       (id, task_id, actor, runtime_system, runtime_external_id, status, blocked_on,
        last_heartbeat_at, expected_next_heartbeat_at, meta_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      e.id,
      e.task,
      e.actor,
      e.runtime?.system ?? null,
      e.runtime?.externalId ?? null,
      e.status,
      e.blockedOn ?? null,
      e.lastHeartbeatAt ?? null,
      e.expectedNextHeartbeatAt ?? null,
      e._meta ? JSON.stringify(e._meta) : null,
      e.createdAt,
      e.updatedAt,
    );
  }

  getExecution(id: string): Execution | null {
    const r = this.db.prepare(`SELECT * FROM executions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToExecution(r) : null;
  }

  getExecutionBlockedOn(decisionId: string): Execution | null {
    const r = this.db.prepare(`SELECT * FROM executions WHERE blocked_on = ?`).get(decisionId) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToExecution(r) : null;
  }

  listExecutionsByTask(taskId: string): Execution[] {
    const rows = this.db
      .prepare(`SELECT * FROM executions WHERE task_id = ? ORDER BY created_at`)
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToExecution);
  }

  // ---- envelope ledger (SQLite-authoritative, write-once idempotency) ----

  getEnvelope(
    id: string,
  ): { result: ReconcileResult; contentHash: string } | null {
    const r = this.db.prepare(`SELECT * FROM envelopes WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      result: JSON.parse(r.result_json as string) as ReconcileResult,
      contentHash: r.content_hash as string,
    };
  }

  putEnvelope(db: Db, env: InboundEnvelope, result: ReconcileResult): void {
    db.prepare(
      `INSERT OR IGNORE INTO envelopes
       (id, kind, from_addr, content_hash, received_at, verdict, task_id, decision_id, result_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      env.id,
      env.kind,
      env.from,
      contentHash(env.content ?? ""),
      env.receivedAt ?? null,
      result.verdict,
      result.task ?? null,
      result.decision ?? null,
      JSON.stringify(result),
      this.nowIso(),
    );
  }
}

function rowToExecution(r: Record<string, unknown>): Execution {
  const e: Execution = {
    id: r.id as string,
    task: r.task_id as string,
    actor: r.actor as string,
    status: r.status as Execution["status"],
    blockedOn: (r.blocked_on as string | null) ?? null,
    lastHeartbeatAt: (r.last_heartbeat_at as string | null) ?? null,
    expectedNextHeartbeatAt: (r.expected_next_heartbeat_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
  if (r.runtime_system) {
    e.runtime = { system: r.runtime_system as string };
    if (r.runtime_external_id) e.runtime.externalId = r.runtime_external_id as string;
  }
  if (r.meta_json) e._meta = JSON.parse(r.meta_json as string) as Record<string, unknown>;
  return e;
}
