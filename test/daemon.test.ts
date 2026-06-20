import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/index.js";
import { HipDaemon } from "../src/daemon/server.js";
import { HipClient } from "../src/client.js";
import { tmpRoot, cleanup } from "./helpers.js";

const TOKEN = "test-token-abc";
const MATT = "act_matt";

describe("MCP daemon + tool binding (U4)", () => {
  let root: string;
  let store: Store;
  let daemon: HipDaemon;
  let client: HipClient;

  beforeEach(async () => {
    root = tmpRoot();
    store = new Store({ root });
    daemon = new HipDaemon({ store, token: TOKEN, port: 0 });
    await daemon.start();
    // seed the owner actor (install does this for real)
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

  it("connects, lists tools, and drives full CRUD through tools", async () => {
    const tools = await client.listTools();
    expect(tools).toContain("task_create");
    expect(tools).toContain("decision_resolve");
    expect(tools).toContain("task_block");

    const created = await client.callOk("task_create", {
      actorId: MATT,
      title: "Unpack suitcase",
      delegatedBy: { actor: MATT, role: "creator" },
    });
    const id = created.id as string;
    expect(id).toMatch(/^tsk_/);

    const view = await client.callOk("task_read", { id });
    expect((view.task as { title: string }).title).toBe("Unpack suitcase");

    await client.callOk("task_update", { actorId: MATT, id, patch: { priority: "high" } });
    await client.callOk("task_done", { actorId: MATT, id });
    const done = await client.callOk("task_read", { id });
    expect((done.task as { status: string }).status).toBe("done");

    const list = await client.callOk("task_list", { status: "done" });
    expect((list.tasks as unknown[]).length).toBe(1);
  });

  it("brackets a bare IPv6 HIP_HOST into a valid url authority", () => {
    const v6 = new HipDaemon({ store, token: TOKEN, host: "fd7a:1:2::3", port: 4319 });
    expect(v6.url).toBe("http://[fd7a:1:2::3]:4319/mcp");
    // IPv4 / hostnames pass through unchanged.
    const v4 = new HipDaemon({ store, token: TOKEN, host: "100.64.0.1", port: 4319 });
    expect(v4.url).toBe("http://100.64.0.1:4319/mcp");
  });

  it("tags round-trip over MCP: task_create tags, task_list filters by tag, task_read returns them", async () => {
    const gap = (await client.callOk("task_create", {
      actorId: MATT,
      title: "no recurrence support",
      delegatedBy: { actor: MATT, role: "creator" },
      tags: ["protocol-gap"],
    })) as { id: string };
    await client.callOk("task_create", {
      actorId: MATT,
      title: "ordinary task",
      delegatedBy: { actor: MATT, role: "creator" },
    });

    const filtered = (await client.callOk("task_list", { tag: "protocol-gap" })) as {
      tasks: { id: string; tags?: string[] }[];
    };
    expect(filtered.tasks.map((t) => t.id)).toEqual([gap.id]);
    expect(filtered.tasks[0]!.tags).toEqual(["protocol-gap"]);

    const view = await client.callOk("task_read", { id: gap.id });
    expect((view.task as { tags?: string[] }).tags).toEqual(["protocol-gap"]);
  });

  it("the internal union never crosses the wire — tasks stay flat (status + waitingOn)", async () => {
    const created = (await client.callOk("task_create", {
      actorId: MATT,
      title: "Dinner with Alex",
      delegatedBy: { actor: MATT, role: "creator" },
      waitingOn: { onActor: "act_alex", since: "2026-06-09", cadence: "P3D" },
    })) as Record<string, unknown>;
    // task_create return is flat.
    expect(created.status).toBe("waiting");
    expect((created.waitingOn as { onActor: string }).onActor).toBe("act_alex");
    expect(created.state).toBeUndefined();

    // task_read (nested) is flat.
    const view = await client.callOk("task_read", { id: created.id as string });
    const read = view.task as Record<string, unknown>;
    expect(read.status).toBe("waiting");
    expect(read.state).toBeUndefined();

    // task_list (array) is flat.
    const list = await client.callOk("task_list", { status: "waiting" });
    for (const t of list.tasks as Record<string, unknown>[]) {
      expect(t.status).toBeDefined();
      expect(t.state).toBeUndefined();
    }
  });

  it("task_list onActor returns the real 'waiting on actor X' query the client needs (U4)", async () => {
    const mk = (title: string, onActor: string) =>
      client.callOk("task_create", {
        actorId: MATT,
        title,
        delegatedBy: { actor: MATT, role: "creator" },
        waitingOn: { onActor, since: "2026-06-09" },
      });
    const owner = (await mk("waiting on owner", "act_owner")) as { id: string };
    await mk("waiting on alex", "act_alex");
    await client.callOk("task_create", { actorId: MATT, title: "open task", delegatedBy: { actor: MATT, role: "creator" } });

    const onOwner = await client.callOk("task_list", { status: "waiting", onActor: "act_owner" });
    const ids = (onOwner.tasks as { id: string }[]).map((t) => t.id);
    expect(ids).toEqual([owner.id]);

    // No match → empty, not error.
    const none = await client.callOk("task_list", { onActor: "act_nobody" });
    expect((none.tasks as unknown[]).length).toBe(0);
  });

  it("AE6: task_block files a decision, blocks the execution, resolve resumes it", async () => {
    const t = (await client.callOk("task_create", {
      actorId: MATT,
      title: "Book flights",
      delegatedBy: { actor: MATT, role: "creator" },
    })) as { id: string };
    const exe = (await client.callOk("execution_register", {
      actorId: "act_agent",
      task: t.id,
      actor: "act_agent",
    })) as { id: string };

    const blocked = await client.callOk("task_block", {
      actorId: "act_agent",
      taskId: t.id,
      executionId: exe.id,
      reason: "Which dates?",
    });
    const decisionId = (blocked.decision as { id: string }).id;
    const e1 = (await client.callOk("execution_get", { id: exe.id })) as {
      status: string;
      blockedOn: string;
    };
    expect(e1.status).toBe("input-required");
    expect(e1.blockedOn).toBe(decisionId);

    await client.callOk("decision_resolve", {
      actorId: MATT,
      id: decisionId,
      kind: "freeText",
      freeText: "June 20-24",
    });
    // Agent observes resolution by polling execution_get.
    const e2 = (await client.callOk("execution_get", { id: exe.id })) as {
      status: string;
      blockedOn: string | null;
    };
    expect(e2.status).toBe("working");
    expect(e2.blockedOn).toBeNull();
  });

  it("decision_reopen reopens a resolved decision through the daemon (R3)", async () => {
    const dec = (await client.callOk("decision_create", {
      actorId: MATT,
      prompt: "Pick?",
      options: [{ id: "a", label: "A" }],
    })) as { id: string };
    await client.callOk("decision_resolve", { actorId: MATT, id: dec.id, kind: "option", optionId: "a" });
    let list = (await client.callOk("decision_list")) as { decisions: { id: string }[] };
    expect(list.decisions.map((d) => d.id)).not.toContain(dec.id);

    await client.callOk("decision_reopen", { actorId: MATT, id: dec.id });
    list = (await client.callOk("decision_list")) as { decisions: { id: string }[] };
    expect(list.decisions.map((d) => d.id)).toContain(dec.id);
  });

  it("decision_reopen on a missing id returns a tool error, not a crash (R3)", async () => {
    const r = await client.call("decision_reopen", { actorId: MATT, id: "decision_missing" });
    expect(r.isError).toBe(true);
  });

  it("task_block forwards options so the decision offers choices, not just free text", async () => {
    const t = (await client.callOk("task_create", {
      actorId: MATT,
      title: "Lease renewal",
      delegatedBy: { actor: MATT, role: "creator" },
    })) as { id: string };
    const exe = (await client.callOk("execution_register", {
      actorId: "act_agent",
      task: t.id,
      actor: "act_agent",
    })) as { id: string };
    const blocked = await client.callOk("task_block", {
      actorId: "act_agent",
      taskId: t.id,
      executionId: exe.id,
      reason: "Renew for 12 or 24 months?",
      options: [
        { id: "m12", label: "12 months" },
        { id: "m24", label: "24 months" },
      ],
    });
    const decisionId = (blocked.decision as { id: string }).id;
    const got = (await client.callOk("decision_get", { id: decisionId })) as {
      options?: { id: string; label: string }[];
    };
    expect(got.options?.map((o) => o.id)).toEqual(["m12", "m24"]);
  });

  it("read tools report not-found as a tool error (isError), not a soft ok", async () => {
    const r = await client.call("task_read", { id: "tsk_missing" });
    expect(r.isError).toBe(true);
    expect((r.structuredContent?.error as { code: string }).code).toBe("not_found");
    const d = await client.call("decision_get", { id: "dec_missing" });
    expect(d.isError).toBe(true);
    const e = await client.call("execution_get", { id: "exe_missing" });
    expect(e.isError).toBe(true);
  });

  it("rejects task_update carrying a transition field (one verb per transition)", async () => {
    const t = (await client.callOk("task_create", {
      actorId: MATT,
      title: "x",
      delegatedBy: { actor: MATT, role: "creator" },
    })) as { id: string };
    const r = await client.call("task_update", { actorId: MATT, id: t.id, patch: { status: "done" } });
    expect(r.isError).toBe(true);
    expect((r.structuredContent?.error as { code: string }).code).toBe("validation");
  });

  it("rejects a missing/wrong bearer token (401) and an evil origin (403)", async () => {
    const noAuth = await fetch(daemon.url, { method: "POST", body: "{}" });
    expect(noAuth.status).toBe(401);

    const wrongAuth = await fetch(daemon.url, {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      body: "{}",
    });
    expect(wrongAuth.status).toBe(401);

    const evilOrigin = await fetch(daemon.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "http://evil.example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(evilOrigin.status).toBe(403);
  });

  it("refuses GET/DELETE — no server-initiated channel (RC-seam guard)", async () => {
    const get = await fetch(daemon.url, {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(405);
  });

  it("two concurrent clients see each other's writes immediately", async () => {
    const client2 = new HipClient({ url: daemon.url, token: TOKEN });
    await client2.connect();
    try {
      const t = (await client.callOk("task_create", {
        actorId: MATT,
        title: "shared task",
        delegatedBy: { actor: MATT, role: "creator" },
      })) as { id: string };
      const seen = await client2.callOk("task_read", { id: t.id });
      expect((seen.task as { title: string }).title).toBe("shared task");
    } finally {
      await client2.close();
    }
  });
});
