// Future occurrences of schedule items for the schedule panel's day, week and month grids. Expansion reuses the scheduler's own
// next-fire arithmetic (advanceRepeatAt, the cron evaluator) so the grid never draws a time the scheduler would not fire.
import type { RoutineOccurrence, RoutineRecord } from "../shared/routines-types.js";
import { advanceRepeatAt, isMissedWhilePaused } from "./schedule-advance.js";
import { parseCronExpression, nextCronFire } from "./cron-evaluator.js";

/** A one-minute interval over a month would otherwise produce tens of thousands of chips. */
export const MAX_OCCURRENCES_PER_ROUTINE = 200;

export interface OccurrenceRange {
  /** Inclusive start, epoch ms. */
  from: number;
  /** Exclusive end, epoch ms. */
  to: number;
  now: number;
}

// Only what is still ahead: past runs come from the item's sessions and lastFiredAt, not from projection.
export function listRoutineOccurrences(records: readonly RoutineRecord[], range: OccurrenceRange): RoutineOccurrence[] {
  const out: RoutineOccurrence[] = [];
  const start = Math.max(range.from, range.now);
  for (const record of records) {
    if (record.dismissedAt || record.trigger !== "schedule" || !record.schedule) continue;
    if (isMissedWhilePaused(record)) {
      // Missed while paused: drawn where it was due, even in the past, so the user sees it and can run it now.
      const missedAt = Date.parse(record.schedule.at!);
      if (missedAt >= range.from && missedAt < range.to) out.push({ routineId: record.id, at: record.schedule.at!, status: "missed" });
      continue;
    }
    const status = record.orphanedAt ? "orphaned" : record.pausedAt ? "paused" : "scheduled";
    for (const at of expand(record, start, range.to, range.now)) out.push({ routineId: record.id, at, status });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.routineId.localeCompare(b.routineId));
}

function expand(record: RoutineRecord, start: number, end: number, now: number): string[] {
  const schedule = record.schedule!;
  const repeat = schedule.repeat;
  const times: string[] = [];
  if (repeat?.kind === "cron") {
    const fields = parseCronExpression(repeat.expression);
    if (!fields) return times;
    // nextCronFire scans from the minute after its argument, so start one minute early to include `start` itself.
    let cursor = new Date(start - 60_000);
    while (times.length < MAX_OCCURRENCES_PER_ROUTINE) {
      const minutesLeft = Math.ceil((end - cursor.getTime()) / 60_000);
      if (minutesLeft <= 0) break;
      const next = nextCronFire(fields, cursor, minutesLeft);
      if (!next || next.getTime() >= end) break;
      times.push(next.toISOString());
      cursor = next;
    }
    return times;
  }
  if (!schedule.at) return times;
  // A one-shot already fired is not due again; the scheduler's rule.
  if ((!repeat || repeat.kind === "none") && record.lastFiredAt) return times;
  let at = Date.parse(schedule.at);
  if (!Number.isFinite(at)) return times;
  // A next fire already past is due on the next scheduler pass: it runs once now, then the series continues after now.
  if (at < now) {
    if (now < end && now >= start) times.push(new Date(now).toISOString());
    const after = advanceRepeatAt(schedule.at, repeat, now);
    if (after === null) return times;
    at = Date.parse(after);
  }
  let iso = new Date(at).toISOString();
  // Jump fixed-length repeats straight to the range; monthly keeps chaining because each fire re-reads its day from the clamped `at`.
  if (at < start && repeat && repeat.kind !== "monthly" && repeat.kind !== "none") {
    const jumped = advanceRepeatAt(iso, repeat, start - 1);
    if (jumped !== null) {
      iso = jumped;
      at = Date.parse(jumped);
    }
  }
  while (times.length < MAX_OCCURRENCES_PER_ROUTINE && at < end) {
    if (at >= start) times.push(iso);
    const next = advanceRepeatAt(iso, repeat, at);
    if (next === null) break;
    iso = next;
    at = Date.parse(next);
  }
  return times;
}
