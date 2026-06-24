import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/index.js";
import { HipDaemon } from "../src/daemon/server.js";
import { HipClient } from "../src/client.js";
import * as cmd from "../src/cli/commands.js";
import { tmpRoot, cleanup } from "./helpers.js";

const TOKEN = "render-token";
const MATT = "act_matt";
const ALEX = "act_alex";
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[/;

// U4: read renderers gain color in a TTY but must return the exact same plain string
// when non-interactive (vitest is non-TTY), so piped output stays ANSI-free (R7/R9).

describe("read-command rendering stays plain in non-TTY (U4)", () => {
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
    daemon.domain.createActor({ id: ALEX, kind: "person", displayName: "Alex" });
    client = new HipClient({ url: daemon.url, token: TOKEN });
    await client.connect();
  });
  afterEach(async () => {
    await client.close();
    await daemon.stop();
    store.close();
    cleanup(root);
  });

  it("renderTaskLine has no ANSI bytes and shows the waiting-on text (R6/R7)", async () => {
    const t = daemon.domain.createTask(
      { title: "Get Q3 numbers", delegatedBy: { actor: MATT, role: "creator" } },
      MATT,
    );
    daemon.domain.setWaiting(t.id, { onActor: ALEX, since: new Date().toISOString() }, MATT);
    const out = await cmd.listTasks(client);
    expect(ANSI.test(out)).toBe(false);
    expect(out).toContain("waiting on act_alex");
  });

  it("renderTaskView keeps title/from/description with no ANSI (R7/R9)", async () => {
    const t = daemon.domain.createTask(
      { title: "Unpack suitcase", description: "from NY", delegatedBy: { actor: MATT, role: "creator" } },
      MATT,
    );
    const out = await cmd.show(client, t.id);
    expect(ANSI.test(out)).toBe(false);
    expect(out).toContain("Unpack suitcase");
    expect(out).toContain("from NY");
    expect(out).toContain("from: act_matt");
  });

  it("leads with the #N display handle in list and show; keeps the opaque id on show (U3)", async () => {
    const t = daemon.domain.createTask(
      { title: "Numbered task", delegatedBy: { actor: MATT, role: "creator" } },
      MATT,
    );
    const line = await cmd.listTasks(client);
    expect(line).toContain(`#${t.shortId}`); // list leads with the short handle
    expect(line).not.toContain(t.id); // not the opaque id

    const shown = await cmd.show(client, t.id);
    expect(shown).toContain(`#${t.shortId}`);
    expect(shown).toContain(t.id); // detail view keeps the opaque id visible
  });

  it("renders the opaque id for a terminal task that has no #N (U3)", async () => {
    const t = daemon.domain.createTask(
      { title: "Finished", delegatedBy: { actor: MATT, role: "creator" } },
      MATT,
    );
    daemon.domain.markDone(t.id, MATT); // frees the short id
    const line = await cmd.listTasks(client);
    expect(line).toContain(t.id); // falls back to opaque id
    expect(line).not.toContain("#"); // no stray #undefined
  });

  it("renderDecision (inbox) has no ANSI and keeps the option hint (R7)", async () => {
    daemon.domain.createDecision(
      { prompt: "Fold laundry now?", options: [{ id: "now", label: "Now" }] },
      MATT,
    );
    const out = await cmd.inbox(client);
    expect(ANSI.test(out)).toBe(false);
    expect(out).toContain("Fold laundry now?");
    expect(out).toContain("--option now");
  });
});
