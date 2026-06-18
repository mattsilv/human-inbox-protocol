---
title: "feat: Auto-clean demo data on first real task creation"
date: 2026-06-18
type: feat
status: draft
---

# feat: Auto-clean demo data on first real task creation

## Summary

Demo data (`_meta.demo: true` tasks and linked decisions) persists into the live instance after `hip demo` is run, polluting the inbox. This plan adds an `is_demo` flag to `task_index`, populates it during indexing, and silently cleans all demo data the first time a real (non-demo) task is created.

---

## Problem Frame

Running `hip demo` seeds tasks and decisions tagged with `_meta.demo: true`. The existing `resetDemo()` cleans them up — but only when the demo is re-run. If a user runs the demo, then starts real usage, demo data sits alongside real data indefinitely. The user confirmed demo tasks are visible in their live instance right now.

**Scope:** Add `is_demo` DB flag for reliable detection, then trigger `resetDemo`-equivalent cleanup when the first real task is written.

**Out of scope:** Cleaning demo actors (`act_demo_*`) — they have no inbox visibility and match current `resetDemo()` behavior. UI/TUI changes to show a cleanup notice — a single stdout line is sufficient.

---

## Requirements

- R1: `task_index` carries `is_demo INTEGER NOT NULL DEFAULT 0`, set from `task._meta?.demo`
- R2: `indexTask()` populates `is_demo` correctly on every reindex and incremental write
- R3: Existing DBs migrate safely — no data loss, no reindex required for the flag to default correctly
- R4: `maybeCleanDemo(store)` silently deletes demo tasks, demo decisions, and their files when real tasks exist alongside demo tasks
- R5: `maybeCleanDemo` is idempotent and a no-op when no demo data is present
- R6: `createTask()` calls `maybeCleanDemo` after writing a non-demo task
- R7: Demo seeding (re-running `hip demo`) still works after cleanup

---

## Key Technical Decisions

**KTD1 — Direct file+DB deletion vs. API-based cleanup**
`resetDemo()` uses `HipClient` (HTTP calls: `task_drop`, `decision_resolve`). The auto-trigger fires inside `createTask()` which has direct `Store` access — no HTTP client. Bypass the API: delete markdown files directly and run targeted `DELETE` SQL on both derived tables AND the authoritative `executions` and `envelopes` tables. The demo seed does create authoritative rows: `blockedTask` calls `execution_register` (5 times per seed run) and `reconcile_submit` creates `envelopes` rows (2 times per seed run). These must be explicitly deleted since they reference demo task IDs.

**KTD2 — `is_demo` on `task_index` only; decisions found via task link; envelope-prefix arm is an explicit invariant**
Demo decisions are reliably found via `WHERE task_id IN (SELECT id FROM task_index WHERE is_demo = 1)`. The `isDemoDecision` function has a second arm (envelope ID starts with `env_demo`) as a defensive guard for the reconcile path. The demo seed (`blockedTask`, `openTask`, `waitingTask`) never creates decisions without a task link — every seeded decision carries `d.task = taskId`. This is an explicit invariant enforced by a test (U3 test scenarios). We do not store `envelope_id` in `decision_index` to avoid a wider schema change for a defensive case the seed code never exercises.

**KTD3 — Migration via `ALTER TABLE ADD COLUMN` + SCHEMA string update**
Since `task_index` is a derived table it could be dropped and reindexed, but that's heavy for a minor schema change. Instead: add `is_demo INTEGER NOT NULL DEFAULT 0` to the `SCHEMA` constant's `CREATE TABLE IF NOT EXISTS task_index` block (for fresh DBs), AND add a migration block guarded by a `PRAGMA table_info` column-existence check:
```
const current = db.pragma("user_version", { simple: true }) as number;
if (current < 3) {
  const cols = db.pragma("table_info(task_index)") as Array<{name: string}>;
  if (!cols.some(c => c.name === "is_demo")) {
    db.exec(`ALTER TABLE task_index ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_task_demo ON task_index(is_demo)`);
  }
}
if (current < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
```
The column-existence check is required because `db.exec(SCHEMA)` runs before `user_version` is read — a fresh DB (version 0) already has `is_demo` from the SCHEMA string, so running `ALTER TABLE` again would throw "duplicate column name". The guard handles all cases: fresh DB (column present, skip ALTER), v0/v1/v2 upgrade (column absent, ALTER fires), v3 re-open (migration block skips). SQLite has no `ADD COLUMN IF NOT EXISTS` syntax, so the explicit check is the correct vehicle.

