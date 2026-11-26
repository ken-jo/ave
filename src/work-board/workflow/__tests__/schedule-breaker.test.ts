import { expect, it } from "vitest";
import { mayFire, nextScheduleState } from "../schedule-breaker.js";

it("mayFire refuses run-unsettled when the schedule-wide scan reports an unsettled run", () => {
  expect(mayFire({ unsettledRun: true, paused: false })).toEqual({ fire: false, reason: "run-unsettled" });
  expect(mayFire({ unsettledRun: false, paused: true })).toEqual({ fire: false, reason: "paused" });
  expect(mayFire({ unsettledRun: false, paused: false })).toEqual({ fire: true });
});

it("two bad runs pause the schedule and a completed run resets the count", () => {
  const first = nextScheduleState({ consecutiveBad: 0 }, "failed");
  expect(first).toEqual({ consecutiveBad: 1 });
  expect(nextScheduleState(first, "completed")).toEqual({ consecutiveBad: 0 });
  const paused = nextScheduleState(first, "parked-on-denials");
  expect(paused).toEqual({ consecutiveBad: 2, pausedAt: expect.any(String) });
  expect(nextScheduleState(paused, "completed")).toEqual(paused);
});

it("two skipped-unavailable firings in a row pause the schedule, one followed by a completed run does not, and a run-unsettled skip between them changes nothing", () => {
  const first = nextScheduleState({ consecutiveBad: 0 }, "skipped-unavailable");
  expect(nextScheduleState(first, "completed")).toEqual({ consecutiveBad: 0 });
  expect(mayFire({ unsettledRun: true, paused: false })).toEqual({ fire: false, reason: "run-unsettled" });
  expect(nextScheduleState(first, "skipped-unavailable")).toEqual({ consecutiveBad: 2, pausedAt: expect.any(String) });
});
