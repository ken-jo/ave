// Round budgets stop incomplete work; frozen tool scope and depth guards constrain child authority.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationLoop } from "../conversation-loop.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { makeSubagentLoopDeps as buildLoopDeps, patchLoopProvider } from "./support/subagent-loop-fixtures.js";
import {
  SubAgentRunner,
  resolveSubAgentModel,
  buildModePreamble,
  exactToolScope,
  fromPersistedToolScope,
  toPersistedToolScope,
  DENY_ALL_TOOL_SCOPE,
  PARENT_ALL_TOOL_SCOPE,
  type SubAgentSpawnResult,
  type SubAgentToolScope,
} from "../subagent-runner.js";
import { MODEL_COMPLEXITY_MAP } from "../../shared/model-complexity-map.js";
import { llmVendorModelOptions } from "../../shared/llm-vendor-defaults.js";
import { AGENT_MODE_MAP } from "../../shared/agent-mode-map.js";
import type { LLMProvider, StreamEvent, StreamTurnParams,
} from "../llm/types.js";
import { createAgentSpawnTool, createAgentStatusTool } from "../../tools/agent-spawn.js";
import type { AgentSpawnEvent } from "../../shared/subagent-events.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import {
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
  type SubscriptionChatRuntimeSelection,
} from "../../shared/subscription-runtime.js";
import { buildPluginToolsForTest } from "../../plugins/__tests__/plugin-tool-test-fixture.js";
import {
  CARD_FIXTURE_IN_SCOPE_PLUGIN,
  CARD_FIXTURE_IN_SCOPE_TOOL,
  CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN,
  CARD_FIXTURE_OUT_OF_SCOPE_TOOLS,
  pluginCardRuntimeFixture,
} from "../../plugins/__tests__/plugin-card-runtime-fixture.js";
import { createSystemPromptBuilder } from "../../boot/conversation.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { PluginManifest } from "../../plugins/types.js";
import { A2A_ROLE_AGENT, A2ATaskState, type A2AMessage,
} from "../../shared/a2a.js";
import { A2ASubAgentMessageBus } from "../a2a-subagent-message-bus.js";
import { SubAgentMessageMailbox } from "../subagent-message-mailbox.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { endTurnScript } from "./conversation-loop-test-helpers.js";
import type { PromptMemorySource } from "../../memory/memory-manager.js";
import { makePromptMemorySource } from "../../prompts/__tests__/test-helpers.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { updateApprovalSurface } from "../../permissions/approval-surface-registry.js";
import { authorizationRequiredStateForOutput } from "../../shared/authorization-required.js";
import { SkillOverlay } from "../../main/skill-overlay.js";
import { checkpointFileMutation, restoreCodeCheckpoint, withCodeCheckpoint } from "../../memory/code-checkpoints.js";
import type { LoadedSkill } from "../../main/skill-store.js";

const SUBSCRIPTION_SELECTION = { kind: "subscription", provider: "codex" } as const;

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  public turnsServed = 0;
  public observedToolNames: string[][] = [];
  public observedSystemPrompts: string[] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.observedToolNames.push((params.tools ?? []).map((tool) => tool.name));
    this.observedSystemPrompts.push(params.systemPrompt);
    const idx = this.turnsServed++;
    yield* this.turns[idx] ?? this.turns[this.turns.length - 1] ?? [
      { type: "text_delta", text: "(out-of-script)" },
      { type: "message_complete", stopReason: "end_turn" },
    ];
  }
}

// Use an isolated child store so behavioral fixtures cannot write main-session history.
function fakeSubAgentMemoryManager(memory: Partial<PromptMemorySource> = {}) {
  return {
    // Prompt fixtures must implement the child store reader contract.
    ...makePromptMemorySource(memory),
    saveSession: () => Promise.resolve(),
    saveSessionMetadata: () => Promise.resolve(),
    listSessions: () => [],
    listSessionsPage: () => [],
    load: () => undefined,
  } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["subAgentMemoryManager"];
}

function makeRunner(toolRegistry: ToolRegistry) {
  return new SubAgentRunner({
    parentDeps: buildLoopDeps(toolRegistry),
    toolRegistry,
    subAgentMemoryManager: fakeSubAgentMemoryManager(),
  });
}

