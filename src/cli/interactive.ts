import * as readline from "node:readline";
import type { HipClient } from "../client.js";
import type { Decision, DecisionOption } from "../types.js";
import * as cmd from "./commands.js";
import { colorDim, colorHeading, colorKey, glyph } from "./tty.js";

// The interactive inbox is a small full-screen TUI: it redraws the CURRENT decision
// in the terminal's alternate screen buffer, takes a single keypress to pick a
// numbered choice (no Enter), and on exit restores the terminal clean with a one-line
// summary. Every mutation routes through the SAME command bodies the non-TTY path uses
// (cmd.answer/snooze/dismiss) — it never re-implements the mutation logic. The loop is
// driven through an InboxIO seam so it's unit-testable with scripted keys (no real TTY).

// ---- pure menu model (unit-tested) ----------------------------------------

export interface Choices {
  options: DecisionOption[];
  allowFreeText: boolean;
}

/** Options plus whether free-text answering applies to this decision. */
export function decisionToChoices(d: Decision): Choices {
  // Escalation decisions steer ONLY through their numbered options (attach/new/ignore).
  // Free-texting one would resolve it generically and silently drop the inbound message.
  const allowFreeText = d.kind === "escalation" ? false : (d.allowFreeText ?? true);
  return { options: d.options ?? [], allowFreeText };
}

export type MenuKind = "option" | "freeText" | "snooze" | "dismiss" | "skip";

export interface MenuEntry {
  num: number;
  kind: MenuKind;
  label: string;
  optionIndex?: number;
  optionId?: string;
}

/**
 * Build the single numbered menu for a decision: `1..N` options, then (when allowed)
 * "type your own", "snooze", "dismiss", "skip" — all numbered sequentially. One list,
 * numbers only, so a single keypress picks anything.
 */
export function buildMenu(d: Decision): MenuEntry[] {
  const choices = decisionToChoices(d);
  const entries: MenuEntry[] = [];
  let n = 1;
  choices.options.forEach((o, i) =>
    entries.push({ num: n++, kind: "option", label: o.label, optionIndex: i, optionId: o.id }),
  );
  if (choices.allowFreeText) entries.push({ num: n++, kind: "freeText", label: `${glyph.edit} Type your own answer` });
  entries.push({ num: n++, kind: "snooze", label: `${glyph.snooze} Snooze` });
  entries.push({ num: n++, kind: "dismiss", label: `${glyph.dismissed} Dismiss` });
  entries.push({ num: n++, kind: "skip", label: `${glyph.skip} Skip for now` });
  return entries;
}

/** Resolve a typed/pressed number to its menu entry, or null if out of range. */
export function resolveMenuKey(menu: MenuEntry[], num: number): MenuEntry | null {
  return menu.find((e) => e.num === num) ?? null;
}

