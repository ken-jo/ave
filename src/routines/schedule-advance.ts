// Next-fire arithmetic for at-based repeats. The store advances a fired item with it and the schedule panel expands occurrences with it,
// so the grid draws exactly the times the scheduler will fire. Each function returns the first fire strictly after `nowMs`.
import type { RoutineRepeat } from "../shared/routines-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function advanceFixed(atIso: string, intervalMs: number, nowMs: number): string {
  const d = new Date(atIso);
  if (intervalMs <= 0) return d.toISOString();
  if (d.getTime() <= nowMs) {
    const skips = Math.floor((nowMs - d.getTime()) / intervalMs) + 1;
    d.setTime(d.getTime() + skips * intervalMs);
  }
  return d.toISOString();
}

// Keep the original calendar day across skipped months so February clamping does not permanently shift a 31st-day schedule.
function advanceMonthly(atIso: string, nowMs: number, originalDay: number): string {
  const d = new Date(atIso);
  while (d.getTime() <= nowMs) {
    // Set day=1 first to avoid month-overflow when current day > target-month days.
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const maxDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(originalDay, maxDay));
  }
  return d.toISOString();
}

/** The first fire of an at-based repeat after `nowMs`, or null for a kind that does not advance `at` (none, cron). */
export function advanceRepeatAt(atIso: string, repeat: RoutineRepeat | undefined, nowMs: number): string | null {
  switch (repeat?.kind) {
    case "daily": return advanceFixed(atIso, DAY_MS, nowMs);
    case "weekly": return advanceFixed(atIso, 7 * DAY_MS, nowMs);
    case "monthly": return advanceMonthly(atIso, nowMs, new Date(atIso).getUTCDate());
    case "interval": return advanceFixed(atIso, repeat.intervalMs, nowMs);
    default: return null;
  }
}