**KTD4 — Trigger in `createTask()`, not in a daemon hook**
`createTask()` is the single domain-layer write point for all real task creation (direct API calls and reconcile path both flow through it). Hooking here ensures cleanup fires regardless of how the task was created. The check is two COUNT queries — negligible overhead.

---

## High-Level Technical Design

```
createTask(store, input, actorId)
  └─ store.writeObjects(...)          ← writes markdown + indexes via indexTask()
       └─ indexTask(db, task, hash)
            └─ is_demo = task._meta?.demo === true ? 1 : 0
  └─ if !input._meta?.demo
       └─ maybeCleanDemo(store)
            ├─ hasDemoData(db)        → SELECT COUNT(*) FROM task_index WHERE is_demo = 1
            ├─ hasRealActiveTasks(db) → SELECT COUNT(*) FROM task_index WHERE is_demo = 0 AND status IN ('open', 'waiting')
            └─ cleanDemoData(store)
                 ├─ query demo task IDs + linked decision IDs from task_index/decision_index
                 ├─ DB transaction: DELETE task_index/task_tag/task_reference/
                 │                  thread_envelope/timers/decision_index/
                 │                  executions/envelopes rows
                 ├─ file deletion after DB commit: decision .md, then task .md (skip if absent)
                 └─ print "Demo data removed — starting fresh.\n" to stdout
```

DB schema delta:

```sql
-- migration block (current < 3)
ALTER TABLE task_index ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_task_demo ON task_index(is_demo);
```

---

## Implementation Units

### U1. DB schema migration — add `is_demo` to `task_index`

**Goal:** Persist demo flag in the derived index so cleanup queries require no file I/O.

**Requirements:** R1, R3

**Dependencies:** none

**Files:**
- `src/store/db.ts`

**Approach:**
- Bump `SCHEMA_VERSION` from `2` to `3`
- Add `is_demo INTEGER NOT NULL DEFAULT 0` to the `CREATE TABLE IF NOT EXISTS task_index` block inside the `SCHEMA` constant — this handles fresh DBs
- Add `CREATE INDEX IF NOT EXISTS idx_task_demo ON task_index(is_demo)` to the `SCHEMA` constant as well
- In `openDb()`, add a migration block BEFORE the version-bump pragma that guards with `PRAGMA table_info` before running `ALTER TABLE`:
  ```
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current < 3) {
    const cols = db.pragma("table_info(task_index)") as Array<{name: string}>;
    if (!cols.some(c => c.name === "is_demo")) {
      db.exec(`ALTER TABLE task_index ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_demo ON task_index(is_demo)`);
    }
  }
  if (current < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  ```
  The column-existence check prevents "duplicate column name" on fresh DBs where `db.exec(SCHEMA)` already added `is_demo` before `user_version` was read. The current single-expression `if (current < SCHEMA_VERSION)` at line 153 must be expanded to accommodate this structure.

**Patterns to follow:** The existing `SCHEMA_VERSION`/`user_version` migration pattern at `src/store/db.ts:148`.

**Test scenarios:**
- Fresh DB (version 0): `SCHEMA` creates `task_index` with `is_demo`; migration block fires (`0 < 3`) but `PRAGMA table_info` finds the column already present → `ALTER TABLE` skipped; no duplicate-column error
- Existing v2 DB (no `is_demo`): migration block fires (`current < 3`), column absent → `ALTER TABLE` adds it; existing rows get `0`; no data loss in `envelopes`/`executions`
- V3 DB re-opened: `current < 3` false; migration block skips entirely; `CREATE TABLE IF NOT EXISTS` in SCHEMA is a no-op

**Verification:** `PRAGMA user_version` returns 3 after upgrade; `PRAGMA table_info(task_index)` lists `is_demo`.

---

### U2. Indexer — populate `is_demo` from `task._meta?.demo`

**Goal:** Every `indexTask()` call writes the correct `is_demo` value, covering both incremental writes and full reindex.

**Requirements:** R1, R2

**Dependencies:** U1

**Files:**
- `src/store/indexer.ts`

