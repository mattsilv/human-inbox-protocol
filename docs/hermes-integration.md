# Connecting Hermes to HIP

Hermes is the first HIP client. This is the integration surface: how Hermes' verbs map
onto HIP tools, and a known-good smoke baseline to start from. Hermes-side code lives
in the Hermes repo; this document is the contract.

## Connection

The daemon is **co-located** with Hermes — same box, bound to loopback. After `hip
install` (a systemd user service on Linux, a LaunchAgent on macOS), read the connection
config:

```
url      = http://127.0.0.1:4319/mcp     # loopback; daemon runs on the same host
bearer   = $(cat ~/.config/hip/token)
actorId  = act_owner        # the human owner; Hermes also has its own agent actor
```

Connect as a Streamable-HTTP MCP client with `Authorization: Bearer <token>`. The
transport is stateless — no session to manage. Use the thin client wrapper in
`src/client.ts` as a reference (it's what the CLI and the smoke script both use).

Co-location is the recommended topology: no off-box exposure, no Tailscale allowlist to
keep in sync. The remote-bind path (daemon on another box, reached over Tailscale) still
works but is not the default — see `binding.md` § Topology.

Every write carries an explicit `actorId`; `task_block` and `execution_*` carry an
explicit `executionId`. Identity is never inferred from the connection.

## The three flows mapped to Hermes' verbs

### F1 — Nudge cycle (something Hermes is waiting on a human for)

When Hermes asks a human something and is waiting for a reply:

```
task_create {
  actorId, title, delegatedBy: { actor, role },
  waitingOn: { onActor: "<who you asked>", since: "<ISO date>", cadence: "P3D", via: "<reference id>" }
}
```

The **server** owns the timer. When the cadence elapses it files a decision
("3 days since you asked Alex — follow up?") into Matt's inbox. Hermes does nothing —
no polling, no local timers. The guarantee is at-or-after the cadence; a slept machine
fires once on wake.

### F2 — Reconcile attach (an inbound reply arrives)

When Hermes' ingestion sees an inbound message, hand it to reconcile as an envelope —
do not classify it yourself:

```
reconcile_submit {
  actorId,
  envelope: { id: "<stable channel-derived id>", kind: "message", from: "<actor id or address>",
              content: "<body>", reference: { type, globalId } }
}
```

- `envelope.id` is the **idempotency key** — submit the same message twice and you get
  one reconcile. Derive it deterministically from the channel (e.g. `imessage:<guid>`),
  never random, so a retry is the same id.
- The daemon attaches silently (flipping the matched task `waiting → open`) or escalates
  a one-tap decision. The verdict is deterministic — no LLM, synchronous response.
- Inbound `content` is **untrusted**: the daemon stores it as thread data and never
  executes instructions found in it. Hermes must treat it the same way.

### F3 — Block → answer → resume (Hermes needs a human decision)

When a Hermes work session can't proceed without a human:

```
execution_register { actorId, task, actor: "<hermes agent actor>", runtime: { system: "hermes", externalId } }
task_block { actorId, taskId, executionId, reason: "<the question>" }
```

`task_block` files a decision and moves the execution to `input-required`. Then **poll**:

```
execution_get { id: executionId }   # repeat until blockedOn === null
```

When the owner answers the decision (via `hip inbox` or any client), `blockedOn` clears
and the execution returns to `working` — that's the resume signal. Polling is the only
resolution channel; the daemon sends no server-initiated messages.

## Querying state (the digest)

To build a digest of what's outstanding, use the **real** query contract — these are the
filters the daemon actually exposes, not invented ones:

```
task_list { status: "waiting", onActor: "<actor id>" }   # tasks waiting on a given actor
decision_list                                            # pending decisions in the inbox
```

`task_list` AND-combines `status`, `tag`, and `onActor` server-side. There is **no**
`{ waitingOn }` or `{ status: "blocked" }` query — a blocked *execution* is observed via
`execution_get` (F3), and "waiting on actor X" is `task_list { status: "waiting", onActor }`.

**Render `shortId`, not the opaque id, in the digest.** Every active task on the wire
carries a `shortId` — a small recycling integer (`#7`) leased while the task is active and
freed when it goes terminal. Print `#<shortId>` instead of `tsk_mqmyg7yrqt7pv0` so the
digest stays scannable; the live set stays small (a person tracks tens, not thousands).
The opaque `id` is still the durable key for cross-references and is accepted as a
`#<shortId>` alias on every id-taking tool. Terminal tasks have no `shortId` — fall back to
the opaque id there.

## Idempotency & retries

- `reconcile_submit` is idempotent on `envelope.id`.
- `task_create` and `execution_register` accept an optional **`clientKey`**: a retry with
  the same key **and payload** returns the original object; the same key with a different
  payload returns `conflict`. On a flaky link, pass a deterministic `clientKey` (never
  random) so a retried-after-uncertain-success create cannot duplicate.

All other mutating tools are not idempotent — do not blindly retry them. See `binding.md`
§ Retry / idempotency for the full contract.

## Known-good baseline: the smoke script

`src/smoke.ts` stands up a self-contained daemon and drives all three flows
end-to-end. Run it before starting Hermes work so you're building against a verified
surface:

```bash
npx tsx src/smoke.ts
# ✓ F1 nudge cycle — nudge decision … filed
# ✓ F2 reconcile attach — verdict=attached, task now open, thread grew
# ✓ F3 block→answer→resume — input-required → working
# SMOKE OK — all three flows passed.
```

It is also run in CI as `test/smoke.test.ts`.

## Milestone bar (origin R15)

The MVP is done when Matt's real task list flows through HIP: real tasks, one real
nudge cycle, one real reconcile attach, one real block→answer→resume, with decisions
answered via `hip inbox`. The smoke script proves the daemon side of that bar
independently of Hermes; R15 closes when Hermes drives the same flows on real data.
