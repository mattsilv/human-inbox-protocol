import * as clack from "@clack/prompts";
import pc from "picocolors";
import type { TaskStatus } from "../types.js";

// Shared CLI presentation layer. One gate — isInteractive() — decides whether a
// command renders rich (clack prompts, spinners, color) or falls back to today's
// plain-string output. Every color helper is a pass-through when non-interactive,
// so piped/CI/vitest output stays byte-identical and ANSI-free (R7/R9).

// A global `--plain` (parsed in index.ts) forces non-interactive for the whole run.
let forcedPlain = false;

/** Force non-interactive mode (used by the `--plain` flag). */
export function forcePlain(value = true): void {
  forcedPlain = value;
}

/**
 * The single source of truth for "is this a rich terminal?". False when stdin or
 * stdout is not a TTY (pipes, redirects, CI, vitest direct calls), when
 * `HIP_NO_INTERACTIVE` is set, or when `--plain` forced it. Clack prompts would hang
 * or throw on a non-TTY stdin, so every interactive entry point checks this first.
 */
export function isInteractive(): boolean {
  if (forcedPlain) return false;
  if (process.env.HIP_NO_INTERACTIVE) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Wrap slow daemon work in a spinner with success/error framing. In non-interactive
 * mode it just awaits `fn` silently (no output). The spinner is always stopped, and
 * `fn`'s rejection is rethrown so callers (e.g. withClient's connect-error mapping)
 * still see the failure (R5, KTD5).
 */
export async function spin<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!isInteractive()) return fn();
  const s = clack.spinner();
  s.start(label);
  try {
    const out = await fn();
    s.stop(label);
    return out;
  } catch (e) {
    s.stop(`${label} — failed`);
    throw e;
  }
}

// ---- color helpers --------------------------------------------------------
// Each is a no-op passthrough when non-interactive. picocolors already strips when
// it sees no TTY, but explicit gating keeps captured output provably clean (R7).

function paint(fn: (s: string) => string, s: string): string {
  return isInteractive() ? fn(s) : s;
}

/** Colorize a task/decision status token. */
export function colorStatus(status: TaskStatus | string): string {
  const map: Record<string, (s: string) => string> = {
    open: pc.cyan,
    waiting: pc.yellow,
    done: pc.green,
    dropped: pc.dim,
  };
  return paint(map[status] ?? ((s) => s), status);
}

/** Dim an object id so titles stay the focus. */
export function colorId(id: string): string {
  return paint(pc.dim, id);
}

/** Accent a hotkey (option number or shortcut letter) so it pops in the menu. */
export function colorKey(s: string): string {
  return paint((x) => pc.cyan(pc.bold(x)), s);
}

/** Bold a heading/title. */
export function colorHeading(s: string): string {
  return paint(pc.bold, s);
}

/** Dim secondary/hint text. */
export function colorDim(s: string): string {
  return paint(pc.dim, s);
}

// ---- glyphs ---------------------------------------------------------------
// Symbols used by the interactive inbox loop. The plain read renderers stay
// glyph-free to preserve byte-identical non-TTY output (R7/R9).

export const glyph = {
  done: "✓",
  dismissed: "✕",
  snooze: "⏰",
  edit: "✎",
  skip: "→",
} as const;
