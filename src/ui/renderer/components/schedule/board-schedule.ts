// The work board's schedule cards, projected from the same occurrences and runs the schedule panel draws: each active item
// once in 예정 at its next time, each run in progress in 진행 중, and this week's finished runs as one bundle in 완료.
import type { RoutineOccurrence, RoutineRecord, RoutineRun } from "../../../../shared/routines-types.js";

export interface PlannedScheduleCard {
  routine: RoutineRecord;
  nextAt: string;
}

export interface RunningScheduleCard {
  routine: RoutineRecord;
  firedAt: string;
  sessionId?: string;
}

interface ScheduleWeekRow {
  routine: RoutineRecord;
  count: number;
  failed: number;
}

export interface BoardScheduleCards {
  planned: PlannedScheduleCard[];
  running: RunningScheduleCard[];
  /** Finished runs this week per item, and the items whose last occurrence was skipped (건너뜀) because its extensions are missing. */
  week: { total: number; rows: ScheduleWeekRow[]; skipped: RoutineRecord[] };
}

/** Monday 00:00 local of the week holding `now`, the same week the schedule panel shows. */
export function weekStart(now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

export function boardScheduleCards(input: {
  records: readonly RoutineRecord[];
  occurrences: readonly RoutineOccurrence[];
  runs: readonly RoutineRun[];
  running: ReadonlyMap<string, string>;
  now: Date;
}): BoardScheduleCards {
  const byId = new Map(input.records.map((r) => [r.id, r]));

  const running: RunningScheduleCard[] = [];
  for (const [routineId, firedAt] of input.running) {
    const routine = byId.get(routineId);
    if (!routine) continue;
    const sessionId = input.runs.find((run) => run.routineId === routineId && run.firedAt === firedAt)?.sessionId;
    running.push({ routine, firedAt, ...(sessionId ? { sessionId } : {}) });
  }

  const next = new Map<string, string>();
  for (const occ of input.occurrences) {
    if (occ.status !== "scheduled" || input.running.has(occ.routineId)) continue;
    const routine = byId.get(occ.routineId);
    if (!routine || routine.pausedAt) continue;
    const seen = next.get(occ.routineId);
    if (seen === undefined || Date.parse(occ.at) < Date.parse(seen)) next.set(occ.routineId, occ.at);
  }
  const planned = [...next].map(([id, nextAt]) => ({ routine: byId.get(id)!, nextAt }))
    .sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt));

  const fromMs = weekStart(input.now).getTime();
  const counts = new Map<string, { count: number; failed: number }>();
  for (const run of input.runs) {
    if (Date.parse(run.firedAt) < fromMs || !byId.has(run.routineId)) continue;
    if (input.running.get(run.routineId) === run.firedAt) continue;
    const entry = counts.get(run.routineId) ?? { count: 0, failed: 0 };
    entry.count += 1;
    if (run.status === "failed") entry.failed += 1;
    counts.set(run.routineId, entry);
  }
  const rows = input.records.flatMap((routine) => {
    const entry = counts.get(routine.id);
    return entry ? [{ routine, ...entry }] : [];
  });
  const skipped = input.records.filter((r) => r.lastSkippedReason === "plugins-missing" && r.needsAttention !== undefined);
  return { planned, running, week: { total: rows.reduce((sum, row) => sum + row.count, 0), rows, skipped } };
}
