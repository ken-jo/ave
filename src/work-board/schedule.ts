/** Build host-local midnight bounds with calendar helpers so DST days stay aligned with picker dates; inject time for tests. */
import { localDayStart, shiftLocalDateKey } from "../shared/local-date.js";

export function localDayBounds(day: string): { startMs: number; endMs: number } | null {
  const start = localDayStart(day);
  const end = localDayStart(shiftLocalDateKey(day, 1));
  if (start === null || end === null) return null;
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** Reports use Sunday weeks, while usage reporting deliberately uses Monday weeks. */
export function sundayWeekBoundsLocal(
  now: Date,
  weekOffset = 0,
): { start: Date; end: Date } {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay() + weekOffset * 7,
  );
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return { start, end };
}

export function isoWeekFor(now: Date): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
