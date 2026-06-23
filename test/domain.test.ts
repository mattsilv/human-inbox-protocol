import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/index.js";
import { doctor } from "../src/store/index.js";
import { Domain, HipError } from "../src/domain/index.js";
import { tmpRoot, cleanup, FakeClock } from "./helpers.js";

const MATT = "act_matt";

describe("domain layer (U3)", () => {
  let root: string;
  let clock: FakeClock;
  let store: Store;
  let d: Domain;

  beforeEach(() => {
    root = tmpRoot();
    clock = new FakeClock(Date.parse("2026-06-12T12:00:00Z"));
    store = new Store({ root, clock });
    d = new Domain(store);
    d.createActor({ id: MATT, kind: "person", displayName: "Matt" });
  });
  afterEach(() => {
    store.close();
    cleanup(root);
  });

  function taskEventKinds(taskId: string): string[] {
    return store.events.forTask(taskId).map((e) => e.kind);
  }

  it("runs a full lifecycle open→waiting→open→done with an event per transition", () => {
    const t = d.createTask({ title: "Dinner with Alex", delegatedBy: { actor: MATT, role: "creator" } }, MATT);
    expect(t.state.kind).toBe("open");

    d.setWaiting(t.id, { onActor: "act_alex", since: "2026-06-09", cadence: "P3D" }, MATT);
    const waiting = store.getTask(t.id)!.state;
    expect(waiting.kind).toBe("waiting");
    expect(waiting.kind === "waiting" ? waiting.onActor : null).toBe("act_alex");

    d.setWaiting(t.id, null, MATT);
    expect(store.getTask(t.id)!.state.kind).toBe("open");

    d.markDone(t.id, MATT);
    expect(store.getTask(t.id)!.state.kind).toBe("done");

    expect(taskEventKinds(t.id)).toEqual([
      "created",
      "status-changed",
      "status-changed",
      "status-changed",
    ]);
  });

  it("tags: create stores tags, list filters by tag, status+tag AND-combine", () => {
    const gap = d.createTask(
      { title: "gap a", tags: ["protocol-gap"], delegatedBy: { actor: MATT, role: "creator" } },
      MATT,
    );
    expect(gap.tags).toEqual(["protocol-gap"]);
    const plain = d.createTask({ title: "plain", delegatedBy: { actor: MATT, role: "creator" } }, MATT);

    const tagged = d.listTasks({ tag: "protocol-gap" }).map((t) => t.id);
    expect(tagged).toContain(gap.id);
    expect(tagged).not.toContain(plain.id);

    // status + tag AND-combine: once done, the gap drops out of the open+tag filter.
    d.markDone(gap.id, MATT);
    expect(d.listTasks({ status: "open", tag: "protocol-gap" }).map((t) => t.id)).not.toContain(gap.id);
    expect(d.listTasks({ status: "done", tag: "protocol-gap" }).map((t) => t.id)).toContain(gap.id);

    // task_read DTO surfaces tags.
    expect(d.orient(gap.id)!.task.tags).toEqual(["protocol-gap"]);
  });

  it("tags: empty array stores nothing; duplicates de-duplicate", () => {
    const empty = d.createTask(
      { title: "empty", tags: [], delegatedBy: { actor: MATT, role: "creator" } },
      MATT,
    );
    expect(empty.tags).toBeUndefined();
    expect(d.listTasks({ tag: "protocol-gap" }).map((t) => t.id)).not.toContain(empty.id);

    const dup = d.createTask(
      { title: "dup", tags: ["x", "x", "y"], delegatedBy: { actor: MATT, role: "creator" } },
      MATT,
    );
    expect(dup.tags).toEqual(["x", "y"]);
  });

  it("rejects task create without provenance and any mutation without an actor", () => {
    expect(() =>
      d.createTask({ title: "x", delegatedBy: { actor: "", role: "creator" } }, MATT),
    ).toThrowError(HipError);
    const t = d.createTask({ title: "y", delegatedBy: { actor: MATT, role: "creator" } }, MATT);
    expect(() => d.updateTask(t.id, { title: "z" }, "")).toThrowError(/actorId is required/);
  });

  it("task_update rejects status and waiting fields (one verb per transition)", () => {
    const t = d.createTask({ title: "x", delegatedBy: { actor: MATT, role: "creator" } }, MATT);
    expect(() => d.updateTask(t.id, { status: "done" }, MATT)).toThrowError(/cannot change "status"/);
    expect(() => d.updateTask(t.id, { waitingOn: {} }, MATT)).toThrowError(/cannot change "waitingOn"/);
    // content field is fine
    const u = d.updateTask(t.id, { title: "renamed", priority: "high" }, MATT);
    expect(u.title).toBe("renamed");
    expect(u.priority).toBe("high");
  });

  it("AE3: snooze re-surfaces after snoozedUntil; dismiss is terminal", () => {
    const dec = d.createDecision({ prompt: "Fold laundry now?" }, MATT);
    expect(d.listPendingDecisions().map((x) => x.id)).toContain(dec.id);

    d.snoozeDecision(dec.id, "2026-06-12T18:00:00Z", MATT);
    expect(d.listPendingDecisions().map((x) => x.id)).not.toContain(dec.id);

    clock.set(Date.parse("2026-06-12T18:30:00Z"));
    expect(d.listPendingDecisions().map((x) => x.id)).toContain(dec.id);

    d.dismissDecision(dec.id, MATT);
    expect(d.getDecision(dec.id)!.resolution?.kind).toBe("dismissed");
    expect(d.listPendingDecisions().map((x) => x.id)).not.toContain(dec.id);
  });

  it("AE4: a decision past expiresAt resolves as expired and keeps the event", () => {
    const dec = d.createDecision({ prompt: "RSVP?", expiresAt: "2026-06-12T13:00:00Z" }, MATT);
    clock.set(Date.parse("2026-06-12T13:00:01Z"));
    const got = d.getDecision(dec.id)!;
    expect(got.resolution?.kind).toBe("expired");
    const kinds = store.events.forDecision(dec.id).map((e) => e.kind);
    expect(kinds).toContain("decision-resolved");
    expect(d.listPendingDecisions().map((x) => x.id)).not.toContain(dec.id);
  });

  it("rejects resolving an already-resolved decision with no duplicate event", () => {
    const dec = d.createDecision({ prompt: "Pick", options: [{ id: "a", label: "A" }] }, MATT);
    d.resolveDecision(dec.id, { kind: "option", optionId: "a" }, MATT);
    const before = store.events.forDecision(dec.id).filter((e) => e.kind === "decision-resolved").length;
    expect(() => d.resolveDecision(dec.id, { kind: "option", optionId: "a" }, MATT)).toThrowError(
      /already resolved/,
    );
    const after = store.events.forDecision(dec.id).filter((e) => e.kind === "decision-resolved").length;
    expect(after).toBe(before);
    expect(before).toBe(1);
  });

  it("block→answer→resume: resolving the block decision clears the execution", () => {
    const t = d.createTask({ title: "Research flights", delegatedBy: { actor: MATT, role: "creator" } }, MATT);
    const exe = d.registerExecution({ task: t.id, actor: "act_agent" }, "act_agent");
    const { decision } = d.block({ task: t.id, execution: exe.id, reason: "Which dates?" }, "act_agent");

    const blocked = d.getExecution(exe.id)!;
    expect(blocked.status).toBe("input-required");
    expect(blocked.blockedOn).toBe(decision.id);
    expect(store.getTask(t.id)!.state.kind).toBe("open"); // two-state-machines: task untouched

    d.resolveDecision(decision.id, { kind: "freeText", freeText: "June 20-24" }, MATT);
    const resumed = d.getExecution(exe.id)!;
    expect(resumed.status).toBe("working");
    expect(resumed.blockedOn).toBeNull();
  });

  it("reopen: resolved-by-option decision returns to pending (R1)", () => {
    const dec = d.createDecision({ prompt: "Pick", options: [{ id: "a", label: "A" }] }, MATT);
    d.resolveDecision(dec.id, { kind: "option", optionId: "a" }, MATT);
    expect(d.listPendingDecisions().map((x) => x.id)).not.toContain(dec.id);

    d.reopenDecision(dec.id, MATT);
    expect(d.getDecision(dec.id)!.resolution).toBeNull();
    expect(d.listPendingDecisions().map((x) => x.id)).toContain(dec.id);
  });

  it("reopen: a resumed block execution is re-blocked input-required (R2)", () => {
    const t = d.createTask({ title: "Research flights", delegatedBy: { actor: MATT, role: "creator" } }, MATT);
    const exe = d.registerExecution({ task: t.id, actor: "act_agent" }, "act_agent");
    const { decision } = d.block({ task: t.id, execution: exe.id, reason: "Which dates?" }, "act_agent");
    d.resolveDecision(decision.id, { kind: "freeText", freeText: "June 20-24" }, MATT);
    expect(d.getExecution(exe.id)!.status).toBe("working");

    d.reopenDecision(decision.id, MATT);
    const reblocked = d.getExecution(exe.id)!;
    expect(reblocked.status).toBe("input-required");
    expect(reblocked.blockedOn).toBe(decision.id);
  });

  it("reopen: a snoozed decision clears snoozedUntil and is pending again (R1)", () => {
    const dec = d.createDecision({ prompt: "Later?" }, MATT);
    d.snoozeDecision(dec.id, "2026-06-12T18:00:00Z", MATT);
    expect(d.listPendingDecisions().map((x) => x.id)).not.toContain(dec.id);

    d.reopenDecision(dec.id, MATT);
    expect(d.getDecision(dec.id)!.snoozedUntil).toBeNull();
    expect(d.listPendingDecisions().map((x) => x.id)).toContain(dec.id);
  });

  it("reopen: an already-open decision is a no-op with no spurious events (R1)", () => {
    const dec = d.createDecision({ prompt: "Open?" }, MATT);
    const before = store.events.forDecision(dec.id).length;
    const out = d.reopenDecision(dec.id, MATT);
    expect(out.resolution ?? null).toBeNull();
    expect(store.events.forDecision(dec.id).length).toBe(before);
  });

  it("reopen: resolved decision whose task has no working execution reopens without throwing (R2)", () => {
    const t = d.createTask({ title: "x", delegatedBy: { actor: MATT, role: "creator" } }, MATT);
    const exe = d.registerExecution({ task: t.id, actor: "act_agent" }, "act_agent");
    const { decision } = d.block({ task: t.id, execution: exe.id, reason: "?" }, "act_agent");
    d.resolveDecision(decision.id, { kind: "dismissed" }, MATT);
    // Move the execution off `working` so reopen finds nothing to re-block.
    d.setExecutionStatus(exe.id, "completed", "act_agent");

    expect(() => d.reopenDecision(decision.id, MATT)).not.toThrow();
    expect(d.getDecision(decision.id)!.resolution).toBeNull();
    expect(d.getExecution(exe.id)!.status).toBe("completed");
  });

  it("reopen: a dismissed decision returns to pending (R1)", () => {
    const dec = d.createDecision({ prompt: "Nope?" }, MATT);
    d.dismissDecision(dec.id, MATT);
    d.reopenDecision(dec.id, MATT);
    expect(d.getDecision(dec.id)!.resolution).toBeNull();
    expect(d.listPendingDecisions().map((x) => x.id)).toContain(dec.id);
  });

  it("doctor flags a resolved decision whose execution is still blocked (stuck resume)", () => {
    const t = d.createTask({ title: "x", delegatedBy: { actor: MATT, role: "creator" } }, MATT);
    const exe = d.registerExecution({ task: t.id, actor: "act_agent" }, "act_agent");
    const { decision } = d.block({ task: t.id, execution: exe.id, reason: "?" }, "act_agent");

    // Force the stuck state: resolve the decision file directly without clearing blockedOn.
    const raw = store.getDecision(decision.id)!;
    raw.resolution = { kind: "dismissed", at: store.nowIso() };
    store.writeObjects([{ type: "decision", obj: raw as never }], []);

    const rep = doctor(store);
    expect(rep.ok).toBe(false);
    expect(rep.issues.some((i) => i.code === "stuck-block" && i.id === exe.id)).toBe(true);
  });

  it("rejects transitioning a terminal task", () => {
    const t = d.createTask({ title: "x", delegatedBy: { actor: MATT, role: "creator" } }, MATT);
    d.markDone(t.id, MATT);
    expect(() => d.markDropped(t.id, MATT)).toThrowError(/cannot transition/);
    expect(() => d.setWaiting(t.id, { onActor: "act_alex", since: "2026-06-09" }, MATT)).toThrowError(
      /cannot change waiting/,
    );
  });
});

