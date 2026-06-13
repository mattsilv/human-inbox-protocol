# Connecting Hermes to HIP

Hermes is the first HIP client. This is the integration surface: how Hermes' verbs map
onto HIP tools, and a known-good smoke baseline to start from. Hermes-side code lives
in the Hermes repo; this document is the contract.

## Connection

After `hip install`, read the connection config:

```
url      = http://127.0.0.1:4319/mcp
bearer   = $(cat ~/.config/hip/token)
actorId  = act_owner        # Matt; Hermes also has its own agent actor, e.g. act_hermes
```

Connect as a Streamable-HTTP MCP client with `Authorization: Bearer <token>`. The
transport is stateless — no session to manage. Use the thin client wrapper in
`src/client.ts` as a reference (it's what the CLI and the smoke script both use).

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

When Matt answers the decision (via `hip inbox` or any client), `blockedOn` clears and
the execution returns to `working` — that's the resume signal. Polling is the only
resolution channel; the daemon sends no server-initiated messages.

## Idempotency & retries

Only `reconcile_submit` is idempotent (on `envelope.id`). Other creates can duplicate on
retry — Hermes should not blindly retry a `task_create` that may have succeeded. The
v2-era fix is client-supplied creation ids; not yet implemented.

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
