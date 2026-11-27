import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { expect, it, vi } from "vitest";
import { afterQueuedCallbacks, deferred } from "../../../__tests__/support/deferred.js";
import { unusedNetworkFetch } from "../../../__tests__/support/network-fetch-stubs.js";
import { within } from "../../../__tests__/support/signal-wait.js";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { makeConversationLoopSettings } from "../../../engine/__tests__/conversation-loop-test-helpers.js";
import { makeSubagentLoopDeps, patchLoopProvider } from "../../../engine/__tests__/support/subagent-loop-fixtures.js";
import { exactToolScope, SubAgentRunner, type SubAgentSpawnResult } from "../../../engine/subagent-runner.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { registerUnattendedStage, unattendedLaneHooks } from "../../../permissions/unattended-lane-registry.js";
import { createDynamicTool } from "../../../tools/base.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { checkStageBudget, MAX_LANE_DENIALS_PER_STAGE, type StageUsage } from "../run-budget.js";
import type { StageEnvelope, TemplateScope, TemplateStage } from "../../../shared/workflow-template-types.js";
import { boardParentToolRegistry } from "../../__tests__/board-test-fixtures.js";
import * as templateGraph from "../../template-graph.js";
import type { StageRunEngineDeps } from "../stage-run-engine.js";
import * as stageMachine from "../stage-machine.js";
import { authoriseRunSource } from "../run-authority.js";
import { boardRunState } from "../run-state.js";
import { createHostGit } from "../host-git.js";
import { createPassConditionRegistry } from "../stage-gates.js";
import { createStageWorkspaceProvider } from "../stage-workspaces.js";
import { RUN_FILE, stageDirName } from "../workspace-layout.js";
import * as workspaceSeed from "../workspace-seed.js";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
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

async function startScheduled(h: Awaited<ReturnType<typeof stageRunHarness>>, stages: TemplateStage[] = [autoStageOf("report", { envelope: ENVELOPE })], scope: TemplateScope = { kind: "all" }) {
  const version = await h.confirm(stages, { scope });
  const { source } = await h.attach(version, scope);
  if (source.kind !== "schedule-attachment") throw new Error("Expected a schedule source");
  const started = await h.engine.startScheduledTemplate(source, "Report");
  if (!started.ok) throw new Error(started.code);
  return started;
}

const beforeUnblock = (expire: () => void) => {
  const timer = setTimeout(expire, 2_000);
  return () => clearTimeout(timer);
};

it.each(["seals before expiry", "seals after expiry", "also expires"])("expires parallel preparation on the real workspace queue when a sibling %s", async sibling => {
  const siblingSeals = sibling !== "also expires";
  const checking = deferred<void>();
  const release = deferred<void>();
  const queued = deferred<void>();
  const sealing = deferred<void>();
  const preparations: Promise<unknown>[] = [];
  const seals: Promise<unknown>[] = [];
  const git = createHostGit();
  const ignoreChecks: string[] = [];
  const workspace = createStageWorkspaceProvider({
    plainCeiling: tmpdir(),
    git: {
      ...git,
      run: async (cwd, args, call) => {
        if (args.includes("check-ignore")) {
          ignoreChecks.push(cwd);
          checking.resolve();
          await release.promise;
        }
        return git.run(cwd, args, call);
      },
    },
  });
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: () => ({ workspace: {
      ...workspace,
      prepare: (...args) => {
        const pending = workspace.prepare(...args);
        preparations.push(pending);
        if (args[1].id === "second") queued.resolve();
        return pending;
      },
      seal: (...args) => {
        const pending = workspace.seal(...args);
        seals.push(pending);
        sealing.resolve();
        return pending;
      },
    } }),
  });
  await h.runThenEnd(async () => {
    const projectRoot = join(realpathSync(h.dir), "project");
    const home = join(h.dir, "home");
    mkdirSync(home);
    mkdirSync(projectRoot);
    writeFileSync(join(projectRoot, "input.txt"), "project input");
    writeFileSync(join(projectRoot, ".gitignore"), "ignored.txt\n");
    vi.stubEnv("AVE_HOME", home);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const seeded = autoStageOf("second", { envelope: ENVELOPE, inputFiles: [{ from: "project", paths: ["input.txt"] }] });
    const long = { ...ENVELOPE, budget: { ...LIMITS, minutes: 2 } };
    const first = siblingSeals ? autoStageOf("first", { envelope: sibling === "seals after expiry" ? long : ENVELOPE }) : { ...seeded, id: "first" };
    try {
      const started = await startScheduled(h, [first, seeded], { kind: "project", projectRoot });
      await within(Promise.all([checking.promise, queued.promise]), "both preparations to reach the workspace queue", beforeUnblock);
      if (sibling === "seals before expiry") {
        const [child] = await h.untilLive(1);
        child.finish();
        await within(sealing.promise, "the first stage to queue its seal", beforeUnblock);
      }
      const running = await h.item(started.itemId);
      const root = running.record?.runWorkspace?.runRoot;
      if (!root) throw new Error("Expected a run workspace");
      expect(running.stageRuns.map(stage => stage.status)).toEqual([sibling === "seals before expiry" ? "passed" : "running", "running"]);
      expect(ignoreChecks).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      if (sibling === "seals after expiry") {
        await h.untilStage(started.itemId, "second", "failed");
        const [child] = await h.untilLive(1);
        child.finish();
        await within(sealing.promise, "the surviving sibling to queue its seal", beforeUnblock);
      }
      await expect(within(started.result, "the budget failure while the workspace queue is still held", beforeUnblock))
        .resolves.toMatchObject({ status: "awaiting_approval", reasonCode: "stage-failed" });
      const failed = await h.item(started.itemId);
      expect(failed.stageRuns[1]).toMatchObject({ status: "failed", failure: "budget" });
      expect(failed.stageRuns[1].workspace).toBeUndefined();
      if (!siblingSeals) expect(failed.stageRuns[0]).toMatchObject({ status: "failed", failure: "budget" });
      expect(h.children).toHaveLength(siblingSeals ? 1 : 0);
      release.resolve();
      await Promise.all([...preparations, ...seals]);
      await h.drainRunWork();
      expect(ignoreChecks).toHaveLength(1);
      expect(existsSync(join(root, stageDirName("second")))).toBe(false);
      expect(existsSync(join(root, stageDirName("first")))).toBe(siblingSeals);
      expect((await h.item(started.itemId)).stageRuns).toEqual(failed.stageRuns);
    } finally {
      release.resolve();
      await Promise.allSettled([...preparations, ...seals]);
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
});

it("interrupts and records the deadline while a sibling holds the real workspace queue sealing", async () => {
  const sealing = deferred<void>();
  const release = deferred<void>();
  const listSeedFiles = workspaceSeed.listSeedFiles;
  const list = vi.spyOn(workspaceSeed, "listSeedFiles").mockImplementation(async (root, globs, rules) => {
    if (basename(root) === stageDirName("first")) {
      sealing.resolve();
      await release.promise;
    }
    return listSeedFiles(root, globs, rules);
  });
  const workspace = createStageWorkspaceProvider();
  const h = await stageRunHarness({ observeRunWork: true, interruptChild: vi.fn(), wiring: () => ({ workspace }) });
  await h.runThenEnd(async () => {
    const home = join(h.dir, "home");
    mkdirSync(home);
    vi.stubEnv("AVE_HOME", home);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = await startScheduled(h, ["first", "second"].map(id => autoStageOf(id, { envelope: ENVELOPE })));
      const children = await h.untilLive(2);
      const first = children.find(child => child.input.unattendedStage?.stageId === "first");
      const second = children.find(child => child.input.unattendedStage?.stageId === "second");
      if (!first || !second) throw new Error("Expected both children");
      first.finish();
      await within(sealing.promise, "the first stage to hold the workspace queue while sealing", beforeUnblock);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.interrupts).toEqual([second.sessionId]);
      await h.untilStage(started.itemId, "second", "failed");
      expect(await h.stageRun(started.itemId, "second")).toMatchObject({ failure: "budget", childSessionId: second.sessionId });
      const fire = vi.fn();
      void started.result.then(fire);
      await afterQueuedCallbacks();
      expect(fire).not.toHaveBeenCalled();
      second.finish({ ok: false, stopReason: "interrupted" });
      await expect(within(started.result, "the exited sibling's budget result while sealing", beforeUnblock))
        .resolves.toMatchObject({ status: "awaiting_approval", reasonCode: "stage-failed" });
    } finally {
      release.resolve();
      try {
        await within(h.drainRunWork({ includeLaunches: false }), "the seal to finish", beforeUnblock);
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        list.mockRestore();
      }
    }
  });
});