describe("short-id allocation + recycling (U2)", () => {
  let root: string;
  let store: Store;
  let d: Domain;
  const mk = (title: string) =>
    d.createTask({ title, delegatedBy: { actor: MATT, role: "creator" } }, MATT);

  beforeEach(() => {
    root = tmpRoot();
    store = new Store({ root, clock: new FakeClock(Date.parse("2026-06-12T12:00:00Z")) });
    d = new Domain(store);
    d.createActor({ id: MATT, kind: "person", displayName: "Matt" });
  });
  afterEach(() => {
    store.close();
    cleanup(root);
  });

  it("assigns #1 to the first task in an empty store", () => {
    expect(mk("first").shortId).toBe(1);
  });

  it("recycles the lowest free number after a terminal task frees it", () => {
    const a = mk("a"); // 1
    const b = mk("b"); // 2
    const c = mk("c"); // 3
    expect([a.shortId, b.shortId, c.shortId]).toEqual([1, 2, 3]);
    d.markDropped(b.id, MATT); // frees #2
    expect(mk("d").shortId).toBe(2); // lowest-free reuse, not 4
  });

  it("clears shortId on done; the number is reused by the next create", () => {
    const a = mk("a"); // 1
    d.markDone(a.id, MATT);
    expect(store.getTask(a.id)!.shortId).toBeUndefined(); // freed on terminal
    expect(mk("b").shortId).toBe(1); // reused
  });

  it("keeps shortId stable across waiting↔open (still active)", () => {
    const a = mk("a"); // 1
    d.setWaiting(a.id, { onActor: "act_alex", since: "2026-06-09" }, MATT);
    expect(store.getTask(a.id)!.shortId).toBe(1);
    d.setWaiting(a.id, null, MATT);
    expect(store.getTask(a.id)!.shortId).toBe(1);
  });

  it("never writes shortId into the append-only event log (R4)", () => {
    const a = mk("a");
    d.markDone(a.id, MATT);
    const evs = store.events.forTask(a.id);
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs) {
      expect(JSON.stringify(e)).not.toContain("shortId");
    }
  });

  it("resolveTaskRef maps #N and bare N to the active opaque id; passes opaque through", () => {
    const a = mk("a"); // #1
    expect(d.resolveTaskRef("#1")).toBe(a.id);
    expect(d.resolveTaskRef("1")).toBe(a.id);
    expect(d.resolveTaskRef(a.id)).toBe(a.id); // opaque passthrough
  });

  it("resolveTaskRef throws not-found for a #N with no active holder", () => {
    expect(() => d.resolveTaskRef("#999")).toThrowError(/no active task #999/);
  });

  it("resolveTaskRef follows a recycled number to its new owner, never the terminal task", () => {
    mk("a"); // #1
    const b = mk("b"); // #2
    d.markDropped(b.id, MATT); // frees #2
    const c = mk("c"); // reuses #2
    expect(c.shortId).toBe(2);
    expect(d.resolveTaskRef("#2")).toBe(c.id); // new owner, not b
  });
});