describe("SubAgentRunner approval-owner setup", () => {
  it("releases the temporary child registration when initialization fails", async () => {
    let temporarySessionId: string | undefined;
    const initialize = vi.spyOn(ConversationLoop.prototype, "initializeConversation")
      .mockImplementation(function (this: ConversationLoop) {
        temporarySessionId = this.sessionId;
        throw new Error("child initialization rejected");
      });
    try {
      const result = await makeRunner(new ToolRegistry()).spawn({
        title: "initialization failure",
        instructions: "prepare the child",
        toolScope: DENY_ALL_TOOL_SCOPE,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("child initialization rejected");
      expect(temporarySessionId).toBeTypeOf("string");
      expect(() => updateApprovalSurface({ kind: "move", previousSessionId: temporarySessionId!, sessionId: "replacement-child" }))
        .toThrow("approval-surface: unregistered outgoing session");
    } finally {
      initialize.mockRestore();
      if (temporarySessionId) updateApprovalSurface({ kind: "release", sessionId: temporarySessionId });
    }
  });
});

function createInMemoryMailboxNamespace() {
  let stored: unknown;
  let rejectNextWrite = false;
  return {
    handle: {
      dir: "memory",
      readJson: async (_name: string, fallback: unknown) =>
        structuredClone(stored === undefined ? fallback : stored),
      writeJson: async (_name: string, value: unknown) => {
        if (rejectNextWrite) {
          rejectNextWrite = false;
          throw new Error("mailbox-write-failed");
        }
        stored = structuredClone(value);
      },
      childDir: async (name: string) => name,
    } as never,
    rejectNextWrite: () => {
      rejectNextWrite = true;
    },
  };
}

describe("SubAgentRunner checkpoint child lifetime", () => {
  it.each([
    ["spawn", "finished"], ["spawn", "failed"], ["spawn", "cancelled"],
    ["resume", "finished"], ["resume", "failed"], ["resume", "cancelled"],
  ] as const)("keeps later parent turns unavailable during %s until the child is %s", async (entry, outcome) => {
    const root = await realpath(mkdtempSync(join(tmpdir(), "ave-runner-checkpoint-")));
    vi.stubEnv("AVE_HOME", join(root, "state"));
    const sessionId = "a1bdc27a-c758-4a74-8955-5e9188412366";
    const file = join(root, "t2.txt");
    const childFile = join(root, "child.txt");
    await writeFile(file, "original");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "read_item", description: "Read an item", source: "builtin", category: "read",
      jsonSchema: { type: "object", properties: {} }, execute: async () => ({ output: "value", isError: false }),
    }));
    const memory = new MemoryManager({ aveDir: join(root, "subagent") });
    const runner = new SubAgentRunner({ parentDeps: buildLoopDeps(registry), toolRegistry: registry, subAgentMemoryManager: memory });
    const hasProvider = vi.spyOn(ConversationLoop.prototype, "hasProvider").mockReturnValue(true);
    const refresh = vi.spyOn(ConversationLoop.prototype, "refreshProvider").mockImplementation(() => {});
    const loadSession = vi.spyOn(ConversationLoop.prototype, "loadSession").mockResolvedValue(true);
    const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn");
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    let editChild!: () => void;
    const editAllowed = new Promise<void>((resolve) => { editChild = resolve; });
    let edited!: () => void;
    const childEdited = new Promise<void>((resolve) => { edited = resolve; });
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => { finish = resolve; });
    let running: Promise<SubAgentSpawnResult> | undefined;
    const detached = new AsyncResource("checkpoint-child-dispatch");
    try {
      const input = { toolScope: PARENT_ALL_TOOL_SCOPE, title: "checkpoint child", instructions: "edit", originSessionId: sessionId, background: true };
      let resumeId: string | undefined;
      if (entry === "resume") {
        runTurn.mockResolvedValue({ text: "paused", toolCalls: [], route: "default", stopReason: "round-cap" });
        resumeId = (await runner.spawn(input)).childSessionId;
      }
      runTurn.mockImplementation(async () => {
        start();
        await editAllowed;
        await checkpointFileMutation([{ path: childFile, content: "child edit" }], () => writeFile(childFile, "child edit"));
        edited();
        await finishing;
        if (outcome === "failed") throw new Error("child failed");
        return { text: "done", toolCalls: [], route: "default", stopReason: "end_turn" };
      });
      await withCodeCheckpoint({ sessionId, messageId: "T1" }, async () => {
        const dispatch = () => entry === "spawn" ? runner.spawn(input) : runner.resume(resumeId!, "continue", input.title, undefined, sessionId, undefined, true);
        running = outcome === "finished" ? dispatch() : detached.runInAsyncScope(dispatch);
        await Promise.race([started, running.then(() => { throw new Error("Child ended before it started"); })]);
      });
      await withCodeCheckpoint({ sessionId, messageId: "T2" }, async () => {
        await checkpointFileMutation([{ path: file, content: "parent edit" }], () => writeFile(file, "parent edit"));
        editChild();
        await childEdited;
      });
      if (outcome === "cancelled") {
        const status = runner.listRunStatuses(sessionId).find((item) => item.status === "running")!;
        expect(runner.interruptRun(status.spawnId ?? status.childSessionId, sessionId)).toMatchObject({ ok: true });
      }
      expect(await restoreCodeCheckpoint(sessionId, "T2", { cwd: root, extraAllowedDirectories: [] }))
        .toEqual({ ok: false, error: "code-checkpoint-unavailable" });
      expect(await readFile(file, "utf8")).toBe("parent edit");
      expect(await readFile(childFile, "utf8")).toBe("child edit");
      finish();
      await running;
      const ledger = JSON.parse(await readFile(join(root, "state/code-checkpoints/turns.json"), "utf8"));
      expect(ledger.turns.find((item: { messageId: string }) => item.messageId === "T1").unavailable).toBe(true);
      expect(ledger.turns.find((item: { messageId: string }) => item.messageId === "T2").unavailable).toBe(true);
      await withCodeCheckpoint({ sessionId, messageId: "after" }, () =>
        checkpointFileMutation([{ path: file, content: "later" }], () => writeFile(file, "later")));
      expect(await restoreCodeCheckpoint(sessionId, "after", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
      expect(await readFile(file, "utf8")).toBe("parent edit");
    } finally {
      editChild();
      finish();
      await running;
      runTurn.mockRestore();
      loadSession.mockRestore();
      refresh.mockRestore();
      hasProvider.mockRestore();
      detached.emitDestroy();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("SubAgentRunner — authorization terminal propagation", () => {
  it("lifts a live child authorization terminal into the spawn result", async () => {
    const toolRegistry = new ToolRegistry();
    const execute = vi.fn(async () => ({ output: "unexpected execution", isError: false }));
    toolRegistry.register(createDynamicTool({
      name: "authorization_probe",
      description: "Authorization probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: {} },
      execute,
    }));
    const permissionDirectory = mkdtempSync(join(tmpdir(), "ave-subagent-auth-"));
    const permissionManager = new PermissionManager(
      join(permissionDirectory, "permissions.json"),
    );
    permissionManager.checkDetailed = () => ({
      decision: "ask",
      reason: "fixture requires local authorization",
      layer: 3,
      forceModal: true,
    });
    const provider = new ScriptedProvider([[
      { type: "tool_call", id: "child-auth", name: "authorization_probe", input: {} },
      { type: "message_complete", stopReason: "tool_use" },
    ]]);
    const runner = new SubAgentRunner({
      parentDeps: {
        ...buildLoopDeps(toolRegistry),
        permissionManager,
        approvalSurface: "unavailable",
      },
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);

    try {
      const result = await runner.spawn({
        title: "authorization child",
        instructions: "perform the protected action",
        toolScope: exactToolScope(["authorization_probe"]),
        maxRounds: 2,
        originSessionId: "8f0f47bf-c978-4a4b-948d-eb86cd8f9258",
      });

      expect(provider.turnsServed).toBe(1);
      expect(execute).not.toHaveBeenCalled();
      expect(result.stopReason).toBe("authorization-required");
      expect(authorizationRequiredStateForOutput(result.authorizationRequired)).toMatchObject({
        toolName: "authorization_probe",
        reason: "approval-surface-unavailable",
      });
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
      await cleanupTmpDir(permissionDirectory);
    }
  });
});

describe("SubAgentRunner — shared SkillOverlay teardown", () => {
  it("drops the finished child's read-skill entries and keeps the parent's", async () => {
    const overlay = new SkillOverlay();
    const parentSessionId = "8f0f47bf-c978-4a4b-948d-eb86cd8f9258";
    const skill = (name: string) => ({
      name,
      body: "",
      resources: [],
      filePath: `/skills/${name}/SKILL.md`,
    }) as unknown as LoadedSkill;
    overlay.register(parentSessionId, skill("parent-skill"));

    const childSessionIds: string[] = [];
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "overlay_probe",
      description: "Registers a skill read for the calling session",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (_input, ctx) => {
        const sessionId = ctx.metadata?.sessionId;
        if (typeof sessionId !== "string" || !sessionId) {
          return { output: "no session", isError: true };
        }
        childSessionIds.push(sessionId);
        overlay.register(sessionId, skill("child-skill"));
        return { output: "registered", isError: false };
      },
    }));
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", id: "probe-1", name: "overlay_probe", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      ...endTurnScript("done"),
    ]);
    const permissionDirectory = mkdtempSync(join(tmpdir(), "ave-overlay-permissions-"));
    const runner = new SubAgentRunner({
      parentDeps: {
        ...buildLoopDeps(toolRegistry),
        permissionManager: new PermissionManager(join(permissionDirectory, "permissions.json")),
        skillOverlay: overlay,
      },
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);

    try {
      const result = await runner.spawn({
        title: "overlay child",
        instructions: "load a skill",
        toolScope: exactToolScope(["overlay_probe"]),
        maxRounds: 3,
        originSessionId: parentSessionId,
      });

      expect(result.ok).toBe(true);
      expect(childSessionIds).toHaveLength(1);
      const [childSessionId] = childSessionIds;
      expect(childSessionId).not.toBe(parentSessionId);
      expect(overlay.list(childSessionId)).toEqual([]);
      expect(overlay.list(parentSessionId).map((entry) => entry.name)).toEqual(["parent-skill"]);
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
      await cleanupTmpDir(permissionDirectory);
    }
  });
});

describe("SubAgentRunner — maxRounds bound", () => {
  it("terminates after the host-assigned `maxRounds` budget even if provider keeps emitting tool calls, and flags the cut-off run incomplete", async () => {
    const toolRegistry = new ToolRegistry();
    const execSpy = vi.fn(async () => ({ output: "ok", isError: false }));
    toolRegistry.register(
      createDynamicTool({
        name: "noop",
        description: "no-op tool",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: execSpy,
      }),
    );

    const provider = new ScriptedProvider(
      Array.from({ length: 5 }).map((_, i) => [
        { type: "text_delta", text: `round-${i}` },
            { type: "tool_call", id: `tu-${i}`, name: "noop", input: {} },
            { type: "message_complete", stopReason: "tool_use" },
          ] as StreamEvent[],
      ),
    );

    const permissionDirectory = mkdtempSync(join(tmpdir(), "ave-budget-permissions-"));
    const parentDeps = buildLoopDeps(toolRegistry, {
      permissionManager: new PermissionManager(join(permissionDirectory, "permissions.json")),
    });
    const parentLoop = new ConversationLoop(parentDeps);
    (parentLoop as { provider: LLMProvider | null }).provider = provider;

    const runner = new SubAgentRunner({ parentDeps, toolRegistry, subAgentMemoryManager: fakeSubAgentMemoryManager() });
    // Patch child loops too because each spawn constructs a fresh loop.
    const origConstructor = ConversationLoop.prototype as unknown as {
      hasProvider: () => boolean;
    };
    const hasProviderSpy = vi
      .spyOn(origConstructor, "hasProvider")
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
        "refreshProvider",
      )
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });

    try {
      const result = await runner.spawn({
        title: "test",
        instructions: "do",
        toolScope: exactToolScope(["noop"]),
        maxRounds: 2,
        originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
      });
      // Require the full budget, not just an upper bound that would admit premature termination.
      expect(result.turnCount).toBe(2);
      expect(result.toolCallCount).toBeLessThanOrEqual(2 * 10);
      expect(execSpy).toHaveBeenCalledTimes(2);
      // Round-capped work is successful but incomplete, allowing the parent to resume it.
      expect(result.ok).toBe(true);
      expect(result.incomplete).toBe(true);
      expect(result.stopReason).toBe("round-cap");
      expect(result.suspension).toEqual({
        reason: "budget",
        prompt:
          "Send any message to continue, or treat the partial result as done.",
        resumeId: result.childSessionId,
      });
      expect(
        runner.getRunStatus(result.childSessionId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        status: "waiting",
        suspension: result.suspension,
      });
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
      await cleanupTmpDir(permissionDirectory);
    }
  });

  it("does NOT flag a clean end_turn completion as incomplete", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "final answer" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const runner = makeRunner(toolRegistry);
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);
    try {
      const result = await runner.spawn({
        toolScope: PARENT_ALL_TOOL_SCOPE,
        title: "clean",
        instructions: "do",
        maxRounds: 5,
      });
      expect(result.ok).toBe(true);
      expect(result.stopReason).toBe("end_turn");
      expect(result.incomplete).toBeFalsy();
      expect(result.suspension).toBeUndefined();
      expect(result.summary).toContain("final answer");
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });

  it("inherits a subscription provider factory for child execution", async () => {
    const toolRegistry = new ToolRegistry();
    const subscriptionProviderFactory = vi.fn((selection: SubscriptionChatRuntimeSelection) => new class extends ScriptedProvider {
      readonly subscriptionRuntime = selection;
    }([
      [
        { type: "text_delta", text: "subscription child completed" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]));
    // An ID absent from the API-key catalog must still reach the live subscription catalog.
    const profileModel = "codex-live-only-test-model";
    const configuredSettings = {
      ...fakeLlmSettings(),
      activeChatRuntime: SUBSCRIPTION_SELECTION,
    };
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      settingsService: {
        get: () => configuredSettings,
        getSecret: () => "test-key",
      },
      subscriptionProviderFactory,
    } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["parentDeps"];
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });

    const result = await runner.spawn({
      toolScope: PARENT_ALL_TOOL_SCOPE,
      title: "subscription child",
      instructions: "finish the task",
      maxRounds: 2,
      profileModel,
    });

    expect(subscriptionProviderFactory).toHaveBeenCalledWith(
      {
        ...SUBSCRIPTION_SELECTION,
        model: profileModel,
      },
      SUBSCRIPTION_SELECTION,
    );
    expect(result).toMatchObject({
      ok: true,
      summary: expect.stringContaining("subscription child completed"),
      stopReason: "end_turn",
    });
  });

  it("runs the Settings-configured round budget unclamped — 500 reaches the child loop", async () => {
    const toolRegistry = new ToolRegistry();
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      settingsService: {
        get: (key: string) =>
          key === "chat" ? { subAgentMaxRounds: 500 } : fakeLlmSettings(),
        getSecret: () => "test-key",
      },
    } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["parentDeps"];
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue({
        text: "done",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      });
    try {
      await runner.spawn({ toolScope: PARENT_ALL_TOOL_SCOPE, title: "budget", instructions: "do" });
      const options = runTurnSpy.mock.calls[0]?.[3] as { maxRounds?: number } | undefined;
      expect(options?.maxRounds).toBe(500);
    } finally {
      runTurnSpy.mockRestore();
      hasProviderSpy.mockRestore();
    }
  });

  it("floors a nonsense configured budget at 1 instead of refusing to run", async () => {
    const toolRegistry = new ToolRegistry();
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      settingsService: {
        get: (key: string) =>
          key === "chat" ? { subAgentMaxRounds: 0 } : fakeLlmSettings(),
        getSecret: () => "test-key",
      },
    } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["parentDeps"];
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue({
        text: "done",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      });
    try {
      await runner.spawn({ toolScope: PARENT_ALL_TOOL_SCOPE, title: "floor", instructions: "do" });
      const options = runTurnSpy.mock.calls[0]?.[3] as { maxRounds?: number } | undefined;
      expect(options?.maxRounds).toBe(1);
    } finally {
      runTurnSpy.mockRestore();
      hasProviderSpy.mockRestore();
    }
  });
});

describe("SubAgentRunner — provider-status activity", () => {
  it("publishes a retry status snapshot before the child completes its answer", async () => {
    const toolRegistry = new ToolRegistry();
    const runner = makeRunner(toolRegistry);
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(async (_prompt, callbacks) => {
        callbacks?.onLlmStatus?.({ phase: "retry", attempt: 2, maxAttempts: 5 });
        callbacks?.onAssistantRound?.({
          roundIndex: 1,
          thought: "",
          text: "recovered child answer",
          stopReason: "end_turn",
          hasToolCalls: false,
          messageId: "status-child-answer",
        });
        return {
          text: "recovered child answer",
          toolCalls: [],
          route: "default",
          stopReason: "end_turn",
        };
      });
    const onActivity = vi.fn();

    try {
      const result = await runner.spawn(
        {
          toolScope: PARENT_ALL_TOOL_SCOPE,
          title: "status child",
          instructions: "recover",
        },
        { onActivity },
      );

      expect(result.ok).toBe(true);
      const snapshots = onActivity.mock.calls.map(([update]) => update.entries);
      expect(snapshots).toContainEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", phase: "status", streaming: true }),
      ]));
      expect(snapshots.at(-1)).toEqual([
        expect.objectContaining({
          kind: "assistant",
          text: "recovered child answer",
          streaming: false,
        }),
      ]);
    } finally {
      runTurnSpy.mockRestore();
      hasProviderSpy.mockRestore();
    }
  });

  it("clears a status-only retry before an errored child result is published", async () => {
    const toolRegistry = new ToolRegistry();
    const runner = makeRunner(toolRegistry);
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(async (_prompt, callbacks) => {
        callbacks?.onLlmStatus?.({ phase: "retry", attempt: 2, maxAttempts: 5 });
        throw new Error("child failed before producing output");
      });
    const onActivity = vi.fn();

    try {
      const result = await runner.spawn(
        {
          toolScope: PARENT_ALL_TOOL_SCOPE,
          title: "status-only error",
          instructions: "recover",
        },
        { onActivity },
      );

      expect(result.ok).toBe(false);
      expect(result.entries).toEqual([]);
      expect(onActivity.mock.calls.at(-1)?.[0].entries).toEqual([]);
    } finally {
      runTurnSpy.mockRestore();
      hasProviderSpy.mockRestore();
    }
  });
});