it("arms the deadline when a sibling passes and frees a slot before its seal returns", async () => {
  const sealing = deferred<void>();
  const release = deferred<void>();
  const h = await stageRunHarness({ observeRunWork: true, workspace: { seal: async () => {
    sealing.resolve();
    await release.promise;
    return { ok: true };
  } } });
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const short = { ...ENVELOPE, budget: { ...LIMITS, minutes: 0.5 } };
      const started = await startScheduled(h, ["first", "second", "third", "waiting"].map(id => autoStageOf(id, { envelope: id === "waiting" ? short : ENVELOPE })));
      const children = await h.untilLive(3);
      expect(await h.stageRun(started.itemId, "waiting")).toMatchObject({ status: "waiting" });
      children.find(child => child.input.unattendedStage?.stageId === "first")?.finish();
      await within(sealing.promise, "the first stage to start sealing", beforeUnblock);
      expect(await h.stageRun(started.itemId, "waiting")).toMatchObject({ status: "running" });
      await vi.advanceTimersByTimeAsync(30_000);
      await within(h.untilStage(started.itemId, "waiting", "failed"), "the fourth stage to fail while the seal is held", beforeUnblock);
      expect(await h.stageRun(started.itemId, "waiting")).toMatchObject({ failure: "budget" });
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });
});

