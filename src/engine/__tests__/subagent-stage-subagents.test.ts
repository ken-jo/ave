import { spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { t } from "../../i18n/index.js";
import { configureHostResources } from "../../main/host-resources.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST } from "../../permissions/approval-gate.js";
import { approvalSurfaceRegistry, updateApprovalSurface } from "../../permissions/approval-surface-registry.js";
import { __resetRunGrantsForTest, endRunSession, registerRunSession, runGrantKeyOfSession } from "../../permissions/run-grants.js";
import { STAGE_REQUEST_OUTPUT_TOOL } from "../../shared/workflow-template-types.js";
import { createAgentInterruptTool, createAgentSpawnTool, createAgentStatusTool } from "../../tools/agent-spawn.js";
import { createDynamicTool, type Tool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import { backgroundShellManager, listShellTasks } from "../../tools/shell-tools.js";
import { createStageRequestOutputTool } from "../../tools/stage-request-output.js";
import { ConversationLoop, type TurnResult } from "../conversation-loop.js";
import { exactToolScope, PARENT_ALL_TOOL_SCOPE, SubAgentRunner } from "../subagent-runner.js";
import { makeSubagentLoopDeps, patchLoopProvider } from "./support/subagent-loop-fixtures.js";

import { PermissionManager } from "../../permissions/permission-manager.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { ReadFileTool } from "../../tools/file-tools.js";
import type { StreamEvent, StreamTurnParams } from "../llm/types.js";

beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetRunGrantsForTest();
  updateApprovalSurface({ kind: "release", sessionId: "work-board:1" });
});

const CWD = process.cwd();

function fixture(saveSessionMetadata: (sessionId: string) => Promise<void> = async () => undefined) {
  const contents = makeMockWebContents();
  updateApprovalSurface({ kind: "attach", sessionId: "work-board:1", surface: contents as never });
  const gate = new ApprovalGate(sessionId => approvalSurfaceRegistry.resolve(sessionId));
  const registry = new ToolRegistry();
  const request = vi.spyOn(gate, "requestAndWait");
  const runner = new SubAgentRunner({
    parentDeps: makeSubagentLoopDeps(registry, { approvalGate: gate, supportsA2AParentDelivery: true }),
    toolRegistry: registry,
    subAgentMemoryManager: {
      sessions: { saveSessionMetadata },
    } as never,
  });
  const tool = createAgentSpawnTool({ getRunner: () => runner, emit: () => undefined });
  registry.register(tool);
  registry.register(createAgentStatusTool({ getRunner: () => runner }));
  registry.register(createAgentInterruptTool({ getRunner: () => runner }));
  for (const [name, category] of [["read_stage", "read"], ["write_outside", "write"]] as const) {
    registry.register(createDynamicTool({
      name, category, source: "builtin", description: "", jsonSchema: {},
      execute: async () => ({ output: "", isError: false }),
    }));
  }
  vi.spyOn(ConversationLoop.prototype, "hasProvider").mockReturnValue(true);
  vi.spyOn(ConversationLoop.prototype, "refreshProvider").mockResolvedValue(undefined);
  const turn = vi.spyOn(ConversationLoop.prototype, "runTurn");
  const bind = vi.fn((sessionId: string, title: string) => {
    registerRunSession("run", sessionId, { stageId: "scan", stageName: "Scan", lane: "attended", agentTitle: title });
    return () => endRunSession(sessionId);
  });
  const start = (opts: { enabled?: boolean; unattended?: boolean; allTools?: boolean; stageOutputTool?: Tool } = {}) =>
    runner.spawn({
      title: "Scan",
      instructions: "stage",
      originSessionId: "work-board:1",
      projectRoot: CWD,
      toolScope: opts.allTools ? PARENT_ALL_TOOL_SCOPE : exactToolScope(["read_stage"]),
      maxRounds: 3,
      ...(opts.enabled === false ? {} : { stageSubAgents: { stageName: "Scan", runKey: "run", max: 3 } }),
      ...(opts.stageOutputTool ? { stageOutputTool: opts.stageOutputTool } : {}),
      ...(opts.unattended ? { unattendedStage: { runKey: "run", stageId: "scan" } } : {}),
    }, { onStageSubAgentLinked: bind });
  return { gate, request, contents, runner, tool, turn, start, bind, registry };
}

