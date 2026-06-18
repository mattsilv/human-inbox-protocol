import { existsSync, unlinkSync } from "node:fs";
import type { Store } from "../store/index.js";
import { filePath } from "../store/index.js";
import type { Db } from "../store/db.js";
import type { TaskStatus } from "../types.js";

// Auto-cleanup of `hip demo` seed data. The demo tags every task it creates with
// `_meta.demo: true`, persisted as task_index.is_demo by the indexer (KTD1). When a
// real (non-demo) task is created alongside demo data, maybeCleanDemo wipes the seed
// directly — file + DB — without the HTTP client resetDemo() uses, since createTask
// runs in the domain layer with raw Store access.

/** Envelope-id prefix the demo seed stamps on every reconcile envelope it submits. */
export const DEMO_ENVELOPE_PREFIX = "env_demo";

/** Active = surfaces in the inbox. Mirrors TaskStatus so the query can't silently drift. */
const ACTIVE_STATUSES: TaskStatus[] = ["open", "waiting"];

/** True when any demo-tagged task remains in the index. */
export function hasDemoData(db: Db): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM task_index WHERE is_demo = 1`).get() as {
    n: number;
  };
  return row.n > 0;
}

/** True when a real (non-demo) task is in an active (inbox-visible) state. */
export function hasRealActiveTasks(db: Db): boolean {
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM task_index WHERE is_demo = 0 AND status IN (${placeholders})`,
    )
    .get(...ACTIVE_STATUSES) as { n: number };
  return row.n > 0;
}

/**
 * Delete all demo tasks, their linked decisions, and every derived + authoritative row
 * that references them. Two arms find demo decisions, mirroring the demo's own
 * isDemoDecision: (1) decisions task-linked to a demo task, and (2) escalation decisions
 * with no task link, reached via their demo-prefixed envelope (reconcile escalation
 * creates a task-less decision whose envelope id starts with `env_demo`). The DB
 * transaction runs first (a crash leaves orphaned files, which are harmless; orphaned
 * rows pointing at deleted files are not), then the markdown files.
 */
export function cleanDemoData(store: Store): void {
  const db = store.db;
  const demoTasks = `SELECT id FROM task_index WHERE is_demo = 1`;
  const taskIds = (db.prepare(demoTasks).all() as { id: string }[]).map((r) => r.id);

  // Decision ids for file deletion: task-linked plus task-less escalation decisions
  // reached through the demo's prefixed envelopes.
  const linkedDecisionIds = (
    db.prepare(`SELECT id FROM decision_index WHERE task_id IN (${demoTasks})`).all() as {
      id: string;
    }[]
  ).map((r) => r.id);
  const escalationDecisionIds = (
    db
      .prepare(
        `SELECT decision_id AS id FROM envelopes WHERE id LIKE ? AND decision_id IS NOT NULL`,
      )
      .all(`${DEMO_ENVELOPE_PREFIX}%`) as { id: string }[]
  ).map((r) => r.id);
  const decisionIds = [...new Set([...linkedDecisionIds, ...escalationDecisionIds])];

  if (taskIds.length === 0 && decisionIds.length === 0) return; // nothing to clean

  // Subquery-scoped deletes avoid binding one parameter per id (no SQLite IN-limit risk)
  // and read the demo set live — so task_index must be deleted LAST, after every
  // dependent row has been resolved against it.
  const demoEnv = `${DEMO_ENVELOPE_PREFIX}%`;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM task_tag WHERE task_id IN (${demoTasks})`).run();
    db.prepare(`DELETE FROM task_reference WHERE task_id IN (${demoTasks})`).run();
    db.prepare(`DELETE FROM thread_envelope WHERE task_id IN (${demoTasks})`).run();
    db.prepare(`DELETE FROM timers WHERE task_id IN (${demoTasks})`).run();
    // Authoritative rows the demo seed creates: execution_register (blockedTask) and
    // reconcile_submit (envelopes). Decisions go by task link AND envelope prefix — the
    // escalation decision/envelope carry NULL task_id, so the task arm alone misses them.
    db.prepare(`DELETE FROM executions WHERE task_id IN (${demoTasks})`).run();
    db.prepare(
      `DELETE FROM decision_index
       WHERE task_id IN (${demoTasks})
          OR id IN (SELECT decision_id FROM envelopes WHERE id LIKE ? AND decision_id IS NOT NULL)`,
    ).run(demoEnv);
    db.prepare(`DELETE FROM envelopes WHERE task_id IN (${demoTasks}) OR id LIKE ?`).run(demoEnv);
    db.prepare(`DELETE FROM task_index WHERE is_demo = 1`).run();
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