describe("SubAgentRunner — cross-agent DLP boundary", () => {
  it("masks a child success across returned, tracked, and activity callback surfaces", async () => {
    const secret = "ghp_" + "s".repeat(24);
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "completed with " + secret },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const toolRegistry = new ToolRegistry();
    const runner = makeRunner(toolRegistry);
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);
    const onActivity = vi.fn();

    try {
      const result = await runner.spawn(
        {
          toolScope: PARENT_ALL_TOOL_SCOPE,
          title: "dlp-success",
          instructions: "finish",
          originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        },
        { onActivity },
      );
      const snapshot = runner.getRunStatus(
        result.childSessionId,
        "a1bdc27a-c758-4a74-8955-5e9188412366",
      );

      for (const surface of [result, snapshot, onActivity.mock.calls]) {
        const serialized = JSON.stringify(surface);
        expect(serialized).not.toContain(secret);
        expect(serialized).toContain("[REDACTED:TOKEN]");
      }
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });

  it("masks a child failure across returned, tracked, and error callback surfaces", async () => {
    const secret = "ghp_" + "e".repeat(24);
    const toolRegistry = new ToolRegistry();
    const runner = makeRunner(toolRegistry);
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockRejectedValue(new Error("provider exposed " + secret));
    const onError = vi.fn();

    try {
      const result = await runner.spawn(
        {
          toolScope: PARENT_ALL_TOOL_SCOPE,
          title: "dlp-error",
          instructions: "fail",
          originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        },
        { onError },
      );
      const snapshot = runner.getRunStatus(
        result.childSessionId,
        "a1bdc27a-c758-4a74-8955-5e9188412366",
      );

      expect(result.ok).toBe(false);
      for (const surface of [result, snapshot, onError.mock.calls]) {
        const serialized = JSON.stringify(surface);
        expect(serialized).not.toContain(secret);
        expect(serialized).toContain("[REDACTED:TOKEN]");
      }
    } finally {
      hasProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
    }
  });
});
describe("SubAgentRunner — projected terminal status", () => {
  it("projects a structurally returned blocked turn as rejected/error", async () => {
    const toolRegistry = new ToolRegistry();
    const saveSessionMetadata = vi.fn(async () => undefined);
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: {
        ...fakeSubAgentMemoryManager(),
        saveSessionMetadata,
      },
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
        "refreshProvider",
      )
      .mockImplementation(() => undefined);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue({
        text: "prompt refused",
        toolCalls: [],
        route: "default",
        stopReason: "blocked",
      });

    try {
      const result = await runner.spawn({
        toolScope: PARENT_ALL_TOOL_SCOPE,
        title: "blocked",
        instructions: "attempt work",
        originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
      });

      expect(result).toMatchObject({
        ok: false,
        error: "prompt refused",
        stopReason: "blocked",
        summary: "prompt refused",
      });
      expect(
        runner.getRunStatus(result.childSessionId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        status: "error",
        taskState: "TASK_STATE_REJECTED",
        error: "prompt refused",
      });
      expect(saveSessionMetadata).toHaveBeenCalledTimes(2);
      expect(saveSessionMetadata.mock.calls[1]?.[1]).toMatchObject({
        cumulativeRounds: 0,
        subAgentTaskState: "TASK_STATE_REJECTED",
        subAgentSuspensionReason: undefined,
      });
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
    }
  });

  it.each(["stream-error", "context-error", "max_tokens", "tool_use"] as const)(
    "projects a non-completing %s turn as failed/error and commits zero-round metadata",
    async (stopReason) => {
      const toolRegistry = new ToolRegistry();
      const saveSessionMetadata = vi.fn(async () => undefined);
      const runner = new SubAgentRunner({
        parentDeps: buildLoopDeps(toolRegistry),
        toolRegistry,
        subAgentMemoryManager: {
          ...fakeSubAgentMemoryManager(),
          saveSessionMetadata,
        },
      });
      const hasProviderSpy = vi
        .spyOn(
          ConversationLoop.prototype as unknown as {
            hasProvider: () => boolean;
          },
          "hasProvider",
        )
        .mockReturnValue(true);
      const refreshProviderSpy = vi
        .spyOn(
          ConversationLoop.prototype as unknown as {
            refreshProvider: () => void;
          },
          "refreshProvider",
        )
        .mockImplementation(() => undefined);
      const runTurnSpy = vi
        .spyOn(ConversationLoop.prototype, "runTurn")
        .mockResolvedValue({
          text: "",
          toolCalls: [],
          route: "default",
          stopReason,
        });

      try {
        const result = await runner.spawn({
          toolScope: PARENT_ALL_TOOL_SCOPE,
          title: `non-completing-${stopReason}`,
          instructions: "attempt work",
          originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        });

        expect(result).toMatchObject({
          ok: false,
          error: `sub-agent run stopped with ${stopReason}`,
          stopReason,
          turnCount: 0,
        });
        expect(
          runner.getRunStatus(result.childSessionId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
        ).toMatchObject({
          status: "error",
          taskState: "TASK_STATE_FAILED",
          error: `sub-agent run stopped with ${stopReason}`,
        });
        expect(saveSessionMetadata).toHaveBeenCalledTimes(2);
        expect(saveSessionMetadata.mock.calls[1]?.[1]).toMatchObject({
          cumulativeRounds: 0,
          subAgentTaskState: "TASK_STATE_FAILED",
          subAgentSuspensionReason: undefined,
        });
      } finally {
        hasProviderSpy.mockRestore();
        refreshProviderSpy.mockRestore();
        runTurnSpy.mockRestore();
      }
    },
  );
  it("keeps cancellation terminal when the pending initial metadata save rejects", async () => {
    let rejectMetadata!: (error: Error) => void;
    const saveSessionMetadata = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectMetadata = reject;
        }),
    );
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "canceled-message",
    }));
    const toolRegistry = new ToolRegistry();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: {
        ...fakeSubAgentMemoryManager(),
        saveSessionMetadata,
      },
      messageBus: { deliverToParent } as never,
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue({
        text: "must not run",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      });
    let capturedResult: SubAgentSpawnResult | undefined;
    const originalSpawn = runner.spawn.bind(runner);
    const spawnSpy = vi
      .spyOn(runner, "spawn")
      .mockImplementation(async (input, callbacks) => {
        capturedResult = await originalSpawn(input, callbacks);
        return capturedResult;
      });
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: (event) => events.push(event),
    });

    try {
      const handleResult = await tool.execute(
        {
          title: "cancel-before-working",
          instructions: "do not start",
          background: true,
        },
        {
          cwd: process.cwd(),
          extraAllowedDirectories: [],
          metadata: {
            sessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
            spawnDepth: 0,
            supportsA2AParentDelivery: true,
          },
        },
      );
      const handle = JSON.parse(handleResult.output);
      expect(handle.childSessionId).toBeTruthy();
      expect(
        runner.getRunStatus(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        taskState: "TASK_STATE_SUBMITTED",
        status: "running",
      });

      expect(
        runner.interruptRun(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        ok: true,
        run: { taskState: "TASK_STATE_CANCELED", status: "interrupted" },
      });
      rejectMetadata(new Error("initial metadata write failed"));

      const deadline = Date.now() + 4000;
      while (deliverToParent.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(capturedResult).toMatchObject({
        childSessionId: handle.childSessionId,
        ok: false,
        stopReason: "interrupted",
        error: "sub-agent run interrupted",
      });
      expect(runTurnSpy).not.toHaveBeenCalled();
      const terminalEvents = events.filter(
        (event) => event.type === "done" || event.type === "error",
      );
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "done",
        taskState: "TASK_STATE_CANCELED",
        status: "interrupted",
        childSessionId: handle.childSessionId,
      });
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(deliverToParent).toHaveBeenCalledTimes(1);
      expect(deliverToParent.mock.calls[0]![0]).toMatchObject({
        parentSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        childSessionId: handle.childSessionId,
        message: expect.objectContaining({
          taskId: handle.childSessionId,
          metadata: expect.objectContaining({
            taskState: "TASK_STATE_CANCELED",
          }),
        }),
      });
      expect(
        runner.getRunStatus(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        taskState: "TASK_STATE_CANCELED",
        status: "interrupted",
        stopReason: "interrupted",
      });
      expect(
        runner.interruptRun(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        ok: false,
        run: { taskState: "TASK_STATE_CANCELED", status: "interrupted" },
      });
    } finally {
      hasProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it("terminalizes a successful turn as FAILED when its final metadata save rejects", async () => {
    let saveCount = 0;
    let rejectFinalMetadata!: (error: Error) => void;
    const saveSessionMetadata = vi.fn(() => {
      saveCount += 1;
      if (saveCount === 1) return Promise.resolve();
      return new Promise<void>((_resolve, reject) => {
        rejectFinalMetadata = reject;
      });
    });
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "failed-final-save-message",
    }));
    const toolRegistry = new ToolRegistry();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: {
        ...fakeSubAgentMemoryManager(),
        saveSessionMetadata,
      },
      messageBus: { deliverToParent } as never,
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(async (_prompt, callbacks) => {
        callbacks?.onAssistantRound?.({
          thought: "",
          text: "completed but not durable",
        });
        return {
          text: "completed but not durable",
          toolCalls: [],
          route: "default",
          stopReason: "end_turn",
        };
      });
    let capturedResult: SubAgentSpawnResult | undefined;
    const originalSpawn = runner.spawn.bind(runner);
    const spawnSpy = vi
      .spyOn(runner, "spawn")
      .mockImplementation(async (input, callbacks) => {
        capturedResult = await originalSpawn(input, callbacks);
        return capturedResult;
      });
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: (event) => events.push(event),
    });

    try {
      const handleResult = await tool.execute(
        { title: "final-save", instructions: "complete", background: true },
        {
          cwd: process.cwd(),
          extraAllowedDirectories: [],
          metadata: {
            sessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
            spawnDepth: 0,
            supportsA2AParentDelivery: true,
          },
        },
      );
      const handle = JSON.parse(handleResult.output);
      const saveDeadline = Date.now() + 4000;
      while (
        saveSessionMetadata.mock.calls.length < 2 &&
        Date.now() < saveDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(saveSessionMetadata).toHaveBeenCalledTimes(2);
      expect(
        runner.getRunStatus(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        taskState: "TASK_STATE_WORKING",
        status: "running",
      });
      expect(
        runner.interruptRun(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        ok: false,
        run: { taskState: "TASK_STATE_WORKING", status: "running" },
      });

      rejectFinalMetadata(new Error("final metadata write failed"));
      const deliveryDeadline = Date.now() + 4000;
      while (
        deliverToParent.mock.calls.length === 0 &&
        Date.now() < deliveryDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(capturedResult).toMatchObject({
        childSessionId: handle.childSessionId,
        ok: false,
        error: "final metadata write failed",
      });
      const terminalEvents = events.filter(
        (event) => event.type === "done" || event.type === "error",
      );
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "error",
        taskState: "TASK_STATE_FAILED",
        status: "error",
        message: "final metadata write failed",
        childSessionId: handle.childSessionId,
      });
      expect(deliverToParent).toHaveBeenCalledTimes(1);
      expect(deliverToParent.mock.calls[0]![0]).toMatchObject({
        parentSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        childSessionId: handle.childSessionId,
        message: expect.objectContaining({
          taskId: handle.childSessionId,
          metadata: expect.objectContaining({ taskState: "TASK_STATE_FAILED" }),
        }),
      });
      expect(
        runner.getRunStatus(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        taskState: "TASK_STATE_FAILED",
        status: "error",
        error: "final metadata write failed",
      });
      expect(
        runner.interruptRun(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        ok: false,
        run: { taskState: "TASK_STATE_FAILED", status: "error" },
      });
    } finally {
      hasProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });
  it("keeps a pre-loop setup failure pollable and delivers one linked background failure", async () => {
    const toolRegistry = new ToolRegistry();
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "setup-failure-message",
    }));
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
      messageBus: { deliverToParent } as never,
    });
    const setupSpy = vi
      .spyOn(toolRegistry, "createScopedView")
      .mockImplementation(() => {
        throw new Error("child setup failed");
      });
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: (event) => events.push(event),
    });

    try {
      const handleResult = await tool.execute(
        { title: "setup-failure", instructions: "start", background: true },
        {
          cwd: process.cwd(),
          extraAllowedDirectories: [],
          metadata: {
            sessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
            spawnDepth: 0,
            supportsA2AParentDelivery: true,
          },
        },
      );
      const handle = JSON.parse(handleResult.output);
      expect(handleResult.isError).toBe(false);
      expect(handle.childSessionId).toBeTruthy();
      expect(handle).toMatchObject({
        status: "error",
        taskState: "TASK_STATE_FAILED",
      });
      expect(
        runner.getRunStatus(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        childSessionId: handle.childSessionId,
        status: "error",
        taskState: "TASK_STATE_FAILED",
        error: "child setup failed",
      });

      await vi.waitFor(() => expect(deliverToParent).toHaveBeenCalledTimes(1));
      const terminalEvents = events.filter(
        (event) => event.type === "done" || event.type === "error",
      );
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "error",
        taskState: "TASK_STATE_FAILED",
        childSessionId: handle.childSessionId,
        message: "child setup failed",
      });
      expect(deliverToParent.mock.calls[0]?.[0]).toMatchObject({
        parentSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        childSessionId: handle.childSessionId,
        message: expect.objectContaining({
          taskId: handle.childSessionId,
          metadata: expect.objectContaining({ taskState: "TASK_STATE_FAILED" }),
        }),
      });
    } finally {
      setupSpy.mockRestore();
    }
  });
});
describe("SubAgentToolScope — one meaning per value", () => {
  // Parent scope, deliberate empty scope, and corrupt frozen scope must stay distinct grants.
  it("refuses to build an `exactly` scope with no names", () => {
    expect(() => exactToolScope([])).toThrow(/at least one tool name/i);
  });

  it("names exactly what it was given, and copies rather than aliases", () => {
    const requested = ["read_file", "grep_files"];
    const scope = exactToolScope(requested);
    expect(scope).toEqual({ kind: "exactly", names: ["read_file", "grep_files"] });
    requested.push("write_file");
    expect(scope.kind === "exactly" && scope.names).toEqual(["read_file", "grep_files"]);
  });

  it("round-trips a persistable scope through the codec pair", () => {
    const scope = exactToolScope(["noop"]);
    expect(toPersistedToolScope(scope)).toEqual(["noop"]);
    expect(fromPersistedToolScope(toPersistedToolScope(scope), false)).toEqual(scope);
    expect(toPersistedToolScope(DENY_ALL_TOOL_SCOPE)).toEqual([]);
  });

  it("decodes an absent record as unreadable, whoever is asking", () => {
    expect(fromPersistedToolScope(undefined, false)).toBeNull();
    expect(fromPersistedToolScope(undefined, true)).toBeNull();
  });

  it("decodes an EMPTY record as deny-all only for a wire-bound task", () => {
    // Only the wire path may freeze an empty grant; no empty decode may widen to parent tools.
    expect(fromPersistedToolScope([], true)).toEqual(DENY_ALL_TOOL_SCOPE);
    expect(fromPersistedToolScope([], false)).toBeNull();
  });
});