function toolContext(sessionId: string, abortSignal?: AbortSignal, options?: { spawnDepth?: number; stageSubAgents?: true }) {
  return {
    cwd: resolve("resources"), extraAllowedDirectories: [], abortSignal,
    metadata: { sessionId, spawnDepth: options?.spawnDepth ?? 1, stageSubAgents: options?.stageSubAgents ?? (options === undefined ? true : undefined), supportsA2AParentDelivery: true },
  };
}

const done: TurnResult = { text: "done", toolCalls: [], route: "default", stopReason: "end_turn" };

it("an opted-in stage child can spawn one level", async () => {
  const { tool, turn, start } = fixture();
  turn.mockImplementation(async function (this: ConversationLoop, prompt, _callbacks, signal, options) {
    if (prompt === "stage") {
      expect(options).toMatchObject({ spawnDepth: 1, stageSubAgents: true });
      expect(this.deps.toolRegistry.listAll().map(item => item.name)).toEqual(expect.arrayContaining([
        "agent_spawn", "agent_status", "agent_interrupt",
      ]));
      expect((await tool.execute({ title: "Extract", instructions: "grandchild" }, toolContext(this.sessionId, signal, options))).isError).toBe(false);
    }
    return done;
  });
  expect((await start()).ok).toBe(true);
  expect(turn).toHaveBeenCalledTimes(2);
});

it("the grandchild cannot spawn", async () => {
  const { tool, turn, start } = fixture();
  turn.mockImplementation(async function (this: ConversationLoop, prompt, _callbacks, signal, options) {
    if (prompt === "stage") {
      expect((await tool.execute({ title: "Extract", instructions: "grandchild" }, toolContext(this.sessionId, signal))).isError).toBe(false);
    } else {
      expect(options?.spawnDepth).toBe(2);
      expect(options).not.toHaveProperty("stageSubAgents");
      expect(this.deps.toolRegistry.findByName("agent_spawn")).toBeUndefined();
      const result = await tool.execute({ title: "Too deep", instructions: "work" }, toolContext(this.sessionId, signal, options));
      expect(JSON.parse(result.output).error).toBe(t("be_agentSpawn.depthLimit"));
    }
    return done;
  });
  expect((await start()).ok).toBe(true);
  expect(turn).toHaveBeenCalledTimes(2);
});

it.each(["parent-all", "exactly"] as const)("keeps stage output intake out of a grandchild with %s scope", async scope => {
  const { tool, turn, start } = fixture();
  const stageOutputTool = createStageRequestOutputTool([], async () => ({ ok: false, code: "output-not-declared" }));
  turn.mockImplementation(async function (this: ConversationLoop, prompt, _callbacks, signal) {
    if (prompt === "stage") {
      expect(this.deps.toolRegistry.findByName(STAGE_REQUEST_OUTPUT_TOOL)).toBe(stageOutputTool);
      const sourceTools = scope === "exactly" ? ["read_stage", STAGE_REQUEST_OUTPUT_TOOL] : undefined;
      const result = await tool.execute({ title: "Extract", instructions: "grandchild", sourceTools }, toolContext(this.sessionId, signal));
      expect(result.isError).toBe(false);
    } else {
      expect(this.deps.toolRegistry.findByName("read_stage")).toBeDefined();
      expect(this.deps.toolRegistry.findByName(STAGE_REQUEST_OUTPUT_TOOL)).toBeUndefined();
    }
    return done;
  });
  expect((await start({ stageOutputTool })).ok).toBe(true);
  expect(turn).toHaveBeenCalledTimes(2);
});

