import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Store } from "./store/index.js";
import { HipDaemon } from "./daemon/server.js";
import { NudgeEngine } from "./daemon/nudge.js";
import { HipClient } from "./client.js";

const DAY = 86_400_000;
const OWNER = "act_owner";
const ALEX = "act_alex";

export interface SmokeResult {
  ok: boolean;
  steps: { name: string; ok: boolean; detail: string }[];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
}

/**
 * Exercises the three milestone flows end-to-end against a self-contained daemon:
 * F1 nudge cycle, F2 reconcile attach, F3 block→answer→resume. A known-good baseline
 * for Hermes integration — if this passes, the daemon side of origin R15 is met.
 */
export async function runSmoke(log: (s: string) => void = () => {}): Promise<SmokeResult> {
  const root = mkdtempSync(join(tmpdir(), "hip-smoke-"));
  const token = "smoke-token";
  const port = await freePort();
  const store = new Store({ root });
  const daemon = new HipDaemon({ store, token, port });
  const engine = new NudgeEngine(store, { intervalMs: 60_000 });
  const steps: SmokeResult["steps"] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
  };

  await daemon.start();
  // Seed actors (install does this for real).
  daemon.domain.createActor({ id: OWNER, kind: "person", displayName: "Matt" });
  daemon.domain.createActor({ id: ALEX, kind: "person", displayName: "Alex", address: "+15551234" });

  const client = new HipClient({ url: daemon.url, token });
  await client.connect();

  try {
    // ---- F1: nudge cycle ----------------------------------------------------
    const since = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
    const t1 = (await client.callOk("task_create", {
      actorId: OWNER,
      title: "Dinner with Alex on Saturday",
      delegatedBy: { actor: OWNER, role: "creator" },
      references: [{ id: "ref_im", type: "email-thread", globalId: "imessage:thread_alex" }],
      waiting: { onActor: ALEX, since, cadence: "P1D" },
    })) as { id: string };

    engine.tick(); // server-owned timer scan: a 3-day-overdue P1D cadence fires once
    const pending = (await client.callOk("decision_list")) as { decisions: { id: string; task?: string; kind?: string }[] };
    const nudge = pending.decisions.find((d) => d.task === t1.id && d.kind === "nudge");
    record("F1 nudge cycle", !!nudge, nudge ? `nudge decision ${nudge.id} filed` : "no nudge decision filed");
    if (nudge) {
      await client.callOk("decision_resolve", { actorId: OWNER, id: nudge.id, kind: "option", optionId: "followed-up" });
    }

    // ---- F2: reconcile attach ----------------------------------------------
    const recon = (await client.callOk("reconcile_submit", {
      actorId: OWNER,
      envelope: {
        id: "env_smoke_1",
        kind: "message",
        from: ALEX,
        content: "Saturday works!",
        reference: { id: "r", type: "email-thread", globalId: "imessage:thread_alex" },
      },
    })) as { verdict: string; task?: string };
    const t1After = (await client.callOk("task_read", { id: t1.id })) as { task: { status: string; thread?: unknown[] } };
    const f2ok =
      recon.verdict === "attached" && recon.task === t1.id && t1After.task.status === "open" && !!t1After.task.thread?.length;
    record("F2 reconcile attach", f2ok, `verdict=${recon.verdict}, task now ${t1After.task.status}, thread grew`);

    // ---- F3: block → answer → resume ---------------------------------------
    const t3 = (await client.callOk("task_create", {
      actorId: OWNER,
      title: "Book the flights",
      delegatedBy: { actor: OWNER, role: "creator" },
    })) as { id: string };
    const exe = (await client.callOk("execution_register", { actorId: "act_agent", task: t3.id, actor: "act_agent" })) as { id: string };
    const blocked = (await client.callOk("task_block", {
      actorId: "act_agent",
      taskId: t3.id,
      executionId: exe.id,
      reason: "Which dates work?",
    })) as { decision: { id: string } };
    const beforeResolve = (await client.callOk("execution_get", { id: exe.id })) as { status: string };
    await client.callOk("decision_resolve", { actorId: OWNER, id: blocked.decision.id, kind: "freeText", freeText: "June 20-24" });
    const afterResolve = (await client.callOk("execution_get", { id: exe.id })) as { status: string; blockedOn: string | null };
    const f3ok = beforeResolve.status === "input-required" && afterResolve.status === "working" && afterResolve.blockedOn === null;
    record("F3 block→answer→resume", f3ok, `${beforeResolve.status} → ${afterResolve.status}`);

    return { ok: steps.every((s) => s.ok), steps };
  } finally {
    await client.close();
    engine.stop();
    await daemon.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// Runnable entry: `tsx src/smoke.ts` or `node dist/smoke.js`.
if (import.meta.url === `file://${process.argv[1]}`) {
  runSmoke((s) => process.stdout.write(s + "\n"))
    .then((r) => {
      process.stdout.write(r.ok ? "\nSMOKE OK — all three flows passed.\n" : "\nSMOKE FAILED.\n");
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      process.stderr.write(`smoke error: ${e instanceof Error ? e.stack : String(e)}\n`);
      process.exit(1);
    });
}