describe("SubAgentRunner — what each tool scope grants", () => {
  function scopeProbeRegistry(): ToolRegistry {
    const toolRegistry = new ToolRegistry();
    for (const [name, category] of [
      ["read_file", "read"],
      ["run_shell", "shell"],
      ["agent_spawn", "meta"],
    ] as const) {
      toolRegistry.register(
        createDynamicTool({
          name,
          description: name,
          source: "builtin",
          category,
          ...(category === "meta" ? { decisionOverride: "ask" as const } : {}),
          jsonSchema: { type: "object", properties: {} },
          execute: async () => ({ output: name, isError: false }),
        }),
      );
    }
    return toolRegistry;
  }

  async function advertisedToolNames(toolScope: SubAgentToolScope): Promise<string[]> {
    const toolRegistry = scopeProbeRegistry();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const runner = makeRunner(toolRegistry);
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { refreshProvider: () => void },
        "refreshProvider",
      )
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });
    try {
      await runner.spawn({ title: "scope probe", instructions: "probe", toolScope, maxRounds: 1 });
      return provider.observedToolNames[0] ?? [];
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  }

  it("grants the whole parent registry minus the blocklist for `parent-all`", async () => {
    const advertised = await advertisedToolNames(PARENT_ALL_TOOL_SCOPE);
    expect(advertised).toEqual(expect.arrayContaining(["read_file", "run_shell"]));
    expect(advertised).not.toContain("agent_spawn");
  });

  it("grants exactly the named tools for `exactly`", async () => {
    const advertised = await advertisedToolNames(exactToolScope(["read_file"]));
    expect(advertised).toEqual(["read_file"]);
  });

  it("grants no source tool at all for `deny-all`", async () => {
    // A tool-less wire profile must grant nothing rather than the parent registry.
    expect(await advertisedToolNames(DENY_ALL_TOOL_SCOPE)).toEqual([]);
  });
});

describe("SubAgentRunner — sourceTools allowlist", () => {
  it("filters tools so a not-listed tool is unavailable to the LLM", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      createDynamicTool({
        name: "bash",
        description: "shell",
        source: "builtin",
        category: "shell",
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "bash-out", isError: false }),
      }),
    );
    toolRegistry.register(
      createDynamicTool({
        name: "read_file",
        description: "read",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "file-contents", isError: false }),
      }),
    );

    const runner = makeRunner(toolRegistry);

    const scoped = toolRegistry.createScopedView(["bash"]);
    expect(scoped.findByName("bash")).toBeDefined();
    expect(scoped.findByName("read_file")).toBeUndefined();
    void runner;
  });

  it("keeps allowlisted plugin tools visible to the child LLM schema", async () => {
    const toolRegistry = new ToolRegistry();
    const execSpy = vi.fn(async () => ({ output: "schedule", isError: false }));
    const scheduleToolName = "plugin_today_team_schedule";
    toolRegistry.register(
      createDynamicTool({
        name: scheduleToolName,
        description: "team schedule",
        source: "plugin",
        pluginId: "sample-plugin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: execSpy,
      }),
    );
    toolRegistry.register(
      createDynamicTool({
        name: "other_plugin_tool",
        description: "other",
        source: "plugin",
        pluginId: "other-plugin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "other", isError: false }),
      }),
    );

    const provider = new ScriptedProvider([
      [
        { type: "tool_call", id: "tu-1", name: scheduleToolName, input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const permissionDirectory = mkdtempSync(join(tmpdir(), "ave-plugin-scope-permissions-"));
    const contents = makeMockWebContents();
    const approvalGate = new ApprovalGate(contents as never);
    const requestAndWait = vi.spyOn(approvalGate, "requestAndWait");
    contents.send.mockImplementation((channel: string, request: ApprovalRequest) => {
      if (channel !== IPC_APPROVAL_REQUEST) return;
      queueMicrotask(() => approvalGate.resolveFromDesktopRenderer(request.id, {
        requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac,
      }, contents as never));
    });
    const parentDeps = buildLoopDeps(toolRegistry, {
      approvalGate,
      permissionManager: new PermissionManager(join(permissionDirectory, "permissions.json")),
    });
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);

    try {
      await runner.spawn({
        title: "team schedule",
        instructions: "오늘 팀 스케줄 조회",
        toolScope: exactToolScope([scheduleToolName]),
        maxRounds: 2,
      });

      expect(provider.observedToolNames[0]).toEqual([scheduleToolName]);
      expect(provider.observedToolNames[0]).not.toContain("other_plugin_tool");
      expect(execSpy).toHaveBeenCalledOnce();
      expect(requestAndWait).toHaveBeenCalledOnce();
      expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ toolName: scheduleToolName, source: "plugin", toolCategory: "write" }));
    } finally {
      approvalGate.disposeAll();
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
      await cleanupTmpDir(permissionDirectory);
    }
  });

  it("does not ADVERTISE a plugin the child cannot call (prompt scope == registry scope)", async () => {
    // Advertised plugin tools must be bounded by the same scoped registry as execution.
    const toolRegistry = new ToolRegistry();
    const pluginTools: Array<[string, string]> = [
      [CARD_FIXTURE_IN_SCOPE_PLUGIN, CARD_FIXTURE_IN_SCOPE_TOOL],
      ...CARD_FIXTURE_OUT_OF_SCOPE_TOOLS.map(
        (name) => [CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN, name] as [string, string],
      ),
    ];
    for (const [pluginId, name] of pluginTools) {
      toolRegistry.register(
        createDynamicTool({
          name,
          description: `${name} description`,
          source: "plugin",
          pluginId,
          category: "read",
          isReadOnly: () => true,
          jsonSchema: { type: "object", properties: {} },
          execute: async () => ({ output: "ok", isError: false }),
        }),
      );
    }

    const provider = new ScriptedProvider([[
      { type: "text_delta", text: "done" },
      { type: "message_complete", stopReason: "end_turn" },
    ]]);
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      systemPromptBuilder: createSystemPromptBuilder({
        memoryManager: makePromptMemorySource(),
        toolRegistry,
        pluginRuntime: pluginCardRuntimeFixture(process.cwd()),
      }),
    } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["parentDeps"];
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);

    try {
      await runner.spawn({
        title: "scoped child",
        instructions: "summarize",
        toolScope: exactToolScope([CARD_FIXTURE_IN_SCOPE_TOOL]),
        maxRounds: 1,
      });

      const childPrompt = provider.observedSystemPrompts[0] ?? "";
      expect(provider.observedToolNames[0]).toEqual([CARD_FIXTURE_IN_SCOPE_TOOL]);
      expect(childPrompt).not.toContain(CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN);
      for (const name of CARD_FIXTURE_OUT_OF_SCOPE_TOOLS) {
        expect(childPrompt).not.toContain(name);
      }
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });

  it("strips memory_write and memory_delete even when they are explicitly allowlisted", async () => {
    const toolRegistry = new ToolRegistry();
    for (const tool of [
      ...["memory_write", "memory_delete"].map((name) => createDynamicTool({
        name,
        description: "persistent write",
        source: "builtin",
        category: "write",
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "would-change-memory", isError: false }),
      })),
      createDynamicTool({
        name: "noop",
        description: "safe",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "ok", isError: false }),
      }),
    ]) toolRegistry.register(tool);
    const provider = new ScriptedProvider([[
      { type: "text_delta", text: "done" },
      { type: "message_complete", stopReason: "end_turn" },
    ]]);
    const runner = makeRunner(toolRegistry);
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);

    try {
      await runner.spawn({
        title: "read only subagent",
        instructions: "summarize",
        toolScope: exactToolScope(["memory_write", "memory_delete", "noop"]),
        maxRounds: 1,
      });

      expect(provider.observedToolNames[0]).toEqual(["noop"]);
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });

  it("does not execute an inactive plugin's tool even when allowlisted via sourceTools", async () => {
    // Scoped views share gated adapters; disabled plugin tools must still fail closed at execution.
    const toolRegistry = new ToolRegistry();
    const runtimeCall = vi.fn(async () => ({ items: ["secret"] }));
    const fakeRuntime = {
      isPluginEnabled: () => false,
      call: runtimeCall,
    } as unknown as PluginRuntime;
    const toolName = "index_scan";
    for (const tool of buildPluginToolsForTest(fakeRuntime, "local-indexer", {
      id: "local-indexer",
      name: "indexer",
      version: "1.0.0",
      main: "x.js",
      tools: [
        {
          name: toolName,
          description: "scan the index",
          inputSchema: {
            type: "object",
            properties: { q: { type: "string" } },
          },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    } as unknown as PluginManifest)) {
      toolRegistry.register(tool);
    }

    const provider = new ScriptedProvider([
      [
        { type: "tool_call", id: "tu-1", name: toolName, input: { q: "x" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const runner = makeRunner(toolRegistry);
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);

    try {
      await runner.spawn({
        title: "indexer",
        instructions: "scan",
        toolScope: exactToolScope([toolName]),
        maxRounds: 2,
      });

      expect(provider.observedToolNames[0]).toContain(toolName);
      expect(runtimeCall).not.toHaveBeenCalled();
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });
});

describe("SubAgentRunner — the child's agent context", () => {
  it("composes the sub-agent store's agents.custom.md after its AGENTS.md", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new ScriptedProvider([[
      { type: "text_delta", text: "done" },
      { type: "message_complete", stopReason: "end_turn" },
    ]]);
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      systemPromptBuilder: createSystemPromptBuilder({
        memoryManager: makePromptMemorySource({
          getAgentsMd: () => "PARENT packaged reference",
          getAgentsCustomMd: () => "PARENT own rules",
        }),
        toolRegistry,
        pluginRuntime: pluginCardRuntimeFixture(process.cwd()),
      }),
    } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["parentDeps"];
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager({
        getAgentsMd: () => "CHILD packaged reference",
        getAgentsCustomMd: () => "CHILD own rules",
      }),
    });
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);

    try {
      await runner.spawn({ toolScope: PARENT_ALL_TOOL_SCOPE, title: "child", instructions: "summarize", maxRounds: 1 });

      const childPrompt = provider.observedSystemPrompts[0] ?? "";
      expect(childPrompt).toContain("<ave-agents-custom-context>");
      expect(childPrompt).toContain("CHILD packaged reference");
      // Put the user-owned prompt half last so it wins conflicts.
      expect(childPrompt.indexOf("CHILD packaged reference"))
        .toBeLessThan(childPrompt.indexOf("CHILD own rules"));
      // Both prompt halves must come from the child store, never the parent store.
      expect(childPrompt).not.toContain("PARENT packaged reference");
      expect(childPrompt).not.toContain("PARENT own rules");
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });
});

describe("agent_spawn — recursive call refusal", () => {
  it("returns an error when invoked from a sub-agent (spawnDepth >= 1)", async () => {
    const tool = createAgentSpawnTool({
      getRunner: () => ({ spawn: async () => ({}) }) as never,
      emit: () => undefined,
    });
    const ctxAsSubAgent = {
      cwd: process.cwd(),
      metadata: { sessionId: "1ae80cfb-d8c8-4a02-806d-4f4d2872a62d", spawnDepth: 1 },
      extraAllowedDirectories: [],
    };
    const r = await tool.execute(
      { title: "nested", instructions: "go deeper" },
      ctxAsSubAgent,
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.output);
    expect(parsed.error).toContain("cannot be invoked from a sub-agent");
  });

  it("allows agent_spawn from the parent loop (spawnDepth=0)", async () => {
    const tool = createAgentSpawnTool({
      getRunner: () =>
        ({
          spawn: async () => ({
            summary: "ok",
            toolCallCount: 0,
            turnCount: 1,
            childSessionId: "2e7d2c03-a950-4ae2-85ec-f5b5356885a5",
            entries: [],
            ok: true,
          }),
        }) as never,
      emit: () => undefined,
    });
    const ctxAsParent = {
      cwd: process.cwd(),
      metadata: { sessionId: "e4712596-8b3b-4104-8fbc-4802d1e40a71", spawnDepth: 0 },
      extraAllowedDirectories: [],
    };
    const r = await tool.execute(
      { title: "child", instructions: "do" },
      ctxAsParent,
    );
    expect(r.isError).toBe(false);
  });
});

describe("SubAgentRunner — agent_spawn always stripped", () => {
  it("strips agent_spawn from the child registry even when sourceTools includes it", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      createDynamicTool({
        name: "agent_spawn",
        description: "spawn",
        source: "builtin",
        category: "meta",
        decisionOverride: "ask",
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "would-spawn", isError: false }),
      }),
    );
    toolRegistry.register(
      createDynamicTool({
        name: "noop",
        description: "no-op",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "ok", isError: false }),
      }),
    );

    const scopedFromAllowlist = toolRegistry.createScopedView(
      ["agent_spawn", "noop"].filter((n) => n !== "agent_spawn"),
    );
    expect(scopedFromAllowlist.findByName("agent_spawn")).toBeUndefined();
    expect(scopedFromAllowlist.findByName("noop")).toBeDefined();
  });
});

