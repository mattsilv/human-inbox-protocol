import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store/index.js";
import { HipDaemon } from "../src/daemon/server.js";
import { HipClient } from "../src/client.js";
import type { Decision } from "../src/types.js";
import {
  buildMenu,
  resolveMenuKey,
  parseConfirm,
  parseSnoozeShorthand,
  formatSnoozeEcho,
  decisionToChoices,
  interactiveInbox,
  CANCEL,
  type InboxIO,
  type InboxKey,
} from "../src/cli/interactive.js";
import { tmpRoot, cleanup } from "./helpers.js";

const TOKEN = "int-token";
const MATT = "act_matt";

// ---- pure functions -------------------------------------------------------

const baseDecision = { id: "dec_1", prompt: "p", createdAt: "", updatedAt: "" };

describe("buildMenu / resolveMenuKey (numbers-only menu)", () => {
  it("numbers options 1..N then type-your-own, snooze, dismiss, skip", () => {
    const d = { ...baseDecision, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } as Decision;
    const menu = buildMenu(d);
    expect(menu.map((e) => e.kind)).toEqual(["option", "option", "freeText", "snooze", "dismiss", "skip"]);
    expect(menu.map((e) => e.num)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(resolveMenuKey(menu, 1)).toMatchObject({ kind: "option", optionId: "a", optionIndex: 0 });
    expect(resolveMenuKey(menu, 2)).toMatchObject({ kind: "option", optionId: "b", optionIndex: 1 });
    expect(resolveMenuKey(menu, 4)).toMatchObject({ kind: "snooze" });
    expect(resolveMenuKey(menu, 7)).toBeNull();
  });

  it("omits type-your-own when free text is disallowed", () => {
    const d = { ...baseDecision, options: [{ id: "a", label: "A" }], allowFreeText: false } as Decision;
    expect(buildMenu(d).map((e) => e.kind)).toEqual(["option", "snooze", "dismiss", "skip"]);
  });

  it("never offers free text on an escalation (would silently drop the envelope)", () => {
    const d = { ...baseDecision, kind: "escalation", allowFreeText: true } as Decision;
    expect(decisionToChoices(d).allowFreeText).toBe(false);
    expect(buildMenu(d).some((e) => e.kind === "freeText")).toBe(false);
  });
});

describe("parseConfirm", () => {
  it("maps 1/y/yes → true, 2/n/no → false, else null", () => {
    expect(parseConfirm("1")).toBe(true);
    expect(parseConfirm("y")).toBe(true);
    expect(parseConfirm("2")).toBe(false);
    expect(parseConfirm("n")).toBe(false);
    expect(parseConfirm("maybe")).toBe(null);
  });
});

describe("parseSnoozeShorthand", () => {
  const now = new Date(2026, 5, 12, 20, 0, 0); // Friday 2026-06-12 20:00 local

  it("maps presets to concrete future timestamps", () => {
    const tom = new Date(parseSnoozeShorthand("2", now)!);
    expect(tom.getDate()).toBe(13);
    expect(tom.getHours()).toBe(9);
    expect(new Date(parseSnoozeShorthand("3", now)!).getDay()).toBe(6); // Saturday
    expect(new Date(parseSnoozeShorthand("4", now)!).getDay()).toBe(1); // Monday
  });
  it("maps relative shorthand and weekday names", () => {
    expect(new Date(parseSnoozeShorthand("2h", now)!).getTime()).toBe(now.getTime() + 2 * 3_600_000);
    expect(new Date(parseSnoozeShorthand("3d", now)!).getTime()).toBe(now.getTime() + 3 * 86_400_000);
    const mon = new Date(parseSnoozeShorthand("mon", now)!);
    expect(mon.getDay()).toBe(1);
    expect(mon.getHours()).toBe(9);
  });
  it("accepts ISO and rejects past/garbage", () => {
    expect(parseSnoozeShorthand("2026-07-01", now)).not.toBeNull();
    expect(parseSnoozeShorthand("yesterday", now)).toBeNull();
    expect(parseSnoozeShorthand("2020-01-01", now)).toBeNull();
    expect(parseSnoozeShorthand("", now)).toBeNull();
  });
  it("formatSnoozeEcho renders a human time", () => {
    expect(formatSnoozeEcho(new Date(2026, 5, 15, 9, 0, 0).toISOString())).toBe("Mon Jun 15, 9am");
  });
});

// ---- loop integration with a scripted InboxIO -----------------------------

function key(digit: number): InboxKey {
  return { seq: String(digit), name: String(digit), isCancel: false, digit };
}
function cancelKey(): InboxKey {
  return { seq: "", name: "escape", isCancel: true, digit: null };
}

function scriptedIO(keys: InboxKey[], lines: (string | typeof CANCEL)[] = []): InboxIO {
  const keyQ = [...keys];
  const lineQ = [...lines];
  return {
    begin: () => {},
    end: () => {},
    render: () => {},
    readKey: async () => {
      if (keyQ.length === 0) throw new Error("key queue exhausted");
      return keyQ.shift()!;
    },
    readLine: async () => {
      if (lineQ.length === 0) throw new Error("line queue exhausted");
      return lineQ.shift()!;
    },
  };
}

describe("interactiveInbox loop", () => {
  let root: string;
  let store: Store;
  let daemon: HipDaemon;
  let client: HipClient;
  const NOW = new Date(2026, 5, 12, 20, 0, 0);
  let outSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = tmpRoot();
    store = new Store({ root });
    daemon = new HipDaemon({ store, token: TOKEN, port: 0 });
    await daemon.start();
    daemon.domain.createActor({ id: MATT, kind: "person", displayName: "Matt" });
    client = new HipClient({ url: daemon.url, token: TOKEN });
    await client.connect();
    outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(async () => {
    outSpy.mockRestore();
    await client.close();
    await daemon.stop();
    store.close();
    cleanup(root);
  });

  const printed = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");

  /** Three single-option decisions so each menu has the same shape (1 opt → skip=5, dismiss=4). */
  function seedThree(): Decision[] {
    return [
      daemon.domain.createDecision({ prompt: "Pick A?", options: [{ id: "a", label: "A" }] }, MATT),
      daemon.domain.createDecision({ prompt: "Pick B?", options: [{ id: "b", label: "B" }] }, MATT),
      daemon.domain.createDecision({ prompt: "Pick C?", options: [{ id: "c", label: "C" }] }, MATT),
    ];
  }
  const kinds = (ids: string[]): (string | undefined)[] =>
    ids.map((id) => daemon.domain.getDecision(id)!.resolution?.kind);

  it("answers (instant key), skips, and dismisses across decisions", async () => {
    const decs = seedThree();
    // menu per decision: 1)opt 2)type-own 3)snooze 4)dismiss 5)skip
    const io = scriptedIO([key(1), key(5), key(4), key(1)]); // answer · skip · dismiss(+confirm yes)
    await interactiveInbox(client, MATT, io, NOW);

    const k = kinds(decs.map((d) => d.id));
    expect(k.filter((x) => x === "option")).toHaveLength(1);
    expect(k.filter((x) => x === "dismissed")).toHaveLength(1);
    expect(k.filter((x) => x === undefined)).toHaveLength(1); // skipped, untouched
    expect(printed()).toContain("answered 1");
    expect(printed()).toContain("skipped 1");
  });

  it("free-text answer requires a typed line (Enter)", async () => {
    const d = daemon.domain.createDecision({ prompt: "When?" }, MATT); // no options → 1)type-own
    const io = scriptedIO([key(1)], ["6pm"]);
    await interactiveInbox(client, MATT, io, NOW);
    expect(daemon.domain.getDecision(d.id)!.resolution?.freeText).toBe("6pm");
  });

  it("snooze fires on a preset keypress and records the snooze", async () => {
    const d = daemon.domain.createDecision({ prompt: "Later?" }, MATT); // 1)type-own 2)snooze
    const io = scriptedIO([key(2), key(2)]); // snooze → preset 2 (tomorrow morning)
    await interactiveInbox(client, MATT, io, NOW);
    expect(daemon.domain.getDecision(d.id)!.snoozedUntil).toBeTruthy();
  });

  it("empty inbox prints the empty message and seeds nothing", async () => {
    await interactiveInbox(client, MATT, scriptedIO([]), NOW);
    expect(printed()).toMatch(/empty/i);
  });

  it("cancel mid-loop stops processing and leaves decisions untouched", async () => {
    const decs = seedThree();
    await interactiveInbox(client, MATT, scriptedIO([cancelKey()]), NOW);
    expect(kinds(decs.map((d) => d.id)).every((x) => x === undefined)).toBe(true);
  });

  it("a rejected mutation re-prompts the same decision instead of aborting", async () => {
    const d = daemon.domain.createDecision({ prompt: "Pick?", options: [{ id: "x", label: "X" }] }, MATT);
    const realCallOk = client.callOk.bind(client);
    let thrown = false;
    client.callOk = async (name: string, args?: Record<string, unknown>) => {
      if (name === "decision_resolve" && !thrown) {
        thrown = true;
        throw new Error("daemon hiccup");
      }
      return realCallOk(name, args);
    };
    const io = scriptedIO([key(1), key(1)]); // first attempt throws, retry succeeds
    await interactiveInbox(client, MATT, io, NOW);
    expect(daemon.domain.getDecision(d.id)!.resolution?.kind).toBe("option");
  });

  it("no pending hint when nothing is skipped", async () => {
    const d = daemon.domain.createDecision({ prompt: "Pick?", options: [{ id: "x", label: "X" }] }, MATT);
    await interactiveInbox(client, MATT, scriptedIO([key(1)]), NOW);
    expect(daemon.domain.getDecision(d.id)!.resolution?.kind).toBe("option");
    expect(printed()).not.toContain("pending");
  });

  // ---- undo (U3) ----------------------------------------------------------

  const undoKey = (): InboxKey => ({ seq: "u", name: "u", isCancel: false, digit: null });
  // Two single-option decisions so there's always a "next" frame to press `u` on.
  const seedTwo = (): Decision[] => [
    daemon.domain.createDecision({ prompt: "Pick A?", options: [{ id: "a", label: "A" }] }, MATT),
    daemon.domain.createDecision({ prompt: "Pick B?", options: [{ id: "b", label: "B" }] }, MATT),
  ];

  it("u after answering reopens the previous decision and returns to it (R5)", async () => {
    const [d0] = seedTwo();
    // menu: 1)opt 2)type 3)snooze 4)dismiss 5)skip
    const io = scriptedIO([key(1), undoKey(), cancelKey()]); // answer d0 · at d1 undo · quit on d0
    await interactiveInbox(client, MATT, io, NOW);
    expect(daemon.domain.getDecision(d0!.id)!.resolution).toBeNull(); // reopened, pending again
  });

  it("undo then re-answer with a different option keeps one answered in the tally (R5, R6)", async () => {
    const d0 = daemon.domain.createDecision(
      { prompt: "A or B?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      MATT,
    );
    daemon.domain.createDecision({ prompt: "Other?", options: [{ id: "x", label: "X" }] }, MATT);
    // d0 menu: 1)a 2)b 3)type 4)snooze 5)dismiss 6)skip ; d1 menu: …5)skip
    const io = scriptedIO([key(1), undoKey(), key(2), key(5)]); // a · undo · b · skip d1
    await interactiveInbox(client, MATT, io, NOW);
    expect(daemon.domain.getDecision(d0.id)!.resolution?.optionId).toBe("b");
    expect(printed()).toContain("answered 1");
  });

  it("u on the very first decision is an invalid key — no reopen, re-prompts (R5)", async () => {
    const decs = seedTwo();
    let reopens = 0;
    const realCallOk = client.callOk.bind(client);
    client.callOk = async (name: string, args?: Record<string, unknown>) => {
      if (name === "decision_reopen") reopens++;
      return realCallOk(name, args);
    };
    const io = scriptedIO([undoKey(), cancelKey()]); // u with no prior action, then quit
    await interactiveInbox(client, MATT, io, NOW);
    expect(reopens).toBe(0);
    expect(kinds(decs.map((d) => d.id)).every((x) => x === undefined)).toBe(true);
  });

  it("undo a snooze clears it and resets the snoozed tally (R6)", async () => {
    const [d0] = seedTwo();
    const io = scriptedIO([key(3), key(2), undoKey(), cancelKey()]); // snooze→preset2 · undo · quit
    await interactiveInbox(client, MATT, io, NOW);
    expect(daemon.domain.getDecision(d0!.id)!.snoozedUntil).toBeNull();
    expect(printed()).toContain("snoozed 0");
  });

  it("undo a dismiss reopens the decision (R6)", async () => {
    const [d0] = seedTwo();
    const io = scriptedIO([key(4), key(1), undoKey(), cancelKey()]); // dismiss→confirm yes · undo · quit
    await interactiveInbox(client, MATT, io, NOW);
    expect(daemon.domain.getDecision(d0!.id)!.resolution).toBeNull();
  });

  it("undo a skip returns without any decision_reopen call (R5)", async () => {
    seedTwo();
    let reopens = 0;
    const realCallOk = client.callOk.bind(client);
    client.callOk = async (name: string, args?: Record<string, unknown>) => {
      if (name === "decision_reopen") reopens++;
      return realCallOk(name, args);
    };
    const io = scriptedIO([key(5), undoKey(), cancelKey()]); // skip d0 · undo · quit
    await interactiveInbox(client, MATT, io, NOW);
    expect(reopens).toBe(0);
    expect(printed()).toContain("skipped 0"); // skip tally reversed
  });

  it("a steered escalation answer offers no undo on the next frame (R7)", async () => {
    // Escalation routes through reconcile_resolve; stub it so the answer succeeds.
    const esc = daemon.domain.createDecision(
      { prompt: "Inbound — attach?", kind: "escalation", options: [{ id: "att", label: "Attach" }] },
      MATT,
    );
    const d1 = daemon.domain.createDecision({ prompt: "Next?", options: [{ id: "y", label: "Y" }] }, MATT);
    let reopens = 0;
    const realCallOk = client.callOk.bind(client);
    client.callOk = async (name: string, args?: Record<string, unknown>) => {
      if (name === "reconcile_resolve") return { verdict: "attached" } as never;
      if (name === "decision_reopen") reopens++;
      return realCallOk(name, args);
    };
    // esc menu (no free text): 1)att 2)snooze 3)dismiss 4)skip ; press 1 to steer, then u (invalid), then answer d1
    const io = scriptedIO([key(1), undoKey(), key(1)]);
    await interactiveInbox(client, MATT, io, NOW);
    expect(reopens).toBe(0); // u was an invalid key, no reopen
    expect(daemon.domain.getDecision(d1.id)!.resolution?.optionId).toBe("y"); // u didn't navigate back
    expect(esc.id).toBeTruthy();
  });
});
