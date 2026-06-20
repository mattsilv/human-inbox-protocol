import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store, reindex, doctor, newId, filePath, openDb, SCHEMA_VERSION } from "../src/store/index.js";
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

  it("listTasks onActor filters to tasks waiting on that actor, AND-combining with status (U4)", () => {
    const waitOpts = (onActor: string) => ({
      state: { kind: "waiting" as const, onActor, since: "2026-06-09", cadence: null, lastNudge: null },
    });
    const owned = makeTask(store, { title: "waiting on owner", ...waitOpts("act_owner") });
    makeTask(store, { title: "waiting on alex", ...waitOpts("act_alex") });
    makeTask(store, { title: "plain open" }); // no waiting_on_actor

    const onOwner = store.listTasks({ onActor: "act_owner" });
    expect(onOwner.map((t) => t.id)).toEqual([owned.id]);

    // status + onActor AND-combine.
    expect(store.listTasks({ status: "waiting", onActor: "act_owner" }).map((t) => t.id)).toEqual([owned.id]);
    // a non-waiting task never matches an onActor filter.
    expect(store.listTasks({ status: "open", onActor: "act_owner" })).toHaveLength(0);
    // no match → empty, not error.
    expect(store.listTasks({ onActor: "act_nobody" })).toHaveLength(0);
    // no filter → unchanged (all three).
    expect(store.listTasks()).toHaveLength(3);
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

describe("schema migration (task_tag, is_demo, creation_keys)", () => {
  it("upgrades a v1 DB: creates task_tag, adds is_demo, bumps user_version, preserves rows", () => {
    const root = tmpRoot();
    const dbFile = join(root, "hip.db");
    // Hand-build a v1 store: task_index only, no task_tag, user_version = 1.
    const raw = new Database(dbFile);
    raw.exec(
      `CREATE TABLE task_index (id TEXT PRIMARY KEY, title TEXT, status TEXT, next_action_on TEXT,
        waiting_on_actor TEXT, priority TEXT, content_hash TEXT, created_at TEXT, updated_at TEXT);`,
    );
    raw.prepare(`INSERT INTO task_index (id, title, status) VALUES ('tsk_a','keep','open')`).run();
    raw.pragma("user_version = 1");
    raw.close();

    const db = openDb(dbFile);
    expect(SCHEMA_VERSION).toBe(4);
    expect(db.pragma("user_version", { simple: true })).toBe(4);
    const tbl = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_tag'`)
      .get();
    expect(tbl).toBeTruthy();
    // v4 adds the creation_keys ledger (new table only, additive — no ALTER).
    const ck = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='creation_keys'`)
      .get();
    expect(ck).toBeTruthy();
    // is_demo added by the v3 ALTER; the pre-existing row defaults to 0.
    const cols = db.pragma("table_info(task_index)") as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "is_demo")).toBe(true);
    expect(db.prepare(`SELECT title, is_demo FROM task_index WHERE id='tsk_a'`).get()).toEqual({
      title: "keep",
      is_demo: 0,
    });
    db.close();
    cleanup(root);
  });

  it("opening an already-current DB is an idempotent no-op (no duplicate-column error)", () => {
    const root = tmpRoot();
    const dbFile = join(root, "hip.db");
    // Fresh DB gets is_demo from SCHEMA; reopening must not re-run ALTER (would throw
    // "duplicate column name") — the table_info guard handles this.
    const db1 = openDb(dbFile);
    expect(db1.pragma("user_version", { simple: true })).toBe(4);
    db1.close();
    const db2 = openDb(dbFile);
    expect(db2.pragma("user_version", { simple: true })).toBe(4);
    db2.close();
    cleanup(root);
  });

  it("upgrades a v2 DB (task_tag present, is_demo absent): ALTER adds is_demo, rows default 0", () => {
    const root = tmpRoot();
    const dbFile = join(root, "hip.db");
    // Hand-build a v2 store: task_index without is_demo, task_tag present, user_version = 2.
    const raw = new Database(dbFile);
    raw.exec(
      `CREATE TABLE task_index (id TEXT PRIMARY KEY, title TEXT, status TEXT, next_action_on TEXT,
        waiting_on_actor TEXT, priority TEXT, content_hash TEXT, created_at TEXT, updated_at TEXT);
       CREATE TABLE task_tag (task_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (task_id, tag));`,
    );
    raw.prepare(`INSERT INTO task_index (id, title, status) VALUES ('tsk_v2','keep','open')`).run();
    raw.pragma("user_version = 2");
    raw.close();

    const db = openDb(dbFile);
    expect(db.pragma("user_version", { simple: true })).toBe(4);
    const cols = db.pragma("table_info(task_index)") as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "is_demo")).toBe(true);
    expect(db.prepare(`SELECT is_demo FROM task_index WHERE id='tsk_v2'`).get()).toEqual({
      is_demo: 0,
    });
    db.close();
    cleanup(root);
  });
});

describe("indexer is_demo derivation (U2)", () => {
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

  function isDemo(id: string): number {
    return (store.db.prepare(`SELECT is_demo FROM task_index WHERE id = ?`).get(id) as {
      is_demo: number;
    }).is_demo;
  }

  it("derives is_demo from _meta.demo, defaulting to 0 for every other shape", () => {
    expect(isDemo(makeTask(store, { _meta: { demo: true } }).id)).toBe(1);
    expect(isDemo(makeTask(store, { _meta: { demo: false } }).id)).toBe(0);
    expect(isDemo(makeTask(store, { _meta: { other: true } }).id)).toBe(0);
    expect(isDemo(makeTask(store, {}).id)).toBe(0);
  });
});

describe("task_tag indexing (U2)", () => {
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

  function tagRows(taskId: string): string[] {
    return (
      store.db.prepare(`SELECT tag FROM task_tag WHERE task_id = ? ORDER BY tag`).all(taskId) as {
        tag: string;
      }[]
    ).map((r) => r.tag);
  }

  it("indexes tag rows; re-indexing with a tag removed leaves no stale row", () => {
    const t = makeTask(store, { title: "gap", tags: ["protocol-gap", "infra"] });
    expect(tagRows(t.id)).toEqual(["infra", "protocol-gap"]);

    // Rewrite the task with one tag removed → stale row must be gone.
    const obj = { ...store.getTask(t.id)!, tags: ["protocol-gap"] };
    store.writeObjects([{ type: "task", obj: obj as unknown as Record<string, unknown> }], []);
    expect(tagRows(t.id)).toEqual(["protocol-gap"]);
  });

  it("reindex repopulates task_tag from frontmatter", () => {
    const t = makeTask(store, { title: "gap", tags: ["protocol-gap"] });
    store.db.exec(`DELETE FROM task_tag`);
    expect(tagRows(t.id)).toEqual([]);
    reindex(store);
    expect(tagRows(t.id)).toEqual(["protocol-gap"]);
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
