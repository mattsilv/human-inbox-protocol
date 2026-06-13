import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, reindex, filePath } from "../src/store/index.js";
import { serialize } from "../src/store/index.js";
import { Domain } from "../src/domain/index.js";
import { NudgeEngine, SYSTEM_ACTOR } from "../src/daemon/nudge.js";
import { tmpRoot, cleanup, FakeClock } from "./helpers.js";
import type { Task } from "../src/types.js";

const MATT = "act_matt";
const DAY = 86_400_000;
const base = Date.parse("2026-06-09T12:00:00Z");

describe("nudge engine (U5)", () => {
  let root: string;
  let clock: FakeClock;
  let store: Store;
  let d: Domain;
  let engine: NudgeEngine;

  beforeEach(() => {
    root = tmpRoot();
    clock = new FakeClock(base);
    store = new Store({ root, clock });
    d = new Domain(store);
    d.createActor({ id: MATT, kind: "person", displayName: "Matt" });
    engine = new NudgeEngine(store, { intervalMs: 1000 });
  });
  afterEach(() => {
    engine.stop();
    store.close();
    cleanup(root);
  });

  function waitingTask(cadence: string | null): Task {
    return d.createTask(
      {
        title: "Dinner with Alex",
        delegatedBy: { actor: MATT, role: "creator" },
        waiting: { onActor: "act_alex", since: "2026-06-09", cadence },
      },
      MATT,
    );
  }

  function pendingNudges(taskId: string): number {
    return store.listPendingDecisions().filter((x) => x.task === taskId && x.kind === "nudge").length;
  }

  it("AE1: a timer due across a sleep fires exactly once on the next tick", () => {
    const t = waitingTask("PT1H");
    clock.set(base + 5 * 3_600_000); // machine slept 5 hours
    const r = engine.tick();
    expect(r.fired).toEqual([t.id]);
    expect(pendingNudges(t.id)).toBe(1); // coalesced — not 5
    expect(engine.slept).toBe(false); // single tick, no drift recorded yet
  });

  it("P3D cadence fires at/after 3 days and advances next_fire_at", () => {
    const t = waitingTask("P3D");
    clock.set(base + 2 * DAY);
    expect(engine.tick().fired).toEqual([]); // not yet due
    clock.set(base + 3 * DAY + 1000);
    expect(engine.tick().fired).toEqual([t.id]);
    const timer = store.allTimers().find((x) => x.task_id === t.id)!;
    expect(timer.next_fire_at).toBeGreaterThan(clock.now()); // advanced into the future
  });

  it("cadence null never fires; leaving waiting removes the timer", () => {
    const t = waitingTask(null);
    expect(store.allTimers()).toHaveLength(0);
    clock.set(base + 100 * DAY);
    expect(engine.tick().fired).toEqual([]);

    const t2 = waitingTask("P1D");
    expect(store.allTimers().some((x) => x.task_id === t2.id)).toBe(true);
    d.setWaiting(t2.id, null, MATT);
    expect(store.allTimers().some((x) => x.task_id === t2.id)).toBe(false);
    expect(t.id).not.toBe(t2.id);
  });

  it("a pending nudge suppresses a duplicate when the timer comes due again", () => {
    const t = waitingTask("P3D");
    clock.set(base + 3 * DAY + 1000);
    engine.tick(); // fire 1 → decision pending, timer → +3d
    clock.set(base + 6 * DAY + 1000); // due again, decision still unresolved
    const r = engine.tick();
    expect(r.fired).toEqual([]);
    expect(r.repaired).toEqual([t.id]);
    expect(pendingNudges(t.id)).toBe(1); // still exactly one
  });

  it("crash repair: decision filed but timer not advanced → no duplicate, no refire after resolve", () => {
    const t = waitingTask("P3D");
    clock.set(base + 3 * DAY + 1000);

    // Simulate a crash AFTER the decision was filed but BEFORE recordNudge advanced.
    const dec = d.createDecision({ task: t.id, prompt: "follow up?", kind: "nudge" }, SYSTEM_ACTOR);
    // timer is still due (next_fire_at unchanged)

    const r = engine.tick();
    expect(r.fired).toEqual([]); // did not duplicate
    expect(r.repaired).toEqual([t.id]); // repaired the stuck timer
    expect(pendingNudges(t.id)).toBe(1);

    // Matt resolves the recovered decision; the next tick must NOT refire seconds later.
    d.resolveDecision(dec.id, { kind: "dismissed" }, MATT);
    const r2 = engine.tick();
    expect(r2.fired).toEqual([]);
    expect(r2.repaired).toEqual([]);
    expect(pendingNudges(t.id)).toBe(0);
  });

  it("dedupe survives an index rebuild (delete hip.db + reindex)", () => {
    const t = waitingTask("P3D");
    clock.set(base + 3 * DAY + 1000);
    d.createDecision({ task: t.id, prompt: "follow up?", kind: "nudge" }, SYSTEM_ACTOR);
    store.close();

    rmSync(join(root, "hip.db"));
    for (const ext of ["-wal", "-shm"]) {
      const f = join(root, `hip.db${ext}`);
      if (existsSync(f)) rmSync(f);
    }
    const s2 = new Store({ root, clock });
    reindex(s2);
    const engine2 = new NudgeEngine(s2, { intervalMs: 1000 });
    const r = engine2.tick();
    engine2.stop();
    expect(r.fired).toEqual([]); // rebuilt decision index → dedupe still holds
    expect(s2.listPendingDecisions().filter((x) => x.task === t.id).length).toBe(1);
    s2.close();
  });

  it("clock moving backward causes no fire storm and does not corrupt next_fire_at", () => {
    const t = waitingTask("P3D");
    clock.set(base + 3 * DAY + 1000);
    engine.tick(); // fire, timer → ~day6
    const before = store.allTimers().find((x) => x.task_id === t.id)!.next_fire_at;

    clock.set(base); // NTP yanks the clock backward
    const r = engine.tick();
    expect(r.fired).toEqual([]);
    const after = store.allTimers().find((x) => x.task_id === t.id)!.next_fire_at;
    expect(after).toBe(before); // untouched
  });

  it("a task marked done by external edit with a due timer suppresses the fire", () => {
    const t = waitingTask("P3D");
    clock.set(base + 3 * DAY + 1000);

    // External $EDITOR marks it done; the index/timer still think it's waiting.
    const done = { ...store.getTask(t.id)!, status: "done" as const, waiting: null };
    writeFileSync(filePath(store.paths, "task", t.id), serialize("task", done as never));

    const r = engine.tick();
    expect(r.fired).toEqual([]);
    expect(pendingNudges(t.id)).toBe(0);
    expect(store.allTimers().some((x) => x.task_id === t.id)).toBe(false); // stale timer dropped
  });
});
