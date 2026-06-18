import type { Command } from "commander";
import * as clack from "@clack/prompts";
import type { HipClient } from "../client.js";
import type { WireTask, Decision } from "../types.js";
import { withClient, withClientVoid } from "./run.js";
import { spin, colorHeading, colorDim, glyph, isInteractive } from "./tty.js";
import { interactiveInbox } from "./interactive.js";
import { DEMO_ENVELOPE_PREFIX } from "../domain/demo-cleanup.js";

// `hip demo` seeds one believable, specific example per distinct HIP scenario so a
// first-timer running the inbox immediately sees the full range of what HIP does. It
// drives everything through the MCP binding (no direct store access), exactly like an
// agent would. Every demo object is tagged `_meta.demo` so a re-run RESETS the prior
// seed first — no stale pile-up. Decisions are mostly concrete numbered options.

const ALEX = "act_demo_alex";
const AGENT = "act_demo_agent";
const PLUMBER = "act_demo_plumber";
const DEMO_ENV_PREFIX = DEMO_ENVELOPE_PREFIX;

/** Create an actor, tolerating "already exists" so the demo is re-runnable. */
async function ensureActor(
  client: HipClient,
  input: { id: string; kind: string; displayName: string },
): Promise<void> {
  const r = await client.call("actor_create", input);
  if (r.isError) {
    const code = (r.structuredContent?.error as { code?: string } | undefined)?.code;
    if (code !== "conflict") {
      throw new Error(`actor_create ${input.id} failed: ${JSON.stringify(r.structuredContent)}`);
    }
  }
}

/**
 * Register an execution and block it on a human decision (an agent hitting a fork).
 * Returns the created decision id so callers can snooze it. The task is demo-tagged at
 * creation (`_meta.demo`) — tagging inline, not via a follow-up update, is required so
 * the maybeCleanDemo hook in createTask sees the demo flag and skips the seed task.
 * The decision carries `task`, so resetDemo reaches it via the task link.
 */
async function blockedTask(
  client: HipClient,
  owner: string,
  title: string,
  prompt: string,
  options?: { id: string; label: string }[],
  description?: string,
): Promise<string> {
  const t = (await client.callOk("task_create", {
    actorId: owner,
    title,
    ...(description ? { description } : {}),
    delegatedBy: { actor: owner, role: "creator" },
    demoSeed: true,
  })) as { id: string };
  const exe = (await client.callOk("execution_register", { actorId: AGENT, task: t.id, actor: AGENT })) as {
    id: string;
  };
  const r = (await client.callOk("task_block", {
    actorId: AGENT,
    taskId: t.id,
    executionId: exe.id,
    reason: prompt,
    ...(options ? { options } : {}),
  })) as { decision: { id: string } };
  return r.decision.id;
}

async function openTask(
  client: HipClient,
  owner: string,
  title: string,
  patch?: Record<string, unknown>,
): Promise<string> {
  const t = (await client.callOk("task_create", {
    actorId: owner,
    title,
    delegatedBy: { actor: owner, role: "creator" },
    demoSeed: true,
  })) as { id: string };
  // Tagged at creation above; only apply the extra patch (e.g. priority) if present.
  if (patch) await client.callOk("task_update", { actorId: owner, id: t.id, patch });
  return t.id;
}

/** A task that is waiting on someone, with an auto-nudge cadence. */
async function waitingTask(
  client: HipClient,
  owner: string,
  title: string,
  onActor: string,
  cadence: string | null,
): Promise<string> {
  const id = await openTask(client, owner, title);
  await client.callOk("task_wait", {
    actorId: owner,
    id,
    waitingOn: { onActor, since: new Date().toISOString(), cadence },
  });
  return id;
}

function isDemoTask(t: WireTask): boolean {
  return (t._meta as { demo?: unknown } | undefined)?.demo === true;
}
function isDemoDecision(d: Decision, demoTaskIds: Set<string>): boolean {
  if (d.task && demoTaskIds.has(d.task)) return true;
  const env = (d._meta as { envelope?: { id?: string } } | undefined)?.envelope;
  return typeof env?.id === "string" && env.id.startsWith(DEMO_ENV_PREFIX);
}