it("a stage without the opt-in has no agent_spawn tool", async () => {
  const { turn, start } = fixture();
  turn.mockImplementation(async function (this: ConversationLoop, _prompt, _callbacks, _signal, options) {
    expect(options).not.toHaveProperty("stageSubAgents");
    for (const name of ["agent_spawn", "agent_status", "agent_interrupt"]) {
      expect(this.deps.toolRegistry.findByName(name)).toBeUndefined();
    }
    return done;
  });
  expect((await start({ enabled: false })).ok).toBe(true);
});

it("requires host stage metadata even for a live opted-in stage", async () => {
  const { turn, tool, start } = fixture();
  turn.mockImplementation(async function (this: ConversationLoop, _prompt, _callbacks, signal) {
    const result = await tool.execute({ title: "Too deep", instructions: "work" }, toolContext(this.sessionId, signal, { spawnDepth: 1 }));
    expect(JSON.parse(result.output).error).toBe(t("be_agentSpawn.depthLimit"));
    return done;
  });
  expect((await start()).ok).toBe(true);
  expect(turn).toHaveBeenCalledTimes(1);
});

it.each(["sequentially", "concurrently"])("limits each stage to three grandchildren spawned %s", async mode => {
  const { tool, turn, start } = fixture();
  turn.mockImplementation(async function (this: ConversationLoop, prompt, _callbacks, signal) {
    if (prompt === "stage") {
      const call = (index: number) => tool.execute({ title: `Helper ${index}`, instructions: "grandchild" }, toolContext(this.sessionId, signal));
      const results = [];
      if (mode === "concurrently") results.push(...await Promise.all([0, 1, 2, 3].map(call)));
      else for (const index of [0, 1, 2, 3]) results.push(await call(index));
      expect(results.map(result => result.isError)).toEqual([false, false, false, true]);
      expect(JSON.parse(results[3].output).error).toContain("stage-spawn-limit");
    }
    return done;
  });
  expect((await start()).ok).toBe(true);
  expect((await start()).ok).toBe(true);
  expect(turn).toHaveBeenCalledTimes(8);
});

it.each(["deferred abort", "bind refusal", "link callback refusal"])("returns the slot after a %s", async failure => {
  const { bind, runner, turn, start } = fixture();
  turn.mockImplementation(async function (this: ConversationLoop, prompt) {
    if (prompt !== "stage") return done;
    const input = { title: "Helper", instructions: "grandchild", toolScope: PARENT_ALL_TOOL_SCOPE };
    if (failure === "deferred abort") {
      const controller = new AbortController();
      const pending = runner.spawnStageSubAgent(this.sessionId, input, undefined, controller.signal);
      controller.abort();
      expect((await pending).ok).toBe(false);
      expect(bind).not.toHaveBeenCalled();
    } else {
      const refuse = () => { throw new Error("Link refused"); };
      if (failure === "bind refusal") bind.mockImplementationOnce(refuse);
      const callbacks = failure === "link callback refusal" ? { onLinked: refuse } : undefined;
      await expect(runner.spawnStageSubAgent(this.sessionId, input, callbacks)).rejects.toThrow("Link refused");
    }
    const results = await Promise.all([1, 2, 3, 4].map(() => runner.spawnStageSubAgent(this.sessionId, input)));
    expect(results.map(result => result.ok)).toEqual([true, true, true, false]);
    expect(results[3].error).toContain("stage-spawn-limit");
    return done;
  });
  const result = await start();
  expect(result.ok, result.error).toBe(true);
});

it("refuses a plugin tool whose owner is inactive in the stage", async () => {
  const { registry, turn, tool, start } = fixture();
  registry.register(createDynamicTool({
    name: "plugin_probe", category: "read", source: "plugin", pluginId: "inactive-plugin",
    description: "", jsonSchema: {}, execute: async () => ({ output: "", isError: false }),
  }));
  turn.mockImplementation(async function (this: ConversationLoop, prompt, _callbacks, signal) {
    if (prompt === "stage") {
      expect(this.deps.toolRegistry.findByName("plugin_probe")).toBeDefined();
      const result = await tool.execute({ title: "Extract", instructions: "grandchild", sourceTools: ["plugin_probe"] }, toolContext(this.sessionId, signal));
      expect(JSON.parse(result.output).error).toContain("stage-extension-out-of-scope");
      expect(result.isError).toBe(true);
    }
    return done;
  });
  expect((await start({ allTools: true })).ok).toBe(true);
  expect(turn).toHaveBeenCalledTimes(1);
});