/** Parse a number-keyed confirm: `1`/`y`/`yes` → true, `2`/`n`/`no` → false, else null. */
export function parseConfirm(input: string): boolean | null {
  const s = input.trim().toLowerCase();
  if (s === "1" || s === "y" || s === "yes") return true;
  if (s === "2" || s === "n" || s === "no") return false;
  return null;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Resolve a snooze input to a concrete ISO timestamp, or null if unintelligible/past.
 * Accepts numbered presets (`1` this evening, `2` tomorrow 9am, `3` this weekend, `4`
 * next week), shorthand (`2h`, `3d`, `1w`), weekday names (`mon`), and ISO dates.
 */
export function parseSnoozeShorthand(input: string, now: Date): string | null {
  const s = input.trim().toLowerCase();
  if (s === "") return null;

  if (s === "1") return atHour(addDays(startOfDay(now), now.getHours() >= 18 ? 1 : 0), 18).toISOString();
  if (s === "2") return atHour(addDays(startOfDay(now), 1), 9).toISOString();
  if (s === "3") return atHour(nextWeekday(now, 6), 9).toISOString(); // Saturday
  if (s === "4") return atHour(nextWeekday(now, 1), 9).toISOString(); // next Monday

  const rel = s.match(/^(\d+)\s*(h|d|w)$/);
  if (rel) {
    const n = Number.parseInt(rel[1]!, 10);
    const ms = rel[2] === "h" ? n * 3_600_000 : rel[2] === "d" ? n * 86_400_000 : n * 604_800_000;
    const at = new Date(now.getTime() + ms);
    return at.getTime() > now.getTime() ? at.toISOString() : null;
  }

  const wd = WEEKDAYS.indexOf(s);
  if (wd >= 0) return atHour(nextWeekday(now, wd), 9).toISOString();

  const t = Date.parse(input.trim());
  if (!Number.isNaN(t) && t > now.getTime()) return new Date(t).toISOString();

  return null;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function atHour(d: Date, h: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0, 0);
}
/** The next calendar day whose weekday is `target` (1=Mon…6=Sat,0=Sun), strictly after today. */
function nextWeekday(now: Date, target: number): Date {
  let delta = (target - now.getDay() + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(startOfDay(now), delta);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYNAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human echo of a resolved snooze time: `Mon Jun 16, 9am`. */
export function formatSnoozeEcho(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  const min = d.getMinutes();
  const time = min === 0 ? `${h}${ampm}` : `${h}:${String(min).padStart(2, "0")}${ampm}`;
  return `${DAYNAMES[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`;
}

// ---- IO seam (real terminal vs. scripted test) ----------------------------

export const CANCEL = Symbol("cancel");
export const UNDO = Symbol("undo");

/** A single keypress, normalized. `digit` is 1-9 for the menu; `isCancel` for Esc/Ctrl-C/q. */
export interface InboxKey {
  seq: string;
  name: string;
  isCancel: boolean;
  digit: number | null;
}

export interface InboxIO {
  begin(): void; // enter the alternate screen
  end(): void; // restore the terminal
  render(frame: string): void; // clear + draw the current frame
  readKey(): Promise<InboxKey>; // one keypress, instant (menu/preset/confirm)
  readLine(prompt: string): Promise<string | typeof CANCEL>; // a typed line, Enter submits
}

/** The real terminal IO: alternate screen + raw-mode keypresses + line input. */
function createTerminalIO(): InboxIO {
  const out = process.stdout;
  const stdin = process.stdin;
  readline.emitKeypressEvents(stdin);
  let pendingKey: ((k: InboxKey) => void) | null = null;

  const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
    if (!pendingKey) return;
    const seq = str ?? "";
    const name = key?.name ?? seq;
    const isCancel = Boolean((key?.ctrl && key?.name === "c") || key?.name === "escape" || name === "q");
    const digit = /^[1-9]$/.test(seq) ? Number(seq) : null;
    const resolve = pendingKey;
    pendingKey = null;
    resolve({ seq, name, isCancel, digit });
  };

  return {
    begin() {
      out.write("\x1b[?1049h\x1b[?25l"); // alt screen + hide cursor
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("keypress", onKeypress);
    },
    end() {
      stdin.removeListener("keypress", onKeypress);
      if (stdin.isTTY) stdin.setRawMode(false);
      out.write("\x1b[?25h\x1b[?1049l"); // show cursor + leave alt screen
      stdin.pause();
    },
    render(frame) {
      out.write("\x1b[2J\x1b[H" + frame);
    },
    readKey() {
      return new Promise<InboxKey>((resolve) => {
        pendingKey = resolve;
      });
    },
    async readLine(prompt) {
      // Hand stdin to a line reader (Enter submits); restore keypress capture after.
      stdin.removeListener("keypress", onKeypress);
      if (stdin.isTTY) stdin.setRawMode(false);
      out.write("\x1b[?25h");
      const rl = readline.createInterface({ input: stdin, output: out });
      try {
        return await new Promise<string | typeof CANCEL>((resolve) => {
          rl.question(prompt, (a) => resolve(a));
          rl.on("SIGINT", () => resolve(CANCEL));
        });
      } finally {
        rl.close();
        out.write("\x1b[?25l");
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.on("keypress", onKeypress);
        stdin.resume();
      }
    },
  };
}

// ---- the loop -------------------------------------------------------------

interface Tally {
  answered: number;
  snoozed: number;
  dismissed: number;
  skipped: number;
}

/**
 * Walk every pending decision in one stay-open TUI session. The alt-screen enter/leave
 * is in `finally`, so Ctrl-C or a throw always restores the terminal. Runs inside
 * `withClientVoid`, which closes the client in its own `finally`. A rejected mutation
 * re-prompts the same decision instead of tearing down the loop.
 */
export async function interactiveInbox(
  client: HipClient,
  actorId: string,
  io: InboxIO = createTerminalIO(),
  now: Date = new Date(),
): Promise<void> {
  const tally: Tally = { answered: 0, snoozed: 0, dismissed: 0, skipped: 0 };
  let summaryLine = "";

  const { decisions } = (await client.callOk("decision_list")) as { decisions: Decision[] };

  const summarize = (): string => {
    const parts = [
      `answered ${tally.answered}`,
      `snoozed ${tally.snoozed}`,
      `dismissed ${tally.dismissed}`,
      `skipped ${tally.skipped}`,
    ].join(" · ");
    const resolved = tally.answered + tally.snoozed + tally.dismissed;
    const pending = decisions.length - resolved; // skips + anything left on early exit
    const head = pending === 0 ? `Inbox clear ${glyph.done}` : `Inbox paused — ${pending} still waiting`;
    const hint = pending > 0 ? ` (${pending} pending — run \`hip inbox\` again)` : "";
    return `${head} — ${parts}${hint}`;
  };

  if (decisions.length === 0) {
    process.stdout.write(`Inbox empty ${glyph.done} — nothing waiting on you.\n`);
    return;
  }

  io.begin();
  try {
    const total = decisions.length;
    let flash = ""; // one-shot confirmation shown atop the NEXT decision, then cleared
    // Single-level undo: the most recent completed action, or null. `u` is offered only
    // while this is set (exactly when a flash is showing). Cleared after an undo and
    // suppressed for a steered escalation answer (its reconcile side-effects can't be reopened).
    let lastAction: { index: number; id: string; kind: keyof Tally } | null = null;

    let i = 0;
    while (i < total) {
      const d = decisions[i]!;
      const menu = buildMenu(d);
      let status = "";
      let next: number | null = null; // set to the index to move to once this decision is left

      while (next === null) {
        const canUndo = lastAction !== null;
        io.render(renderDecision(d, i, total, menu, status, flash, canUndo));
        flash = "";
        status = "";

        const entry = await pickEntry(io, menu, canUndo);
        if (entry === CANCEL) {
          summaryLine = summarize();
          return;
        }
        if (entry === UNDO) {
          const la = lastAction!; // pickEntry only returns UNDO when canUndo
          try {
            if (la.kind !== "skipped") await cmd.reopen(client, actorId, la.id);
            tally[la.kind]--;
            flash = colorDim("Undid — answer again.");
            lastAction = null;
            next = la.index;
          } catch (e) {
            status = `Couldn't undo — ${e instanceof Error ? e.message : String(e)}. Try again.`;
          }
          continue;
        }
        if (entry === null) {
          status = "Press a number from the list.";
          continue;
        }

        try {
          switch (entry.kind) {
            case "skip":
              tally.skipped++;
              flash = colorDim("Skipped.");
              lastAction = { index: i, id: d.id, kind: "skipped" };
              next = i + 1;
              break;
            case "option":
              await cmd.answer(client, actorId, d.id, { option: entry.optionId! });
              tally.answered++;
              flash = `${glyph.done} Answered "${stripLabel(entry.label)}"`;
              // A steered escalation answer is not undoable (reconcile side-effects).
              lastAction = d.kind === "escalation" ? null : { index: i, id: d.id, kind: "answered" };
              next = i + 1;
              break;
            case "freeText": {
              io.render(renderDecision(d, i, total, menu, "Type your answer, then Enter:", ""));
              const txt = await io.readLine("› ");
              if (txt === CANCEL) {
                summaryLine = summarize();
                return;
              }
              const s = String(txt).trim();
              if (s === "") {
                status = "Empty answer — try again.";
                continue;
              }
              await cmd.answer(client, actorId, d.id, { text: s });
              tally.answered++;
              flash = `${glyph.done} Answered: "${s}"`;
              lastAction = { index: i, id: d.id, kind: "answered" };
              next = i + 1;
              break;
            }
            case "snooze": {
              const r = await runSnooze(io, client, actorId, d, i, total, now);
              if (r === "cancel") {
                summaryLine = summarize();
                return;
              }
              if (r === "retry") {
                status = "Didn't understand that time — try a preset 1-4, or 2h / 3d / mon.";
                continue;
              }
              tally.snoozed++;
              flash = `${glyph.done} ${r}`;
              lastAction = { index: i, id: d.id, kind: "snoozed" };
              next = i + 1;
              break;
            }
            case "dismiss": {
              io.render(renderDecision(d, i, total, menu, "Dismiss this decision?  1) Yes   2) No", ""));
              const k = await io.readKey();
              if (k.isCancel) {
                summaryLine = summarize();
                return;
              }
              const yes = parseConfirm(k.seq || k.name);
              if (!yes) {
                status = "Kept.";
                continue;
              }
              await cmd.dismiss(client, actorId, d.id);
              tally.dismissed++;
              flash = `${glyph.dismissed} Dismissed.`;
              lastAction = { index: i, id: d.id, kind: "dismissed" };
              next = i + 1;
              break;
            }
          }
        } catch (e) {
          // A rejected mutation re-prompts the SAME decision instead of aborting.
          status = `Couldn't do that — ${e instanceof Error ? e.message : String(e)}. Try again.`;
        }
      }
      i = next;
    }
    summaryLine = summarize();
  } finally {
    io.end();
    if (summaryLine) process.stdout.write(summaryLine + "\n");
  }
}

/**
 * Read one menu selection. Single keypress when ≤9 entries; typed number otherwise.
 * `u`/`U` returns UNDO, but only when `canUndo` — otherwise a stray `u` is an invalid key.
 */
async function pickEntry(
  io: InboxIO,
  menu: MenuEntry[],
  canUndo: boolean,
): Promise<MenuEntry | null | typeof CANCEL | typeof UNDO> {
  if (menu.length <= 9) {
    const key = await io.readKey();
    if (key.isCancel) return CANCEL;
    if (canUndo && (key.seq === "u" || key.seq === "U" || key.name === "u")) return UNDO;
    if (key.digit === null) return null;
    return resolveMenuKey(menu, key.digit);
  }
  // Rare: more than 9 entries (big escalation list) — multi-digit needs Enter.
  const line = await io.readLine(`Choose a number (1-${menu.length}) › `);
  if (line === CANCEL) return CANCEL;
  const raw = String(line).trim();
  if (canUndo && raw.toLowerCase() === "u") return UNDO;
  const num = Number.parseInt(raw, 10);
  return Number.isNaN(num) ? null : resolveMenuKey(menu, num);
}

/** The snooze sub-flow. Returns "cancel", "retry", or the success echo string. */
async function runSnooze(
  io: InboxIO,
  client: HipClient,
  actorId: string,
  d: Decision,
  i: number,
  total: number,
  now: Date,
): Promise<"cancel" | "retry" | string> {
  const presets = [
    "  1) this evening",
    "  2) tomorrow morning",
    "  3) this weekend",
    "  4) next week",
    `  5) ${glyph.edit} custom (2h, 3d, mon, ISO)`,
  ].join("\n");
  io.render(renderFrame(i, total, `When should this come back?\n\n${presets}`, ""));

  const key = await io.readKey();
  if (key.isCancel) return "cancel";

  let at: string | null = null;
  if (key.digit !== null && key.digit >= 1 && key.digit <= 4) {
    at = parseSnoozeShorthand(String(key.digit), now);
  } else if (key.digit === 5) {
    const line = await io.readLine("Snooze until (2h, 3d, mon, ISO) › ");
    if (line === CANCEL) return "cancel";
    at = parseSnoozeShorthand(String(line), now);
  } else {
    return "retry";
  }
  if (!at) return "retry";

  await cmd.snooze(client, actorId, d.id, at);
  return `Snoozed until ${formatSnoozeEcho(at)}`;
}

// ---- rendering ------------------------------------------------------------

function decisionTitle(d: Decision): string {
  const firstLine = d.prompt.split("\n")[0]!.trim();
  return firstLine.length > 0 ? firstLine : d.id;
}

/** Strip a leading glyph from a menu label for clean echo text. */
function stripLabel(label: string): string {
  return label.replace(/^[^\w$]+\s*/, "").trim() || label;
}

/** Render a full decision frame: header, prompt, numbered menu, status/flash. */
function renderDecision(
  d: Decision,
  i: number,
  total: number,
  menu: MenuEntry[],
  status: string,
  flash: string,
  canUndo = false,
): string {
  const body = [colorHeading(decisionTitle(d)), "", ...menu.map((e) => `  ${colorKey(`${e.num})`)} ${e.label}`)].join(
    "\n",
  );
  return renderFrame(i, total, body, status, flash, canUndo);
}

/** The shared frame chrome (header, body, footer hint, status line). */
function renderFrame(i: number, total: number, body: string, status: string, flash = "", canUndo = false): string {
  const header = `${colorHeading("📥 HIP inbox")} ${colorDim(`(${i + 1}/${total})`)}`;
  const lines = [header, ""];
  // `u to undo` is advertised on the flash line and footer only while an undo target exists.
  if (flash) lines.push(colorDim(flash + (canUndo ? "  ·  press u to undo" : "")), "");
  lines.push(body, "");
  if (status) lines.push(status, "");
  const footer = canUndo ? "Press a number · u to undo · Esc to quit" : "Press a number · Esc to quit";
  lines.push(colorDim(footer));
  return lines.join("\r\n") + "\r\n";
}
