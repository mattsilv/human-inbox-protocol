import { existsSync, unlinkSync } from "node:fs";
import type { Store } from "../store/index.js";
import { filePath } from "../store/index.js";
import type { Db } from "../store/db.js";

// Auto-cleanup of `hip demo` seed data. The demo tags every task it creates with
// `_meta.demo: true`, persisted as task_index.is_demo by the indexer (KTD1). When a
// real (non-demo) task is created alongside demo data, maybeCleanDemo wipes the seed
// directly — file + DB — without the HTTP client resetDemo() uses, since createTask
// runs in the domain layer with raw Store access.

/** True when any demo-tagged task remains in the index. */
export function hasDemoData(db: Db): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM task_index WHERE is_demo = 1`).get() as {
    n: number;
  };
  return row.n > 0;
}

/**
 * True when a real (non-demo) task is in an active state. Allowlist is complete:
 * TaskStatus = "open" | "waiting" | "done" | "dropped" — only open/waiting are active.
 */
export function hasRealActiveTasks(db: Db): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM task_index WHERE is_demo = 0 AND status IN ('open', 'waiting')`,
    )
    .get() as { n: number };
  return row.n > 0;
}

/**
 * Delete all demo tasks, their linked decisions, and every derived + authoritative row
 * that references them. DB transaction first (a crash leaves orphaned files, which are
 * harmless; orphaned rows pointing at deleted files are not), then markdown files.
 */
export function cleanDemoData(store: Store): void {
  const db = store.db;
  const taskIds = (db.prepare(`SELECT id FROM task_index WHERE is_demo = 1`).all() as {
    id: string;
  }[]).map((r) => r.id);
  if (taskIds.length === 0) return;

  const decisionIds: string[] = [];
  const selDecisions = db.prepare(`SELECT id FROM decision_index WHERE task_id = ?`);
  for (const tid of taskIds) {
    for (const r of selDecisions.all(tid) as { id: string }[]) decisionIds.push(r.id);
  }

  const placeholders = taskIds.map(() => "?").join(",");
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM task_index WHERE is_demo = 1`).run();
    db.prepare(`DELETE FROM task_tag WHERE task_id IN (${placeholders})`).run(...taskIds);
    db.prepare(`DELETE FROM task_reference WHERE task_id IN (${placeholders})`).run(...taskIds);
    db.prepare(`DELETE FROM thread_envelope WHERE task_id IN (${placeholders})`).run(...taskIds);
    db.prepare(`DELETE FROM timers WHERE task_id IN (${placeholders})`).run(...taskIds);
    db.prepare(`DELETE FROM decision_index WHERE task_id IN (${placeholders})`).run(...taskIds);
    // Authoritative rows the demo seed creates: execution_register (blockedTask) and
    // reconcile_submit (envelopes). These reference demo task IDs and must go too.
    db.prepare(`DELETE FROM executions WHERE task_id IN (${placeholders})`).run(...taskIds);
    db.prepare(`DELETE FROM envelopes WHERE task_id IN (${placeholders})`).run(...taskIds);
  });
  tx();

  // Files after the DB commit. Decisions first, then tasks; skip any already gone.
  for (const id of decisionIds) unlinkIfExists(filePath(store.paths, "decision", id));
  for (const id of taskIds) unlinkIfExists(filePath(store.paths, "task", id));

  process.stdout.write("Demo data removed — starting fresh.\n");
}

/** Clean the demo seed iff demo data and real active tasks coexist. Returns whether it ran. */
export function maybeCleanDemo(store: Store): boolean {
  if (hasDemoData(store.db) && hasRealActiveTasks(store.db)) {
    cleanDemoData(store);
    return true;
  }
  return false;
}

function unlinkIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
