import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Store, reindex, doctor, newId, filePath } from "../src/store/index.js";
import { serialize, deserialize } from "../src/store/index.js";
import type { Task, HipEvent } from "../src/types.js";
import { tmpRoot, cleanup, makeTask, FakeClock } from "./helpers.js";

describe("store layer (U2)", () => {
  let root: string;
  let store: Store;

  beforeEach(() => {
    root = tmpRoot();
    store = new Store({ root });
  });
  afterEach(() => {
    store.close();
    cleanup(root);
  });

  it("round-trips a task including _meta and unknown frontmatter fields", () => {
    const t = makeTask(store, {
      title: "Unpack suitcase",
      description: "from the New York trip",
      priority: "high",
      _meta: { source: "hermes" },
    });
    // Inject an unknown frontmatter field directly on disk (Taskwarrior rule).
    const path = filePath(store.paths, "task", t.id);
    const raw = readFileSync(path, "utf8").replace(/^---\n/, "---\nfutureField: keep-me\n");
    writeFileSync(path, raw);

    const back = store.getTask(t.id)!;
    expect(back.title).toBe("Unpack suitcase");
    expect(back.description).toBe("from the New York trip");
    expect(back.priority).toBe("high");
    expect(back._meta).toEqual({ source: "hermes" });
    expect((back as unknown as Record<string, unknown>).futureField).toBe("keep-me");

    // A daemon rewrite must preserve the unknown field.
    store.writeObjects(
      [{ type: "task", obj: { ...back, status: "done" } as unknown as Record<string, unknown> }],
      [{ id: newId("event"), task: t.id, actor: "act_matt", kind: "status-changed", at: store.nowIso() }],
    );
    const after = readFileSync(path, "utf8");
    expect(after).toContain("futureField: keep-me");
    expect(store.getTask(t.id)!.status).toBe("done");
  });

  it("reindex rebuilds the index from files and is idempotent", () => {
    const a = makeTask(store, { title: "a" });
    makeTask(store, { title: "b", status: "done" });

    const r1 = reindex(store);
    expect(r1.counts.task).toBe(2);
    const r2 = reindex(store);
    expect(r2.counts.task).toBe(2);

    const listed = store.listTasks().map((t) => t.id);
    expect(listed).toContain(a.id);
    expect(store.listTasks({ status: "done" })).toHaveLength(1);
  });

  it("doctor flags an index row with no file and an unindexed file", () => {
    const t = makeTask(store);
    // Delete the file but leave the index row → index-orphan.
    rmSync(filePath(store.paths, "task", t.id));
    let rep = doctor(store);
    expect(rep.ok).toBe(false);
    expect(rep.issues.some((i) => i.code === "index-orphan" && i.id === t.id)).toBe(true);

    // Recreate a file without indexing it → unindexed-file.
    const orphanId = newId("task");
    const obj: Task = {
      id: orphanId,
      title: "ghost",
      status: "open",
      delegatedBy: { actor: "act_matt", role: "creator" },
      createdAt: store.nowIso(),
      updatedAt: store.nowIso(),
    };
    writeFileSync(filePath(store.paths, "task", orphanId), serialize("task", obj as never));
    rep = doctor(store);
    expect(rep.issues.some((i) => i.code === "unindexed-file" && i.id === orphanId)).toBe(true);
  });

  it("doctor flags an event referencing a nonexistent object", () => {
    store.events.append({
      id: newId("event"),
      task: "tsk_doesnotexist",
      actor: "act_matt",
      kind: "created",
      at: store.nowIso(),
    });
    const rep = doctor(store);
    expect(rep.issues.some((i) => i.code === "event-dangling-task")).toBe(true);
  });

  it("delete hip.db then reindex restores index and timers from files", () => {
    const clock = new FakeClock(Date.parse("2026-06-12T00:00:00Z"));
    const s2 = new Store({ root, clock });
    makeTask(s2, {
      title: "dinner with Alex",
      status: "waiting",
      waitingOn: { onActor: "act_alex", since: "2026-06-09", cadence: "P3D", lastNudge: null },
    });
    expect(s2.allTimers()).toHaveLength(1);
    s2.close();

    // Nuke the derived DB entirely.
    rmSync(join(root, "hip.db"));
    for (const ext of ["-wal", "-shm"]) {
      const f = join(root, `hip.db${ext}`);
      if (existsSync(f)) rmSync(f);
    }

    const s3 = new Store({ root, clock });
    expect(s3.allTimers()).toHaveLength(0); // gone with the DB
    reindex(s3);
    const timers = s3.allTimers();
    expect(timers).toHaveLength(1); // rebuilt from the waiting task's frontmatter
    expect(s3.listTasks()).toHaveLength(1);
    // the renamed `waitingOn` key survives the write → reindex → read round-trip
    expect(s3.listTasks()[0].waitingOn?.onActor).toBe("act_alex");
    s3.close();
  });

  it("an intent event without a completed file rename produces no state change", () => {
    // Simulate a crash after event-append, before file rename: the task keeps its
    // prior state, and reindex-from-files is the recovery. No duplicate timers/rows.
    const t = makeTask(store, { title: "original", status: "open" });
    store.events.append({
      id: newId("event"),
      task: t.id,
      actor: "act_matt",
      kind: "status-changed",
      payload: { to: "done" },
      at: store.nowIso(),
    });
    reindex(store);
    reindex(store);
    expect(store.getTask(t.id)!.status).toBe("open"); // file never changed
    expect(store.listTasks()).toHaveLength(1);
    expect(store.allTimers()).toHaveLength(0);
  });

  it("a stray .tmp file is ignored and the original is byte-identical", () => {
    const t = makeTask(store, { title: "keep" });
    const path = filePath(store.paths, "task", t.id);
    const before = readFileSync(path, "utf8");
    writeFileSync(`${path}.99999.tmp`, "garbage half-write");

    const r = reindex(store);
    expect(r.counts.task).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("external edit on disk survives a daemon rewrite and logs external-edit", () => {
    const t = makeTask(store, { title: "shared", description: "agent wrote this" });
    const path = filePath(store.paths, "task", t.id);

    // Human edits an unrelated field via $EDITOR (changes description).
    const edited = deserialize<Task>("task", readFileSync(path, "utf8"));
    edited.description = "human edited the notes";
    writeFileSync(path, serialize("task", edited as never));

    // Daemon now performs a status mutation. It must read FRESH and revalidate.
    const fresh = store.loadTask(t.id)!;
    expect(store.externalEditDetected("task", t.id, fresh.hash)).toBe(true);
    fresh.obj.status = "done";
    fresh.obj.updatedAt = store.nowIso();
    const events: HipEvent[] = [
      { id: newId("event"), task: t.id, actor: "act_system", kind: "external-edit", at: store.nowIso() },
      { id: newId("event"), task: t.id, actor: "act_matt", kind: "status-changed", at: store.nowIso() },
    ];
    store.writeObjects(
      [{ type: "task", obj: fresh.obj as unknown as Record<string, unknown> }],
      events,
    );

    const after = store.getTask(t.id)!;
    expect(after.status).toBe("done"); // daemon mutation applied
    expect(after.description).toBe("human edited the notes"); // human edit survived
    expect(store.events.forTask(t.id).some((e) => e.kind === "external-edit")).toBe(true);
  });

  it("two store connections both write and stay consistent (serialized writers)", () => {
    expect(store.db.pragma("busy_timeout", { simple: true })).toBe(5000);
    const a = makeTask(store, { title: "from-conn-1" });

    const store2 = new Store({ root });
    const b = makeTask(store2, { title: "from-conn-2" });
    store2.close();

    reindex(store);
    const titles = store.listTasks().map((t) => t.title);
    expect(titles).toContain("from-conn-1");
    expect(titles).toContain("from-conn-2");
    expect([a.id, b.id]).toHaveLength(2);
  });

  it("has no event update or delete API (append-only)", () => {
    const log = store.events as unknown as Record<string, unknown>;
    expect(typeof log.append).toBe("function");
    expect(log.update).toBeUndefined();
    expect(log.delete).toBeUndefined();
  });
});
