import { describe, it, expect } from "vitest";
import { listRoutineOccurrences, MAX_OCCURRENCES_PER_ROUTINE } from "../occurrences.js";
import type { RoutineRecord } from "../../shared/routines-types.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-04T02:20:00.000Z");
const FROM = Date.parse("2026-11-02T00:00:00.000Z");
const TO = FROM + 7 * DAY;

function record(patch: Partial<RoutineRecord>): RoutineRecord {
  return {
    id: "r1",
    trigger: "schedule",
    execution: "llm-session",
    prePrompt: "p",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  };
}

describe("listRoutineOccurrences", () => {
  it("expands a daily item from its next fire to the end of the range", () => {
    const occ = listRoutineOccurrences([record({ schedule: { at: "2026-11-05T00:00:00.000Z", repeat: { kind: "daily" } } })], { from: FROM, to: TO, now: NOW });
    expect(occ.map((o) => o.at)).toEqual([
      "2026-11-05T00:00:00.000Z",
      "2026-11-06T00:00:00.000Z",
      "2026-11-07T00:00:00.000Z",
      "2026-11-08T00:00:00.000Z",
    ]);
    expect(occ.every((o) => o.routineId === "r1" && o.status === "scheduled")).toBe(true);
  });

  // The store re-reads the day from the stored `at` on each fire, so a 31st clamped to the 28th stays on the 28th; the grid mirrors that.
  it("steps monthly exactly as successive scheduler fires do", () => {
    const occ = listRoutineOccurrences(
      [record({ schedule: { at: "2027-01-31T00:00:00.000Z", repeat: { kind: "monthly" } } })],
      { from: Date.parse("2027-01-01T00:00:00.000Z"), to: Date.parse("2027-04-01T00:00:00.000Z"), now: Date.parse("2027-01-01T00:00:00.000Z") },
    );
    expect(occ.map((o) => o.at)).toEqual(["2027-01-31T00:00:00.000Z", "2027-02-28T00:00:00.000Z", "2027-03-28T00:00:00.000Z"]);
  });

  it("expands cron minutes inside the range only", () => {
    const occ = listRoutineOccurrences([record({ schedule: { repeat: { kind: "cron", expression: "30 0 * * 1" } } })], { from: FROM, to: TO + 7 * DAY, now: NOW });
    expect(occ.map((o) => o.at)).toEqual(["2026-11-09T00:30:00.000Z"]);
  });

  it("marks a paused item, skips dismissed, shutdown and fired one-shots", () => {
    const occ = listRoutineOccurrences([
      record({ id: "paused", pausedAt: "2026-11-03T00:00:00.000Z", pausedBy: "user", schedule: { at: "2026-11-05T09:00:00.000Z" } }),
      record({ id: "dismissed", dismissedAt: "2026-11-03T00:00:00.000Z", schedule: { at: "2026-11-05T09:00:00.000Z" } }),
      record({ id: "shutdown", trigger: "shutdown" }),
      record({ id: "fired", lastFiredAt: "2026-11-03T00:00:00.000Z", schedule: { at: "2026-11-03T00:00:00.000Z" } }),
    ], { from: FROM, to: TO, now: NOW });
    expect(occ).toEqual([{ routineId: "paused", at: "2026-11-05T09:00:00.000Z", status: "paused" }]);
  });

  it("a past-due next fire is shown at now, where the scheduler will catch it up", () => {
    const occ = listRoutineOccurrences([record({ schedule: { at: "2026-11-03T00:00:00.000Z", repeat: { kind: "daily" } } })], { from: FROM, to: TO, now: NOW });
    expect(occ[0]).toEqual({ routineId: "r1", at: new Date(NOW).toISOString(), status: "scheduled" });
    expect(occ[1]?.at).toBe("2026-11-05T00:00:00.000Z");
  });

  it("draws a one-shot missed while paused at its time, even in the past", () => {
    const occ = listRoutineOccurrences([record({ schedule: { at: "2026-11-03T00:00:00.000Z" }, resumedAt: "2026-11-04T00:00:00.000Z" })], { from: FROM, to: TO, now: NOW });
    expect(occ).toEqual([{ routineId: "r1", at: "2026-11-03T00:00:00.000Z", status: "missed" }]);
  });

  it("bounds a one-minute interval", () => {
    const occ = listRoutineOccurrences([record({ schedule: { at: "2026-11-05T00:00:00.000Z", repeat: { kind: "interval", intervalMs: 60_000 } } })], { from: FROM, to: TO, now: NOW });
    expect(occ).toHaveLength(MAX_OCCURRENCES_PER_ROUTINE);
  });
});