describe("resolveSubAgentModel — #1112 complexity resolution", () => {
  const NO_LIVE_MODELS: readonly string[] = [];

  it("resolves a complexity tier to the active vendor's model", () => {
    expect(resolveSubAgentModel("mid", "claude", undefined, NO_LIVE_MODELS)).toBe(
      MODEL_COMPLEXITY_MAP.claude.mid,
    );
    expect(resolveSubAgentModel("high", "openai", undefined, NO_LIVE_MODELS)).toBe(
      MODEL_COMPLEXITY_MAP.openai.high,
    );
    expect(resolveSubAgentModel("low", "gemini", undefined, NO_LIVE_MODELS)).toBe(
      MODEL_COMPLEXITY_MAP.gemini.low,
    );
  });

  it("passes an explicit model ID through only when the active vendor offers it", () => {
    const claudeOpt = llmVendorModelOptions("claude")[0]!;
    expect(resolveSubAgentModel(claudeOpt, "claude", undefined, NO_LIVE_MODELS)).toBe(claudeOpt);
    const openaiOpt = llmVendorModelOptions("openai")[0]!;
    expect(resolveSubAgentModel(openaiOpt, "openai", undefined, NO_LIVE_MODELS)).toBe(openaiOpt);
  });

  it("accepts a model the catalog lists for the vendor even when no hand-written seed named it", () => {
    expect(resolveSubAgentModel("gpt-6.1-sol", "openai", undefined, NO_LIVE_MODELS)).toBe("gpt-6.1-sol");
    expect(resolveSubAgentModel("claude-opus-5-5", "claude", undefined, NO_LIVE_MODELS)).toBe("claude-opus-5-5");
  });

  it("accepts a model only the vendor's live /models answer named", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(resolveSubAgentModel("ft:gpt-6-luna:acme::abc123", "openai", undefined, NO_LIVE_MODELS)).toBeNull();
      expect(resolveSubAgentModel("ft:gpt-6-luna:acme::abc123", "openai", undefined, ["ft:gpt-6-luna:acme::abc123"]))
        .toBe("ft:gpt-6-luna:acme::abc123");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to the parent model (null) + warns when an explicit ID is not selectable for the active vendor", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      // Vendor-incompatible model IDs must be rejected before reaching the provider.
      expect(resolveSubAgentModel("gpt-5.4", "claude", undefined, NO_LIVE_MODELS)).toBeNull();
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toMatch(/parent-model fallback used/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns null for undefined / empty — caller keeps the parent model", () => {
    expect(resolveSubAgentModel(undefined, "claude", undefined, NO_LIVE_MODELS)).toBeNull();
    expect(resolveSubAgentModel("", "claude", undefined, NO_LIVE_MODELS)).toBeNull();
    expect(resolveSubAgentModel("   ", "claude", undefined, NO_LIVE_MODELS)).toBeNull();
  });

  it("uses the active Codex subscription catalog instead of the stale API-key vendor catalog", () => {
    const codex = { kind: "subscription", provider: "codex" } as const;

    expect(resolveSubAgentModel("  codex-live-only-model  ", "claude", codex, NO_LIVE_MODELS))
      .toBe("codex-live-only-model");
    // Complexity tiers are not subscription model IDs; retain the persisted selection.
    expect(resolveSubAgentModel("high", "openai", codex, NO_LIVE_MODELS)).toBeNull();
    expect(resolveSubAgentModel("bad\u0000model", "openai", codex, NO_LIVE_MODELS)).toBeNull();
    expect(resolveSubAgentModel("x".repeat(MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH + 1), "openai", codex, NO_LIVE_MODELS)).toBeNull();
  });

  it("keeps an ACP subscription's persisted default model", () => {
    expect(resolveSubAgentModel(
      "codex-live-only-model",
      "openai",
      { kind: "subscription", provider: "kimi-code" },
      NO_LIVE_MODELS,
    )).toBeNull();
  });

  it("returns null when the active vendor is outside the union (boundary)", () => {
    // Unknown vendors cannot map complexity tiers; retain the parent model instead.
    expect(resolveSubAgentModel("mid", "totally-fake-vendor", undefined, NO_LIVE_MODELS)).toBeNull();
  });

  it("trims surrounding whitespace before classifying", () => {
    expect(resolveSubAgentModel("  mid  ", "claude", undefined, NO_LIVE_MODELS)).toBe(
      MODEL_COMPLEXITY_MAP.claude.mid,
    );
  });
});

describe("buildModePreamble — #1113 mode posture + skill recommendation", () => {
  it("includes the posture line and skill recommendation for a skill-bearing mode", () => {
    const preamble = buildModePreamble(AGENT_MODE_MAP.execute);
    expect(preamble).toContain("<ave-agent-mode-posture>");
    expect(preamble).toContain(AGENT_MODE_MAP.execute.reasoningHint);
    expect(preamble).toContain("<ave-agent-mode-skills>");
    for (const skill of AGENT_MODE_MAP.execute.autoSkills) {
      expect(preamble).toContain(skill);
    }
    // Skill recommendations must still pass body-hash approval.
    expect(preamble).toContain("skill_load");
  });

  it("omits the skills block for a mode with no auto skills (explore)", () => {
    const preamble = buildModePreamble(AGENT_MODE_MAP.explore);
    expect(preamble).toContain("<ave-agent-mode-posture>");
    expect(preamble).not.toContain("<ave-agent-mode-skills>");
  });

  it("returns an empty string for the inert default mode", () => {
    expect(buildModePreamble(AGENT_MODE_MAP.default)).toBe("");
  });
});

describe("SubAgentRunner — unknown mode audit warn", () => {
  it("logs a warning when the profile mode does not match a known mode", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const runner = makeRunner(toolRegistry);
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      await runner.spawn({
        toolScope: PARENT_ALL_TOOL_SCOPE,
        title: "t",
        instructions: "do",
        profileMode: "supervise",
        maxRounds: 1,
      });
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toMatch(/unknown mode/i);
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// Persist regex-valid child IDs only in the isolated subagent namespace.

const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

describe("SubAgentRunner — subagent session namespace isolation (PR-A)", () => {
  let tmpHome: string;
  let prevAveHome: string | undefined;

  beforeEach(() => {
    prevAveHome = process.env.AVE_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "ave-subagent-test-"));
    process.env.AVE_HOME = tmpHome;
  });

  afterEach(async () => {
    if (prevAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = prevAveHome;
    await cleanupTmpDir(tmpHome);
  });

  it("persists the child JSONL under ~/.ave/subagent/, keeps it out of the main session list, and returns a regex-valid childSessionId", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "child answer" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);

    const mainMemoryManager = new MemoryManager({ aveDir: tmpHome });
    mainMemoryManager.load();
    const subAgentMemoryManager = new MemoryManager({
      aveDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();

    const parentDeps = buildLoopDeps(toolRegistry);
    // Use a real parent store so accidental reuse visibly pollutes its session list.
    (parentDeps as { memoryManager: unknown }).memoryManager =
      mainMemoryManager;

    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager,
    });

    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);

    try {
      const result = await runner.spawn({
        toolScope: PARENT_ALL_TOOL_SCOPE,
        title: "isolated",
        instructions: "do",
        originSessionId: "abc123-DEF-should:be::sanitized",
        maxRounds: 3,
      });

      expect(result.childSessionId).toMatch(SESSION_ID_REGEX);
      expect(result.childSessionId.startsWith("sub-")).toBe(true);

      const subSessionsDir = join(tmpHome, "subagent", "sessions");
      expect(
        existsSync(join(subSessionsDir, `${result.childSessionId}.jsonl`)),
      ).toBe(true);

      const mainSessionsDir = join(tmpHome, "sessions");
      const mainFiles = existsSync(mainSessionsDir)
        ? readdirSync(mainSessionsDir).filter((f) => f.endsWith(".jsonl"))
        : [];
      expect(mainFiles).toEqual([]);

      expect(mainMemoryManager.listSessions()).toEqual([]);
      // Child sessions must be listed under the subagent kind, never the default main kind.
      const subIds = subAgentMemoryManager
        .listSessions({ kind: "subagent" })
        .map((s) => s.id);
      expect(subIds).toContain(result.childSessionId);
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });

  it("sanitizes an origin session id to the id charset (no `::`, no leaked separators)", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const subAgentMemoryManager = new MemoryManager({
      aveDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager,
    });
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);
    try {
      const result = await runner.spawn({
        toolScope: PARENT_ALL_TOOL_SCOPE,
        title: "sanitize",
        instructions: "do",
        originSessionId: "a::b//c..d",
        maxRounds: 1,
      });
      expect(result.childSessionId).toMatch(SESSION_ID_REGEX);
      expect(result.childSessionId).not.toContain("::");
      expect(result.childSessionId).not.toContain("/");
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });
});

// Persist frozen resume metadata and hash the origin tag to avoid exposing parent IDs.

