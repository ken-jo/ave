import { describe, expect, it } from "vitest";
import { boardScheduleCards, weekStart } from "../board-schedule.js";
import type { RoutineRecord } from "../../../../../shared/routines-types.js";
import { localIso } from "./schedule-test-helpers.js";

const NOW = new Date("2026-11-05T10:00:00");

function routine(id: string, extra: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id,
    trigger: "schedule",
    execution: "llm-session",
    prePrompt: "p",
    title: id,
    createdAt: "2026-11-01T00:00:00.000Z",
    schedule: { at: "2026-11-01T00:00:00.000Z", repeat: { kind: "daily" } },
    ...extra,
  };
}

const iso = localIso;

describe("weekStart", () => {
  it("is Monday 00:00 local, also on a Sunday", () => {
    expect(weekStart(NOW).getTime()).toBe(new Date("2026-11-02T00:00:00").getTime());
    expect(weekStart(new Date("2026-11-08T23:00:00")).getTime()).toBe(new Date("2026-11-02T00:00:00").getTime());
  });
});

describe("boardScheduleCards", () => {
  it("plans each active item once at its next scheduled time, soonest first, skipping paused and running items", () => {
    const cards = boardScheduleCards({
      records: [routine("later"), routine("soon"), routine("paused", { pausedAt: "2026-11-04T00:00:00.000Z", pausedBy: "user" }), routine("busy")],
      occurrences: [
        { routineId: "later", at: iso("2026-11-06T09:00:00"), status: "scheduled" },
        { routineId: "later", at: iso("2026-11-07T09:00:00"), status: "scheduled" },
        { routineId: "soon", at: iso("2026-11-05T13:00:00"), status: "scheduled" },
        { routineId: "paused", at: iso("2026-11-05T11:00:00"), status: "paused" },
        { routineId: "busy", at: iso("2026-11-06T08:30:00"), status: "scheduled" },
      ],
      runs: [],
      running: new Map([["busy", iso("2026-11-05T09:56:00")]]),
      now: NOW,
    });
    expect(cards.planned.map((c) => [c.routine.id, c.nextAt])).toEqual([
      ["soon", iso("2026-11-05T13:00:00")],
      ["later", iso("2026-11-06T09:00:00")],
    ]);
    expect(cards.running.map((c) => [c.routine.id, c.firedAt])).toEqual([["busy", iso("2026-11-05T09:56:00")]]);
  });

  it("links a running card to its chat once the run has one", () => {
    const firedAt = iso("2026-11-05T09:56:00");
    const cards = boardScheduleCards({
      records: [routine("busy")],
      occurrences: [],
      runs: [{ routineId: "busy", firedAt, status: "done", sessionId: "s-1" }],
      running: new Map([["busy", firedAt]]),
      now: NOW,
    });
    expect(cards.running[0]?.sessionId).toBe("s-1");
    // The run in progress is not counted as finished.
    expect(cards.week.total).toBe(0);
  });

  it("bundles this week's finished runs per item, counting failures, and leaves last week's out", () => {
    const cards = boardScheduleCards({
      records: [routine("brief"), routine("deps")],
      occurrences: [],
      runs: [
        { routineId: "brief", firedAt: iso("2026-11-03T08:30:00"), status: "done" },
        { routineId: "brief", firedAt: iso("2026-11-04T08:30:00"), status: "done" },
        { routineId: "deps", firedAt: iso("2026-11-02T13:00:00"), status: "failed" },
        { routineId: "brief", firedAt: iso("2026-11-01T08:30:00"), status: "done" },
        { routineId: "gone", firedAt: iso("2026-11-03T08:30:00"), status: "done" },
      ],
      running: new Map(),
      now: NOW,
    });
    expect(cards.week.total).toBe(3);
    expect(cards.week.rows.map((r) => [r.routine.id, r.count, r.failed])).toEqual([
      ["brief", 2, 0],
      ["deps", 1, 1],
    ]);
  });

  it("lists the items whose last occurrence was skipped for missing extensions", () => {
    const cards = boardScheduleCards({
      records: [routine("ok"), routine("gh", { lastSkippedReason: "plugins-missing", needsAttention: { missingPluginIds: ["github"] } })],
      occurrences: [], runs: [], running: new Map(), now: NOW,
    });
    expect(cards.week.skipped.map((r) => r.id)).toEqual(["gh"]);
  });
});