it("persists a linked child's deadline before interruption finishes and keeps retry fenced", async () => {
  const h = await stageRunHarness({ observeRunWork: true, interruptChild: vi.fn() });
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = await startScheduled(h);
      const [child] = await h.untilLive(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.interrupts).toEqual([child.sessionId]);
      await within(h.untilStage(started.itemId, "report", "failed"), "the budget failure before the child's interruption finishes", beforeUnblock);
      const current = await h.item(started.itemId);
      const runId = current.runId;
      if (!runId) throw new Error("Expected a run id");
      expect(current.stageRuns[0]).toMatchObject({ status: "failed", failure: "budget", childSessionId: child.sessionId });
      await expect(h.engine.retryStage(started.itemId, { runId, stageId: "report", attempt: 1 })).resolves.toEqual({ ok: false, reason: "not_pending" });
      expect(h.engine.cancelRun(started.itemId)).toEqual({ ok: true });
      await h.drainRunWork({ includeLaunches: false });
      expect((await h.item(started.itemId)).record?.settled).toBeUndefined();
      child.finish({ ok: false, stopReason: "interrupted" });
      await h.drainRunWork();
      expect((await h.item(started.itemId)).record?.settled?.status).toBe("cancelled");
      expect(h.interrupts).toEqual([child.sessionId]);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("keeps a timed-out child in its parallel slot until it exits", async () => {
  const reduce = vi.spyOn(stageMachine, "reduceRun");
  const h = await stageRunHarness({ observeRunWork: true, interruptChild: vi.fn() });
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const short = { ...ENVELOPE, budget: { ...LIMITS, minutes: 0.5 } };
      const started = await startScheduled(h, ["first", "second", "third", "waiting"].map(id => autoStageOf(id, { envelope: id === "first" ? short : ENVELOPE })));
      const fire = vi.fn();
      void started.result.then(fire);
      const children = await h.untilLive(3);
      const child = children.find(candidate => candidate.input.unattendedStage?.stageId === "first");
      if (!child) throw new Error("Expected the first stage's child");
      expect(await h.stageRun(started.itemId, "waiting")).toMatchObject({ status: "waiting" });
      await vi.advanceTimersByTimeAsync(30_000);
      await within(h.untilStage(started.itemId, "first", "failed"), "the first stage's budget failure", beforeUnblock);
      expect(h.interrupts).toEqual([child.sessionId]);
      expect(await h.stageRun(started.itemId, "waiting")).toMatchObject({ status: "waiting" });
      expect(fire).not.toHaveBeenCalled();
      child.finish({ ok: false, stopReason: "interrupted" });
      await within(h.untilStage(started.itemId, "waiting", "running"), "the fourth stage to claim the released slot", beforeUnblock);
      expect((await h.untilLive(3)).map(candidate => candidate.input.unattendedStage?.stageId)).toContain("waiting");
      await h.drainRunWork();
      expect(reduce.mock.calls.filter(([, event]) => event.type === "slot_released")).toHaveLength(1);
    } finally {
      reduce.mockRestore();
      vi.useRealTimers();
    }
  });
});

it("persists the deadline while the launch is re-reading its pinned version", async () => {
  const resolving = deferred<void>();
  const release = deferred<void>();
  const h = await stageRunHarness({ observeRunWork: true });
  const resolveVersion = h.templates.resolveVersion.bind(h.templates);
  const lookup = vi.spyOn(h.templates, "resolveVersion").mockImplementation(async pin => {
    const version = await resolveVersion(pin);
    if (h.events.some(event => event.workflowRun?.stages.some(stage => stage.status === "running"))) {
      resolving.resolve();
      await release.promise;
    }
    return version;
  });
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = await startScheduled(h);
      await within(resolving.promise, "the launch to reach the pin lookup", beforeUnblock);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(within(started.result, "the budget failure while the pin lookup is held", beforeUnblock))
        .resolves.toMatchObject({ status: "awaiting_approval", reasonCode: "stage-failed" });
      expect(await h.stageRun(started.itemId, "report")).toMatchObject({ status: "failed", failure: "budget" });
      expect(h.children).toEqual([]);
    } finally {
      release.resolve();
      lookup.mockRestore();
      vi.useRealTimers();
    }
  });
});

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