describe("SubAgentRunner — resume metadata + subagent SessionKind (PR-B)", () => {
  let tmpHome: string;
  let prevAveHome: string | undefined;

  beforeEach(() => {
    prevAveHome = process.env.AVE_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "ave-subagent-prb-"));
    process.env.AVE_HOME = tmpHome;
  });

  afterEach(async () => {
    if (prevAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = prevAveHome;
    await cleanupTmpDir(tmpHome);
  });

  function makeCleanProvider(): ScriptedProvider {
    return new ScriptedProvider(endTurnScript("child answer"));
  }

  function spawnWith(
    provider: ScriptedProvider,
    subAgentMemoryManager: MemoryManager,
    input: Parameters<SubAgentRunner["spawn"]>[0],
  ) {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      createDynamicTool({
        name: "noop",
        description: "no-op tool",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "ok", isError: false }),
      }),
    );
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager,
    });
    const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider(provider);
    return {
      run: () => runner.spawn(input),
      restore: () => {
        hasProviderSpy.mockRestore();
        refreshProviderSpy.mockRestore();
      },
    };
  }

  it("persists routing metadata before provider validation so failed runs remain addressable", async () => {
    const subAgentMemoryManager = new MemoryManager({
      aveDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    const toolRegistry = new ToolRegistry();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager,
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(false);

    try {
      const result = await runner.spawn({
        toolScope: PARENT_ALL_TOOL_SCOPE,
        title: "provider-missing",
        instructions: "do",
        originSessionId: "b0590dc4-c31e-4ff6-8106-2b5f6d6325d9",
        maxRounds: 1,
      });

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("provider not configured"),
      });
      expect(
        subAgentMemoryManager.loadSessionMetadata(result.childSessionId),
      ).toMatchObject({
        sessionKind: "subagent",
        originSessionId: "b0590dc4-c31e-4ff6-8106-2b5f6d6325d9",
        subAgentTitle: "provider-missing",
        budgetResumeCount: 0,
        questionAnswerCount: 0,
        cumulativeRounds: 0,
        subAgentTaskState: "TASK_STATE_FAILED",
        subAgentSuspensionReason: undefined,
      });
      await expect(
        runner.resolveSubAgentAddress("b0590dc4-c31e-4ff6-8106-2b5f6d6325d9", result.childSessionId),
      ).resolves.toEqual({
        childSessionId: result.childSessionId,
        parentSessionId: "b0590dc4-c31e-4ff6-8106-2b5f6d6325d9",
        childTitle: "provider-missing",
      });
    } finally {
      hasProviderSpy.mockRestore();
    }
  });

  it('tags the persisted sub-agent session `sessionKind: "subagent"` and round-trips the resume metadata fields', async () => {
    const subAgentMemoryManager = new MemoryManager({
      aveDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    const { run, restore } = spawnWith(
      makeCleanProvider(),
      subAgentMemoryManager,
      {
        title: "meta",
        instructions: "do",
        originSessionId: "51941cbf-7fc2-45a8-8401-d2193b48d640",
        toolScope: exactToolScope(["noop"]),
        profileModel: "high",
        profileMode: "execute",
        maxRounds: 3,
      },
    );
    try {
      const result = await run();
      const meta = subAgentMemoryManager.loadSessionMetadata(
        result.childSessionId,
      );
      expect(meta).not.toBeNull();
      expect(meta?.sessionKind).toBe("subagent");
      expect(meta?.sourceTools).toEqual(["noop"]);
      expect(meta?.profileModel).toBe("high");
      expect(meta?.profileMode).toBe("execute");
      expect(meta?.resumeCount).toBe(0);
      expect(meta?.budgetResumeCount).toBe(0);
      expect(meta?.questionAnswerCount).toBe(0);
      expect(meta?.cumulativeRounds).toBe(result.turnCount);
      const listed = subAgentMemoryManager
        .listSessions({ kind: "subagent" })
        .find((s) => s.id === result.childSessionId);
      expect(listed?.sessionKind).toBe("subagent");
    } finally {
      restore();
    }
  });

  it("omits profileModel/profileMode from metadata when the spawn did not supply them", async () => {
    const subAgentMemoryManager = new MemoryManager({
      aveDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    const { run, restore } = spawnWith(
      makeCleanProvider(),
      subAgentMemoryManager,
      {
        title: "meta-min",
        instructions: "do",
        originSessionId: "dbf92cab-1af6-4614-815f-ee0e85ca76ab",
        toolScope: PARENT_ALL_TOOL_SCOPE,
        maxRounds: 1,
      },
    );
    try {
      const result = await run();
      const meta = subAgentMemoryManager.loadSessionMetadata(
        result.childSessionId,
      );
      expect(meta?.sessionKind).toBe("subagent");
      expect(meta?.profileModel).toBeUndefined();
      expect(meta?.profileMode).toBeUndefined();
      expect(meta?.resumeCount).toBe(0);
      expect(meta?.budgetResumeCount).toBe(0);
      expect(meta?.questionAnswerCount).toBe(0);
      expect(meta?.cumulativeRounds).toBe(result.turnCount);
      expect(meta?.sourceTools).toEqual(["noop"]);
    } finally {
      restore();
    }
  });

  it("derives the origin tag from a HASH of the origin id (not a raw slice) and keeps the id regex-valid", async () => {
    const subAgentMemoryManager = new MemoryManager({
      aveDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    // Origin tags must not embed a raw slice of the parent session ID.
    const origin = "abcdefgh-IJKL-should-not-appear-verbatim";
    const { run, restore } = spawnWith(
      makeCleanProvider(),
      subAgentMemoryManager,
      {
        title: "hash",
        instructions: "do",
        originSessionId: origin,
        toolScope: PARENT_ALL_TOOL_SCOPE,
        maxRounds: 1,
      },
    );
    try {
      const result = await run();
      expect(result.childSessionId).toMatch(SESSION_ID_REGEX);
      expect(result.childSessionId.startsWith("sub-")).toBe(true);
      expect(result.childSessionId).not.toContain("abcdefgh");
      const expectedTag = createHash("sha256")
        .update(origin)
        .digest("hex")
        .slice(0, 8);
      expect(result.childSessionId.startsWith(`sub-${expectedTag}-`)).toBe(
        true,
      );
    } finally {
      restore();
    }
  });

  it("re-inits the tracer on the rebound childSessionId so dev traces key on the addressable id (not the stale constructor UUID)", async () => {
    const prevTrace = process.env.AVE_TRACE;
    process.env.AVE_TRACE = "1";
    const subAgentMemoryManager = new MemoryManager({
      aveDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    const { run, restore } = spawnWith(
      makeCleanProvider(),
      subAgentMemoryManager,
      {
        title: "trace",
        instructions: "do",
        originSessionId: "5ff63492-6b31-40b0-89d5-e32bffe9063b",
        toolScope: PARENT_ALL_TOOL_SCOPE,
        maxRounds: 1,
      },
    );
    try {
      const result = await run();
      // Trace filenames must use the rebound child session ID rather than the constructor UUID.
      const tracesDir = join(tmpHome, "traces");
      const traceFiles = existsSync(tracesDir)
        ? readdirSync(tracesDir).filter((f) => f.endsWith(".jsonl"))
        : [];
      expect(traceFiles).toContain(`${result.childSessionId}.jsonl`);
      const uuidNamed = traceFiles.filter((f) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(
          f,
        ),
      );
      expect(uuidNamed).toEqual([]);
    } finally {
      restore();
      if (prevTrace === undefined) delete process.env.AVE_TRACE;
      else process.env.AVE_TRACE = prevTrace;
    }
  });
});

describe("SubAgentRunner A2A bus facade", () => {
  it("fails closed and returns inert mailbox results when boot has no bus", async () => {
    const toolRegistry = new ToolRegistry();
    const runner = makeRunner(toolRegistry);

    await expect(
      runner.deliverToParent({
        parentSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        childSessionId: "sub-cd737a61-ca965459-55b1-40f6-8d1a-600e3f7a12ae",
        message: {
          messageId: "message-1",
          contextId: "a1bdc27a-c758-4a74-8955-5e9188412366",
          taskId: "sub-cd737a61-ca965459-55b1-40f6-8d1a-600e3f7a12ae",
          role: "ROLE_AGENT",
          parts: [{ text: "hello" }],
        },
      }),
    ).resolves.toEqual({
      ok: false,
      disposition: "dropped",
      reason: "message-bus-unavailable",
    });
    await expect(runner.peekParentMailbox("a1bdc27a-c758-4a74-8955-5e9188412366")).resolves.toEqual(
      [],
    );
    await expect(
      runner.acknowledgeParentMailbox("a1bdc27a-c758-4a74-8955-5e9188412366", ["message-1"]),
    ).resolves.toBe(0);
    expect(() => runner.setParentWakeHandler(null)).not.toThrow();
  });

  it("one-shots an initial-metadata failure through the real bus and durable mailbox", async () => {
    const parentSessionId = "a1bdc27a-c758-4a74-8955-5e9188412366";
    const namespace = createInMemoryMailboxNamespace();
    const mailbox = new SubAgentMessageMailbox(namespace.handle);
    const audit = vi.fn();
    const toolRegistry = new ToolRegistry();
    const subAgentMemoryManager = {
      ...fakeSubAgentMemoryManager(),
      saveSessionMetadata: vi.fn(async () => {
        throw new Error("initial metadata write failed");
      }),
      loadSessionMetadata: vi.fn(() => null),
      hasSessionMetadataFile: vi.fn(() => false),
    } as unknown as ConstructorParameters<
      typeof SubAgentRunner
    >[0]["subAgentMemoryManager"];
    let runner!: SubAgentRunner;
    const bus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "different-active-session",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox,
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: (parentId, childId, messageId) =>
        runner.resolveSubAgentAddress(parentId, childId, messageId),
      releaseEphemeralChildAddress: (parentId, childId, messageId) =>
        runner.releaseEphemeralParentDelivery(parentId, childId, messageId),
    });
    runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager,
      messageBus: bus,
    });
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: (event) => events.push(event),
    });

    const handleResult = await tool.execute(
      { title: "metadata-failure", instructions: "start", background: true },
      {
        cwd: process.cwd(),
        extraAllowedDirectories: [],
        metadata: {
          sessionId: parentSessionId,
          spawnDepth: 0,
          supportsA2AParentDelivery: true,
        },
      },
    );
    const handle = JSON.parse(handleResult.output) as {
      spawnId: string;
      childSessionId: string;
    };
    expect(handleResult.isError).toBe(false);
    expect(handle.childSessionId).toBeTruthy();

    let persisted = await runner.peekParentMailbox(parentSessionId);
    const deadline = Date.now() + 2_000;
    while (persisted.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      persisted = await runner.peekParentMailbox(parentSessionId);
    }
    expect(persisted).toHaveLength(1);
    const entry = persisted[0]!;
    expect(entry).toMatchObject({
      parentSessionId,
      childSessionId: handle.childSessionId,
      childTitle: "metadata-failure",
      message: {
        contextId: parentSessionId,
        taskId: handle.childSessionId,
        metadata: { taskState: A2ATaskState.FAILED },
      },
    });
    expect(
      events.filter((event) => event.type === "done" || event.type === "error"),
    ).toHaveLength(1);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      taskState: A2ATaskState.FAILED,
      childSessionId: handle.childSessionId,
    });

    await expect(
      runner.resolveSubAgentAddress(
        parentSessionId,
        handle.childSessionId,
        entry.message.messageId,
      ),
    ).resolves.toEqual({
      parentSessionId,
      childSessionId: handle.childSessionId,
      childTitle: "metadata-failure",
      ephemeralMessageId: entry.message.messageId,
    });

    const makeReplay = (contextId: string, messageId: string): A2AMessage => ({
      messageId,
      contextId,
      taskId: handle.childSessionId,
      role: A2A_ROLE_AGENT,
      parts: [{ text: "forged terminal replay" }],
      metadata: { taskState: A2ATaskState.FAILED },
    });
    await expect(
      runner.deliverToParent({
        parentSessionId: "bebd469f-b3d4-42a8-8340-f0a27e66162b",
        childSessionId: handle.childSessionId,
        message: makeReplay("bebd469f-b3d4-42a8-8340-f0a27e66162b", "wrong-parent-message"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "unknown-child" });
    await expect(
      runner.deliverToParent({
        parentSessionId,
        childSessionId: handle.childSessionId,
        message: makeReplay(parentSessionId, "wrong-message-id"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "unknown-child" });

    namespace.rejectNextWrite();
    await expect(
      runner.acknowledgeParentMailbox(parentSessionId, [entry.id]),
    ).rejects.toThrow("mailbox-write-failed");
    await expect(
      runner.resolveSubAgentAddress(
        parentSessionId,
        handle.childSessionId,
        entry.message.messageId,
      ),
    ).resolves.toMatchObject({ ephemeralMessageId: entry.message.messageId });
    await expect(
      runner.peekParentMailbox(parentSessionId),
    ).resolves.toHaveLength(1);

    await expect(
      runner.acknowledgeParentMailbox(parentSessionId, [entry.id]),
    ).resolves.toBe(1);
    await expect(
      runner.resolveSubAgentAddress(
        parentSessionId,
        handle.childSessionId,
        entry.message.messageId,
      ),
    ).resolves.toBeNull();
    await expect(
      runner.deliverToParent({
        parentSessionId,
        childSessionId: handle.childSessionId,
        message: makeReplay(parentSessionId, "post-ack-message-id"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "unknown-child" });
    await expect(runner.peekParentMailbox(parentSessionId)).resolves.toEqual(
      [],
    );
  });
});

describe("SubAgentRunner workspace lifecycle", () => {
  it("revokes every active child and surfaces an aggregate child failure", () => {
    const first = vi.fn(() => ({
      sessionDirectoriesRemoved: 2,
      turnDirectoriesRemoved: 1,
      projectRebound: false,
    }));
    const failing = vi.fn(() => {
      throw new Error("isolated child failure");
    });
    const last = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 4,
      projectRebound: true,
    }));
    const runner = new SubAgentRunner({} as never);
    const activeChildren = (
      runner as unknown as {
        activeChildren: Map<string, unknown>;
      }
    ).activeChildren;
    const child = (
      childSessionId: string,
      revokeWorkspaceRoot: ReturnType<typeof vi.fn>,
    ) => ({
      lease: Symbol(childSessionId),
      childSessionId,
      title: childSessionId,
      background: true,
      loop: { revokeWorkspaceRoot },
    });
    activeChildren.set("child-one", child("child-one", first));
    activeChildren.set("child-failing", child("child-failing", failing));
    activeChildren.set("child-last", child("child-last", last));

    const options = {
      globalScopeWasAuthorized: true,
      preserveRoots: [join(tmpdir(), "removed-workspace", "child")],
    };
    let thrown: unknown;
    try {
      runner.revokeWorkspaceRoot(join(tmpdir(), "removed-workspace"), options);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown).toMatchObject({
      code: "SUBAGENT_WORKSPACE_ROOT_REVOKE_FAILED",
    });
    expect((thrown as AggregateError).errors).toHaveLength(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(last).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]?.[0]).toBe(last.mock.calls[0]?.[0]);
    expect(first.mock.calls[0]?.[1]).toEqual(options);
    expect(failing.mock.calls[0]?.[1]).toEqual(options);
    expect(last.mock.calls[0]?.[1]).toEqual(options);
  });

  it("registers a fresh child before initial metadata persistence can race workspace removal", async () => {
    const removedRoot = join(tmpdir(), "subagent-pending-metadata-root");
    const fallbackRoot = join(tmpdir(), "subagent-safe-default-root");
    let rootRegistered = true;
    let releaseInitialMetadata!: () => void;
    const initialMetadataPending = new Promise<void>((resolve) => {
      releaseInitialMetadata = resolve;
    });
    let metadataSaveCount = 0;
    const saveSessionMetadata = vi.fn(() => {
      metadataSaveCount += 1;
      return metadataSaveCount === 1
        ? initialMetadataPending
        : Promise.resolve();
    });
    const toolRegistry = new ToolRegistry();
    const parentDeps = buildLoopDeps(toolRegistry);
    Object.assign(parentDeps, {
      getAdditionalDirectories: () => (rootRegistered ? [removedRoot] : []),
      getDefaultProject: () => ({
        projectRoot: fallbackRoot,
        projectName: "safe-default",
        isDefault: true,
      }),
      authorizeProject: (projectRoot: string, projectName?: string) =>
        rootRegistered && projectRoot === removedRoot
          ? { projectRoot, projectName, isDefault: false }
          : null,
    });
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: {
        ...fakeSubAgentMemoryManager(),
        saveSessionMetadata,
      },
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    let directoriesAtRun: readonly string[] = [];
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(async function (this: ConversationLoop) {
        directoriesAtRun = this.getTurnAdditionalDirectories();
        return {
          text: "safe",
          toolCalls: [],
          route: "default",
          stopReason: "end_turn",
        };
      });
    let spawnPromise: Promise<SubAgentSpawnResult> | undefined;

    try {
      spawnPromise = runner.spawn({
        toolScope: PARENT_ALL_TOOL_SCOPE,
        title: "pending metadata child",
        instructions: "run only after metadata persists",
        projectRoot: removedRoot,
        projectName: "removed-project",
        originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
      });
      expect(saveSessionMetadata).toHaveBeenCalledTimes(1);
      expect(runTurnSpy).not.toHaveBeenCalled();

      rootRegistered = false;
      expect(
        runner.revokeWorkspaceRoot(removedRoot, {
          globalScopeWasAuthorized: true,
        }),
      ).toMatchObject({
        activeChildrenVisited: 1,
        liveScopesRevoked: 1,
      });

      releaseInitialMetadata();
      const result = await spawnPromise;
      spawnPromise = undefined;

      expect(result.ok).toBe(true);
      expect(runTurnSpy).toHaveBeenCalledTimes(1);
      expect(directoriesAtRun).toContain(fallbackRoot);
      expect(directoriesAtRun).not.toContain(removedRoot);
      expect(
        (runner as unknown as { activeChildren: Map<string, unknown> })
          .activeChildren.size,
      ).toBe(0);
    } finally {
      releaseInitialMetadata();
      await spawnPromise?.catch(() => undefined);
      hasProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
    }
  });

  it("delegates project detach and re-add to the isolated metadata store", async () => {
    const allowProjectRoot = vi.fn();
    const detachSessionsFromProject = vi.fn(async () => 2);
    const runner = new SubAgentRunner({
      subAgentMemoryManager: {
        allowProjectRoot,
        detachSessionsFromProject,
      },
    } as never);
    const root = join(tmpdir(), "removed-subagent-workspace");

    await expect(runner.detachSessionsFromProject(root)).resolves.toBe(2);
    runner.allowProjectRoot(root);

    expect(detachSessionsFromProject).toHaveBeenCalledWith(root);
    expect(allowProjectRoot).toHaveBeenCalledWith(root);
  });
});
describe("spawn cancellation signal", () => {
  it("hands the run's abort signal to the child turn", async () => {
    // Cancellation during spawn setup must reach the later turn even before abortCurrentTurn can.
    const toolRegistry = new ToolRegistry();
    const runner = makeRunner(toolRegistry);
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    let releaseTurn: () => void = () => {};
    const turnParked = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let sawTurn: () => void = () => {};
    const turnStarted = new Promise<void>((resolve) => {
      sawTurn = resolve;
    });
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation((async () => {
        sawTurn();
        await turnParked;
        return { text: "done", stopReason: "end_turn" };
      }) as never);

    try {
      const spawned = runner.spawn(
        {
          toolScope: PARENT_ALL_TOOL_SCOPE,
          title: "cancel-signal",
          instructions: "work",
          originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        },
        {},
      );
      await turnStarted;

      // Assert signal linkage; a defined but unrelated signal would not propagate cancellation.
      const signal = runTurnSpy.mock.calls[0]?.[2] as AbortSignal | undefined;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      const snapshot = runner.listRunStatuses("a1bdc27a-c758-4a74-8955-5e9188412366")[0];
      const runId = snapshot?.spawnId ?? snapshot?.childSessionId ?? "";
      expect(runner.interruptRun(runId, "a1bdc27a-c758-4a74-8955-5e9188412366")).toMatchObject({ ok: true });
      expect(signal?.aborted).toBe(true);

      releaseTurn();
      await spawned;
    } finally {
      hasProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
    }
  });
});