/**
 * Clear a prior demo seed: dismiss demo decisions (so they leave the inbox) and drop
 * demo tasks. Only ever touches `_meta.demo` tasks and decisions linked to them (or demo
 * reconcile envelopes), so real tasks are untouched.
 */
async function resetDemo(client: HipClient, owner: string): Promise<void> {
  const { tasks } = (await client.callOk("task_list")) as { tasks: WireTask[] };
  const demoTasks = tasks.filter(isDemoTask);
  const demoTaskIds = new Set(demoTasks.map((t) => t.id));

  const { decisions } = (await client.callOk("decision_list")) as { decisions: Decision[] };
  for (const d of decisions) {
    if (d.resolution) continue;
    if (isDemoDecision(d, demoTaskIds)) {
      await client.callOk("decision_resolve", { actorId: owner, id: d.id, kind: "dismissed" });
    }
  }
  // Only drop tasks that are still live — task_drop throws on an already-dropped task,
  // and task_list returns dropped ones from earlier resets.
  for (const t of demoTasks) {
    if (t.status !== "dropped" && t.status !== "done") {
      await client.callOk("task_drop", { actorId: owner, id: t.id });
    }
  }
}

async function seedAll(client: HipClient, owner: string): Promise<void> {
  await ensureActor(client, { id: ALEX, kind: "person", displayName: "Alex (teammate)" });
  await ensureActor(client, { id: AGENT, kind: "agent", displayName: "Demo agent" });
  await ensureActor(client, { id: PLUMBER, kind: "service", displayName: "Marco the plumber" });

  // Fresh start every run — no stale pile-up.
  await resetDemo(client, owner);

  // Unique envelope ids per run so reconcile (idempotent on id) re-seeds after a reset.
  const stamp = Date.now();

  // --- inbox decisions, strongest first, mostly concrete numbered options ---

  // 1. Decision with options — agent blocks, human picks, agent resumes.
  await blockedTask(
    client,
    owner,
    "Reply to the landlord about the lease renewal",
    "Renew the lease for 12 or 24 months?",
    [
      { id: "m12", label: "12 months — rent rises to $2,520/mo" },
      { id: "m24", label: "24 months — rent holds at $2,400/mo" },
    ],
    "Lease ends Aug 31. The landlord offered $2,520/mo on a 12-month or $2,400/mo locked for 24.",
  );

  // 2. Approve-a-quote decision.
  await blockedTask(
    client,
    owner,
    "Approve the dishwasher repair quote",
    "The repair tech quoted $340 for the dishwasher — how do you want to proceed?",
    [
      { id: "accept", label: "Approve $340 and book the repair" },
      { id: "decline", label: "Decline — it's not worth it" },
      { id: "second", label: "Get a second quote first" },
    ],
  );

  // 3. Pick-a-slot decision.
  await blockedTask(
    client,
    owner,
    "Book the dentist cleaning",
    "Which slot works for the dentist cleaning?",
    [
      { id: "mon", label: "Mon Jun 15, 9:00am" },
      { id: "tue", label: "Tue Jun 16, 9:00am" },
      { id: "wed", label: "Wed Jun 17, 2:00pm" },
    ],
  );

  // 4. Free-text decision — an open question with no preset answers.
  await blockedTask(
    client,
    owner,
    "Give FedEx the delivery gate code",
    "FedEx needs a gate code for the 3pm drop-off — what should I give them?",
  );

  // 5. Escalation — an inbound email that matches no open task escalates a one-tap.
  await client.callOk("reconcile_submit", {
    actorId: owner,
    envelope: {
      id: `${DEMO_ENV_PREFIX}_reservation_${stamp}`,
      kind: "email",
      from: "reservations@bistro.example",
      content: "Re: your reservation — confirming a table for 4 on Friday at 7:30pm.",
      receivedAt: new Date().toISOString(),
    },
  });

  // --- tasks ---------------------------------------------------------------

  // 6. Waiting on a person + auto-nudge cadence (every 2 days).
  await waitingTask(client, owner, "Get Q3 revenue numbers from Alex for the board deck", ALEX, "P2D");

  // 7. Inbound message reconciles onto a task (attach). The plumber task waits on Marco;
  //    his reply attaches to the thread and flips the task back to open.
  await waitingTask(client, owner, "Fix the dripping kitchen faucet", PLUMBER, null);
  await client.callOk("reconcile_submit", {
    actorId: owner,
    envelope: {
      id: `${DEMO_ENV_PREFIX}_plumber_${stamp}`,
      kind: "message",
      from: PLUMBER,
      content: "Can do Thursday 9am — does that work?",
      receivedAt: new Date().toISOString(),
    },
  });

  // 8. High-priority open task.
  await openTask(client, owner, "Pay the electric bill — $143, due tomorrow", { priority: "high" });

  // 9. Plain open task.
  await openTask(client, owner, "Unpack the last two kitchen boxes from the move");

  // 10. Snoozed decision — deferred, non-terminal; stays out of the inbox until later.
  const passport = await blockedTask(
    client,
    owner,
    "Renew your passport",
    "Your passport expires in 5 months — start the renewal?",
  );
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 9, 0, 0);
  await client.callOk("decision_snooze", { actorId: owner, id: passport, until: nextMonth.toISOString() });
}

