import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/index.js";
import { HipDaemon } from "../src/daemon/server.js";
import { HipClient } from "../src/client.js";
import * as cmd from "../src/cli/commands.js";
import { seedDemo } from "../src/cli/demo.js";
import { loadConfig, ConfigError } from "../src/cli/config.js";
import { tmpRoot, cleanup } from "./helpers.js";

const TOKEN = "cli-token";
const MATT = "act_matt";

describe("CLI inbox + inspection (U7)", () => {
  let root: string;
  let store: Store;
  let daemon: HipDaemon;
  let client: HipClient;

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

  it("shows a pending decision, answers by option, records the CLI actor", async () => {
    const dec = daemon.domain.createDecision(
      { prompt: "Fold laundry now?", options: [{ id: "now", label: "Now" }, { id: "later", label: "Later" }] },
      MATT,
    );
    const view = await cmd.inbox(client);
    expect(view).toContain("Fold laundry now?");
    expect(view).toContain("--option now");

    const msg = await cmd.answer(client, MATT, dec.id, { option: "now" });
    expect(msg).toContain("now");
    const resolved = daemon.domain.getDecision(dec.id)!;
    expect(resolved.resolution?.kind).toBe("option");
    expect(resolved.resolution?.optionId).toBe("now");
    expect(resolved.resolution?.actor).toBe(MATT);
  });

  it("answers with free text", async () => {
    const dec = daemon.domain.createDecision({ prompt: "What time?" }, MATT);
    await cmd.answer(client, MATT, dec.id, { text: "6pm" });
    expect(daemon.domain.getDecision(dec.id)!.resolution?.freeText).toBe("6pm");
  });

  it("states an empty inbox plainly", async () => {
    expect(await cmd.inbox(client)).toMatch(/empty/i);
  });

  it("AE3 surface: snooze and dismiss round-trip", async () => {
    const a = daemon.domain.createDecision({ prompt: "A" }, MATT);
    const b = daemon.domain.createDecision({ prompt: "B" }, MATT);
    await cmd.snooze(client, MATT, a.id, "2026-06-13T00:00:00Z");
    expect(daemon.domain.getDecision(a.id)!.snoozedUntil).toBe("2026-06-13T00:00:00Z");
    await cmd.dismiss(client, MATT, b.id);
    expect(daemon.domain.getDecision(b.id)!.resolution?.kind).toBe("dismissed");
  });

  it("list and show render task state", async () => {
    const t = daemon.domain.createTask(
      { title: "Unpack suitcase", description: "from NY", delegatedBy: { actor: MATT, role: "creator" } },
      MATT,
    );
    expect(await cmd.listTasks(client)).toContain("Unpack suitcase");
    const shown = await cmd.show(client, t.id);
    expect(shown).toContain("Unpack suitcase");
    expect(shown).toContain("from NY");
  });

  it("hip demo seeds concrete examples, resets prior seed on re-run (R12)", async () => {
    const out = await seedDemo(client, MATT);
    expect(out).toContain("Seeded");
    expect(out).toContain("Now run: hip inbox"); // explicit next-step handoff

    // Five concrete inbox decisions (mostly numbered options) plus the snoozed passport.
    const { decisions } = (await client.callOk("decision_list")) as { decisions: { prompt: string }[] };
    expect(decisions).toHaveLength(5);
    const prompts = decisions.map((d) => d.prompt).join("\n");
    expect(prompts).toContain("Renew the lease for 12 or 24 months?");
    expect(prompts).toContain("$340"); // dishwasher quote
    expect(prompts).toContain("dentist cleaning");
    expect(prompts).toContain("gate code for the 3pm drop-off");
    // The snoozed passport decision exists but stays out of the inbox.
    expect(prompts).not.toContain("Renew your passport");

    // The strongest example surfaces first in the inbox loop.
    const inbox = await cmd.inbox(client);
    expect(inbox).toMatch(/Decision 1 of 5/);
    expect(inbox).toContain("Renew the lease for 12 or 24 months?");

    // task_list includes the waiting, high-priority, and plain tasks.
    const list = await cmd.listTasks(client);
    expect(list).toContain("Get Q3 revenue numbers from Alex");
    expect(list).toMatch(/waiting on act_demo_alex/);
    expect(list).toContain("Pay the electric bill");
    expect(list).toContain("Unpack the last two kitchen boxes");

    // The plumber's inbound reply reconciled onto the faucet task's thread.
    const { tasks } = (await client.callOk("task_list")) as { tasks: { id: string; title: string }[] };
    const faucet = tasks.find((t) => t.title.includes("dripping kitchen faucet"))!;
    const view = (await client.callOk("task_read", { id: faucet.id })) as {
      task: { thread?: { content: string }[] };
    };
    expect((view.task.thread ?? []).map((c) => c.content).join("\n")).toContain("Can do Thursday 9am");

    // Re-running RESETS the prior seed — the inbox stays at five, no pile-up. A THIRD
    // run matters: by then the first run's tasks are already dropped, so reset must skip
    // re-dropping them (task_drop throws on an already-dropped task).
    await expect(seedDemo(client, MATT)).resolves.toContain("Seeded");
    await expect(seedDemo(client, MATT)).resolves.toContain("Seeded");
    const after = (await client.callOk("decision_list")) as { decisions: unknown[] };
    expect(after.decisions).toHaveLength(5);
  });

  it("loadConfig throws an actionable error when no config exists", () => {
    const prev = process.env.HIP_CONFIG_DIR;
    process.env.HIP_CONFIG_DIR = tmpRoot();
    try {
      expect(() => loadConfig()).toThrowError(ConfigError);
      expect(() => loadConfig()).toThrowError(/hip install/);
    } finally {
      if (prev === undefined) delete process.env.HIP_CONFIG_DIR;
      else process.env.HIP_CONFIG_DIR = prev;
    }
  });
});
