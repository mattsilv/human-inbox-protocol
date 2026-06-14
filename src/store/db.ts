import Database from "better-sqlite3";
import { ensureDir } from "./atomic.js";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 2;

// Tables rebuilt from files by `reindex`. Everything here is a cache of file truth.
const DERIVED_TABLES = [
  "task_index",
  "task_reference",
  "task_tag",
  "thread_envelope",
  "decision_index",
  "entity_index",
  "entity_alias",
  "actor_index",
  "timers",
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_index (
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT,
  next_action_on TEXT,
  waiting_on_actor TEXT,
  priority TEXT,
  content_hash TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_status ON task_index(status);
CREATE INDEX IF NOT EXISTS idx_task_waiting_actor ON task_index(waiting_on_actor);

CREATE TABLE IF NOT EXISTS task_reference (
  task_id TEXT NOT NULL,
  global_id TEXT NOT NULL,
  PRIMARY KEY (task_id, global_id)
);
CREATE INDEX IF NOT EXISTS idx_task_ref_global ON task_reference(global_id);

-- Filterable multi-valued task labels (1:many side table, mirrors task_reference).
-- protocol-gap is the dogfood gap marker queried by task_list tag filter / hip-gaps.
CREATE TABLE IF NOT EXISTS task_tag (
  task_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_task_tag_tag ON task_tag(tag);

-- Reconcile idempotency marker: which task a processed envelope landed in. Derived
-- from thread frontmatter, so it survives reindex and is the file-layer guard that
-- makes attach idempotent even if the authoritative envelope ledger write was lost.
CREATE TABLE IF NOT EXISTS thread_envelope (
  envelope_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_index (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  prompt TEXT,
  kind TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  snoozed_until TEXT,
  expires_at TEXT,
  content_hash TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_resolved ON decision_index(resolved);
CREATE INDEX IF NOT EXISTS idx_decision_task ON decision_index(task_id);

CREATE TABLE IF NOT EXISTS entity_index (
  id TEXT PRIMARY KEY,
  kind TEXT,
  content_hash TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS entity_alias (
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_entity_alias ON entity_alias(alias);

CREATE TABLE IF NOT EXISTS actor_index (
  id TEXT PRIMARY KEY,
  kind TEXT,
  display_name TEXT,
  address TEXT,
  content_hash TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_actor_address ON actor_index(address);

CREATE TABLE IF NOT EXISTS timers (
  task_id TEXT PRIMARY KEY,
  next_fire_at INTEGER NOT NULL,
  cadence TEXT,
  last_nudge TEXT,
  since TEXT
);
CREATE INDEX IF NOT EXISTS idx_timers_fire ON timers(next_fire_at);

-- AUTHORITATIVE: not rebuilt by reindex; part of the data-dir backup unit.
CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  kind TEXT,
  from_addr TEXT,
  content_hash TEXT,
  received_at TEXT,
  verdict TEXT,
  task_id TEXT,
  decision_id TEXT,
  result_json TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  actor TEXT,
  runtime_system TEXT,
  runtime_external_id TEXT,
  status TEXT,
  blocked_on TEXT,
  last_heartbeat_at TEXT,
  expected_next_heartbeat_at TEXT,
  meta_json TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_task ON executions(task_id);
CREATE INDEX IF NOT EXISTS idx_exec_blocked ON executions(blocked_on);
`;

export type Db = Database.Database;

export function openDb(dbFile: string): Db {
  ensureDir(dirname(dbFile));
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  // SCHEMA is all `IF NOT EXISTS`, so it brings any older DB up to the current table
  // set on open (e.g. task_tag for a v1 store). The version pragma is bookkeeping:
  // a fresh DB (0) and any pre-HEAD DB both advance to SCHEMA_VERSION; an existing
  // v1 store keeps its rows — the migration is additive (new table only).
  db.exec(SCHEMA);
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** Wipe derived tables only — authoritative envelopes/executions are untouched. */
export function clearDerived(db: Db): void {
  const tx = db.transaction(() => {
    for (const t of DERIVED_TABLES) db.exec(`DELETE FROM ${t}`);
  });
  tx();
}
