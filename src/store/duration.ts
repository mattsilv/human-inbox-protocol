// Minimal ISO-8601 duration support for nudge cadences (P3D, PT30M, P1W, ...).
// We only need to add a duration to an instant; calendar-aware month/year math uses
// civil date arithmetic so "P1M" lands on the same day-of-month where possible.

const DURATION_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export interface ParsedDuration {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function parseDuration(iso: string): ParsedDuration | null {
  const m = DURATION_RE.exec(iso);
  if (!m || iso === "P" || iso === "PT") return null;
  const n = (s: string | undefined) => (s ? parseInt(s, 10) : 0);
  return {
    years: n(m[1]),
    months: n(m[2]),
    weeks: n(m[3]),
    days: n(m[4]),
    hours: n(m[5]),
    minutes: n(m[6]),
    seconds: n(m[7]),
  };
}

/** Add an ISO-8601 duration to an epoch-ms instant. Returns null on invalid input. */
export function addDuration(fromEpochMs: number, iso: string): number | null {
  const d = parseDuration(iso);
  if (!d) return null;
  const date = new Date(fromEpochMs);
  if (d.years) date.setUTCFullYear(date.getUTCFullYear() + d.years);
  if (d.months) date.setUTCMonth(date.getUTCMonth() + d.months);
  let ms = date.getTime();
  ms += d.weeks * 7 * 86_400_000;
  ms += d.days * 86_400_000;
  ms += d.hours * 3_600_000;
  ms += d.minutes * 60_000;
  ms += d.seconds * 1000;
  return ms;
}
