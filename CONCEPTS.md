# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Relationships

- An **Actor** is the subject of every write; a **Task** records which Actor delegated it (provenance) and, when waiting, which Actor it waits on.
- A **Task** owns its **Thread** and its **References**; it has many **Executions** and many **Events**.
- A **Decision** may belong to a Task or stand alone; a **Block** is a Decision that links one **Execution**.
- A Task's status and an Execution's status are independent state machines (the two-state-machines rule).

## The protocol

### HIP
The agent↔human interaction protocol: a small, local-first contract for the things agents and humans owe each other — work that outlives a session, questions answerable in one tap, follow-ups on what someone is waiting for, and inbound messages that need to find their place. "Human Inbox Protocol."

## Task

### Task
A unit of work owed to or by a human that outlives any agent session. Distinct from an agent's ephemeral work session (that is an Execution) — the two never share a status. A Task carries required provenance (who delegated it), a Thread, and References.

Status is `open`, `waiting`, `done`, or `dropped`. A Task is `waiting` if and only if it carries a waitingOn payload; `done` and `dropped` are terminal. Content edits never change status — each transition has its own dedicated write path so the Event log stays unambiguous (one verb per transition).

### Orient-first
The rule that reading a Task returns everything an agent needs to start work in one call — title, status, provenance, full Thread, References, prior Executions, recent Events — with no side-channel context required.

### Thread
The append-only conversation substrate on a Task that humans and agents both write to, and where Reconcile appends inbound messages. Distinct from the Event log: the Thread is what was said about the Task, the Event log is what changed.

### waitingOn
The payload on a `waiting` Task naming the Actor being waited on, when the wait began, and the optional nudge cadence. Its presence is what makes a Task `waiting`; clearing it returns the Task to `open`.

### Display id
The small recycling integer (`#42`) leased to a Task while it is active (`open`/`waiting`) so a human tracks a short handle instead of the opaque `tsk_…` id. Stored authoritatively as `shortId` in frontmatter, mirrored into the index; assigned lowest-free at create and freed (cleared) on terminal, so the live set stays small. Display-only: never canonical, never a foreign key, and never written to the append-only Event log (recycling a number must not make past entries ambiguous). Accepted as a `#N` alias on any Task-id input.
*Avoid:* task number (the opaque id is the canonical identity, not this).

## Decision

### Decision
One question surfaced to a human, answerable in one tap, optionally attached to a Task (standalone is allowed). Beyond its options it always supports four affordances: free text, snooze, dismiss, and expiry.
*Avoid:* prompt, question.

Snooze is non-terminal — it delays re-delivery without resolving. Dismiss is terminal. An unanswered Decision past its expiry resolves as `expired` rather than being silently deleted, so the Event log retains it.

### Block
The agent's name for filing a Decision that pauses the calling Execution until a human answers. Humans see a Decision; agents say block — same object, two vocabularies. Resolving the Decision resumes the paused Execution.

### Nudge
A follow-up the server raises when a `waiting` Task's cadence elapses — it files a Decision ("still waiting on X — follow up?"), never an automatic action, keeping a human in the loop. The guarantee is *at or after* the cadence elapses (late is fine, lost is not); real-time delivery is not required.

## Execution

### Execution
An agent's ephemeral work session against a Task — the A2A/MCP sense of "task," kept deliberately separate from a HIP Task. Its status (`working`, `input-required`, and so on) tracks the run, not the work item.

An Execution blocked by a Block points at the unresolved Decision and sits in `input-required`; resolving that Decision clears the link and returns it to `working`. Agents observe this resume by polling — the server initiates nothing.

### Two-state-machines rule
The invariant that a Task's status and an Execution's status evolve independently: blocking an Execution for a human decision does not change the Task's status, and vice versa.

## Context

### Actor
A named participant in the protocol — a person, agent, service, or group — asserted explicitly on every write. Identity is never inferred from the connection; the Actor is the subject of provenance and of waitingOn.

### Provenance
The required record on every Task of which Actor delegated it and in what role (creator or delegator). A Task cannot exist without it.
*Avoid:* delegatedBy (the field name; the concept is provenance).

### Entity
A real-world thing a Task or Decision refers to — a person, vendor, place, or initiative — as opposed to an Actor, which is a participant that acts.

### Reference
A pointer from a Task to where truth lives outside HIP (an email thread, ticket, document, URL). A Reference may carry a stable global id used as the idempotency key when reconciling external updates.

## Flows & ledger

### Reconcile
The flow that maps an inbound message to its place: attach it to the matching Task (flipping `waiting` back to `open`) or escalate it as a Decision. The verdict is deterministic, not model-driven, and inbound content is treated as untrusted data, never as instructions.

### Envelope
The inbound message handed to Reconcile, carrying a caller-supplied stable id that is the idempotency key — submitting the same Envelope twice yields one reconcile and the original verdict.
*Avoid:* InboundEnvelope.

### Creation key
A caller-supplied idempotency key (`clientKey`) on `task_create` and `execution_register`, recorded per-Actor in a write-once ledger mirroring the Envelope's. A retry with the same key and identical payload returns the original object; the same key with a different payload is rejected as a conflict (a client bug, surfaced not merged). Lets a remote agent on a flaky link retry a create safely. Omitting the key preserves non-idempotent creation.

### Event log
The append-only record of state changes (creation, transitions, resolutions, nudges, reconciles), separate from the Thread. It is the audit trail and the learning substrate; it is never updated or deleted, only appended.

### protocol-gap
The marker a HIP client files when it hits missing protocol functionality — a Task tagged `protocol-gap` instead of a silent workaround. The dev-time read side ranks these by how often each gap was hit and turns the top one into a plan.
