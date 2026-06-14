import type { Store } from "../store/index.js";
import { Domain } from "../domain/index.js";
import { applyExpiry } from "../domain/decisions.js";
import type { Task } from "../types.js";

export const SYSTEM_ACTOR = "act_system";

export interface NudgeEngineOptions {
  intervalMs?: number;
}

/**
 * Server-owned cadence timers. A poll loop scans `next_fire_at <= now` every tick and
 * fires once per due task (coalesced, not once per missed period), so a slept machine
 * fires exactly once on wake — the at-or-after guarantee comes from the DB scan, not
 * from any single long timer.
 *
 * Firing invariant: the nudge decision is durable BEFORE the timer advances. Combined
 * with the dedupe rule (skip if an unresolved nudge decision already exists) this gives
 * at-least-once + idempotent firing. Crash repair: if a due timer's task already has an
 * unresolved nudge decision, that is a fire whose timer-advance was lost to a crash —
 * complete it (advance the timer) instead of filing a duplicate.
 */
export class NudgeEngine {
  private readonly domain: Domain;
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private lastTickAt?: number;
  private driftDetected = false;

  constructor(
    private readonly store: Store,
    opts: NudgeEngineOptions = {},
  ) {
    this.domain = new Domain(store);
    this.intervalMs = opts.intervalMs ?? 60_000;
  }

  /** Run a catch-up scan immediately, then poll. Startup order is reindex → here. */
  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One scan pass. Exposed for tests with an injectable clock. */
  tick(): { fired: string[]; repaired: string[]; expired: string[] } {
    const now = this.store.clock.now();
    if (this.lastTickAt !== undefined && now - this.lastTickAt > 2 * this.intervalMs) {
      this.driftDetected = true; // machine slept; the scan below already catches up
    }
    const result = this.scan(now);
    this.lastTickAt = now;
    return result;
  }

  get slept(): boolean {
    return this.driftDetected;
  }

  private scan(now: number): { fired: string[]; repaired: string[]; expired: string[] } {
    const fired: string[] = [];
    const repaired: string[] = [];

    for (const { task_id } of this.store.dueTimers(now)) {
      const task = this.store.getTask(task_id);
      if (!task || task.state.kind !== "waiting" || !task.state.cadence) {
        // Task left `waiting` (possibly via external edit) — drop the stale timer.
        this.store.removeTimer(task_id);
        continue;
      }

      const pending = this.store.pendingNudgeDecisionId(task_id);
      if (pending) {
        // Crashed-firing repair OR a still-open prior nudge: never duplicate, just
        // advance the timer so it stops being due. (confidence-100 fix)
        this.domain.recordNudge(task_id, SYSTEM_ACTOR);
        repaired.push(task_id);
        continue;
      }

      // Normal fire: decision durable first, THEN advance the timer.
      this.domain.createDecision(
        { task: task_id, prompt: nudgePrompt(task, now), options: nudgeOptions(), kind: "nudge" },
        SYSTEM_ACTOR,
      );
      this.domain.recordNudge(task_id, SYSTEM_ACTOR);
      fired.push(task_id);
    }

    const expired = this.sweepExpiry(now);
    return { fired, repaired, expired };
  }

  /** Actively resolve overdue decisions (lazy expiry also runs on read/list). */
  private sweepExpiry(now: number): string[] {
    const expired: string[] = [];
    for (const id of this.store.unresolvedDecisionIdsWithExpiry(now)) {
      const d = this.store.getDecision(id);
      if (d && applyExpiry(this.store, d)) expired.push(id);
    }
    return expired;
  }
}

function nudgePrompt(task: Task, now: number): string {
  const waiting = task.state.kind === "waiting" ? task.state : null;
  const onActor = waiting?.onActor ?? "someone";
  const since = waiting?.lastNudge ?? waiting?.since;
  const days = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 86_400_000)) : null;
  const lead = days !== null ? `${days} day${days === 1 ? "" : "s"} since you last checked` : "Following up";
  return `${lead} on "${task.title}" — you're waiting on ${onActor}. Follow up?`;
}

function nudgeOptions() {
  return [
    { id: "followed-up", label: "I followed up" },
    { id: "still-waiting", label: "Still waiting — remind me later" },
    { id: "drop", label: "Drop this" },
  ];
}
