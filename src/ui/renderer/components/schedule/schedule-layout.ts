// Pure layout for the schedule grids: which days a view shows, how the anchor moves, and where a day's chips sit.
export type ScheduleViewMode = "day" | "week" | "month";

/** A chip with no other item in the next 50 minutes has room for a second line. */
const TWO_LINE_GAP_MS = 50 * 60 * 1000;
const MAX_LANES = 3;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Monday on or before `d`, in local time. */
function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  return addDays(day, -((day.getDay() + 6) % 7));
}

export interface ScheduleRange {
  from: Date;
  to: Date;
  days: Date[];
}

/** The days a view shows. A narrow week shows the anchor day with one day either side. */
export function scheduleRange(mode: ScheduleViewMode, anchor: Date, narrow: boolean): ScheduleRange {
  let first: Date;
  let count: number;
  if (mode === "day") {
    first = startOfDay(anchor);
    count = 1;
  } else if (mode === "week") {
    first = narrow ? addDays(startOfDay(anchor), -1) : startOfWeek(anchor);
    count = narrow ? 3 : 7;
  } else {
    first = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    count = 42;
  }
  const days = Array.from({ length: count }, (_, i) => addDays(first, i));
  return { from: first, to: addDays(first, count), days };
}

export function shiftAnchor(mode: ScheduleViewMode, anchor: Date, direction: 1 | -1, narrow: boolean): Date {
  if (mode === "day") return addDays(anchor, direction);
  if (mode === "week") return addDays(anchor, direction * (narrow ? 3 : 7));
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}


export interface ChipInput {
  key: string;
  startMs: number;
}

export interface LaidChip {
  key: string;
  top: number;
  lane: number;
  /** Lanes in this chip's cluster, capped at MAX_LANES; the chip's width is 1/lanes. */
  lanes: number;
  twoLine: boolean;
}

export interface ChipOverflow {
  top: number;
  keys: string[];
}

/**
 * Chips that touch share the row side by side, up to three lanes; the rest of a cluster is counted into one "+N" at the
 * cluster's top. A chip spans its one-line height in time, so two items 30 minutes apart at 48 px per hour do not touch.
 */
export function layoutDayChips(
  items: readonly ChipInput[],
  { dayStartMs, pxPerHour, chipPx, maxLanes = MAX_LANES }: { dayStartMs: number; pxPerHour: number; chipPx: number; maxLanes?: number },
): { chips: LaidChip[]; overflow: ChipOverflow[] } {
  const spanMs = (chipPx / pxPerHour) * 60 * 60 * 1000;
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs || a.key.localeCompare(b.key));
  const chips: LaidChip[] = [];
  const overflow: ChipOverflow[] = [];
  const topOf = (ms: number) => ((ms - dayStartMs) / (60 * 60 * 1000)) * pxPerHour;
  let i = 0;
  while (i < sorted.length) {
    // A cluster runs while each next item starts before the cluster's furthest chip ends.
    let clusterEnd = sorted[i].startMs + spanMs;
    let j = i + 1;
    while (j < sorted.length && sorted[j].startMs < clusterEnd) {
      clusterEnd = Math.max(clusterEnd, sorted[j].startMs + spanMs);
      j += 1;
    }
    const laneEnds: number[] = [];
    const placed: Array<{ item: ChipInput; lane: number }> = [];
    const hidden: string[] = [];
    for (const item of sorted.slice(i, j)) {
      let lane = laneEnds.findIndex((end) => end <= item.startMs);
      if (lane < 0) lane = laneEnds.length;
      if (lane >= maxLanes) {
        hidden.push(item.key);
        continue;
      }
      laneEnds[lane] = item.startMs + spanMs;
      placed.push({ item, lane });
    }
    const lanes = Math.min(maxLanes, laneEnds.length);
    const next = sorted[j]?.startMs;
    for (const { item, lane } of placed) {
      chips.push({
        key: item.key,
        top: topOf(item.startMs),
        lane,
        lanes,
        twoLine: lanes === 1 && (next === undefined || next - item.startMs >= TWO_LINE_GAP_MS),
      });
    }
    if (hidden.length > 0) overflow.push({ top: topOf(sorted[i].startMs), keys: hidden });
    i = j;
  }
  return { chips, overflow };
}