it("rejects malformed descendant provenance and stage authority before linking", async () => {
  const { runner, turn, start, bind } = fixture();
  turn.mockImplementation(async function (this: ConversationLoop) {
    const input = { title: "Extract", instructions: "grandchild", toolScope: exactToolScope(["read_stage"]) };
    await expect(runner.spawnStageSubAgent(this.sessionId, { ...input, approvalProvenance: {} } as typeof input)).rejects.toThrow("Stage descendants cannot carry approval provenance");
    const stageSubAgents = { stageName: "Scan", runKey: "run", max: 3 };
    const malformed = { ...input, stageSubAgents };
    await expect(runner.spawnStageSubAgent(this.sessionId, malformed)).rejects.toThrow("Stage descendants cannot delegate");
    return done;
  });
  expect((await start()).ok).toBe(true);
  expect(bind).not.toHaveBeenCalled();
});

it("tracks and persists a stage-qualified grandchild title", async () => {
  const save = vi.fn(async (_sessionId: string) => undefined);
  const { runner, turn, start, tool } = fixture(save);
  turn.mockImplementation(async function (this: ConversationLoop, prompt, _callbacks, signal) {
    if (prompt === "stage") {
      const result = await tool.execute({ title: "Extract", instructions: "grandchild" }, toolContext(this.sessionId, signal));
      const { childSessionId } = JSON.parse(result.output);
      expect(runner.getRunStatus(childSessionId, this.sessionId)?.title).toBe("Scan › Extract");
      expect(save).toHaveBeenCalledWith(childSessionId, expect.objectContaining({ subAgentTitle: "Scan › Extract" }));
    }
    return done;
  });
  expect((await start()).ok).toBe(true);
});

it("inherits the workspace and round ceiling and intersects requested tools with the stage", async () => {
  const { tool, turn, start } = fixture();
  const observed: unknown[] = [];
  turn.mockImplementation(async function (this: ConversationLoop, prompt, _callbacks, signal, options) {
    if (prompt === "stage") {
      const result = await tool.execute({
        title: "Helper", instructions: "grandchild", sourceTools: ["read_stage", "write_outside", "agent_spawn"], maxRounds: 500,
      }, toolContext(this.sessionId, signal));
      expect(result.isError).toBe(false);
      const resume = await tool.execute({
        resumeId: "prior-child", instructions: "continue", maxRounds: 500,
      }, toolContext(this.sessionId, signal));
      expect(JSON.parse(resume.output)).toMatchObject({ error: t("be_agentSpawn.stageContinuationUnavailable") });
    } else {
      observed.push([this.getSessionProjectRoot(), options?.maxRounds, this.deps.toolRegistry.listAll().map(item => item.name)]);
    }
    return done;
  });
  expect((await start()).ok).toBe(true);
  expect(observed).toEqual([[CWD, 3, expect.arrayContaining(["read_stage"])]]);
  expect(observed[0]).toEqual([CWD, 3, expect.not.arrayContaining(["write_outside"])]);
  expect(observed[0]).toEqual([CWD, 3, expect.not.arrayContaining(["agent_spawn"])]);
});

it("the grandchild's approval is labelled with stage and sub-agent and has no parent adjudication", async () => {
  const { tool, turn, start, gate, request, contents } = fixture();
  const ready = deferred<string>();
  turn.mockImplementation(async function (this: ConversationLoop, prompt, _callbacks, signal) {
    if (prompt === "stage") {
      await tool.execute({ title: "Helper", instructions: "grandchild" }, toolContext(this.sessionId, signal));
    } else {
      ready.resolve(this.sessionId);
      await this.deps.approvalGate?.requestAndWait({
        id: "helper-card", createdAt: Date.now(), category: "tool", kind: "tool",
        toolName: "read_stage", args: {}, source: "builtin", sessionId: this.sessionId, reason: "Confirm read",
      });
    }
    return done;
  });
  const run = start();
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    const childSessionId = await ready.promise;
    expect(request.mock.calls[0][0]).not.toHaveProperty("childProvenance");
    expect(runGrantKeyOfSession(childSessionId)).toBe("run");
    expect(contents.send).toHaveBeenCalledWith(IPC_APPROVAL_REQUEST, expect.objectContaining({
      sessionId: childSessionId,
      requestingAgentTitle: "Helper",
      runStage: expect.objectContaining({ stageId: "scan", stageName: "Scan" }),
    }));
  } finally {
    gate.disposeAll();
    await run;
  }
});

