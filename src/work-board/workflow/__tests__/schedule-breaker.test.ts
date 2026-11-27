import { expect, it, vi } from "vitest";
import { parkedStageOutcome } from "../run-state.js";
import { mayFire, nextScheduleState } from "../schedule-breaker.js";
import { stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it("mayFire refuses run-unsettled when the schedule-wide scan reports an unsettled run", () => {
  expect(mayFire({ unsettledRun: true, paused: false })).toEqual({ fire: false, reason: "run-unsettled" });
  expect(mayFire({ unsettledRun: false, paused: true })).toEqual({ fire: false, reason: "paused" });
  expect(mayFire({ unsettledRun: false, paused: false })).toEqual({ fire: true });
});

it("two bad runs pause the schedule and a completed run resets the count", () => {
  const first = nextScheduleState({ consecutiveBad: 0 }, "failed");
  expect(first).toEqual({ consecutiveBad: 1 });
  expect(nextScheduleState(first, "completed")).toEqual({ consecutiveBad: 0 });
  const threshold = nextScheduleState(first, "parked-on-denials");
  expect(threshold).toEqual({ consecutiveBad: 2 });
  const paused = { ...threshold, pausedAt: new Date(0).toISOString() };
  expect(nextScheduleState(paused, "completed")).toEqual(paused);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(1);
    const transition = nextScheduleState(first, "failed");
    vi.setSystemTime(2);
    expect(nextScheduleState(first, "failed")).toEqual(transition);
  } finally {
    vi.useRealTimers();
  }
});

it("a run waiting at a gate does not count as bad", async () => {
  const h = await stageRunHarness();
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("report")]);
    const { source } = await h.attach(version);
    if (source.kind !== "schedule-attachment") throw new Error("Expected a schedule source");
    const started = await h.engine.startScheduledTemplate(source, "Report");
    if (!started.ok) throw new Error(started.code);
    (await h.untilLive(1))[0].finish();
    await expect(started.result).resolves.toEqual({ status: "awaiting_approval" });
    const run = await h.item(started.itemId);
    expect(run.stageRuns).toMatchObject([{ status: "awaiting_gate" }]);
    expect(parkedStageOutcome(run)).toBeUndefined();
    expect(mayFire({ unsettledRun: run.record?.settled === undefined, paused: false })).toEqual({ fire: false, reason: "run-unsettled" });
  });
});

it("two skipped-unavailable firings in a row pause the schedule, one followed by a completed run does not, and a run-unsettled skip between them changes nothing", () => {
  const first = nextScheduleState({ consecutiveBad: 0 }, "skipped-unavailable");
  expect(nextScheduleState(first, "completed")).toEqual({ consecutiveBad: 0 });
  expect(mayFire({ unsettledRun: true, paused: false })).toEqual({ fire: false, reason: "run-unsettled" });
  expect(nextScheduleState(first, "skipped-unavailable")).toEqual({ consecutiveBad: 2 });
});