export async function seedDemo(client: HipClient, owner: string): Promise<string> {
  await spin("Seeding demo data", () => seedAll(client, owner));
  return summary();
}

const SCENARIO_ROWS: [string, string][] = [
  ["Decision · options", "Landlord lease — 12 vs 24 months"],
  ["Decision · approve", "Dishwasher repair quote — $340?"],
  ["Decision · pick a slot", "Dentist cleaning — Mon / Tue / Wed"],
  ["Decision · free text", "FedEx gate code for the 3pm drop-off"],
  ["Escalation", "Unmatched \"Re: your reservation\" email"],
  ["Waiting + nudge", "Q3 numbers from Alex (nudges every 2 days)"],
  ["Reconcile attach", "Plumber's reply lands on the faucet task"],
  ["High-priority task", "Pay the electric bill — due tomorrow"],
  ["Plain task", "Unpack the last two kitchen boxes"],
  ["Snoozed decision", "Passport renewal — deferred a month"],
];

/** The scenario table — one labeled line per seeded example. */
function rowsBlock(): string {
  const width = Math.max(...SCENARIO_ROWS.map(([k]) => k.length));
  return SCENARIO_ROWS.map(([k, v]) => `${colorHeading(k.padEnd(width))}  ${colorDim("—")}  ${v}`).join("\n");
}

/** Plain (non-TTY) summary string returned by seedDemo for scripts and tests. */
function summary(): string {
  return [
    colorHeading("Seeded one example of each thing HIP handles:"),
    "",
    rowsBlock(),
    "",
    colorDim("Re-runnable; each `hip demo` resets the prior demo seed first."),
    `${glyph.done} Now run: hip inbox`,
  ].join("\n");
}

export function registerDemoCommands(program: Command): void {
  program
    .command("demo")
    .description("Reset and seed one example of each HIP scenario, then open the inbox")
    .action(async () => {
      // Non-TTY (pipe/CI/--plain): seed and print the plain summary, as before.
      if (!isInteractive()) {
        await withClient((c, cfg) => seedDemo(c, cfg.actorId));
        return;
      }
      // TTY: frame the seed, then flow straight into the interactive inbox.
      await withClientVoid(async (c, cfg) => {
        clack.intro(colorHeading("✨ HIP demo"));
        await spin("Seeding one example of each scenario", () => seedAll(c, cfg.actorId));
        clack.note(rowsBlock(), "Seeded 10 examples");
        const go = await clack.confirm({ message: "Open your inbox now?" });
        if (clack.isCancel(go) || !go) {
          clack.outro(`${glyph.done} Run \`hip inbox\` whenever you're ready.`);
          return;
        }
        await interactiveInbox(c, cfg.actorId);
      });
    });
}