**Approach:**
- In `indexTask()`, extend the `INSERT OR REPLACE INTO task_index (...)` to include `is_demo`
- Derive value: `task._meta?.demo === true ? 1 : 0`
- The `_meta` field on `Task` is `Record<string, unknown> | undefined` — safe to access with optional chaining

**Patterns to follow:** Existing column derivation pattern in `indexTask()` at `src/store/indexer.ts:8` (e.g., `status = task.state.kind`, `waitingActor` conditional).

**Test scenarios:**
- Task with `_meta: { demo: true }` → `is_demo = 1` in `task_index`
- Task with no `_meta` → `is_demo = 0`
- Task with `_meta: { demo: false }` → `is_demo = 0`
- Task with `_meta: { someOtherKey: true }` but no `demo` → `is_demo = 0`
- Full `hip reindex` after adding `is_demo` column: existing demo tasks get `is_demo = 1`, real tasks get `0`

**Verification:** After seeding demo (`hip demo`) then running `hip reindex` (or via unit test), `SELECT COUNT(*) FROM task_index WHERE is_demo = 1` equals the number of demo tasks created.

---

### U3. Demo cleanup domain module

**Goal:** Provide `hasDemoData`, `hasRealActiveTasks`, `cleanDemoData`, and `maybeCleanDemo` as importable functions that operate directly on the store (no HTTP client).

**Requirements:** R4, R5, R7

**Dependencies:** U1, U2

**Files:**
- `src/domain/demo-cleanup.ts` (new)

**Approach:**

`hasDemoData(db: Db): boolean`
- `SELECT COUNT(*) FROM task_index WHERE is_demo = 1`

`hasRealActiveTasks(db: Db): boolean`
- `SELECT COUNT(*) FROM task_index WHERE is_demo = 0 AND status IN ('open', 'waiting')`
- Allowlist is complete: `TaskStatus = "open" | "waiting" | "done" | "dropped"` — no other active statuses exist

`cleanDemoData(store: Store): void`
- Query demo task IDs: `SELECT id FROM task_index WHERE is_demo = 1`
- For each demo task, collect linked decision IDs: `SELECT id FROM decision_index WHERE task_id = ?`
- **DB transaction first** (avoids stale rows if process crashes mid-delete):
  - `DELETE FROM task_index WHERE is_demo = 1`
  - `DELETE FROM task_tag WHERE task_id IN (demo task IDs)`
  - `DELETE FROM task_reference WHERE task_id IN (demo task IDs)`
  - `DELETE FROM thread_envelope WHERE task_id IN (demo task IDs)`
  - `DELETE FROM timers WHERE task_id IN (demo task IDs)`
  - `DELETE FROM decision_index WHERE task_id IN (demo task IDs)`
  - `DELETE FROM executions WHERE task_id IN (demo task IDs)` — demo seed calls `execution_register` for every `blockedTask` (5 per seed run); these are authoritative rows that must be cleaned
  - `DELETE FROM envelopes WHERE task_id IN (demo task IDs)` — demo seed calls `reconcile_submit` twice per run creating envelope rows
- File deletion after DB transaction (orphaned files without DB rows are harmless; the reverse is not):
  - Delete decision markdown files (skip if not found)
  - Delete task markdown files (skip if not found)
- Print: `"Demo data removed — starting fresh.\n"` to `process.stdout`

`maybeCleanDemo(store: Store): boolean`
- If `hasDemoData(store.db) && hasRealActiveTasks(store.db)` → `cleanDemoData(store)` → return `true`
- Else → return `false`

Note: `filePath()` and `store.paths` are already accessible via `Store`'s public `paths` field. Verify `filePath` is exported from `src/store/store.ts` or `src/store/paths.ts`; if not, inline the path construction (`join(store.paths.tasksDir, id + '.md')`).

**Patterns to follow:**
- Derived-table cascade deletes: `src/store/indexer.ts:111` (`deindex` function)
- File deletion pattern: check `existsSync` before `unlinkSync` (same as `readIfExists` pattern in `src/store/atomic.ts`)