it("the grandchild resolves the stage's approval surface", async () => {
  const { contents, tool, turn, start } = fixture();
  turn.mockImplementation(async function (this: ConversationLoop, prompt, _callbacks, signal) {
    if (prompt === "stage") {
      expect(approvalSurfaceRegistry.resolve(this.sessionId)).toBe(contents);
      const result = await tool.execute({ title: "Extract", instructions: "grandchild" }, toolContext(this.sessionId, signal));
      expect(result.isError).toBe(false);
    } else {
      expect(approvalSurfaceRegistry.resolve(this.sessionId)).toBe(contents);
    }
    return done;
  });
  expect((await start()).ok).toBe(true);
  expect(turn).toHaveBeenCalledTimes(2);
});

it("interrupting the stage interrupts its grandchildren", async () => {
  const { runner, tool, turn, start } = fixture();
  const linked = deferred<void>();
  const order: string[] = [];
  let stageId = "";
  turn.mockImplementation(async function (this: ConversationLoop, prompt, _callbacks, signal) {
    if (!signal) throw new Error("Expected cancellation signal");
    const aborted = once(signal, "abort");
    signal.addEventListener("abort", () => order.push(prompt));
    if (prompt === "stage") {
      stageId = this.sessionId;
      await tool.execute({ title: "Helper", instructions: "grandchild" }, toolContext(this.sessionId, signal));
    } else {
      linked.resolve();
    }
    await aborted;
    return done;
  });
  const running = start();
  await linked.promise;
  expect(runner.interruptRun(stageId, "work-board:1").ok).toBe(true);
  expect(order).toEqual(["grandchild", "stage"]);
  expect(await running).toMatchObject({ stopReason: "interrupted" });
});