describe("actor_delete (U6)", () => {
  let root: string;
  let store: Store;
  let d: Domain;

  beforeEach(() => {
    root = tmpRoot();
    store = new Store({ root, clock: new FakeClock(Date.parse("2026-06-12T12:00:00Z")) });
    d = new Domain(store);
    d.createActor({ id: MATT, kind: "person", displayName: "Matt" });
  });
  afterEach(() => {
    store.close();
    cleanup(root);
  });

  it("hard-deletes an unreferenced (mis-created) actor — its own creation event doesn't block", () => {
    d.createActor({ id: "act_mis", kind: "person", displayName: "Mistake" });
    expect(store.getActor("act_mis")).not.toBeNull();
    expect(d.deleteActor("act_mis")).toEqual({ id: "act_mis" });
    expect(store.getActor("act_mis")).toBeNull();
  });

  it("throws not-found for a missing actor", () => {
    expect(() => d.deleteActor("act_ghost")).toThrowError(/not found/);
  });

  it("refuses when the actor delegated a task (provenance)", () => {
    d.createActor({ id: "act_used", kind: "person", displayName: "Used" });
    d.createTask({ title: "t", delegatedBy: { actor: "act_used", role: "creator" } }, "act_used");
    expect(() => d.deleteActor("act_used")).toThrowError(/in use/);
    expect(store.getActor("act_used")).not.toBeNull(); // not deleted
  });

  it("refuses when a task is waiting on the actor", () => {
    d.createActor({ id: "act_wait", kind: "person", displayName: "W" });
    const t = d.createTask({ title: "t", delegatedBy: { actor: MATT, role: "creator" } }, MATT);
    d.setWaiting(t.id, { onActor: "act_wait", since: "2026-06-09" }, MATT);
    expect(() => d.deleteActor("act_wait")).toThrowError(/in use/);
  });

  it("refuses when the actor authored an event beyond its own creation (append-only log)", () => {
    d.createActor({ id: "act_cmt", kind: "person", displayName: "Commenter" });
    const t = d.createTask({ title: "t", delegatedBy: { actor: MATT, role: "creator" } }, MATT);
    d.appendThread(t.id, { actor: "act_cmt", content: "weighing in" }, "act_cmt"); // commented event
    expect(() => d.deleteActor("act_cmt")).toThrowError(/in use/);
  });
});