describe("SubAgentRunner terminal completion step", () => {
  // Publish the terminal renderer frame in the completion step so it agrees with agent_status.
  function completionRunner() {
    const toolRegistry = new ToolRegistry();
    return new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
  }

  // Use the no-provider branch to test completion without an accidental endpoint request.
  let hasProviderSpy: { mockRestore: () => void };
  beforeEach(() => {
    hasProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { hasProvider: () => boolean }, "hasProvider")
      .mockReturnValue(false);
  });
  afterEach(() => {
    hasProviderSpy.mockRestore();
  });

  it("publishes the terminal state and the renderer frame in one uninterruptible step", async () => {
    const runner = completionRunner();
    const observed: string[] = [];
    const spawned = runner.spawn(
      {
        toolScope: PARENT_ALL_TOOL_SCOPE,
        title: "completion order",
        instructions: "do",
        originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        spawnId: "spawn-completion-order",
      },
      {
        onTerminal: (result) => {
          observed.push(`frame:${result.ok ? "ok" : "error"}`);
          observed.push(
            `agent_status:${
              runner.getRunStatus("spawn-completion-order", "a1bdc27a-c758-4a74-8955-5e9188412366")?.status
            }`,
          );
        },
      },
    );
    observed.push("awaiting");
    const result = await spawned;
    observed.push("resolved");

    expect(result.ok).toBe(false);
    expect(observed).toEqual([
      "awaiting",
      "frame:error",
      "agent_status:error",
      "resolved",
    ]);
  });

  it("reports a terminal run to the renderer once, even if the run finalizes twice", async () => {
    const runner = completionRunner();
    const onTerminal = vi.fn();
    await runner.spawn(
      {
        toolScope: PARENT_ALL_TOOL_SCOPE,
        title: "single frame",
        instructions: "do",
        originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        spawnId: "1f2ffeba-7ce4-4ac6-8a3e-6846649f7785",
      },
      { onTerminal },
    );
    expect(onTerminal).toHaveBeenCalledTimes(1);

    // Re-finalization after cancellation or persistence retry must not notify twice.
    const tracked = (
      runner as unknown as { trackedRuns: Map<string, { title: string }> }
    ).trackedRuns.get("1f2ffeba-7ce4-4ac6-8a3e-6846649f7785");
    expect(tracked).toBeDefined();
    (runner as unknown as {
      finalizeRun: (run: unknown, result: SubAgentSpawnResult) => void;
    }).finalizeRun(tracked, {
      summary: "second finalize",
      toolCallCount: 0,
      turnCount: 0,
      childSessionId: "1f2ffeba-7ce4-4ac6-8a3e-6846649f7785",
      entries: [],
      ok: false,
      error: "second finalize",
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });
});

describe("SubAgentRunner completion mailbox single-shot", () => {
  // Reading a terminal report retires its durable steering copy to prevent duplicate parent review.
  const parentSessionId = "a1bdc27a-c758-4a74-8955-5e9188412366";
  const restore: Array<() => void> = [];

  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
  });

  function completionMailboxFixture() {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "child finished" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { refreshProvider: () => void },
        "refreshProvider",
      )
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });
    restore.push(() => hasProviderSpy.mockRestore());
    restore.push(() => refreshProviderSpy.mockRestore());

    const namespace = createInMemoryMailboxNamespace();
    const mailbox = new SubAgentMessageMailbox(namespace.handle);
    const storedMetadata = new Map<string, Record<string, unknown>>();
    const subAgentMemoryManager = {
      ...fakeSubAgentMemoryManager(),
      saveSessionMetadata: vi.fn(async (id: string, meta: Record<string, unknown>) => {
        storedMetadata.set(id, { ...meta });
      }),
      loadSessionMetadata: vi.fn((id: string) => storedMetadata.get(id) ?? null),
      hasSessionMetadataFile: vi.fn((id: string) => storedMetadata.has(id)),
      listSubAgentSessionsForOrigin: vi.fn(() => []),
    } as unknown as ConstructorParameters<
      typeof SubAgentRunner
    >[0]["subAgentMemoryManager"];
    let runner!: SubAgentRunner;
    const bus = new A2ASubAgentMessageBus({
      // An inactive parent receives durable mailbox delivery rather than live guidance.
      parentLoop: {
        getSessionId: () => "different-active-session",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox,
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: vi.fn() } as never,
      resolveChildAddress: (parentId, childId, messageId) =>
        runner.resolveSubAgentAddress(parentId, childId, messageId),
    });
    const toolRegistry = new ToolRegistry();
    runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager,
      messageBus: bus,
    });
    const spawnTool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: () => undefined,
    });
    const statusTool = createAgentStatusTool({ getRunner: () => runner });
    const parentContext = {
      cwd: process.cwd(),
      extraAllowedDirectories: [],
      metadata: {
        sessionId: parentSessionId,
        spawnDepth: 0,
        supportsA2AParentDelivery: true,
      },
    };
    return { runner, bus, spawnTool, statusTool, parentContext };
  }

  async function spawnUntilReportQueued(
    fixture: ReturnType<typeof completionMailboxFixture>,
    title: string,
  ) {
    const handleResult = await fixture.spawnTool.execute(
      { title, instructions: "do" },
      fixture.parentContext,
    );
    expect(handleResult.isError).toBe(false);
    const handle = JSON.parse(handleResult.output) as { spawnId: string };
    let queued = await fixture.runner.peekParentMailbox(parentSessionId);
    const deadline = Date.now() + 5_000;
    while (queued.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      queued = await fixture.runner.peekParentMailbox(parentSessionId);
    }
    return { handle, queued };
  }

  it("retires the queued report once agent_status hands the parent the same run", async () => {
    const fixture = completionMailboxFixture();
    const { handle, queued } = await spawnUntilReportQueued(fixture, "already read");
    expect(queued).toHaveLength(1);

    const status = await fixture.statusTool.execute(
      { id: handle.spawnId },
      fixture.parentContext,
    );
    expect(JSON.parse(status.output)).toMatchObject({
      run: { status: "done", spawnId: handle.spawnId },
    });

    await expect(
      fixture.runner.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
    await expect(
      fixture.runner.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
    // Retire the durable entry too; process-local read marks cannot survive restart.
    await expect(
      fixture.bus.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
  });

  it("retires the queued report through the listing form of agent_status too", async () => {
    const fixture = completionMailboxFixture();
    const { queued } = await spawnUntilReportQueued(fixture, "listed read");
    expect(queued).toHaveLength(1);

    const status = await fixture.statusTool.execute({}, fixture.parentContext);
    expect((JSON.parse(status.output) as { runs: unknown[] }).runs).toHaveLength(1);

    await expect(
      fixture.runner.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
    await expect(
      fixture.bus.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
  });

  it("does not count a snapshot whose result the state machine refused as a read report", async () => {
    // Retire reports only after the completion patch lands; terminal state alone can precede its data.
    const fixture = completionMailboxFixture();
    let releaseTurn: () => void = () => {};
    const turnParked = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let sawTurn: () => void = () => {};
    const turnStarted = new Promise<void>((resolve) => {
      sawTurn = resolve;
    });
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation((async () => {
        sawTurn();
        await turnParked;
        return { text: "unused", stopReason: "end_turn" };
      }) as never);
    restore.push(() => runTurnSpy.mockRestore());
    restore.push(() => releaseTurn());

    const handleResult = await fixture.spawnTool.execute(
      { title: "refused result", instructions: "do" },
      fixture.parentContext,
    );
    expect(handleResult.isError).toBe(false);
    const handle = JSON.parse(handleResult.output) as { spawnId: string };
    await turnStarted;
    expect(
      fixture.runner.interruptRun(handle.spawnId, parentSessionId),
    ).toMatchObject({ ok: true });

    const run = (
      fixture.runner as unknown as {
        trackedRuns: Map<string, { childSessionId: string; taskState: string }>;
      }
    ).trackedRuns.get(handle.spawnId);
    expect(run?.taskState).toBe(A2ATaskState.CANCELED);
    const childSessionId = run!.childSessionId;

    (fixture.runner as unknown as {
      finalizeRun: (run: unknown, result: SubAgentSpawnResult) => void;
    }).finalizeRun(run, {
      summary: "the child's answer",
      toolCallCount: 0,
      turnCount: 1,
      childSessionId,
      entries: [],
      ok: true,
      stopReason: "end_turn",
    });

    const snapshot = fixture.runner.getRunStatus(handle.spawnId, parentSessionId, {
      deliversReportToParent: true,
    });
    expect(snapshot?.taskState).toBe(A2ATaskState.CANCELED);
    expect(snapshot?.summary).toBeUndefined();
    expect(snapshot?.error).toBeUndefined();

    await expect(fixture.runner.deliverToParent(
      {
        parentSessionId,
        childSessionId,
        message: {
          messageId: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          contextId: parentSessionId,
          taskId: childSessionId,
          role: A2A_ROLE_AGENT,
          parts: [{ text: "the child's answer" }],
          metadata: { taskState: A2ATaskState.COMPLETED },
        } satisfies A2AMessage,
      },
      { terminalReport: true },
    )).resolves.toMatchObject({ ok: true });

    const owed = await fixture.runner.peekParentMailbox(parentSessionId);
    expect(owed).toHaveLength(1);
    expect(owed[0]?.formattedText).toContain("the child's answer");
  });

  it("delivers a report the parent never read exactly once across two turns", async () => {
    const fixture = completionMailboxFixture();
    const { queued } = await spawnUntilReportQueued(fixture, "never read");
    expect(queued).toHaveLength(1);

    const firstTurn = await fixture.runner.peekParentMailbox(parentSessionId);
    expect(firstTurn).toHaveLength(1);
    expect(firstTurn[0]?.id).toBe(queued[0]?.id);
    await expect(
      fixture.runner.acknowledgeParentMailbox(parentSessionId, [firstTurn[0]!.id]),
    ).resolves.toBe(1);

    await expect(
      fixture.runner.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
  });
});

describe("listWorkBoardRunSessions", () => {
  it("asks the sub-agent namespace for work-board runs with the caller's page window", () => {
    const toolRegistry = new ToolRegistry();
    const listSessionsPage = vi.fn(() => []);
    const subAgentMemoryManager = {
      ...fakeSubAgentMemoryManager(),
      listSessionsPage,
    } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["subAgentMemoryManager"];
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager,
    });
    const before = new Date("2026-09-03T00:00:00Z");
    runner.listWorkBoardRunSessions({ limit: 3, before, beforeId: "x" });
    expect(listSessionsPage).toHaveBeenCalledWith({
      limit: 3,
      before,
      beforeId: "x",
      kind: "subagent",
      workBoardRuns: true,
    });
  });
});

describe("SubAgentRunner activity ordering", () => {
  it.each(["spawn", "resume"] as const)("preserves activity, lifecycle and terminal payload order for %s", async (entry) => {
    const root = mkdtempSync(join(tmpdir(), "ave-subagent-activity-"));
    vi.stubEnv("AVE_HOME", root);
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "read_item", description: "Read an item", source: "builtin", category: "read",
      jsonSchema: { type: "object", properties: {} }, execute: async () => ({ output: "value", isError: false }),
    }));
    const memory = new MemoryManager({ aveDir: join(root, "subagent") });
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(registry),
      toolRegistry: registry,
      subAgentMemoryManager: memory,
    });
    const timeline: string[] = [];
    const activities: Array<{ toolCallCount: number; turnCount: number }> = [];
    let terminalResult: SubAgentSpawnResult | undefined;
    let terminalTaskState: string | undefined;
    vi.spyOn(ConversationLoop.prototype, "hasProvider").mockReturnValue(true);
    vi.spyOn(ConversationLoop.prototype, "refreshProvider").mockImplementation(() => {});
    vi.spyOn(ConversationLoop.prototype, "loadSession").mockResolvedValue(true);
    vi.spyOn(ConversationLoop.prototype, "fireLifecycleEvent").mockImplementation(async (name) => {
      timeline.push(name);
    });
    const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn").mockResolvedValue({
      text: "paused", toolCalls: [], route: "default", stopReason: "round-cap",
    });
    const input = {
      title: "activity child", instructions: "work", toolScope: PARENT_ALL_TOOL_SCOPE,
      originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
    };
    try {
      const resumeId = entry === "resume" ? (await runner.spawn(input)).childSessionId : undefined;
      timeline.length = 0;
      const saveMetadata = memory.saveSessionMetadata.bind(memory);
      vi.spyOn(memory, "saveSessionMetadata").mockImplementation(async (id, metadata) => {
        timeline.push(`metadata:${metadata.subAgentTaskState}`);
        await saveMetadata(id, metadata);
      });
      runTurn.mockImplementation(async (_prompt, callbacks, signal, options) => {
        timeline.push("run");
        expect(signal?.aborted).toBe(false);
        expect(options).toMatchObject({ spawnDepth: 1, inputOrigin: "llm-tool-arg" });
        expect(options?.sessionIdOverride).toMatch(/^sub-/);
        expect(Object.hasOwn(options!, "subagentStop")).toBe(entry === "spawn");
        const meta = { groupId: "group", toolUseId: "tool", displayOrder: 0 };
        callbacks?.onLlmStatus?.({ phase: "retry", attempt: 2, maxAttempts: 5 });
        callbacks?.onReasoningDelta?.("thinking");
        callbacks?.onToolStart?.("read_item", { path: "item" }, meta);
        callbacks?.onPermissionReview?.({
          status: "reviewing", toolName: "read_item", groupId: "group", toolUseId: "tool", displayOrder: 0,
        });
        callbacks?.onToolEnd?.("read_item", "value", false, meta, undefined, 12);
        callbacks?.onAssistantRound?.({
          roundIndex: 0, text: "answer", thought: "thought", stopReason: "end_turn",
          hasToolCalls: false, messageId: "message",
        });
        callbacks?.onError?.("notice");
        return {
          text: "answer", route: "default", stopReason: "end_turn",
          // The final count comes from the turn result, even if one callback was absent.
          toolCalls: Array.from({ length: 2 }, () => ({ name: "read_item", input: {}, result: "value" })),
        };
      });
      const callbacks = {
        onLinked: () => { timeline.push("linked"); },
        onReady: () => { timeline.push("ready"); },
        onActivity: (update: { entries: unknown[]; toolCallCount: number }) => {
          timeline.push(`activity:${update.toolCallCount}`);
          const run = runner.listRunStatuses(input.originSessionId).find((item) => item.status === "running")!;
          expect(run.entries).toBe(update.entries);
          activities.push({ toolCallCount: run.toolCallCount, turnCount: run.turnCount });
        },
        onError: (message: string) => { timeline.push(`error:${message}`); },
        onTerminal: (result: SubAgentSpawnResult) => {
          timeline.push("terminal");
          terminalResult = structuredClone(result);
          terminalTaskState = memory.loadSessionMetadata(result.childSessionId)?.subAgentTaskState;
        },
      };
      const result = entry === "spawn"
        ? await runner.spawn(input, callbacks)
        : await runner.resume(resumeId!, "continue", input.title, callbacks, input.originSessionId);
      expect(result.ok).toBe(true);
      expect(terminalResult).toEqual({
        summary: "answer", toolCallCount: 2, turnCount: 1,
        childSessionId: result.childSessionId, entries: result.entries, ok: true, stopReason: "end_turn",
      });
      expect(terminalTaskState).toBe(A2ATaskState.COMPLETED);
      expect(activities).toEqual([
        { toolCallCount: 0, turnCount: 0 },
        { toolCallCount: 0, turnCount: 0 },
        { toolCallCount: 0, turnCount: 0 },
        { toolCallCount: 0, turnCount: 0 },
        { toolCallCount: 1, turnCount: 0 },
        { toolCallCount: 1, turnCount: 1 },
      ]);
      expect(timeline).toEqual([
        "linked",
        ...(entry === "spawn" ? ["metadata:TASK_STATE_SUBMITTED", "SubagentStart"] : ["metadata:TASK_STATE_WORKING", "ready"]),
        "run", "activity:0", "activity:0", "activity:0", "activity:0", "activity:1", "activity:1", "error:notice",
        ...(entry === "spawn" ? ["SubagentStop"] : []),
        "metadata:TASK_STATE_COMPLETED", "terminal",
      ]);
      const terminalTimeline = [...timeline];
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(timeline).toEqual(terminalTimeline);
    } finally {
      memory.closeSearchIndex();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await cleanupTmpDir(root);
    }
  });
});
