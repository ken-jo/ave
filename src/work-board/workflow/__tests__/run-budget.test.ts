import { expect, it, vi } from "vitest";
import { checkStageBudget, MAX_LANE_DENIALS_PER_STAGE, type StageUsage } from "../run-budget.js";
import type { StageEnvelope } from "../../../shared/workflow-template-types.js";
import type { StageRunEngineDeps } from "../stage-run-engine.js";
import { autoStageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

const LIMITS = { rounds: 2, minutes: 1, costUsd: 1 };
const USAGE: StageUsage = { rounds: 0, startedAt: 0, denials: 0 };

it("each limit fails the stage with its code", () => {
  expect(checkStageBudget({ ...USAGE, rounds: 3 }, LIMITS, 0)).toEqual({ ok: false, code: "rounds" });
  expect(checkStageBudget(USAGE, LIMITS, 60_000)).toEqual({ ok: false, code: "minutes" });
  expect(checkStageBudget({ ...USAGE, costUsd: 1.01 }, LIMITS, 0)).toEqual({ ok: false, code: "cost" });
  expect(MAX_LANE_DENIALS_PER_STAGE).toBe(3);
  expect(checkStageBudget({ ...USAGE, denials: 3 }, LIMITS, 0)).toEqual({ ok: false, code: "denials" });
  expect(checkStageBudget({ ...USAGE, rounds: 2, costUsd: 1, denials: 2 }, LIMITS, 59_999)).toEqual({ ok: true });
  expect(checkStageBudget(USAGE, { ...LIMITS, costUsd: 0 }, 0)).toEqual({ ok: true });
});

const ENVELOPE: StageEnvelope = {
  tools: [], writePaths: [], readRoots: [], network: [], commands: [], mcpReadOnlyTools: [],
  mcpGenerationTools: [], pluginGenerationTools: [], outputs: [], budget: LIMITS,
};

async function startScheduled(h: Awaited<ReturnType<typeof stageRunHarness>>) {
  const version = await h.confirm([autoStageOf("report", { envelope: ENVELOPE })]);
  const { source } = await h.attach(version);
  if (source.kind !== "schedule-attachment") throw new Error("Expected a schedule source");
  const started = await h.engine.startScheduledTemplate(source, "Report");
  if (!started.ok) throw new Error(started.code);
  return started;
}

function observeDenials() {
  type Listener = Parameters<NonNullable<StageRunEngineDeps["lane"]>["onDenied"]>[0];
  const listeners = new Set<Listener>();
  const lane: NonNullable<StageRunEngineDeps["lane"]> = {
    admit: async () => ({ ok: true }),
    sessionLinked: () => undefined,
    sessionEnded: () => undefined,
    onDenied: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    lane, listeners,
    report: (sessionId: string, code: string, toolName: string) => {
      const call = { toolName, input: "omitted from the stage record" };
      for (const listener of listeners) listener({ sessionId, code, call });
    },
  };
}

it("the third lane denial ends the stage and lists the calls", async () => {
  const observer = observeDenials();
  const h = await stageRunHarness({ workflow: { lane: observer.lane } });
  await h.runThenEnd(async () => {
    const started = await startScheduled(h);
    const [child] = await h.untilLive(1);
    observer.report("another-session", "outside-envelope", "unrelated");
    observer.report(child.sessionId, "policy-denied", "ignored");
    observer.report(child.sessionId, "outside-envelope", "tool_one");
    observer.report(child.sessionId, "no-approver", "tool_two");
    expect(h.interrupts).toEqual([]);
    observer.report(child.sessionId, "outside-envelope", "tool_three");
    const calls = [
      { toolName: "tool_one", code: "outside-envelope" },
      { toolName: "tool_two", code: "no-approver" },
      { toolName: "tool_three", code: "outside-envelope" },
    ];
    expect(h.interrupts).toEqual([child.sessionId]);
    await expect(started.result).resolves.toMatchObject({ status: "awaiting_approval", reasonCode: "parked-on-denials" });
    const stage = await h.stageRun(started.itemId, "report");
    expect(stage).toMatchObject({ status: "failed", failure: "budget", usage: { denials: 3 } });
    expect(stage.deniedCalls).toEqual(calls);
    expect(h.events.findLast(event => event.workflowRun)?.workflowRun?.stages[0].deniedCalls).toEqual(calls);
    expect(observer.listeners.size).toBe(0);
  });
});

it("a grandchild's rounds and denials count against its stage", async () => {
  const observer = observeDenials();
  const h = await stageRunHarness({
    workflow: { lane: observer.lane },
    descendants: (origin) => origin === "child-1" ? [{ childSessionId: "grandchild", turnCount: 2 }] : [],
  });
  await h.runThenEnd(async () => {
    const started = await startScheduled(h);
    const [child] = await h.untilLive(1);
    observer.report("grandchild", "outside-envelope", "nested_read");
    child.finish({ turnCount: 1 });
    await expect(started.result).resolves.toMatchObject({ status: "awaiting_approval", reasonCode: "stage-failed" });
    const stage = await h.stageRun(started.itemId, "report");
    expect(stage).toMatchObject({ status: "failed", failure: "budget", usage: { rounds: 3, denials: 1 } });
    expect(stage.deniedCalls).toEqual([{ toolName: "nested_read", code: "outside-envelope" }]);
  });
});

it("interrupts the child when its unattended deadline expires", async () => {
  const h = await stageRunHarness();
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = await startScheduled(h);
      const [child] = await h.untilLive(1);
      expect(child.input.maxRounds).toBe(LIMITS.rounds);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(h.interrupts).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.interrupts).toEqual([child.sessionId]);
      await started.result;
      expect(await h.stageRun(started.itemId, "report")).toMatchObject({ status: "failed", failure: "budget" });
    } finally {
      vi.useRealTimers();
    }
  });
});

it("fails on an unattended round-cap but keeps the attended round budget", async () => {
  const h = await stageRunHarness();
  await h.runThenEnd(async () => {
    const scheduled = await startScheduled(h);
    const [child] = await h.untilLive(1);
    child.finish({ turnCount: LIMITS.rounds, stopReason: "round-cap" });
    await scheduled.result;
    expect(await h.stageRun(scheduled.itemId, "report")).toMatchObject({ status: "failed", failure: "budget", usage: { rounds: LIMITS.rounds } });

    const version = await h.confirm([autoStageOf("attended", { envelope: ENVELOPE })]);
    const itemId = await h.addItem(version);
    const run = h.start(itemId, h.local(version));
    const [attended] = await h.untilLive(1, itemId);
    expect(attended.input.maxRounds).toBe(20);
    attended.finish({ turnCount: LIMITS.rounds + 1 });
    await expect(run).resolves.toMatchObject({ status: "completed" });
    expect((await h.stageRun(itemId, "attended")).usage).toBeUndefined();
  });
});