it("an admitted unattended stage delegates through the model tool and receives the result", async () => {
  const root = await mkdtemp(join(tmpdir(), "stage-model-"));
  const memory = new MemoryManager({ aveDir: join(root, "memory") });
  try {
    memory.load();
    await writeFile(join(root, ".env"), "TEST_VALUE=private-fixture");
    const registry = new ToolRegistry();
    const { contents, gate } = fixture();
    const permissionManager = new PermissionManager(join(root, "permissions.json"));
    permissionManager.setMode("allow");
    const runner = new SubAgentRunner({
      parentDeps: makeSubagentLoopDeps(registry, { approvalGate: gate, permissionManager, networkFetch: unusedNetworkFetch }),
      toolRegistry: registry, subAgentMemoryManager: memory,
    });
    registry.register(createAgentSpawnTool({ getRunner: () => runner, emit: () => undefined }));
    registry.register(createAgentStatusTool({ getRunner: () => runner }));
    registry.register(createAgentInterruptTool({ getRunner: () => runner }));
    registry.register(new ReadFileTool());
    const toolRound = (id: string, name: string, input: Record<string, unknown>): StreamEvent[] => [
      { type: "tool_call", id, name, input }, { type: "message_complete", stopReason: "tool_use" },
    ];
    const textRound = (text: string): StreamEvent[] => [
      { type: "text_delta", text }, { type: "message_complete", stopReason: "end_turn" },
    ];
    const rounds = [
      toolRound("spawn-helper", "agent_spawn", { title: "Extract", instructions: "grandchild", sourceTools: ["read_file"] }),
      toolRound("secret-read", "read_file", { path: ".env" }),
      textRound("helper finished"),
      textRound("stage finished"),
    ];
    const streamTurn = vi.fn(async function* (_params: StreamTurnParams) {
      const round = rounds.shift();
      if (!round) throw new Error("Unexpected model round");
      yield* round;
    });
    patchLoopProvider({ vendor: "openai", streamTurn });
    const bind = vi.fn(() => () => undefined);
    const stageSubAgents = { stageName: "Scan", runKey: "run", max: 3 };
    const result = await runner.spawn({
      title: "Scan", instructions: "stage", projectRoot: root, originSessionId: "work-board:1",
      toolScope: exactToolScope(["read_file"]), stageSubAgents, unattendedStage: { runKey: "run", stageId: "scan" },
    }, { onStageSubAgentLinked: bind });
    expect(result).toMatchObject({ ok: true, summary: "stage finished" });
    expect(streamTurn.mock.calls[0][0].tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(["agent_spawn", "agent_status", "agent_interrupt"]));
    expect(streamTurn.mock.calls[1][0].tools?.map(tool => tool.name)).toEqual(["read_file"]);
    expect(streamTurn.mock.calls[2][0].messages).toContainEqual(expect.objectContaining({
      role: "tool_result", toolUseId: "secret-read", isError: true,
    }));
    const delivery = streamTurn.mock.calls[3][0].messages.find(message => message.role === "tool_result" && message.toolUseId === "spawn-helper");
    expect(delivery).toMatchObject({ role: "tool_result", toolName: "agent_spawn" });
    expect(delivery).not.toHaveProperty("isError", true);
    expect(delivery?.role === "tool_result" && JSON.parse(delivery.content)).toMatchObject({ summary: "helper finished" });
    expect(contents.send).not.toHaveBeenCalledWith(IPC_APPROVAL_REQUEST, expect.anything());
  } finally {
    memory.sessions.closeSearchIndex();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["terminal write succeeds", "terminal write fails"])("interrupts a live grandchild and reaps its process when %s", async (terminalWrite) => {
  let failWriteFor: string | undefined;
  const { runner, turn, start } = fixture(async sessionId => {
    if (sessionId === failWriteFor) throw new Error("Cannot write terminal metadata");
  });
  const running = deferred<string>();
  let processHandle: ReturnType<typeof spawn> | undefined;
  let task: ReturnType<SubAgentRunner["spawnStageSubAgent"]> | undefined;
  let parentId = "";
  turn.mockImplementation(async function (this: ConversationLoop, prompt, _callbacks, signal) {
    if (prompt === "stage") {
      parentId = this.sessionId;
      task = runner.spawnStageSubAgent(parentId, {
        title: "Helper", instructions: "grandchild", toolScope: exactToolScope(["read_stage"]),
      });
      await running.promise;
    } else {
      processHandle = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "ignore",
      });
      await once(processHandle, "spawn");
      backgroundShellManager.register({
        child: processHandle, sessionId: this.sessionId, startedAt: new Date().toISOString(), command: "fixture",
      });
      if (terminalWrite === "terminal write fails") failWriteFor = this.sessionId;
      running.resolve(this.sessionId);
      if (!signal) throw new Error("No cancellation signal for the grandchild");
      await once(signal, "abort");
    }
    return done;
  });
  try {
    expect((await start()).ok).toBe(true);
    const grandchildId = await running.promise;
    expect(await task).toMatchObject({ stopReason: "interrupted" });
    await vi.waitFor(() => {
      expect(processHandle && (processHandle.exitCode !== null || processHandle.signalCode !== null)).toBe(true);
    });
    expect(listShellTasks(grandchildId)).toEqual([]);
    expect(runner.liveOriginSessionId(grandchildId)).toBeUndefined();
    expect(runGrantKeyOfSession(grandchildId)).toBeUndefined();
    expect((await runner.spawnStageSubAgent(parentId, {
      title: "Too late", instructions: "grandchild", toolScope: exactToolScope(["read_stage"]),
    })).ok).toBe(false);
  } finally {
    if (processHandle?.signalCode === null && processHandle.exitCode === null) processHandle.kill("SIGKILL");
  }
});
