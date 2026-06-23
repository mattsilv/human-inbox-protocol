import type { HipClient } from "../client.js";
import type { Decision, WireTask, HipEvent, Execution } from "../types.js";
import { colorStatus, colorId, colorHeading } from "./tty.js";

// CLI command bodies. Each is an MCP client call (the CLI dogfoods the binding — no
// direct store access) returning a printable string, so they are trivially testable.

export async function inbox(client: HipClient): Promise<string> {
  const { decisions } = (await client.callOk("decision_list")) as { decisions: Decision[] };
  if (decisions.length === 0) return "Inbox empty — nothing waiting on you.";
  const d = decisions[0]!;
  return renderDecision(d, 1, decisions.length);
}

export async function answer(
  client: HipClient,
  actorId: string,
  decisionId: string,
  choice: { option?: string; text?: string },
): Promise<string> {
  const got = await client.call("decision_get", { id: decisionId });
  if (got.isError) return `Decision ${decisionId} not found.`;
  const d = (got.structuredContent ?? {}) as unknown as Decision;
  if (d.resolution) return `Decision ${decisionId} is already resolved (${d.resolution.kind}).`;

  // Escalation decisions steer through reconcile; everything else resolves generically.
  if (d.kind === "escalation" && choice.option) {
    const r = (await client.callOk("reconcile_resolve", {
      actorId,
      decisionId,
      optionId: choice.option,
    })) as { verdict: string; task?: string };
    return `Steered: ${r.verdict}${r.task ? ` → ${r.task}` : ""}.`;
  }

  if (choice.option) {
    await client.callOk("decision_resolve", { actorId, id: decisionId, kind: "option", optionId: choice.option });
    return `Answered ${decisionId} with "${choice.option}".`;
  }
  if (choice.text !== undefined) {
    await client.callOk("decision_resolve", { actorId, id: decisionId, kind: "freeText", freeText: choice.text });
    return `Answered ${decisionId}: "${choice.text}".`;
  }
  return "Provide an option (--option) or free text (--text).";
}

export async function snooze(
  client: HipClient,
  actorId: string,
  decisionId: string,
  until: string,
): Promise<string> {
  await client.callOk("decision_snooze", { actorId, id: decisionId, until });
  return `Snoozed ${decisionId} until ${until}.`;
}

export async function dismiss(client: HipClient, actorId: string, decisionId: string): Promise<string> {
  await client.callOk("decision_resolve", { actorId, id: decisionId, kind: "dismissed" });
  return `Dismissed ${decisionId}.`;
}

export async function reopen(client: HipClient, actorId: string, decisionId: string): Promise<string> {
  await client.callOk("decision_reopen", { actorId, id: decisionId });
  return `Reopened ${decisionId}.`;
}

export async function listTasks(client: HipClient, status?: string): Promise<string> {
  const { tasks } = (await client.callOk("task_list", status ? { status } : {})) as { tasks: WireTask[] };
  if (tasks.length === 0) return "No tasks.";
  return tasks.map(renderTaskLine).join("\n");
}

export async function show(client: HipClient, id: string): Promise<string> {
  const res = await client.call("task_read", { id });
  if (res.isError) return `Task ${id} not found.`;
  const view = (res.structuredContent ?? {}) as {
    task?: WireTask;
    executions?: Execution[];
    events?: HipEvent[];
  };
  if (!view.task) return `Task ${id} not found.`;
  return renderTaskView(view.task, view.executions ?? [], view.events ?? []);
}

export async function events(
  client: HipClient,
  ref: { taskId?: string; decisionId?: string },
): Promise<string> {
  const { events: evs } = (await client.callOk("event_list", {
    ...(ref.taskId ? { taskId: ref.taskId } : {}),
    ...(ref.decisionId ? { decisionId: ref.decisionId } : {}),
  })) as { events: HipEvent[] };
  if (evs.length === 0) return "No events.";
  return evs.map((e) => `${e.at}  ${e.kind.padEnd(20)} ${e.actor}`).join("\n");
}

// ---- rendering ------------------------------------------------------------

function renderDecision(d: Decision, n: number, total: number): string {
  const lines = [`Decision ${n} of ${total}  [${colorId(d.id)}]`, "", colorHeading(d.prompt), ""];
  (d.options ?? []).forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}   (--option ${o.id})`));
  lines.push("");
  lines.push("Answer:  hip answer " + d.id + " --option <id> | --text \"...\"");
  lines.push("Or:      hip snooze " + d.id + " <ISO-time>   |   hip dismiss " + d.id);
  return lines.join("\n");
}

/** Human-facing handle: the small recycling `#N` while active, else the opaque id. */
function taskRef(t: WireTask): string {
  return typeof t.shortId === "number" ? `#${t.shortId}` : t.id;
}

function renderTaskLine(t: WireTask): string {
  const flag =
    t.status === "waiting"
      ? `${colorStatus("waiting")} on ${t.waitingOn?.onActor ?? "?"}`
      : colorStatus(t.status);
  return `${colorId(taskRef(t))}  [${flag}]  ${t.title}`;
}

function renderTaskView(t: WireTask, executions: Execution[], evs: HipEvent[]): string {
  // Detail view keeps the opaque id visible (for debugging / cross-references) but leads
  // with the #N handle when the task is active.
  const idLabel =
    typeof t.shortId === "number" ? `${colorId(`#${t.shortId}`)}  ${colorId(t.id)}` : colorId(t.id);
  const lines = [
    `${colorHeading(t.title)}  [${colorStatus(t.status)}]`,
    `id: ${idLabel}   from: ${t.delegatedBy?.actor} (${t.delegatedBy?.role})`,
  ];
  if (t.description) lines.push("", t.description);
  if (t.status === "waiting" && t.waitingOn) {
    lines.push("", `${colorStatus("waiting")} on ${t.waitingOn.onActor} since ${t.waitingOn.since}` + (t.waitingOn.cadence ? ` (every ${t.waitingOn.cadence})` : ""));
  }
  if (t.references?.length) {
    lines.push("", colorHeading("references:"));
    for (const r of t.references) lines.push(`  - ${r.displayName ?? r.globalId ?? r.type}`);
  }
  if (t.thread?.length) {
    lines.push("", colorHeading("thread:"));
    for (const c of t.thread) lines.push(`  ${c.at}  ${c.actor}: ${c.content}`);
  }
  if (executions.length) {
    lines.push("", colorHeading("executions:"));
    for (const e of executions) lines.push(`  ${colorId(e.id)}  ${e.status}` + (e.blockedOn ? ` (blockedOn ${e.blockedOn})` : ""));
  }
  if (evs.length) lines.push("", `${evs.length} events (hip events ${t.id})`);
  return lines.join("\n");
}
