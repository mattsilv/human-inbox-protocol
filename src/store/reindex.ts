import { readIfExists, contentHash } from "./atomic.js";
import { clearDerived, type Db } from "./db.js";
import { deserialize } from "./markdown.js";
import { indexTask, indexDecision, indexEntity, indexActor } from "./indexer.js";
import { filePath } from "./paths.js";
import { newId } from "./ids.js";
import type { Store } from "./store.js";
import type { Task, Decision, Entity, Actor, ObjectType, HipEvent } from "../types.js";

export interface ReindexReport {
  counts: Record<ObjectType, number>;
  externalEdits: number;
}

/**
 * Rebuild every derived table from the markdown files. Authoritative tables
 * (envelopes, executions) are left untouched — they are part of the data-dir backup
 * unit, not reconstructed from files. Divergence between a file and the hash the
 * index last recorded is logged as an `external-edit` event, keeping R10 ("all state
 * changes append to the event log") true through the `$EDITOR` path.
 */
export function reindex(store: Store): ReindexReport {
  const db = store.db;
  // Capture prior hashes so we can synthesize external-edit events for drift.
  const priorHash = captureIndexHashes(db);

  const counts: Record<ObjectType, number> = { task: 0, decision: 0, entity: 0, actor: 0 };
  const editEvents: HipEvent[] = [];
  const nowIso = store.nowIso();

  const tx = db.transaction(() => {
    clearDerived(db);
    for (const type of ["task", "decision", "entity", "actor"] as ObjectType[]) {
      for (const id of store.listObjectIds(type)) {
        const raw = readIfExists(filePath(store.paths, type, id));
        if (raw === null) continue;
        const hash = contentHash(raw);
        const obj = deserialize<Record<string, unknown>>(type, raw);
        indexByType(db, type, obj, hash);
        counts[type]++;
        const before = priorHash.get(`${type}:${id}`);
        if (before !== undefined && before !== hash) {
          editEvents.push(externalEditEvent(type, id, nowIso));
        }
      }
    }
  });
  tx.immediate();

  for (const ev of editEvents) store.events.append(ev);
  return { counts, externalEdits: editEvents.length };
}

function captureIndexHashes(db: Db): Map<string, string> {
  const map = new Map<string, string>();
  const tables: [ObjectType, string][] = [
    ["task", "task_index"],
    ["decision", "decision_index"],
    ["entity", "entity_index"],
    ["actor", "actor_index"],
  ];
  for (const [type, table] of tables) {
    const rows = db.prepare(`SELECT id, content_hash FROM ${table}`).all() as {
      id: string;
      content_hash: string;
    }[];
    for (const r of rows) map.set(`${type}:${r.id}`, r.content_hash);
  }
  return map;
}

function indexByType(db: Db, type: ObjectType, obj: Record<string, unknown>, hash: string): void {
  switch (type) {
    case "task":
      indexTask(db, obj as unknown as Task, hash);
      break;
    case "decision":
      indexDecision(db, obj as unknown as Decision, hash);
      break;
    case "entity":
      indexEntity(db, obj as unknown as Entity, hash);
      break;
    case "actor":
      indexActor(db, obj as unknown as Actor, hash);
      break;
  }
}

function externalEditEvent(type: ObjectType, id: string, at: string): HipEvent {
  return {
    id: newId("event"),
    task: type === "task" ? id : null,
    decision: type === "decision" ? id : null,
    actor: "act_system",
    kind: "external-edit",
    payload: { type, id },
    at,
  };
}

// ---- doctor ---------------------------------------------------------------

export interface DoctorIssue {
  severity: "warn" | "error";
  code: string;
  message: string;
  id?: string;
}

export interface DoctorReport {
  ok: boolean;
  issues: DoctorIssue[];
}

/**
 * Read-only consistency audit. Cross-object invariants the single-file write path
 * cannot guarantee atomically live here. Most index drift is repaired by reindex;
 * doctor reports it and the caller decides whether to auto-reindex.
 */
export function doctor(store: Store): DoctorReport {
  const db = store.db;
  const issues: DoctorIssue[] = [];

  // 1. index row whose file is missing, and file with no index row.
  for (const type of ["task", "decision", "entity", "actor"] as ObjectType[]) {
    const filesOnDisk = new Set(store.listObjectIds(type));
    const table = indexTable(type);
    const indexed = new Set(
      (db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[]).map((r) => r.id),
    );
    for (const id of indexed) {
      if (!filesOnDisk.has(id))
        issues.push({ severity: "error", code: "index-orphan", message: `${table} row ${id} has no file`, id });
    }
    for (const id of filesOnDisk) {
      if (!indexed.has(id))
        issues.push({ severity: "warn", code: "unindexed-file", message: `${type} ${id} not in index`, id });
    }
  }

  // 2. events referencing a nonexistent object.
  const taskFiles = new Set(store.listObjectIds("task"));
  const decisionFiles = new Set(store.listObjectIds("decision"));
  for (const ev of store.events.readAll()) {
    if (ev.task && !taskFiles.has(ev.task))
      issues.push({ severity: "warn", code: "event-dangling-task", message: `event ${ev.id} → missing task ${ev.task}`, id: ev.id });
    if (ev.decision && !decisionFiles.has(ev.decision))
      issues.push({ severity: "warn", code: "event-dangling-decision", message: `event ${ev.id} → missing decision ${ev.decision}`, id: ev.id });
  }

  // 3. resolved decision whose linked execution still has blockedOn set (stuck resume).
  const resolved = db
    .prepare(`SELECT id FROM decision_index WHERE resolved = 1`)
    .all() as { id: string }[];
  for (const { id } of resolved) {
    const exe = store.getExecutionBlockedOn(id);
    if (exe)
      issues.push({
        severity: "error",
        code: "stuck-block",
        message: `execution ${exe.id} still blockedOn resolved decision ${id}`,
        id: exe.id,
      });
  }

  // 4. waiting task without a timer row (cadence set) / timer row for non-waiting task.
  const timers = new Map(
    (db.prepare(`SELECT task_id FROM timers`).all() as { task_id: string }[]).map((r) => [
      r.task_id,
      true,
    ]),
  );
  for (const id of taskFiles) {
    const t = store.getTask(id);
    if (!t) continue;
    const wantsTimer = t.state.kind === "waiting" && !!t.state.cadence;
    const hasTimer = timers.has(id);
    if (wantsTimer && !hasTimer)
      issues.push({ severity: "error", code: "missing-timer", message: `waiting task ${id} has no timer`, id });
    if (!wantsTimer && hasTimer)
      issues.push({ severity: "error", code: "stray-timer", message: `timer for non-waiting task ${id}`, id });
  }

  return { ok: issues.every((i) => i.severity !== "error"), issues };
}

function indexTable(type: ObjectType): string {
  return type === "task"
    ? "task_index"
    : type === "decision"
      ? "decision_index"
      : type === "entity"
        ? "entity_index"
        : "actor_index";
}