it("accounts for denials emitted by the unattended permission pipeline", async () => {
  const h = await stageRunHarness({ workflow: { lane: { ...unattendedLaneHooks, admit: async () => ({ ok: true }) } } });
  await h.runThenEnd(async () => {
    const manager = new PermissionManager(join(h.dir, "permissions.json"));
    manager.setUnattendedToolEffectResolver({ effectOf: () => "safe" });
    const started = await startScheduled(h);
    const [child] = await h.untilLive(1);
    const { unattendedStage, projectRoot } = child.input;
    if (!unattendedStage || !projectRoot) throw new Error("Expected an unattended stage workspace");
    registerUnattendedStage(child.sessionId, {
      ...unattendedStage, envelope: ENVELOPE, workspaceRoot: projectRoot, isolation: { proven: true },
    });
    for (const toolName of ["read_file", "grep_files", "list_files"]) {
      expect(manager.checkDetailed(toolName, "builtin", "read", undefined, {
        sessionId: child.sessionId, unattendedCallInput: { text: "not stored" },
      })).toMatchObject({ decision: "deny", reasonCode: "outside-envelope" });
    }
    await expect(started.result).resolves.toMatchObject({ reasonCode: "parked-on-denials" });
    expect((await h.stageRun(started.itemId, "report")).deniedCalls).toEqual(
      ["read_file", "grep_files", "list_files"].map(toolName => ({ toolName, code: "outside-envelope" })),
    );
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

function controlledDeadlineTest(body: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return body().finally(() => vi.useRealTimers());
}

function budgetStages(ids: string[], short: string): TemplateStage[] {
  return ids.map(id => autoStageOf(id, {
    envelope: id === short ? { ...ENVELOPE, budget: { ...LIMITS, minutes: 0.5 } } : ENVELOPE,
  }));
}

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;

function childOf(h: Harness, id: string) {
  const child = h.children.find(entry => entry.input.unattendedStage?.stageId === id);
  if (!child) throw new Error(`Expected a child for ${id}`);
  return child;
}

it.each(["stage failure", "write fault"])("reports a pre-link lane refusal as %s while a sibling seal is blocked", async expected => {
  const admitting = deferred<void>();
  const refuse = deferred<void>();
  const sealing = deferred<void>();
  const release = deferred<void>();
  let failWrite = false;
  const h = await stageRunHarness({
    observeRunWork: true,
    workspace: {
      seal: async () => { sealing.resolve(); await release.promise; return { ok: true }; },
      release: async () => { await release.promise; },
    },
    wiring: store => {
      const runs = boardRunState(store);
      return { runs: { ...runs, update: (...args) => {
        if (!failWrite) return runs.update(...args);
        failWrite = false;
        return Promise.resolve({ ok: false, reason: "unavailable" });
      } } };
    },
    workflow: { lane: {
      admit: async ({ stageId }) => {
        if (stageId === "first") return { ok: true };
        admitting.resolve();
        await refuse.promise;
        return { ok: false, code: "isolation-unproven" };
      },
      onDenied: () => () => undefined, sessionLinked: () => undefined, sessionEnded: () => undefined,
    } },
  });
  await h.runThenEnd(() => controlledDeadlineTest(async () => {
    try {
      const started = await startScheduled(h, budgetStages(["first", "refused"], "refused"));
      await within(admitting.promise, "lane admission to wait", beforeUnblock);
      await h.untilLive(1);
      childOf(h, "first").finish();
      await within(sealing.promise, "the seal to hold the event chain", beforeUnblock);
      failWrite = expected === "write fault";
      refuse.resolve();
      if (expected === "write fault") {
        await h.untilRunFile(async () => {
          expect((await h.item(started.itemId)).record?.settled?.status).toBe("error");
        });
        await expect(within(started.result, "the durable fault while cleanup is blocked", beforeUnblock))
          .resolves.toMatchObject({ status: "error", reasonCode: "run-state-unavailable" });
        expect(await started.breakerOutcome).toBe("failed");
        return;
      }
      // Wait for the refusal to reach the store before advancing the clock.
      await h.untilRunFile(async () => {
        expect((await h.stageRun(started.itemId, "refused")).blocked?.code).toBe("isolation-unproven");
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(within(started.result, "the durable refusal while the seal is blocked", beforeUnblock))
        .resolves.toMatchObject({ status: "awaiting_approval", reasonCode: "stage-failed" });
      const stage = await h.stageRun(started.itemId, "refused");
      expect(stage).toMatchObject({ status: "failed", failure: "error", blocked: { code: "isolation-unproven" } });
      release.resolve();
      await h.drainRunWork();
      expect(await h.stageRun(started.itemId, "refused")).toEqual(stage);
    } finally {
      refuse.resolve();
      release.resolve();
    }
  }));
});

it.each(["after expiry", "before expiry", "with a newer attempt"])("revalidates a held slot release when the board is lost %s", async order => {
  const h = await stageRunHarness({ observeRunWork: true, interruptChild: vi.fn() });
  await h.runThenEnd(() => controlledDeadlineTest(async () => {
    const sameAttempt = order !== "with a newer attempt";
    const started = await startScheduled(h, budgetStages(["short", "second", "third", "waiting"], "short"));
    await h.untilLive(3);
    await h.drainRunWork({ includeLaunches: false });
    const initial = await h.item(started.itemId);
    if (!initial.runId) throw new Error("Expected a run id");
    const ref = { itemId: started.itemId, runId: initial.runId };
    const board = readFileSync(h.boardPath);
    const fire = vi.fn();
    void started.result.then(fire);
    try {
      if (order === "before expiry") writeFileSync(h.boardPath, "{");
      await vi.advanceTimersByTimeAsync(30_000);
      await h.drainRunWork({ includeLaunches: false });
      if (order !== "before expiry") {
        expect(await h.stageRun(ref.itemId, "short")).toMatchObject({ status: "failed", failure: "budget" });
        writeFileSync(h.boardPath, "{");
      }
      expect((await h.runOf(ref.runId))?.stageRuns.find(stage => stage.stageId === "waiting")?.status).toBe("waiting");
      expect(fire).not.toHaveBeenCalled();
      childOf(h, "short").finish({ ok: false, stopReason: "interrupted" });
      await h.drainRunWork();
      const markers = await h.board.runs.heldEvents(ref);
      expect(markers.filter(entry => entry.kind === "slot_released")).toEqual([{ ...ref, stage: "short", attempt: 1, kind: "slot_released" }]);
      writeFileSync(h.boardPath, board);
      if (!sameAttempt) {
        const advanced = await h.board.updateRun(ref.itemId, ref.runId, record => ({
          ...record, stageRuns: record.stageRuns.map(stage => stage.stageId === "short" ? { ...stage, attempt: 2 } : stage),
        }));
        expect(advanced.status).toBe("stored");
      }
      await h.engine.adoptParkedTemplateRuns();
      await h.drainRunWork();
      expect(await h.board.runs.heldEvents(ref)).toEqual([]);
      expect(await h.stageRun(ref.itemId, "short")).toMatchObject({ status: "failed", failure: "budget", attempt: sameAttempt ? 1 : 2 });
      expect(await h.stageRun(ref.itemId, "waiting")).toMatchObject({ status: sameAttempt ? "running" : "waiting" });
    } finally {
      writeFileSync(h.boardPath, board);
      await h.engine.adoptParkedTemplateRuns();
    }
  }));
});

it("checks the current attempt after Git driver discovery and before checkout reset", async () => {
  const h = await stageRunHarness();
  await h.runThenEnd(async () => {
    const git = createHostGit();
    const discovering = deferred<void>();
    const release = deferred<void>();
    const resets: string[] = [];
    const projectRoot = join(realpathSync(h.dir), "project");
    const home = join(h.dir, "home");
    mkdirSync(projectRoot);
    mkdirSync(home);
    vi.stubEnv("AVE_HOME", home);
    let current = true;
    const workspace = createStageWorkspaceProvider({ git: {
      ...git,
      drivers: async (cwd, worktree, options) => {
        const result = await git.drivers(cwd, worktree, options);
        if (basename(cwd) === stageDirName("report")) {
          discovering.resolve();
          await release.promise;
        }
        return result;
      },
      run: (cwd, args, call) => {
        if (args[0] === "reset" && basename(cwd) === stageDirName("report")) resets.push(cwd);
        return git.run(cwd, args, call);
      },
    } });
    const ref = { itemId: 1, runId: "checkout", runKey: "checkout", projectRoot };
    try {
      expect((await git.run(projectRoot, ["init", "-q"])).code).toBe(0);
      expect((await git.run(projectRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"])).code).toBe(0);
      const opened = await workspace.open(ref, projectRoot);
      if (!opened.ok) throw new Error(opened.code);
      expect(opened.workspace.kind).toBe("git");
      const preparation = workspace.prepare(ref, autoStageOf("report"), 1, () => current);
      try {
        await within(discovering.promise, "driver discovery to pause before stage checkout", beforeUnblock);
        current = false;
      } finally {
        release.resolve();
        expect(await preparation).toMatchObject({ ok: false });
      }
      expect(resets).toEqual([]);
      expect(existsSync(join(opened.workspace.runRoot, stageDirName("report")))).toBe(false);
      expect(JSON.parse(readFileSync(join(opened.workspace.runRoot, RUN_FILE), "utf8")).stages).not.toHaveProperty("report");
    } finally {
      release.resolve();
      await workspace.release(ref, "all");
      vi.unstubAllEnvs();
    }
  });
});

it.each([
  { action: "Stop", status: "cancelled", breaker: null },
  { action: "authority refusal", status: "cancelled", breaker: null },
  { action: "write fault", status: "error", breaker: "failed" },
  { action: "human reject", status: "denied", breaker: null },
])("reports $status after a timed-out child exits during $action", async ({ action, status, breaker }) => {
  const attemptAdmission = deferred<void>();
  const finishAdmission = deferred<void>();
  let refuse = false;
  let fault = false;
  const h = await stageRunHarness({
    observeRunWork: true,
    interruptChild: vi.fn(),
    workflow: {
      authoriseRunSource: input => refuse && input.phase === "spawn" ? { ok: false, code: "scope-changed" } : authoriseRunSource(input),
      lane: {
        admit: async ({ stageId }) => {
          if (stageId === "trigger" && action !== "human reject") {
            attemptAdmission.resolve();
            await finishAdmission.promise;
          }
          return { ok: true };
        },
        onDenied: () => () => undefined, sessionLinked: () => undefined, sessionEnded: () => undefined,
      },
    },
    wiring: store => {
      const runs = boardRunState(store);
      return { runs: { ...runs, update: (...args) => {
        if (!fault) return runs.update(...args);
        fault = false;
        return Promise.resolve({ ok: false, reason: "unavailable" });
      } } };
    },
  });
  await h.runThenEnd(() => controlledDeadlineTest(async () => {
    try {
      const started = await startScheduled(h, [
        ...budgetStages(["short", "failed"], "short"),
        stageOf("trigger", { envelope: ENVELOPE }),
      ]);
      const fire = vi.fn();
      const outcome = vi.fn();
      void started.result.then(fire);
      void started.breakerOutcome.then(outcome);
      await h.untilLive(action === "human reject" ? 3 : 2);
      if (action === "human reject") {
        childOf(h, "trigger").finish();
        await h.untilStage(started.itemId, "trigger", "awaiting_gate");
      } else {
        await within(attemptAdmission.promise, "trigger stage to reach admission", beforeUnblock);
      }
      childOf(h, "failed").finish({ ok: false });
      await h.untilStage(started.itemId, "failed", "failed");
      await vi.advanceTimersByTimeAsync(30_000);
      await h.untilStage(started.itemId, "short", "failed");
      if (action === "Stop") expect(h.engine.cancelRun(started.itemId)).toEqual({ ok: true });
      else if (action === "human reject") expect(await h.decide(started.itemId, "trigger", "reject")).toEqual({ ok: true, status: "rejected" });
      else if (action === "authority refusal") refuse = true;
      else fault = true;
      finishAdmission.resolve();
      await h.drainRunWork();
      expect(fire).not.toHaveBeenCalled();
      if (action === "write fault") expect(outcome).not.toHaveBeenCalled();
      childOf(h, "short").finish({ ok: false, stopReason: "interrupted" });
      await expect(within(started.result, "the terminal fire after child exit", beforeUnblock)).resolves.toMatchObject({
        status, ...(action === "authority refusal" ? { reasonCode: "scope-changed" } : {}),
      });
      expect((await h.item(started.itemId)).record?.settled?.status).toBe(status);
      expect(await started.breakerOutcome).toBe(breaker);
      expect(outcome).toHaveBeenCalledExactlyOnceWith(breaker);
    } finally {
      finishAdmission.resolve();
    }
  }));
});

it("waits for held winding ends even when the child has exited and the event chain is idle", async () => {
  const h = await stageRunHarness({ observeRunWork: true, interruptChild: vi.fn() });
  await h.runThenEnd(() => controlledDeadlineTest(async () => {
    const started = await startScheduled(h, budgetStages(["short", "failed"], "short"));
    await h.untilLive(2);
    childOf(h, "failed").finish({ ok: false });
    await h.untilStage(started.itemId, "failed", "failed");
    await h.drainRunWork();
    const fire = vi.fn();
    void started.result.then(fire);
    const board = readFileSync(h.boardPath);
    try {
      // The deadline can fire while winding, before the stage has a terminal record.
      expect(h.engine.cancelRun(started.itemId)).toEqual({ ok: true });
      await h.drainRunWork();
      await vi.advanceTimersByTimeAsync(30_000);
      await h.drainRunWork();
      expect(await h.stageRun(started.itemId, "short")).toMatchObject({ status: "running" });
      expect(fire).not.toHaveBeenCalled();
      writeFileSync(h.boardPath, "{");
      childOf(h, "short").finish({ ok: false, stopReason: "interrupted" });
      await h.drainRunWork();
      await afterQueuedCallbacks();
      expect(fire).not.toHaveBeenCalled();
    } finally {
      writeFileSync(h.boardPath, board);
      await h.engine.adoptParkedTemplateRuns();
      await h.drainRunWork();
    }
    await expect(within(started.result, "the replayed stop result", beforeUnblock)).resolves.toMatchObject({ status: "cancelled" });
    expect(await h.stageRun(started.itemId, "short")).toMatchObject({ status: "cancelled" });
    expect(await started.breakerOutcome).toBeNull();
  }));
});

it("holds a deadline behind the earlier covered write that discovers the board loss", async () => {
  const updating = deferred<void>();
  const release = deferred<void>();
  let unreadable = false;
  let holdNext = false;
  const h = await stageRunHarness({
    observeRunWork: true,
    interruptChild: vi.fn(),
    wiring: store => {
      const runs = boardRunState(store);
      return { runs: { ...runs, update: async (...args) => {
        if (holdNext) {
          holdNext = false;
          updating.resolve();
          await release.promise;
        }
        return unreadable ? { ok: false, reason: "board-unread" } : runs.update(...args);
      } } };
    },
  });
  await h.runThenEnd(() => controlledDeadlineTest(async () => {
    try {
      const started = await startScheduled(h, budgetStages(["earlier", "short"], "short"));
      await h.untilLive(2);
      await h.drainRunWork();
      const { runId } = await h.item(started.itemId);
      if (!runId) throw new Error("Expected a run id");
      const ref = { itemId: started.itemId, runId };
      unreadable = true;
      holdNext = true;
      childOf(h, "earlier").finish({ ok: false });
      await within(updating.promise, "the first write to be in flight", beforeUnblock);
      await vi.advanceTimersByTimeAsync(30_000);
      await afterQueuedCallbacks();
      release.resolve();
      await h.drainRunWork();
      expect((await h.board.runs.heldEvents(ref)).map(held => held.stage)).toEqual(["earlier", "short"]);
      unreadable = false;
      childOf(h, "short").finish({ ok: false, stopReason: "interrupted" });
      await h.drainRunWork();
      await h.engine.adoptParkedTemplateRuns();
      await h.drainRunWork();
      expect((await h.item(ref.itemId)).stageRuns.map(stage => stage.failure)).toEqual(["error", "budget"]);
      expect(await h.board.runs.heldEvents(ref)).toEqual([]);
    } finally {
      unreadable = false;
      release.resolve();
    }
  }));
});

it("bounds every launch admission await before runner spawn", () => {
  const engine = readFileSync(new URL("../stage-run-engine.ts", import.meta.url), "utf8");
  const admission = engine.split("state.starting.add(stageId);")[1]?.split("const result = await running;")[0] ?? "";
  expect(admission).toContain("return runner.spawn(");
  const awaits = admission.match(/\bawait\b/gu) ?? [];
  expect(awaits.length).toBeGreaterThan(5);
  expect(admission.match(/\bawait\s+(?:beforeDeadline|authorise)\(/gu)).toHaveLength(awaits.length);
});

it("keeps a starting child in its slot until the runner confirms its exit", async () => {
  const starting = deferred<void>();
  const finishStarting = deferred<void>();
  const spawned: string[] = [];
  const h = await stageRunHarness({
    observeRunWork: true,
    runner: () => ({
      parentToolRegistry: boardParentToolRegistry,
      spawn: async (input: Parameters<SubAgentRunner["spawn"]>[0], callbacks: Parameters<SubAgentRunner["spawn"]>[1]) => {
        const id = input.unattendedStage?.stageId;
        if (!id) throw new Error("Expected an unattended stage");
        spawned.push(id);
        if (id === "short") {
          starting.resolve();
          await finishStarting.promise;
        }
        callbacks?.onLinked?.({ childSessionId: id });
        return { childSessionId: id, summary: "", entries: [], toolCallCount: 0, turnCount: 0, ok: false };
      },
    }) as unknown as SubAgentRunner,
  });
  await h.runThenEnd(() => controlledDeadlineTest(async () => {
    try {
      const started = await startScheduled(h, budgetStages(["short"], "short"));
      const fire = vi.fn();
      void started.result.then(fire);
      await within(starting.promise, "the runner to begin starting the child", beforeUnblock);
      await vi.advanceTimersByTimeAsync(30_000);
      await h.untilStage(started.itemId, "short", "failed");
      await h.drainRunWork({ includeLaunches: false });
      expect(fire).not.toHaveBeenCalled();
      finishStarting.resolve();
      await expect(within(started.result, "the start failure after the runner exits", beforeUnblock))
        .resolves.toMatchObject({ status: "awaiting_approval", reasonCode: "stage-failed" });
      expect(spawned).toEqual(["short"]);
      expect(h.events.some(event => event.runSessionId === "short")).toBe(false);
    } finally {
      finishStarting.resolve();
    }
  }));
});

const halfMinuteEnvelope = { ...ENVELOPE, budget: { ...LIMITS, minutes: 0.5 } };

it("replays a held deadline while the earlier gate seal is in flight", async () => {
  const evaluating = deferred<void>();
  const pass = deferred<void>();
  const sealing = deferred<void>();
  const release = deferred<void>();
  const registry = createPassConditionRegistry();
  const h = await stageRunHarness({
    observeRunWork: true,
    interruptChild: vi.fn(),
    workflow: { passConditions: {
      ...registry,
      evaluate: async (...args) => {
        evaluating.resolve();
        await pass.promise;
        return registry.evaluate(...args);
      },
    } },
    workspace: { seal: async () => { sealing.resolve(); await release.promise; return { ok: true }; } },
  });
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const run = await startScheduled(h, [autoStageOf("first", { envelope: ENVELOPE }), autoStageOf("short", { envelope: halfMinuteEnvelope })]);
    await h.untilLive(2);
    const first = childOf(h, "first");
    const short = childOf(h, "short");
    await h.drainRunWork();
    const { runId } = await h.item(run.itemId);
    if (!runId) throw new Error("Missing run ID");
    const board = readFileSync(h.boardPath);
    const ref = { itemId: run.itemId, runId };
    try {
      first.finish();
      await evaluating.promise;
      writeFileSync(h.boardPath, "{");
      pass.resolve();
      await h.drainRunWork();
      expect((await h.board.runs.heldEvents(ref)).map(event => event.kind)).toEqual(["gate_evaluated"]);
      await vi.advanceTimersByTimeAsync(30_000);
      await h.drainRunWork();
      expect((await h.board.runs.heldEvents(ref)).map(event => event.kind)).toEqual(["gate_evaluated", "stage_ended"]);
      short.finish({ ok: false, stopReason: "interrupted" });
      await h.drainRunWork();
      writeFileSync(h.boardPath, board);
      await h.engine.adoptParkedTemplateRuns();
      await sealing.promise;
      await within(h.untilStage(run.itemId, "short", "failed"), "the held deadline to commit during sealing", beforeUnblock);
      expect(await h.stageRun(run.itemId, "short")).toMatchObject({ failure: "budget" });
      expect(await run.result).toMatchObject({ status: "awaiting_approval", reasonCode: "stage-failed" });
    } finally {
      writeFileSync(h.boardPath, board);
      pass.resolve();
      release.resolve();
      vi.useRealTimers();
    }
  });
});

it.each([
  { outcome: "success", outage: false }, { outcome: "failure", outage: false },
  { outcome: "success", outage: true }, { outcome: "failure", outage: true },
] as const)("settles Stop and records a sibling seal ($outcome, board outage: $outage)", async ({ outcome, outage }) => {
  const sealing = deferred<void>();
  const release = deferred<void>();
  const sealCommit = "a".repeat(40);
  const h = await stageRunHarness({
    observeRunWork: true,
    interruptChild: vi.fn(),
    workspace: { seal: async () => {
      sealing.resolve();
      await release.promise;
      return outcome === "success" ? { ok: true, sealCommit } : { ok: false, code: "workspace-unavailable" };
    } },
  });
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let board: Buffer | undefined;
    try {
      const run = await startScheduled(h, [autoStageOf("first", { envelope: ENVELOPE }), autoStageOf("short", { envelope: halfMinuteEnvelope })]);
      await h.untilLive(2);
      const short = childOf(h, "short");
      childOf(h, "first").finish();
      await sealing.promise;
      expect(h.engine.cancelRun(run.itemId)).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(30_000);
      short.finish({ ok: false, stopReason: "interrupted" });
      await expect(within(run.result, "Stop to settle during sealing", beforeUnblock)).resolves.toMatchObject({ status: "cancelled" });
      expect(await h.stageRun(run.itemId, "short")).toMatchObject({ status: "cancelled" });
      expect((await h.item(run.itemId)).record?.settled?.status).toBe("cancelled");
      if (outage) {
        board = readFileSync(h.boardPath);
        writeFileSync(h.boardPath, "{");
      }
      release.resolve();
      await h.drainRunWork();
      if (board) {
        writeFileSync(h.boardPath, board);
        await h.engine.adoptParkedTemplateRuns();
        await h.drainRunWork();
      }
      expect((await h.item(run.itemId)).record?.settled?.status).toBe("cancelled");
      expect(await h.stageRun(run.itemId, "first")).toMatchObject(outcome === "success"
        ? { status: "passed", workspace: { sealCommit } }
        : { status: "failed", failure: "error" });
    } finally {
      if (board) writeFileSync(h.boardPath, board);
      release.resolve();
      vi.useRealTimers();
    }
  });
});

it("keeps a successful seal receipt behind an earlier held deadline", async () => {
  const sealing = deferred<void>();
  const release = deferred<void>();
  const sealCommit = "a".repeat(40);
  const h = await stageRunHarness({
    observeRunWork: true,
    interruptChild: vi.fn(),
    workspace: { seal: async () => {
      sealing.resolve();
      await release.promise;
      return { ok: true, sealCommit };
    } },
  });
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let board: Buffer | undefined;
    try {
      const run = await startScheduled(h, [autoStageOf("first", { envelope: ENVELOPE }), autoStageOf("short", { envelope: halfMinuteEnvelope })]);
      await h.untilLive(2);
      await h.drainRunWork({ includeLaunches: false });
      const { runId } = await h.item(run.itemId);
      if (!runId) throw new Error("Expected a run ID");
      const ref = { itemId: run.itemId, runId };
      childOf(h, "first").finish();
      await sealing.promise;
      board = readFileSync(h.boardPath);
      writeFileSync(h.boardPath, "{");
      await vi.advanceTimersByTimeAsync(30_000);
      await h.untilRunFile(async () => {
        expect((await h.board.runs.heldEvents(ref)).map(event => event.kind)).toEqual(["stage_ended"]);
      });
      writeFileSync(h.boardPath, board);
      release.resolve();
      await h.drainRunWork({ includeLaunches: false });
      const pending = await h.runOf(runId);
      expect(pending?.stageRuns.find(stage => stage.stageId === "short")?.status).toBe("running");
      expect(pending?.stageRuns.find(stage => stage.stageId === "first")?.workspace?.sealCommit).toBeUndefined();
      await h.engine.adoptParkedTemplateRuns();
      await h.drainRunWork({ includeLaunches: false });
      const replayed = await h.runOf(runId);
      expect(replayed?.stageRuns.find(stage => stage.stageId === "short")).toMatchObject({ status: "failed", failure: "budget" });
      expect(replayed?.stageRuns.find(stage => stage.stageId === "first")?.workspace?.sealCommit).toBe(sealCommit);
    } finally {
      if (board) writeFileSync(h.boardPath, board);
      release.resolve();
      vi.useRealTimers();
    }
  });
});

it.each(["prepare", "retry reset", "seal", "integrate", "release"] as const)(
  "commits an independent stage write and replays a held deadline during %s",
  async kind => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const hold = () => {
      entered.resolve();
      return release.promise;
    };
    const h = await stageRunHarness({
      observeRunWork: true,
      interruptChild: vi.fn(),
      wiring: (_store, { workspace }) => ({ workspace: {
        ...workspace,
        prepare: async (...args) => {
          if (kind === "prepare" && args[1].id === "effect") await hold();
          return workspace.prepare(...args);
        },
        seal: async (...args) => {
          if (kind === "seal" && args[1] === "effect") await hold();
          return workspace.seal(...args);
        },
        integrate: async (...args) => {
          if (kind === "integrate" && args[2].includes("effect")) await hold();
          return workspace.integrate(...args);
        },
        release: async (...args) => {
          if ((kind === "retry reset" || kind === "release") && args[1] !== "all" && args[1].length === 1 && args[1][0] === "effect") await hold();
          return workspace.release(...args);
        },
      } }),
    });
    await h.runThenEnd(async () => {
      const reduce = stageMachine.reduceRun;
      const reducer = vi.spyOn(stageMachine, "reduceRun").mockImplementation((snapshot, event) => {
        const step = reduce(snapshot, event);
        if (event.type === "gate_evaluated" && event.stageId === "effect") {
          // A normal join or settlement occurs at a barrier. Exercise its provider dispatch with sibling writes still eligible.
          if (kind === "integrate") step.effects.push({ type: "integrate", joinId: "step-1", stageIds: ["effect"] });
          if (kind === "release") step.effects.push({ type: "release_workspace", stageIds: ["effect"] });
        }
        return step;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let board: Buffer | undefined;
      try {
        const run = await startScheduled(h, [
          autoStageOf("effect", { envelope: ENVELOPE }), stageOf("write", { envelope: ENVELOPE }),
          autoStageOf("short", { envelope: halfMinuteEnvelope }),
        ]);
        await h.untilLive(kind === "prepare" ? 2 : 3);
        const { runId } = await h.item(run.itemId);
        if (!runId) throw new Error("Missing run ID");
        if (kind === "retry reset") {
          childOf(h, "effect").finish({ ok: false });
          await h.untilStage(run.itemId, "effect", "failed");
          expect(await h.engine.retryStage(run.itemId, { runId, stageId: "effect", attempt: 1 })).toEqual({ ok: true });
        } else if (kind !== "prepare") {
          childOf(h, "effect").finish();
        }
        await within(entered.promise, "the workspace effect to start", beforeUnblock);
        childOf(h, "write").finish();
        await within(h.untilStage(run.itemId, "write", "awaiting_gate"), "the sibling write to commit", beforeUnblock);

        board = readFileSync(h.boardPath);
        writeFileSync(h.boardPath, "{");
        const ref = { itemId: run.itemId, runId };
        await vi.advanceTimersByTimeAsync(30_000);
        await within(h.untilRunFile(async () => {
          expect(await h.board.runs.heldEvents(ref)).toContainEqual(expect.objectContaining({ stage: "short", kind: "stage_ended" }));
        }), "the deadline to be held", beforeUnblock);

        writeFileSync(h.boardPath, board);
        board = undefined;
        await h.engine.adoptParkedTemplateRuns();
        await within(h.untilStage(run.itemId, "short", "failed"), "the held deadline to commit", beforeUnblock);
        expect(await h.stageRun(run.itemId, "short")).toMatchObject({ failure: "budget" });
        await within(h.untilRunFile(async () => {
          expect((await h.board.runs.heldEvents(ref)).some(event => event.stage === "short" && event.kind === "stage_ended")).toBe(false);
        }), "the replayed deadline marker to be removed", beforeUnblock);
      } finally {
        if (board) writeFileSync(h.boardPath, board);
        release.resolve();
        vi.useRealTimers();
        reducer.mockRestore();
      }
    });
  },
);

it("holds a retry reset behind the previous attempt's unfinished preparation", async () => {
  const preparing = deferred<void>();
  const release = deferred<void>();
  const resets = vi.fn();
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (_store, { workspace }) => ({ workspace: {
      ...workspace,
      prepare: async (...args) => {
        if (args[2] === 1) {
          preparing.resolve();
          await release.promise;
        }
        return workspace.prepare(...args);
      },
      release: async (...args) => {
        resets(args[1]);
        return workspace.release(...args);
      },
    } }),
  });
  await h.runThenEnd(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const run = await startScheduled(h);
      await within(preparing.promise, "preparation to start", beforeUnblock);
      const { runId } = await h.item(run.itemId);
      if (!runId) throw new Error("Missing run ID");
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(within(run.result, "the first attempt's deadline to commit", beforeUnblock))
        .resolves.toMatchObject({ status: "awaiting_approval", reasonCode: "stage-failed" });
      expect(await h.engine.retryStage(run.itemId, { runId, stageId: "report", attempt: 1 })).toEqual({ ok: true });
      await h.drainRunWork({ includeLaunches: false });
      expect(await h.stageRun(run.itemId, "report")).toMatchObject({ attempt: 2, status: "running" });
      expect(resets).not.toHaveBeenCalled();

      release.resolve();
      const [retried] = await h.untilLive(1);
      expect(resets).toHaveBeenCalledExactlyOnceWith(["report"]);
      retried.finish();
      await expect(run.completion).resolves.toBe(true);
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });
});
