import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/index.js";
import { Domain } from "../src/domain/index.js";
import { HipDaemon } from "../src/daemon/server.js";
import { HipClient } from "../src/client.js";
import { tmpRoot, cleanup } from "./helpers.js";

const MATT = "act_matt";
const ASH = "act_ash";

describe("creation-key idempotency (U3) — domain layer", () => {
  let root: string;
  let store: Store;
  let domain: Domain;

  beforeEach(() => {
    root = tmpRoot();
    store = new Store({ root });
    domain = new Domain(store);
  });
  afterEach(() => {
    store.close();
    cleanup(root);
  });

  const make = (over: Record<string, unknown> = {}) => ({
    title: "Email the vendor",
    delegatedBy: { actor: MATT, role: "creator" as const },
    ...over,
  });

  describe("task_create", () => {
    it("a fresh clientKey creates one task and one ledger row", () => {
      const t = domain.createTask(make({ clientKey: "k1" }), MATT);
      expect(domain.listTasks()).toHaveLength(1);
      const row = store.getCreationKey(MATT, "k1");
      expect(row).toEqual({ objectType: "task", objectId: t.id, contentHash: expect.any(String) });
    });

    it("a retry with the same key + identical payload returns the original id, no second task", () => {
      const first = domain.createTask(make({ clientKey: "k1" }), MATT);
      const retry = domain.createTask(make({ clientKey: "k1" }), MATT);
      expect(retry.id).toBe(first.id);
      expect(domain.listTasks()).toHaveLength(1);
    });

    it("field reordering / equal payload still hashes equal (no false conflict)", () => {
      const first = domain.createTask(
        { title: "T", delegatedBy: { actor: MATT, role: "creator" }, priority: "high", clientKey: "k1" },
        MATT,
      );
      const retry = domain.createTask(
        { clientKey: "k1", priority: "high", delegatedBy: { actor: MATT, role: "creator" }, title: "T" },
        MATT,
      );
      expect(retry.id).toBe(first.id);
    });

    it("reusing a key with a different payload throws conflict", () => {
      domain.createTask(make({ clientKey: "k1" }), MATT);
      expect(() => domain.createTask(make({ clientKey: "k1", title: "Different" }), MATT)).toThrow(/different content/);
    });

    it("without a clientKey behaves exactly as today (no ledger row)", () => {
      domain.createTask(make(), MATT);
      domain.createTask(make(), MATT);
      expect(domain.listTasks()).toHaveLength(2); // not deduped
    });

    it("the ledger is per-actor: same key under two actors yields two tasks", () => {
      const a = domain.createTask(make({ clientKey: "k1" }), MATT);
      const b = domain.createTask(make({ clientKey: "k1" }), ASH);
      expect(b.id).not.toBe(a.id);
      expect(domain.listTasks()).toHaveLength(2);
    });
  });

  describe("execution_register", () => {
    const seedTask = () => domain.createTask(make(), MATT).id;

    it("a fresh clientKey registers one execution and one ledger row", () => {
      const task = seedTask();
      const e = domain.registerExecution({ task, actor: MATT, clientKey: "e1" }, MATT);
      expect(store.getCreationKey(MATT, "e1")).toEqual({
        objectType: "execution",
        objectId: e.id,
        contentHash: expect.any(String),
      });
    });

    it("a retry with the same key returns the original execution", () => {
      const task = seedTask();
      const first = domain.registerExecution({ task, actor: MATT, clientKey: "e1" }, MATT);
      const retry = domain.registerExecution({ task, actor: MATT, clientKey: "e1" }, MATT);
      expect(retry.id).toBe(first.id);
      expect(store.listExecutionsByTask(task)).toHaveLength(1);
    });

    it("reusing a key with a different payload throws conflict", () => {
      const task = seedTask();
      domain.registerExecution({ task, actor: MATT, clientKey: "e1" }, MATT);
      expect(() =>
        domain.registerExecution({ task, actor: MATT, clientKey: "e1", status: "submitted" }, MATT),
      ).toThrow(/different content/);
    });

    it("without a clientKey registers a fresh execution each time", () => {
      const task = seedTask();
      domain.registerExecution({ task, actor: MATT }, MATT);
      domain.registerExecution({ task, actor: MATT }, MATT);
      expect(store.listExecutionsByTask(task)).toHaveLength(2);
    });
  });

  it("a clientKey reused across object types conflicts (task then execution)", () => {
    const t = domain.createTask(make({ clientKey: "shared" }), MATT);
    expect(() => domain.registerExecution({ task: t.id, actor: MATT, clientKey: "shared" }, MATT)).toThrow(
      /already used for a task/,
    );
  });

  it("idempotent return is durable across a store restart (ledger is on disk)", () => {
    const first = domain.createTask(make({ clientKey: "k1" }), MATT);
    store.close();
    // Reopen a fresh Store on the same root — the ledger must persist (not in-memory).
    const store2 = new Store({ root });
    const retry = new Domain(store2).createTask(make({ clientKey: "k1" }), MATT);
    expect(retry.id).toBe(first.id);
    expect(new Domain(store2).listTasks()).toHaveLength(1);
    store2.close();
    // re-open the original handle so afterEach's close() is balanced
    store = new Store({ root });
  });
});

describe("creation-key idempotency (U3) — over the MCP tool surface", () => {
  let root: string;
  let store: Store;
  let daemon: HipDaemon;
  let client: HipClient;
  const TOKEN = "tok";

  beforeEach(async () => {
    root = tmpRoot();
    store = new Store({ root });
    daemon = new HipDaemon({ store, token: TOKEN, port: 0 });
    await daemon.start();
    daemon.domain.createActor({ id: MATT, kind: "person", displayName: "Matt" });
    client = new HipClient({ url: daemon.url, token: TOKEN });
    await client.connect();
  });
  afterEach(async () => {
    await client.close();
    await daemon.stop();
    store.close();
    cleanup(root);
  });

  it("a double-submitted task_create with the same clientKey yields exactly one task", async () => {
    const args = { actorId: MATT, title: "Pay invoice", delegatedBy: { actor: MATT, role: "creator" }, clientKey: "k1" };
    const a = await client.callOk("task_create", args);
    const b = await client.callOk("task_create", args);
    expect(b.id).toBe(a.id);
    const list = await client.callOk("task_list", {});
    expect((list.tasks as unknown[]).length).toBe(1);
  });

  it("a mismatched clientKey reuse returns a conflict error over MCP", async () => {
    const base = { actorId: MATT, delegatedBy: { actor: MATT, role: "creator" }, clientKey: "k1" };
    await client.callOk("task_create", { ...base, title: "First" });
    const r = await client.call("task_create", { ...base, title: "Second" });
    expect(r.isError).toBe(true);
    expect((r.structuredContent.error as { code: string }).code).toBe("conflict");
  });
});
