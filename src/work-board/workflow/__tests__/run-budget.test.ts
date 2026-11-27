import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { unusedNetworkFetch } from "../../../__tests__/support/network-fetch-stubs.js";
import { within } from "../../../__tests__/support/signal-wait.js";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { makeConversationLoopSettings } from "../../../engine/__tests__/conversation-loop-test-helpers.js";
import { makeSubagentLoopDeps, patchLoopProvider } from "../../../engine/__tests__/support/subagent-loop-fixtures.js";
import { exactToolScope, SubAgentRunner, type SubAgentSpawnResult } from "../../../engine/subagent-runner.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { createDynamicTool } from "../../../tools/base.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { checkStageBudget, MAX_LANE_DENIALS_PER_STAGE, type StageUsage } from "../run-budget.js";
import type { StageEnvelope, TemplateStage } from "../../../shared/workflow-template-types.js";
import * as templateGraph from "../../template-graph.js";
import type { StageRunEngineDeps } from "../stage-run-engine.js";
import * as stageMachine from "../stage-machine.js";
import { autoStageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

const LIMITS = { rounds: 2, minutes: 1, costUsd: 1 };
const USAGE: StageUsage = { rounds: 0, startedAt: 0, denials: 0 };

it("each limit fails the stage with its code", async () => {
  expect(checkStageBudget({ ...USAGE, rounds: 3 }, LIMITS, 0)).toEqual({ ok: false, code: "rounds" });
  expect(checkStageBudget(USAGE, LIMITS, 60_000)).toEqual({ ok: false, code: "minutes" });
  expect(checkStageBudget({ ...USAGE, costUsd: 1.01 }, LIMITS, 0)).toEqual({ ok: false, code: "cost" });
  expect(MAX_LANE_DENIALS_PER_STAGE).toBe(3);
  expect(checkStageBudget({ ...USAGE, denials: 3 }, LIMITS, 0)).toEqual({ ok: false, code: "denials" });
  expect(checkStageBudget({ ...USAGE, rounds: 2, costUsd: 1, denials: 2 }, LIMITS, 59_999)).toEqual({ ok: true });
  expect(checkStageBudget(USAGE, { ...LIMITS, costUsd: 0 }, 0)).toEqual({ ok: true });

  const h = await stageRunHarness({
    workspace: {
      prepare: async (run, stage) => {
        vi.setSystemTime(Date.now() + 60_000);
        const root = join(h.dir, "runs", run.runId, stage.id);
        mkdirSync(root, { recursive: true });
        return { ok: true, workspace: { kind: "folder", root } };
      },
    },
    script: () => ({ turnCount: 1 }),
  });
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const started = await startScheduled(h);
      await expect(started.result).resolves.toMatchObject({ status: "awaiting_approval", reasonCode: "stage-failed" });
      expect(h.children).toEqual([]);
      const stage = await h.stageRun(started.itemId, "report");
      expect(stage).toMatchObject({ status: "failed", failure: "budget", usage: { rounds: 0, startedAt: stage.startedAt } });
    } finally {
      vi.useRealTimers();
    }
  });
});

const ENVELOPE: StageEnvelope = {
  tools: [], writePaths: [], readRoots: [], network: [], commands: [], mcpReadOnlyTools: [],
  mcpGenerationTools: [], pluginGenerationTools: [], outputs: [], budget: LIMITS,
};

async function startScheduled(h: Awaited<ReturnType<typeof stageRunHarness>>, stages: TemplateStage[] = [autoStageOf("report", { envelope: ENVELOPE })]) {
  const version = await h.confirm(stages);
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
  const h = await stageRunHarness({ workflow: { lane: observer.lane }, interruptChild: vi.fn() });
  await h.runThenEnd(async () => {
    const started = await startScheduled(h, ["report", "second", "third", "waiting"].map(id => autoStageOf(id, { envelope: ENVELOPE })));
    const children = await h.untilLive(3);
    const child = children.find(candidate => candidate.input.unattendedStage?.stageId === "report");
    if (!child) throw new Error("Expected the report child");
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
    for (const sibling of children.filter(candidate => candidate !== child)) sibling.finish();
    await h.untilStage(started.itemId, "second", "passed");
    try {
      expect((await h.stageRun(started.itemId, "report")).status).toBe("running");
      expect((await h.stageRun(started.itemId, "waiting")).status).toBe("waiting");
      expect(h.children).toHaveLength(3);
    } finally {
      child.finish({ ok: false, stopReason: "interrupted" });
    }
    await expect(started.result).resolves.toMatchObject({ status: "awaiting_approval", reasonCode: "parked-on-denials" });
    const stage = await h.stageRun(started.itemId, "report");
    expect(stage).toMatchObject({ status: "failed", failure: "budget", usage: { denials: 3 } });
    expect(stage.deniedCalls).toEqual(calls);
    expect((await h.stageRun(started.itemId, "waiting")).status).toBe("waiting");
    expect(h.events.findLast(event => event.workflowRun)?.workflowRun?.stages[0].deniedCalls).toEqual(calls);
    expect(observer.listeners.size).toBe(0);
  });
});

