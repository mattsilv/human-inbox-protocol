import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { Store, filePath } from "../src/store/index.js";
import { Domain } from "../src/domain/index.js";
import {
  hasDemoData,
  hasRealActiveTasks,
  cleanDemoData,
  maybeCleanDemo,
} from "../src/domain/demo-cleanup.js";
import { tmpRoot, cleanup, FakeClock } from "./helpers.js";

const MATT = "act_matt";
const AGENT = "act_agent";

describe("demo auto-cleanup (U3/U4)", () => {
  let root: string;
  let store: Store;
  let d: Domain;

  beforeEach(() => {
    root = tmpRoot();
    store = new Store({ root, clock: new FakeClock(Date.parse("2026-06-18T12:00:00Z")) });
    d = new Domain(store);
    d.createActor({ id: MATT, kind: "person", displayName: "Matt" });
    d.createActor({ id: AGENT, kind: "agent", displayName: "Agent" });
  });
  afterEach(() => {
    store.close();
    cleanup(root);
  });

  function demoTask(title: string, over: Record<string, unknown> = {}): string {
    return d.createTask(
      { title, delegatedBy: { actor: MATT, role: "creator" }, _meta: { demo: true }, ...over },
      MATT,
    ).id;
  }
  function realTask(title: string): string {
    return d.createTask({ title, delegatedBy: { actor: MATT, role: "creator" } }, MATT).id;
  }
  function count(sql: string, ...params: unknown[]): number {
    return (store.db.prepare(sql).get(...params) as { n: number }).n;
  }

  it("hasDemoData reflects is_demo rows", () => {
    expect(hasDemoData(store.db)).toBe(false);
    demoTask("seed");
    expect(hasDemoData(store.db)).toBe(true);
  });

  it("hasRealActiveTasks: open/waiting count, done/dropped do not", () => {
    expect(hasRealActiveTasks(store.db)).toBe(false);
    const id = realTask("real open");
    expect(hasRealActiveTasks(store.db)).toBe(true);
    d.markDone(id, MATT);
    expect(hasRealActiveTasks(store.db)).toBe(false);
    // A demo task in an active state must not count as real-active.
    demoTask("seed open");
    expect(hasRealActiveTasks(store.db)).toBe(false);
  });

  it("cleanDemoData removes demo tasks/decisions/executions/envelopes and files, keeps real", () => {
    // Real task first so the createTask hook is a no-op (no demo data yet); then seed
    // the demo task and its satellites, and clean explicitly below.
    const realId = realTask("real task");
    const demoId = demoTask("demo blocked");
    // Linked decision + execution on the demo task, plus a demo envelope row.
    const dec = d.createDecision({ task: demoId, prompt: "pick", kind: "block" }, MATT);
    const exe = d.registerExecution({ task: demoId, actor: AGENT }, AGENT);
    store.db
      .prepare(`INSERT INTO envelopes (id, kind, task_id, created_at) VALUES (?,?,?,?)`)
      .run("env_demo_1", "email", demoId, store.nowIso());

    const demoFile = filePath(store.paths, "task", demoId);
    const decFile = filePath(store.paths, "decision", dec.id);
    const realFile = filePath(store.paths, "task", realId);
    expect(existsSync(demoFile) && existsSync(decFile) && existsSync(realFile)).toBe(true);

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    cleanDemoData(store);
    expect(spy).toHaveBeenCalledWith("Demo data removed — starting fresh.\n");
    spy.mockRestore();

    // DB: every reference to the demo task is gone; real task untouched.
    expect(count(`SELECT COUNT(*) AS n FROM task_index WHERE is_demo = 1`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM decision_index WHERE id = ?`, dec.id)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM executions WHERE id = ?`, exe.id)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM envelopes WHERE task_id = ?`, demoId)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM task_index WHERE id = ?`, realId)).toBe(1);

    // Files: demo task + decision gone, real task intact.
    expect(existsSync(demoFile)).toBe(false);
    expect(existsSync(decFile)).toBe(false);
    expect(existsSync(realFile)).toBe(true);
  });

  it("cleanDemoData is idempotent with no demo data (no errors)", () => {
    realTask("real");
    expect(() => {
      cleanDemoData(store);
      cleanDemoData(store);
    }).not.toThrow();
  });

  it("maybeCleanDemo: cleans only when demo and real-active coexist", () => {
    // No demo data → no-op.
    expect(maybeCleanDemo(store)).toBe(false);

    // Only demo data, no real task yet → no-op (seed must survive until first real task).
    const demoId = demoTask("seed");
    expect(maybeCleanDemo(store)).toBe(false);
    expect(hasDemoData(store.db)).toBe(true);

    // Real active task present → the createTask hook cleans during creation.
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    realTask("first real");
    expect(spy).toHaveBeenCalledWith("Demo data removed — starting fresh.\n");
    // Already cleaned by the hook; an explicit call is now a no-op.
    expect(maybeCleanDemo(store)).toBe(false);
    spy.mockRestore();
    expect(hasDemoData(store.db)).toBe(false);
    expect(existsSync(filePath(store.paths, "task", demoId))).toBe(false);
  });

  it("createTask hook: first real task sweeps demo seed; demo creates do not", () => {
    const demoId = demoTask("seed open");
    demoTask("seed two");
    expect(count(`SELECT COUNT(*) AS n FROM task_index WHERE is_demo = 1`)).toBe(2);

    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const realId = realTask("real");
    expect(spy).toHaveBeenCalledWith("Demo data removed — starting fresh.\n");
    spy.mockRestore();

    expect(count(`SELECT COUNT(*) AS n FROM task_index WHERE is_demo = 1`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM task_index WHERE id = ?`, realId)).toBe(1);
    expect(existsSync(filePath(store.paths, "task", demoId))).toBe(false);

    // Creating another demo task afterward does not trigger cleanup of itself.
    const laterDemo = demoTask("late seed");
    expect(count(`SELECT COUNT(*) AS n FROM task_index WHERE id = ?`, laterDemo)).toBe(1);
  });
});
