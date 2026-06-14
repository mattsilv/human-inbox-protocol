# HIP-over-MCP binding

How HIP's schema-v0.1 primitives map onto Model Context Protocol tool calls. This
document is normative for the reference daemon. It records **two mappings**: the
**v1 mapping the MVP ships today** (MCP TS SDK v1.29, 2025-11-25 wire protocol) and
the **RC-native target** (MCP 2026-07-28). The semantics are written so the swap from
one to the other is a transport change, not a redesign.

## Transport

- **Streamable HTTP**, bound to `127.0.0.1` only, single daemon, many clients.
- **Stateless**: `sessionIdGenerator: undefined`. The daemon keeps no per-connection
  session state; all server state is keyed by HIP's own ids. This structurally
  guarantees the RC's stateless-core requirement.
- **JSON responses** (`enableJsonResponse: true`). One request, one JSON reply.
- **Only `POST /mcp` carries HIP semantics.** `GET`/`DELETE` (SSE streams, session
  teardown) are refused with `405`. The daemon opens **no** server→client stream.
- **DNS-rebinding protection** on: `Host` and `Origin` are validated against an
  allowlist (loopback + the configured bind host); a mismatched `Host`/`Origin` is
  rejected with `403`.

## Remote agents (Tailscale binding)

The daemon binds to whatever `HIP_HOST` names (`DEFAULT_HOST = 127.0.0.1`); the
LaunchAgent plist carries it as an env var. To let an **off-box agent** reach the
daemon — e.g. an agent on another machine driving HIP as a client — bind to the dev
machine's **Tailscale** interface instead of loopback:

```
HIP_HOST=<this-machine-tailscale-ip>   # in the LaunchAgent plist env, then reload
```

The agent points at `http://<this-machine-tailscale-ip>:4319/mcp` with the same
`Authorization: Bearer <token>`. No `--host` flag is needed for v1 — the env var drives
the bind host, and the daemon adds that host to its DNS-rebinding allowlist so the
remote `Host` header is accepted. (Connect by the **IP** that `HIP_HOST` was set to; a
MagicDNS name only works if `HIP_HOST` is set to that exact name, since the `Host`
header must match the allowlisted bind host.)

> **Security:** binding beyond `127.0.0.1` removes loopback as the network gate, so the
> **bearer token becomes the only thing standing between the tailnet and your store.**
> Pair it with Tailscale ACLs restricting who can reach port `4319`, keep the token
> `0600`, and **never bind `0.0.0.0`.** Loopback-only stays the default for a reason.

## Authentication & identity

Two distinct layers — do not conflate them:

1. **Channel auth** — a bearer token generated at `hip install`, stored `0600` in the
   config dir, sent as `Authorization: Bearer <token>`. A missing/wrong token is
   `401`. The token authenticates *the channel*, not the actor.
2. **Actor identity** — every mutating tool carries an explicit `actorId` argument;
   `task_block` and `execution_*` carry an explicit `executionId`. The daemon **never**
   derives actor or execution from the connection, session, or token. Actor claims are
   asserted and unauthenticated — accepted for the single-user MVP, and the seam where
   real authz lands later.

## Result shape

Every tool returns `structuredContent` as the **canonical** result (a plain-JSON HIP
object or `{ items }` wrapper) with a human-readable `text` content block as a mirror.
Domain errors return `{ isError: true, structuredContent: { error: { code, message } } }`
where `code ∈ {validation, not_found, conflict, state, internal}`.

## Retry / idempotency caveat

Mutating tools are **not idempotent** in the MVP **except** `reconcile_submit`, whose
`InboundEnvelope.id` is an idempotency key (write-once ledger; resubmission returns the
original verdict). All other creates can duplicate on retry. The v2-era fix is
client-supplied creation ids; reserved, not implemented.

## Tool surface (v1, shipped)

Tool names use underscores — major MCP hosts enforce `^[a-zA-Z0-9_-]{1,128}$`, so the
dotted spec shorthand (`task.read`) would fail at the client. Dotted names survive as
documentation only.

| HIP primitive | Tool(s) |
|---|---|
| Task | `task_create`, `task_read` (orient-first), `task_update` (content only), `task_list` |
| Transitions | `task_wait`, `task_done`, `task_drop`, `task_block(taskId, executionId, reason)` |
| Decision | `decision_create`, `decision_list`, `decision_get`, `decision_resolve`, `decision_snooze` |
| Reconcile | `reconcile_submit` (InboundEnvelope → ReconcileResult; synchronous, deterministic) |
| Execution | `execution_register`, `execution_get`, `execution_heartbeat` |
| Context | `actor_create`, `entity_create` (minimal — full CRUD deferred) |
| History | `event_list` |

`task_read` is the **orient-first** contract: one call returns the task, its executions,
and recent events — everything an agent needs to start work, no side-channel context.

**One verb per transition.** `task_update` mutates content fields only and rejects
`status`/`waitingOn`; every state change goes through its own verb so the event log is
unambiguous and invariants live inside the verb.

## Block → resume (no server-initiated requests)

`task_block` files a `decision` (kind `block`) and points the calling execution's
`blockedOn` at it, moving the execution to `input-required` — the task's own status is
untouched (two-state-machines rule). The human resolves the decision; that clears
`blockedOn` and returns the execution to `working`. **Agents observe resolution by
polling** `decision_get` / `execution_get`. Polling is the only resolution channel —
the daemon sends no notifications carrying HIP semantics.

## RC-native target (MCP 2026-07-28) — documented, not shipped

When the stable v2 SDK lands (~2026-07-28), the same semantics map onto:

- **Block/resume** → the Tasks extension `input_required` status + `InputRequiredResult`
  elicitation, instead of a polled `blockedOn` link.
- **Change signals** → `subscriptions/listen` instead of client polling.
- **Server initiated requests** remain unused — the RC removes them, and the MVP already
  depends on none, so nothing breaks.

Because the MVP depends on nothing the RC removes (no server-initiated requests, no
session-dependent behavior, state keyed by HIP ids), the migration is mechanical.

## Admin tools (implementation-specific, not protocol tools)

`doctor_run` and `reindex_run` route store maintenance through the live daemon (the
single writer). They are **not** HIP protocol tools — they are this implementation's
admin surface, exposed only so the CLI can reach the store while the daemon holds the
lock. Documented here so clients don't mistake them for portable HIP verbs.

## Storage model (informative)

The daemon's durability story (see `README.md`): markdown files are the human-editable
truth for tasks/decisions/entities/actors; SQLite holds the derived index/timers plus
the **authoritative** envelope ledger and executions; an append-only `events.jsonl` is
the audit + learning trail. The `~/hip/` data directory is the backup unit. None of
this is visible across the binding — clients see only tool calls and HIP objects.
