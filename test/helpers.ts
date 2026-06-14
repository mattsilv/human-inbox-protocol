import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, newId } from "../src/store/index.js";
import type { Clock } from "../src/store/index.js";
import type { Task, HipEvent } from "../src/types.js";

export function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "hip-test-"));
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** A test clock whose value the test advances explicitly. */
export class FakeClock implements Clock {
  constructor(private ms: number) {}
  now(): number {
    return this.ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

let seq = 0;

export function makeTask(store: Store, over: Partial<Task> = {}): Task {
  const now = store.nowIso();
  const id = over.id ?? newId("task");
  const task: Task = {
    id,
    title: `task ${seq++}`,
    state: { kind: "open" },
    delegatedBy: { actor: "act_matt", role: "creator" },
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  const ev: HipEvent = {
    id: newId("event"),
    task: id,
    actor: task.delegatedBy.actor,
    kind: "created",
    at: now,
  };
  store.writeObjects([{ type: "task", obj: task as unknown as Record<string, unknown> }], [ev]);
  return task;
}
