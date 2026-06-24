// HIP schema v0.1 object shapes — plain JSON types shared by store, domain, tools.
// These are structural views over parsed frontmatter; unknown fields ride along on
// the live object and MUST be preserved on rewrite (Taskwarrior rule). Mutators edit
// the read object in place — never replace it — so unrecognized keys survive.

export type Iso = string; // ISO-8601 timestamp or date

export type ObjectType = "task" | "decision" | "entity" | "actor";

export const ID_PREFIX = {
  task: "tsk",
  decision: "dec",
  entity: "ent",
  actor: "act",
  execution: "exe",
  reference: "ref",
  envelope: "env",
  event: "evt",
} as const;

export type Priority = "low" | "normal" | "high";

// ---- Actor ---------------------------------------------------------------

export type ActorKind = "person" | "agent" | "service" | "group";

export interface Actor {
  id: string;
  kind: ActorKind;
  displayName: string;
  address?: string;
  createdAt: Iso;
  updatedAt: Iso;
  workspaceId?: string;
  origin?: { system: string; importedAt: Iso };
  _meta?: Record<string, unknown>;
}

// ---- Reference -----------------------------------------------------------

export type ReferenceRole = "source" | "check-for-updates" | "publish-updates-to";

export interface Reference {
  id: string;
  type: string; // email-thread | ticket | url | document | ... (open enum)
  system?: string;
  externalId?: string;
  globalId?: string; // upsert idempotency key (Jira pattern) — reconcile tier 1
  url?: string;
  displayName?: string;
  role?: ReferenceRole;
  _meta?: Record<string, unknown>;
}

// ---- Task ----------------------------------------------------------------

export type TaskStatus = "open" | "waiting" | "done" | "dropped";

export interface DelegatedBy {
  actor: string;
  role: "creator" | "delegator";
}

export interface Waiting {
  onActor: string;
  since: Iso;
  via?: string; // Reference id
  cadence?: string | null; // ISO-8601 duration; null = never auto-nudge
  lastNudge?: Iso | null;
  _meta?: Record<string, unknown>;
}

export interface ThreadEntry {
  actor: string;
  content: string; // markdown
  at: Iso;
  envelopeId?: string; // set when appended by reconcile — file-layer idempotency key
}

/**
 * Internal canonical task state — one discriminated value replacing the
 * `status` + `waitingOn` pair. A waiting payload cannot exist without waiting
 * state (illegal states unrepresentable). `kind` equals the flat `TaskStatus`
 * used on every external surface (disk, wire, SQLite). The codec in
 * `store/task-state.ts` lifts flat→union (disk read) and lowers union→flat
 * (disk write, MCP wire); the SQLite index derives its flat columns from the
 * discriminant directly — see WireTask.
 */
export type TaskState =
  | ({ kind: "waiting" } & Waiting)
  | { kind: "open" }
  | { kind: "done" }
  | { kind: "dropped" };

export interface Task {
  id: string;
  title: string;
  shortId?: number; // small recycling human-facing display number; leased while active,
  // freed (cleared) on terminal. Display-only — never canonical, never in the event log.
  description?: string; // body field
  state: TaskState; // internal union; flat status/waitingOn on every boundary
  priority?: Priority;
  nextActionOn?: string; // Actor ref
  watcher?: string; // Actor ref
  due?: Iso | null;
  place?: string; // Entity(place) ref
  delegatedBy: DelegatedBy; // REQUIRED provenance
  references?: Reference[];
  tags?: string[]; // flat labels; `protocol-gap` is the dogfood gap marker (indexed in task_tag)
  thread?: ThreadEntry[];
  createdAt: Iso;
  updatedAt: Iso;
  workspaceId?: string;
  origin?: { system: string; importedAt: Iso };
  _meta?: Record<string, unknown>;
}

/**
 * Flat task DTO at every boundary that leaves TypeScript — MCP wire returns,
 * CLI wire consumption, and the on-disk YAML projection. Derived from Task so
 * shared field changes auto-track; only `state` is swapped for the flat
 * `status` + `waitingOn` pair (present iff status == "waiting").
 */
export type WireTask = Omit<Task, "state"> & {
  status: TaskStatus;
  waitingOn?: Waiting | null;
};

// ---- Decision ------------------------------------------------------------

export type ResolutionKind = "option" | "freeText" | "chat" | "dismissed" | "expired";

export interface DecisionOption {
  id: string;
  label: string;
  _meta?: Record<string, unknown>;
}

export interface Resolution {
  kind: ResolutionKind;
  optionId?: string | null;
  freeText?: string | null;
  at: Iso;
  actor?: string;
}

export interface Decision {
  id: string;
  task?: string | null;
  prompt: string;
  options?: DecisionOption[];
  allowFreeText?: boolean;
  allowChat?: boolean;
  priority?: Priority;
  expiresAt?: Iso | null;
  snoozedUntil?: Iso | null;
  resolution?: Resolution | null;
  kind?: "nudge" | "escalation" | "block" | "standalone"; // internal classification, _meta-grade
  createdAt: Iso;
  updatedAt: Iso;
  workspaceId?: string;
  _meta?: Record<string, unknown>;
}

// ---- Entity --------------------------------------------------------------

export type EntityKind = "person" | "vendor" | "place" | "initiative";

export interface Entity {
  id: string;
  kind: EntityKind;
  aliases?: string[];
  context?: string; // body field — markdown blob
  createdAt: Iso;
  updatedAt: Iso;
  workspaceId?: string;
  _meta?: Record<string, unknown>;
}

// ---- Execution (SQLite-authoritative) ------------------------------------

export type ExecutionStatus =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

export interface Execution {
  id: string;
  task: string;
  actor: string;
  runtime?: { system: string; externalId?: string };
  status: ExecutionStatus;
  blockedOn?: string | null; // decision id, present iff status == input-required
  lastHeartbeatAt?: Iso | null;
  expectedNextHeartbeatAt?: Iso | null;
  createdAt: Iso;
  updatedAt: Iso;
  _meta?: Record<string, unknown>;
}

// ---- Envelope / Reconcile (SQLite-authoritative ledger) ------------------

export interface InboundEnvelope {
  id: string; // idempotency key
  kind: string; // email | message | webhook | ...
  from: string; // resolved Actor ref, or raw address
  content: string;
  receivedAt: Iso;
  reference?: Reference;
}

export type Verdict = "attached" | "created" | "escalated";

export interface ReconcileResult {
  input: string; // envelope id
  matchedEntity?: string | null;
  verdict: Verdict;
  task?: string; // attached-to or created task
  decision?: string | null; // present iff escalated
}

// ---- Event (append-only JSONL) -------------------------------------------

export type EventKind =
  | "created"
  | "status-changed"
  | "decision-resolved"
  | "nudge-fired"
  | "reconciled"
  | "steered"
  | "external-edit"
  | "blocked"
  | "commented"
  | "execution-registered"
  | "execution-updated";

export interface HipEvent {
  id: string;
  task?: string | null;
  decision?: string | null;
  actor: string;
  kind: EventKind;
  payload?: Record<string, unknown>;
  at: Iso;
}