it("a grandchild's rounds and denials count against its stage", async () => {
  const observer = observeDenials();
  const registry = new ToolRegistry();
  let runner: SubAgentRunner;
  let nestedId: string;
  let nestedResult: SubAgentSpawnResult | undefined;
  const requests: string[] = [];
  const read = createDynamicTool({
    name: "read_fixture", description: "Read a fixture", source: "builtin", category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: { fixture: { type: "string" } }, required: ["fixture"] },
    execute: async (input, ctx) => {
      if ((input as { fixture: string }).fixture === "child") {
        observer.report(nestedId, "outside-envelope", "nested_read");
      } else {
        nestedResult = await runner.spawn({
          title: "Nested reader", instructions: "Read the nested fixture.",
          originSessionId: ctx.metadata?.sessionId, toolScope: exactToolScope([read.name]),
          maxRounds: LIMITS.rounds,
        }, { onLinked: ({ childSessionId }) => { nestedId = childSessionId; } });
      }
      return { output: "Read finished", isError: false };
    },
  });
  const execute = vi.spyOn(read, "execute");
  registry.register(read);
  const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider({
    vendor: "claude",
    async *streamTurn({ messages }) {
      const nested = messages.some(message => message.role === "user" && message.content === "Read the nested fixture.");
      const continued = messages.some(message => message.role === "tool_result");
      requests.push(`${nested ? "nested" : "stage"}:${continued ? "continued" : "first"}`);
      if (continued) {
        yield { type: "text_delta", text: "Done" };
        yield { type: "message_complete", stopReason: "end_turn" };
      } else {
        yield { type: "tool_call", id: nested ? "nested-read" : "stage-read", name: read.name, input: { fixture: nested ? "child" : "parent" } };
        yield { type: "message_complete", stopReason: "tool_use" };
      }
    },
  });
  // Permit this opt-in in the fixture while the production attachment limit remains in place.
  const qualification = vi.spyOn(templateGraph, "isAllReadOnlyVersion").mockReturnValue(true);
  try {
    const h = await stageRunHarness({
      workflow: { lane: observer.lane, unattendedAllowed: () => ({ ok: true }) },
      runner: dir => {
        runner = new SubAgentRunner({
          parentDeps: makeSubagentLoopDeps(registry, {
            networkFetch: unusedNetworkFetch, settingsService: makeConversationLoopSettings(false),
            auditLogger: new AuditLogger(), permissionManager: new PermissionManager(join(dir, "permissions.json")),
          }),
          toolRegistry: registry,
          subAgentMemoryManager: new MemoryManager({ aveDir: join(dir, "children") }),
        });
        return runner;
      },
    });
    await h.runThenEnd(async () => {
      const started = await startScheduled(h, [autoStageOf("report", { envelope: ENVELOPE, allowSubAgents: true })]);
      const result = await started.result;
      expect(requests).toEqual(["stage:first", "nested:first"]);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(nestedResult?.stopReason).toBe("round-cap");
      expect(result).toMatchObject({ status: "awaiting_approval", reasonCode: "stage-failed" });
      const stage = await h.stageRun(started.itemId, "report");
      expect(stage).toMatchObject({ status: "failed", failure: "budget", usage: { rounds: 2, denials: 1 } });
      expect(stage.deniedCalls).toEqual([{ toolName: "nested_read", code: "outside-envelope" }]);
    });
  } finally {
    qualification.mockRestore();
    hasProviderSpy.mockRestore();
    refreshProviderSpy.mockRestore();
  }
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

it("ends the stage at its deadline while preparation is still pending", async () => {
  const preparing = deferred<void>();
  const release = deferred<void>();
  const h = await stageRunHarness({
    observeRunWork: true,
    workspace: {
      prepare: async () => {
        preparing.resolve();
        await release.promise;
        throw new Error("Preparation failed after the deadline");
      },
    },
  });
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = await startScheduled(h);
      await preparing.promise;
      const running = await h.stageRun(started.itemId, "report");
      expect(running.status).toBe("running");
      await vi.advanceTimersByTimeAsync(59_999);
      expect((await h.stageRun(started.itemId, "report")).status).toBe("running");
      await vi.advanceTimersByTimeAsync(1);
      await expect(within(started.result, "the budget failure before preparation returns", expire => {
        const timer = setTimeout(expire, 2_000);
        return () => clearTimeout(timer);
      })).resolves.toMatchObject({ status: "awaiting_approval", reasonCode: "stage-failed" });
      const failed = await h.stageRun(started.itemId, "report");
      expect(failed).toMatchObject({ status: "failed", failure: "budget", usage: { rounds: 0, startedAt: running.startedAt } });
      release.resolve();
      await h.drainRunWork();
      expect(await h.stageRun(started.itemId, "report")).toEqual(failed);
      expect(h.children).toEqual([]);
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });
});

it("interrupts a live child at the deadline after refusing a round and keeps the round failure", async () => {
  const reduce = vi.spyOn(stageMachine, "reduceRun");
  const h = await stageRunHarness();
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const envelope = { ...ENVELOPE, budget: { ...LIMITS, rounds: 1 } };
      const started = await startScheduled(h, [autoStageOf("report", { envelope })]);
      const [child] = await h.untilLive(1);
      expect(child.input.claimRound?.()).toBe(true);
      expect(child.input.claimRound?.()).toBe(false);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(h.interrupts).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.interrupts).toEqual([child.sessionId]);
      await started.result;
      expect(await h.stageRun(started.itemId, "report")).toMatchObject({ status: "failed", failure: "budget", usage: { rounds: 1 } });
      expect(reduce.mock.calls.map(([, event]) => event)).toContainEqual(expect.objectContaining({
        type: "stage_ended", stageId: "report", failure: "budget", reason: "rounds",
      }));
    } finally {
      reduce.mockRestore();
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
