import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Store, reindex, doctor, newId, filePath } from "../src/store/index.js";
import { serialize, deserialize, liftTaskState, lowerTaskState } from "../src/store/index.js";
import type { Task, TaskState, HipEvent } from "../src/types.js";
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
      [{ type: "task", obj: { ...back, state: { kind: "done" } } as unknown as Record<string, unknown> }],
      [{ id: newId("event"), task: t.id, actor: "act_matt", kind: "status-changed", at: store.nowIso() }],
    );
    const after = readFileSync(path, "utf8");
    expect(after).toContain("futureField: keep-me");
    expect(store.getTask(t.id)!.state.kind).toBe("done");
  });

  it("round-trips tags through frontmatter; absent tags omit the key", () => {
    const t = makeTask(store, { title: "gap", tags: ["protocol-gap", "infra"] });
    const path = filePath(store.paths, "task", t.id);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("tags:");
    expect(raw).toContain("protocol-gap");

    const back = store.getTask(t.id)!;
    expect(back.tags).toEqual(["protocol-gap", "infra"]); // order preserved

    // A task with no tags writes no `tags:` key (optional-field convention).
    const plain = makeTask(store, { title: "no tags" });
    expect(readFileSync(filePath(store.paths, "task", plain.id), "utf8")).not.toContain("tags:");
    expect(store.getTask(plain.id)!.tags).toBeUndefined();
  });

  it("reindex rebuilds the index from files and is idempotent", () => {
    const a = makeTask(store, { title: "a" });
    makeTask(store, { title: "b", state: { kind: "done" } });

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
      state: { kind: "open" },
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
      state: { kind: "waiting", onActor: "act_alex", since: "2026-06-09", cadence: "P3D", lastNudge: null },
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
    // the waiting payload survives the write → reindex → read round-trip (now in the union)
    const st = s3.listTasks()[0]!.state;
    expect(st.kind === "waiting" ? st.onActor : null).toBe("act_alex");
    s3.close();
  });

  it("an intent event without a completed file rename produces no state change", () => {
    // Simulate a crash after event-append, before file rename: the task keeps its
    // prior state, and reindex-from-files is the recovery. No duplicate timers/rows.
    const t = makeTask(store, { title: "original", state: { kind: "open" } });
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
    expect(store.getTask(t.id)!.state.kind).toBe("open"); // file never changed
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
    fresh.obj.state = { kind: "done" };
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
    expect(after.state.kind).toBe("done"); // daemon mutation applied
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

describe("task-state codec (U2) — flat ↔ union", () => {
  const base = {
    id: "tsk_codec",
    title: "codec task",
    delegatedBy: { actor: "act_matt", role: "creator" as const },
    createdAt: "2026-06-13T00:00:00Z",
    updatedAt: "2026-06-13T00:00:00Z",
  };
  const kinds: TaskState[] = [
    { kind: "open" },
    { kind: "done" },
    { kind: "dropped" },
    { kind: "waiting", onActor: "act_alex", since: "2026-06-09", cadence: "P3D", lastNudge: null },
  ];

  it("serializes a waiting union task to flat status + waitingOn, no state key", () => {
    const task: Task = { ...base, state: kinds[3]! };
    const yaml = serialize("task", task as unknown as Record<string, unknown>);
    expect(yaml).toContain("status: waiting");
    expect(yaml).toContain("onActor: act_alex");
    expect(yaml).not.toContain("state:");
    expect(yaml).not.toContain("kind:");
  });

  it("deserializes a flat YAML task into the internal union (no top-level status/waitingOn)", () => {
    const flatYaml = serialize("task", { ...base, state: kinds[3]! } as unknown as Record<string, unknown>);
    const back = deserialize<Task>("task", flatYaml);
    expect(back.state.kind).toBe("waiting");
    expect(back.state.kind === "waiting" ? back.state.onActor : null).toBe("act_alex");
    expect((back as unknown as Record<string, unknown>).status).toBeUndefined();
    expect((back as unknown as Record<string, unknown>).waitingOn).toBeUndefined();
  });

  it("lift(lower(task)) deep-equals the original union for each kind", () => {
    for (const state of kinds) {
      const task: Task = { ...base, state };
      expect(liftTaskState(lowerTaskState(task))).toEqual(task);
    }
  });

  it("preserves _meta and unknown frontmatter through lift→lower→lift", () => {
    const task = {
      ...base,
      state: kinds[0]!,
      _meta: { source: "hermes" },
      futureField: "keep-me",
    } as unknown as Task;
    const round = liftTaskState(lowerTaskState(liftTaskState(lowerTaskState(task))));
    expect(round._meta).toEqual({ source: "hermes" });
    expect((round as unknown as Record<string, unknown>).futureField).toBe("keep-me");
  });

  it("defensive lift: illegal { status: open, waitingOn: {…} } resolves to open (payload dropped)", () => {
    const lifted = liftTaskState({ ...base, status: "open", waitingOn: { onActor: "act_x", since: "2026-06-01" } } as unknown as Record<string, unknown>);
    expect(lifted.state).toEqual({ kind: "open" });
  });

  it("defensive lift: { status: waiting } with missing payload degrades to open", () => {
    const lifted = liftTaskState({ ...base, status: "waiting" } as unknown as Record<string, unknown>);
    expect(lifted.state).toEqual({ kind: "open" });
  });
});
