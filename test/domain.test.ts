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
    expect(t.status).toBe("open");

    d.setWaiting(t.id, { onActor: "act_alex", since: "2026-06-09", cadence: "P3D" }, MATT);
    expect(store.getTask(t.id)!.status).toBe("waiting");
    expect(store.getTask(t.id)!.waitingOn?.onActor).toBe("act_alex");

    d.setWaiting(t.id, null, MATT);
    expect(store.getTask(t.id)!.status).toBe("open");
    expect(store.getTask(t.id)!.waitingOn).toBeNull();

    d.markDone(t.id, MATT);
    expect(store.getTask(t.id)!.status).toBe("done");

    expect(taskEventKinds(t.id)).toEqual([
      "created",
      "status-changed",
      "status-changed",
      "status-changed",
    ]);
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
    expect(store.getTask(t.id)!.status).toBe("open"); // two-state-machines: task untouched

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
