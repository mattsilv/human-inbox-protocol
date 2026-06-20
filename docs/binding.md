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

## Topology: co-location (recommended) vs remote binding

**Co-location is the recommended topology.** Run the daemon on the **same box** as the
client, bound to loopback; the client connects to `http://127.0.0.1:4319/mcp`. Nothing is
exposed off-box, so the bearer token is paired with the loopback gate rather than standing
alone, and there is no DNS-rebind allowlist to re-derive when a bind host moves. `hip
install` sets up a per-user service for this automatically — a **systemd user service** on
Linux (with `loginctl` linger so the daemon survives logout/boot on a headless box) and a
**LaunchAgent** on macOS. This is the dogfood topology.

### Remote binding (alternative — off-box agent over Tailscale)

The daemon binds to whatever `HIP_HOST` names (`DEFAULT_HOST = 127.0.0.1`); the service
unit carries it as an env var. To let an **off-box agent** reach the daemon — an agent on
another machine driving HIP as a client — bind to the host machine's **Tailscale**
interface instead of loopback. This path still works but is no longer the dogfood
topology, and it makes the bearer token the only network gate (see Security below):

```
HIP_HOST=<this-machine-tailscale-ip>   # in the LaunchAgent plist env, then reload
```

The agent points at `http://<this-machine-tailscale-ip>:4319/mcp` with the same
`Authorization: Bearer <token>`. Connect by the **IP** that `HIP_HOST` was set to; a
MagicDNS name only works if `HIP_HOST` is set to that exact name, since the `Host`
header must match the allowlisted bind host.

Use the CLI rather than hand-editing the service unit — `HIP_HOST`, the `config.json` url,
and the daemon's DNS-rebinding allowlist must all agree, and the allowlist is re-derived
only when the daemon restarts:

- **`hip rebind <host>`** — atomically rewrites the unit host and `config.json` url,
  reloads the daemon, then verifies the *remote* path (an authenticated POST whose `Host`
  is the new bind host). On failure it rolls back to the previous host. This is the safe
  way to move a running daemon on or off loopback.
- **`hip install --host <host>`** — first-time install bound to a non-loopback host. On an
  already-running daemon it refuses and points at `hip rebind` (install does not reload).
- Both reject `0.0.0.0`/`::` — never bind all interfaces (see Security below).

> **Security:** binding beyond `127.0.0.1` removes loopback as the network gate, so the
> **bearer token becomes the only thing standing between the tailnet and your store.**
> Pair it with Tailscale ACLs restricting who can reach port `4319`, keep the token
> `0600`, and **never bind `0.0.0.0`.** Loopback-only stays the default for a reason.

## Authentication & identity

Two distinct layers — do not conflate them:

1. **Channel auth** — a bearer token generated at `hip install`, stored `0600` in the
   config dir, sent as `Authorization: Bearer <token>`. A missing/wrong token is
   `401`. The token authenticates *the channel*, not the actor.
   **Token-file format contract:** the file holds **exactly** the token — no trailing
   newline — so a consumer comparing raw bytes matches. Compare trimmed values, not raw
   bytes. (Installs predating this contract keep a legacy trailing newline until the next
   `hip install`/`hip rebind` rewrites the file; the daemon `.trim()`s on read regardless.)
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

## Retry / idempotency

Three creates are retry-safe; the rest are not.

- **`reconcile_submit`** — idempotent on `InboundEnvelope.id` (write-once envelope ledger;
  resubmission returns the original verdict).
- **`task_create` and `execution_register`** — accept an optional **`clientKey`**. A retry
  with the same `clientKey` **and the same payload** returns the original object (no
  duplicate); the same `clientKey` with a **different** payload returns `conflict` (a
  client bug, surfaced rather than silently merged). Omitting `clientKey` preserves the
  non-idempotent behavior. Keys are **per-actor** and recorded in a write-once
  `creation_keys` ledger mirroring the envelope ledger. Derive the key deterministically
  from the work (never random) so a genuine retry reuses it.

A remote agent on a flaky link should pass a `clientKey` on these creates so a
retried-after-uncertain-success call cannot duplicate. All other mutating tools remain
non-idempotent in the MVP.

## Tool surface (v1, shipped)

Tool names use underscores — major MCP hosts enforce `^[a-zA-Z0-9_-]{1,128}$`, so the
dotted spec shorthand (`task.read`) would fail at the client. Dotted names survive as
documentation only.

| HIP primitive | Tool(s) |
|---|---|
| Task | `task_create` (optional `clientKey`), `task_read` (orient-first), `task_update` (content only), `task_list` (filters: `status`, `tag`, `onActor` — AND-combined) |
| Transitions | `task_wait`, `task_done`, `task_drop`, `task_block(taskId, executionId, reason)` |
| Decision | `decision_create`, `decision_list`, `decision_get`, `decision_resolve`, `decision_snooze` |
| Reconcile | `reconcile_submit` (InboundEnvelope → ReconcileResult; synchronous, deterministic) |
| Execution | `execution_register` (optional `clientKey`), `execution_get`, `execution_heartbeat` |
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

## Troubleshooting: 401 vs 403 (different gates — do not conflate)

These are two distinct guards. A `401` is the **token** gate; a `403` is the
**DNS-rebinding Host/Origin** gate. They fail for unrelated reasons and have different
fixes.

- **`401 unauthorized`** — the `Authorization` header was missing, empty, or malformed.
  The most common real cause is an **unset env var interpolating to an empty Bearer**:
  the client sends `Authorization: Bearer ` with nothing after it, which reads like a
  "bad token" but is actually an unpopulated variable. Confirm the token env var is
  non-empty *before* suspecting the token value — e.g. `echo "[$HIP_TOKEN]"` should show
  the token between the brackets, not `[]`. The token itself lives in the `0600` token
  file (`cat` it, mind the format contract above).

- **`403` (Host/Origin not allowlisted)** — the request reached the daemon with a valid
  token but a `Host`/`Origin` the DNS-rebinding allowlist does not contain. This is a
  bind/connect-string mismatch, **not** an auth failure: the daemon is bound to one host
  and the client connected by another (or the daemon was not reloaded after a host
  change, so its allowlist is stale). Fix with **`hip rebind <host>`** (which reloads and
  re-verifies), and connect by the exact string `HIP_HOST` is set to. Once bound beyond
  loopback the token is the only gate — see Security above.

## Doctor scopes (CLI vs MCP)

`hip doctor` (CLI) runs **store consistency plus network/bind-reality** checks — service
unit↔config host mismatch, unsafe bind, systemd linger (Linux), and dist staleness —
because those need config/unit/filesystem context. The `doctor_run` MCP tool is
**store-scoped only** (it marks its
result `scope: store-only`); an agent calling it over MCP will not see bind-reality
issues. Diagnose host-mismatch, bind safety, and staleness from the CLI.

## Storage model (informative)

The daemon's durability story (see `README.md`): markdown files are the human-editable
truth for tasks/decisions/entities/actors; SQLite holds the derived index/timers plus
the **authoritative** envelope ledger and executions; an append-only `events.jsonl` is
the audit + learning trail. The `~/hip-data/` data directory is the backup unit. None of
this is visible across the binding — clients see only tool calls and HIP objects.
