import { describe, expect, it } from "vitest";
import { layoutDayChips, scheduleRange, shiftAnchor } from "../schedule-layout.js";

const HOUR = 60 * 60 * 1000;
const day = new Date(2026, 10, 5, 0, 0, 0, 0).getTime();
const at = (h: number, m = 0) => day + h * HOUR + m * 60_000;

describe("layoutDayChips", () => {
  it("places items that touch side by side, at most three lanes, then counts the rest", () => {
    const { chips, overflow } = layoutDayChips(
      [at(9), at(9), at(9), at(9), at(13)].map((startMs, i) => ({ key: `k${i}`, startMs })),
      { dayStartMs: day, pxPerHour: 48, chipPx: 22 },
    );
    const nine = chips.filter((c) => c.top === 9 * 48);
    expect(nine.map((c) => c.lane)).toEqual([0, 1, 2]);
    expect(nine.every((c) => c.lanes === 3)).toBe(true);
    expect(overflow).toEqual([{ top: 9 * 48, keys: ["k3"] }]);
    expect(chips.find((c) => c.key === "k4")).toMatchObject({ lane: 0, lanes: 1, twoLine: true });
  });

  it("caps lanes at the caller's limit", () => {
    const { chips, overflow } = layoutDayChips(
      [at(9), at(9), at(9)].map((startMs, i) => ({ key: `k${i}`, startMs })),
      { dayStartMs: day, pxPerHour: 48, chipPx: 22, maxLanes: 2 },
    );
    expect(chips.map((c) => c.lanes)).toEqual([2, 2]);
    expect(overflow).toEqual([{ top: 9 * 48, keys: ["k2"] }]);
  });

  it("keeps a chip on one line when the next item starts within the hour", () => {
    const { chips } = layoutDayChips(
      [{ key: "a", startMs: at(8, 30) }, { key: "b", startMs: at(9) }],
      { dayStartMs: day, pxPerHour: 48, chipPx: 22 },
    );
    expect(chips.map((c) => [c.key, c.lanes, c.twoLine])).toEqual([["a", 1, false], ["b", 1, true]]);
  });
});

describe("scheduleRange", () => {
  const anchor = new Date(2026, 10, 4, 11, 20);
  it("week starts on Monday", () => {
    const r = scheduleRange("week", anchor, false);
    expect(r.days.map((d) => d.getDate())).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });
  it("narrow week shows three days around the anchor", () => {
    expect(scheduleRange("week", anchor, true).days.map((d) => d.getDate())).toEqual([3, 4, 5]);
  });
  it("month covers six whole weeks from the Monday on or before the 1st", () => {
    const r = scheduleRange("month", anchor, false);
    expect(r.days).toHaveLength(42);
    expect(r.days[0]).toEqual(new Date(2026, 9, 26));
    expect(r.to.getTime() - r.from.getTime()).toBeLessThanOrEqual(43 * 24 * HOUR);
  });
  it("moves by a day, a week, three days when narrow, or a month", () => {
    expect(shiftAnchor("day", anchor, 1, false).getDate()).toBe(5);
    expect(shiftAnchor("week", anchor, -1, false).getDate()).toBe(28);
    expect(shiftAnchor("week", anchor, 1, true).getDate()).toBe(7);
    expect(shiftAnchor("month", anchor, 1, false).getMonth()).toBe(11);
  });
});
