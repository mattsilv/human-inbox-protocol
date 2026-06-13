import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { ensureDir } from "./atomic.js";
import { dirname } from "node:path";
import type { HipEvent } from "../types.js";

/**
 * Append-only JSONL event log. Each append is a single line, fsynced — this is the
 * write-ahead intent that makes "no state change without an event" true. A crash
 * during the final append can leave a torn last line; readers tolerate-and-truncate
 * it (a partial trailing line is a write that never completed, so it never happened).
 */
export class EventLog {
  constructor(private readonly file: string) {}

  append(event: HipEvent): void {
    ensureDir(dirname(this.file));
    const line = JSON.stringify(event) + "\n";
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, line, null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Read all well-formed events, silently dropping a torn final line. */
  readAll(): HipEvent[] {
    if (!existsSync(this.file)) return [];
    const raw = readFileSync(this.file, "utf8");
    if (raw.length === 0) return [];
    const lines = raw.split("\n");
    // A well-terminated file ends with "\n" → last split element is "".
    const events: HipEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line) as HipEvent);
      } catch {
        // Only the final, unterminated line is allowed to be torn.
        const isLast = i === lines.length - 1;
        if (isLast) break;
        throw new Error(`Corrupt event log line ${i + 1} (not the trailing line)`);
      }
    }
    return events;
  }

  forTask(taskId: string): HipEvent[] {
    return this.readAll().filter((e) => e.task === taskId);
  }

  forDecision(decisionId: string): HipEvent[] {
    return this.readAll().filter((e) => e.decision === decisionId);
  }
}