**Test scenarios:**
- `hasDemoData`: true when `task_index` has `is_demo = 1` rows; false otherwise
- `hasRealActiveTasks`: true when non-demo tasks with status `open`/`waiting` exist; false when only `dropped`/`done` non-demo tasks
- `cleanDemoData`: demo task markdown files deleted; real task files untouched; demo task rows gone from `task_index`, `task_tag`, `task_reference`; linked decision files deleted; decision rows gone from `decision_index`; `executions` rows for demo task IDs gone; `envelopes` rows for demo task IDs gone; stdout receives the notice line
- `cleanDemoData`: idempotent — running twice with no demo data → no file errors, no DB errors
- `maybeCleanDemo`: returns `true` and cleans when demo + real data coexist
- `maybeCleanDemo`: returns `false` and does nothing when only demo data (no real tasks yet)
- `maybeCleanDemo`: returns `false` and does nothing when no demo data present
- After `maybeCleanDemo` cleans: `hip demo` can be re-run successfully (R7)
- Invariant: every decision created by demo seed (`blockedTask`) has a non-null `task_id` in `decision_index` — assert no demo decisions exist with `task_id IS NULL` after a fresh `hip demo` run (enforces KTD2's envelope-prefix bypass assumption)

**Verification:** After test run with mixed demo+real data, `task_index` has no `is_demo = 1` rows; decision markdown files for demo tasks are absent; real task files are intact.

---

### U4. Hook `maybeCleanDemo` into `createTask()`

**Goal:** Trigger cleanup automatically the first time a real task is created, without any user intervention.

**Requirements:** R6

**Dependencies:** U3

**Files:**
- `src/domain/tasks.ts`

**Approach:**
- Import `maybeCleanDemo` from `src/domain/demo-cleanup.ts`
- In `createTask()`, after `store.writeObjects(...)`, add:
  ```
  if (!input._meta?.demo) maybeCleanDemo(store);
  ```
- This fires on every real task creation until demo data is gone, then becomes a no-op (two COUNT queries ≈ negligible)

**Patterns to follow:** Post-write side effect pattern — see `store.writeObjects()` call and subsequent return in `createTask()` at `src/domain/tasks.ts:80`.

**Test scenarios:**
- Creating a non-demo task when demo data exists: `maybeCleanDemo` called, demo data cleaned, notice printed
- Creating a non-demo task when no demo data exists: `maybeCleanDemo` called, is a no-op (no errors, no output)
- Creating a demo task (`input._meta?.demo === true`): `maybeCleanDemo` NOT called (guard prevents recursive loop during seed)
- Demo seed (`hip demo`) creates demo tasks after real tasks exist: demo tasks written without triggering cleanup, since all demo-tagged tasks skip the hook

**Verification:** Integration test: seed demo → create one real task → assert no demo tasks in `task_index`; assert real task intact.

---

## Scope Boundaries

### In scope
- `is_demo` column in `task_index` with migration
- Auto-cleanup on real task creation via `maybeCleanDemo`
- Direct file+DB deletion (no HTTP client dependency)

### Deferred to Follow-Up Work
- Demo actor cleanup (`act_demo_*`) — actors have no inbox visibility; can be added in a follow-up if desired
- Cleanup notification beyond the stdout line (TUI banner, etc.)
- `is_demo` on `decision_index` as a first-class column (current JOIN approach is sufficient)

### Out of scope
- Changing the `hip demo` command behavior

---

## Open Questions

None blocking. All decisions resolved above.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|-----------|
| `ALTER TABLE` fails on very old SQLite | `better-sqlite3` bundles its own SQLite; version constraint is already enforced in `package.json` |
| `cleanDemoData` deletes a file that another process is reading | File deletion is atomic on Linux/macOS; readers get a valid FD on the old inode |
| False positive: real task with `_meta.demo: true` | `_meta.demo` is only ever set by `tagDemo()` in `src/cli/demo.ts` — not exposed in public API or user-facing input |
| `maybeCleanDemo` called on every `createTask` after demo gone | Two COUNT queries on an indexed column; sub-millisecond; acceptable |

---

## Sources & Research

- `src/store/db.ts` — schema, migration pattern, `SCHEMA_VERSION`
- `src/store/indexer.ts` — `indexTask()`, `indexDecision()`, `deindex()`
- `src/cli/demo.ts` — `resetDemo()`, `isDemoTask()`, `isDemoDecision()`, `tagDemo()`
- `src/domain/tasks.ts` — `createTask()`, `writeObjects()` call
- `test/cli.test.ts:82` — existing demo integration test (idempotency, scenario coverage)
