// Completed rounds and partial streams must survive process exit without relying on finally.
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { turnInflightPath } from "../../memory/session-turn-journal.js";
import * as journalStorage from "../../memory/session-turn-journal.js";
import * as atomicFile from "../../lib/atomic-file.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import { historyToEntries, interruptedTurnOffer } from "../../ui/renderer/utils/history.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { interruptRunningTurnsForExit } from "../turn/turn-journal.js";
import { SubAgentRunner, exactToolScope } from "../subagent-runner.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

const SESSION_ID = "5d1e2f3a-46a9-493a-8a3e-f277ba673230";

type Step = StreamEvent[] | "block" | ((params: StreamTurnParams) => AsyncIterable<StreamEvent>);

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  readonly seen: GenericMessage[][] = [];

  constructor(
    private readonly steps: Step[],
    private readonly onStreamStart?: (round: number) => void,
  ) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    const round = this.index++;
    this.seen.push(structuredClone(params.messages) as GenericMessage[]);
    this.onStreamStart?.(round);
    const step = this.steps[round];
    if (step === "block") {
      yield* waitForAbort(params);
      return;
    }
    if (typeof step === "function") {
      yield* step(params);
      return;
    }
    yield* step ?? [{ type: "text_delta", text: "(out of script)" }, { type: "message_complete", stopReason: "end_turn" }];
  }
}

async function* waitForAbort(params: StreamTurnParams): AsyncIterable<StreamEvent> {
  await new Promise<never>((_resolve, reject) => {
    const abort = () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (params.abortSignal?.aborted) return abort();
    params.abortSignal?.addEventListener("abort", abort, { once: true });
  });
}

function streamThenBlock(text: string, onStreamed: () => void): Step {
  return async function* (params) {
    yield { type: "text_delta", text };
    onStreamed();
    yield* waitForAbort(params);
  };
}

function okTool(name: string, output: string, parallelSafe = false) {
  return createDynamicTool({
    name,
    description: name,
    parallelSafe,
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output, isError: false }),
  });
}

function toolRound(text: string, id: string, name: string): StreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "tool_call", id, name, input: {} },
    { type: "message_complete", stopReason: "tool_use" },
  ];
}

function buildLoop(memoryManager: MemoryManager, toolRegistry: ToolRegistry, provider: LLMProvider): ConversationLoop {
  const loop = new ConversationLoop({
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system" },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry,
    memoryManager,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  (loop as { sessionId: string }).sessionId = SESSION_ID;
  return loop;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-mid-stream-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(dir);
});

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("mid-stream durability", () => {
  it.each([false, true])("recovers a completed call while its sibling is still running (later call completes first: %s)", async (laterFirst) => {
    const memoryManager = new MemoryManager({ aveDir: dir });
    const registry = new ToolRegistry();
    registry.register(okTool("finished_tool", "finished output", true));
    let running = false;
    let release!: () => void;
    registry.register(createDynamicTool({
      name: "waiting_tool",
      description: "waits for release",
      source: "builtin",
      category: "read",
      parallelSafe: true,
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => {
        running = true;
        await new Promise<void>((resolve) => { release = resolve; });
        return { output: "second output", isError: false };
      },
    }));
    // Reverse completion order covers insertion ahead of an already persisted sibling.
    const calls: StreamEvent[] = [
      { type: "tool_call", id: "finished", name: "finished_tool", input: {} },
      { type: "tool_call", id: "waiting", name: "waiting_tool", input: {} },
    ];
    if (laterFirst) calls.reverse();
    const provider = new ScriptedProvider([
      [...calls, { type: "message_complete", stopReason: "tool_use" }],
      [{ type: "text_delta", text: "done" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    const loop = buildLoop(memoryManager, registry, provider);
    const turn = loop.runTurn("batch question", undefined, undefined, { ...userKeyboardTurn() });
    const crashed = mkdtempSync(join(tmpdir(), "ave-batch-crashed-"));
    try {
      const transcript = join(dir, "sessions", SESSION_ID + ".jsonl");
      await waitFor(() => running && existsSync(transcript)
        && readFileSync(transcript, "utf8").includes('"toolUseId":"finished"'));
      cpSync(join(dir, "sessions"), join(crashed, "sessions"), { recursive: true });
      const restored = (new MemoryManager({ aveDir: crashed }).loadSession(SESSION_ID) ?? []) as GenericMessage[];
      const results = restored.filter((row) => row.role === "tool_result");
      expect(results.map((row) => row.toolUseId)).toEqual(laterFirst ? ["waiting", "finished"] : ["finished", "waiting"]);
      expect(results.find((row) => row.toolUseId === "finished")).toMatchObject({ content: "finished output" });
      expect(results.find((row) => row.toolUseId === "finished")?.isError).not.toBe(true);
      expect(results.find((row) => row.toolUseId === "waiting")).toMatchObject({ isError: true, meta: { toolDisplay: { cancelled: true } } });
      expect(restored[1]).toMatchObject({ role: "assistant", toolCalls: calls.map((call) => expect.objectContaining({ id: "id" in call ? call.id : "" })) });
    } finally {
      release?.();
      await turn;
      await cleanupTmpDir(crashed);
    }
    const saved = (new MemoryManager({ aveDir: dir }).loadSession(SESSION_ID) ?? []) as GenericMessage[];
    expect(saved.filter((row) => row.role === "tool_result").map((row) => row.toolUseId))
      .toEqual(laterFirst ? ["waiting", "finished"] : ["finished", "waiting"]);
    expect(provider.seen[1].filter((row) => row.role === "tool_result").map((row) => row.toolUseId))
      .toEqual(laterFirst ? ["waiting", "finished"] : ["finished", "waiting"]);
  });

  it.each(["append", "rewrite"] as const)("restores partial text after EACCES blocks the transcript %s and final save", async (writeKind) => {
    const memoryManager = new MemoryManager({ aveDir: dir });
    let streamed = false;
    const loop = buildLoop(memoryManager, new ToolRegistry(), new ScriptedProvider([
      streamThenBlock("partial text survives denied write", () => { streamed = true; }),
    ]));
    const turn = loop.runTurn("write failure", undefined, undefined, { ...userKeyboardTurn() });
    const sidecar = turnInflightPath(join(dir, "sessions"), SESSION_ID);
    try {
      await waitFor(() => streamed && existsSync(sidecar) && JSON.parse(readFileSync(sidecar, "utf8")).partial !== undefined);
      const transcript = join(dir, "sessions", SESSION_ID + ".jsonl");
      const denied = Object.assign(new Error("transcript write denied"), { code: "EACCES" });
      const write = atomicFile.writeUtf8FileAtomicSync;
      const rewrite = vi.spyOn(atomicFile, "writeUtf8FileAtomicSync").mockImplementation((path, ...args) => {
        if (path === transcript) throw denied;
        return write(path, ...args);
      });
      const append = vi.spyOn(journalStorage, "appendJsonlRecords").mockRejectedValue(denied);
      if (writeKind === "rewrite") appendFileSync(transcript, "\n");
      loop.abortCurrentTurn();
      await expect(turn).rejects.toMatchObject({ code: "EACCES" });
      expect(rewrite.mock.calls.some(([path]) => path === transcript)).toBe(true);
      if (writeKind === "append") expect(append).toHaveBeenCalled();
      expect(existsSync(sidecar)).toBe(true);
      expect(JSON.parse(readFileSync(sidecar, "utf8")).partial.content).toBe("partial text survives denied write");
      vi.restoreAllMocks();
      const restarted = new MemoryManager({ aveDir: dir });
      const restored = restarted.loadSession(SESSION_ID) as GenericMessage[];
      expect(restored.at(-1)).toMatchObject({ role: "assistant", content: "partial text survives denied write", meta: { interrupted: true, interruptedBy: "host-exit" } });
      await restarted.saveSession(SESSION_ID, restored);
      expect(existsSync(sidecar)).toBe(false);
    } finally {
      loop.abortCurrentTurn();
      await turn.catch(() => undefined);
    }
  });

  it("has every completed round and tool_result on disk while the turn is still running, without a save per round", async () => {
    const memoryManager = new MemoryManager({ aveDir: dir });
    const saveSpy = vi.spyOn(memoryManager, "saveSession");
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(okTool("probe_tool", "probe output"));
    let onDiskAtRound2: GenericMessage[] = [];
    let savesBeforeRound2 = -1;
    const provider = new ScriptedProvider(
      [
        toolRound("라운드 1", "call-1", "probe_tool"),
        toolRound("라운드 2", "call-2", "probe_tool"),
        [{ type: "text_delta", text: "마무리" }, { type: "message_complete", stopReason: "end_turn" }],
      ],
      (round) => {
        if (round !== 2) return;
        onDiskAtRound2 = (new MemoryManager({ aveDir: dir }).loadSession(SESSION_ID) ?? []) as GenericMessage[];
        savesBeforeRound2 = saveSpy.mock.calls.length;
      },
    );

    await buildLoop(memoryManager, toolRegistry, provider).runTurn("세 라운드", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(onDiskAtRound2.map((m) => [m.role, m.role === "tool_result" ? m.toolUseId : m.content])).toEqual([
      ["user", "세 라운드"],
      ["assistant", "라운드 1"],
      ["tool_result", "call-1"],
      ["assistant", "라운드 2"],
      ["tool_result", "call-2"],
    ]);
    expect(savesBeforeRound2).toBe(1);
  });

  it("leaves exactly one copy of each row and no in-flight marker after a normal completion", async () => {
    const memoryManager = new MemoryManager({ aveDir: dir });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(okTool("probe_tool", "probe output"));
    const provider = new ScriptedProvider([
      toolRound("도구 먼저", "call-1", "probe_tool"),
      [{ type: "text_delta", text: "완료" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    await buildLoop(memoryManager, toolRegistry, provider).runTurn("정상 완료", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    const messages = (new MemoryManager({ aveDir: dir }).loadSession(SESSION_ID) ?? []) as GenericMessage[];
    const ids = messages.map((m) => m.meta?.messageId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool_result", "assistant"]);
    expect(messages.some((m) => m.meta?.interrupted)).toBe(false);
    expect(existsSync(turnInflightPath(join(dir, "sessions"), SESSION_ID))).toBe(false);
  });

  it("snapshots the streaming text, which a reload after a death folds back in under the round's id", async () => {
    const memoryManager = new MemoryManager({ aveDir: dir });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(okTool("probe_tool", "probe output"));
    let streamed = false;
    const provider = new ScriptedProvider([
      toolRound("라운드 1", "call-1", "probe_tool"),
      streamThenBlock("스트리밍 중인 두 번째 답변", () => { streamed = true; }),
    ]);
    const loop = buildLoop(memoryManager, toolRegistry, provider);
    const turn = loop.runTurn("부분 응답", undefined, undefined, { ...userKeyboardTurn() });
    const sidecar = turnInflightPath(join(dir, "sessions"), SESSION_ID);
    await waitFor(() => streamed);
    // The first stream snapshot must not wait for the throttle interval.
    await waitFor(() => existsSync(sidecar) && JSON.parse(readFileSync(sidecar, "utf-8")).partial !== undefined);

    // Read copied files without the original process holding their journal.
    const crashed = mkdtempSync(join(tmpdir(), "ave-mid-stream-crashed-"));
    try {
      cpSync(join(dir, "sessions"), join(crashed, "sessions"), { recursive: true });
      const recovered = (new MemoryManager({ aveDir: crashed }).loadSession(SESSION_ID) ?? []) as GenericMessage[];
      expect(recovered.map((m) => m.role)).toEqual(["user", "assistant", "tool_result", "assistant"]);
      expect(recovered[3]).toMatchObject({
        content: "스트리밍 중인 두 번째 답변",
        meta: { interrupted: true, interruptedBy: "host-exit" },
      });
      const entries = historyToEntries(recovered.map((m, i) => serializeHistoryMessage(m, i)));
      expect(interruptedTurnOffer(entries)).toBe("resume");
    } finally {
      await cleanupTmpDir(crashed);
    }

    loop.abortCurrentTurn();
    await turn;
  });

  it("stops running turns as host-exit on quit, keeps the partial answer, and offers Continue that resumes from it", async () => {
    const memoryManager = new MemoryManager({ aveDir: dir });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(okTool("probe_tool", "probe output"));
    let streamed = false;
    const provider = new ScriptedProvider([
      toolRound("라운드 1", "call-1", "probe_tool"),
      streamThenBlock("종료 직전까지 쓴 답변", () => { streamed = true; }),
      [{ type: "text_delta", text: "이어서 끝냈습니다" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    const loop = buildLoop(memoryManager, toolRegistry, provider);
    const turn = loop.runTurn("종료 테스트", undefined, undefined, { ...userKeyboardTurn() });
    await waitFor(() => streamed);

    const outcome = await interruptRunningTurnsForExit(3_000);
    expect(outcome).toEqual({ turns: 1, settled: true });
    const result = await turn;
    expect(result.stopReason).toBe("interrupted");

    const relaunched = new MemoryManager({ aveDir: dir });
    const onDisk = (relaunched.loadSession(SESSION_ID) ?? []) as GenericMessage[];
    expect(onDisk[onDisk.length - 1]).toMatchObject({
      role: "assistant",
      content: "종료 직전까지 쓴 답변",
      meta: { interrupted: true, interruptedBy: "host-exit" },
    });
    expect(existsSync(turnInflightPath(join(dir, "sessions"), SESSION_ID))).toBe(false);

    const reopened = buildLoop(relaunched, toolRegistry, provider);
    expect(await reopened.loadSession(SESSION_ID)).toBe(true);
    const entries = historyToEntries(reopened.getHistory().getMessages().map((m, i) => serializeHistoryMessage(m, i)));
    const partial = entries.find((e) => e.kind === "assistant" && e.text === "종료 직전까지 쓴 답변");
    expect(partial).toMatchObject({ interrupted: true, interruptedBy: "host-exit" });
    expect(interruptedTurnOffer(entries)).toBe("resume");
  });

  it("records a quit during tool execution as an interrupted host-exit stop", async () => {
    const memoryManager = new MemoryManager({ aveDir: dir });
    const toolRegistry = new ToolRegistry();
    let toolStarted = false;
    toolRegistry.register(createDynamicTool({
      name: "slow_tool",
      description: "waits for abort",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (_input, context) => {
        toolStarted = true;
        await new Promise<void>((resolve) => {
          const signal = (context as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 2_000);
        });
        return { output: "never mind", isError: false };
      },
    }));
    const provider = new ScriptedProvider([toolRound("느린 도구 실행", "call-slow", "slow_tool")]);
    const turn = buildLoop(memoryManager, toolRegistry, provider).runTurn("도구 중 종료", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    await waitFor(() => toolStarted);
    await interruptRunningTurnsForExit(3_000);
    await turn;

    const onDisk = (new MemoryManager({ aveDir: dir }).loadSession(SESSION_ID) ?? []) as GenericMessage[];
    expect(onDisk[0]).toMatchObject({ role: "user", content: "도구 중 종료" });
    expect(onDisk.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.id === "call-slow")).toBe(true);
    expect(onDisk[onDisk.length - 1]).toMatchObject({
      role: "assistant",
      meta: { interrupted: true, interruptedBy: "host-exit" },
    });
  });

  it("journals a sub-agent child's rounds into the sub-agent store and stops it on quit", async () => {
    const prevHome = process.env.AVE_HOME;
    process.env.AVE_HOME = dir;
    const subStore = new MemoryManager({ aveDir: openFeatureNamespace("subagent").dir });
    subStore.load();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(okTool("noop", "ok"));
    let blocked = false;
    const provider = new ScriptedProvider([
      toolRound("child round 0", "child-call-0", "noop"),
      streamThenBlock("child partial", () => { blocked = true; }),
    ]);
    vi.spyOn(ConversationLoop.prototype as unknown as { hasProvider: () => boolean }, "hasProvider").mockReturnValue(true);
    vi.spyOn(ConversationLoop.prototype as unknown as { refreshProvider: () => void }, "refreshProvider")
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });
    const runner = new SubAgentRunner({
      parentDeps: {
        settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
        systemPromptBuilder: {
          build: () => "system",
          createIsolated: () => ({ build: () => "system" }),
        },
        inputClassifier: new InputClassifier(),
        routeEngine: new RouteEngine(),
        toolRegistry,
        memoryManager: { saveSession: () => Promise.resolve(), listSessions: () => [] },
      } as unknown as ConstructorParameters<typeof ConversationLoop>[0],
      toolRegistry,
      subAgentMemoryManager: subStore,
    });
    try {
      const spawned = runner.spawn({
        title: "durable child",
        instructions: "work",
        toolScope: exactToolScope(["noop"]),
        maxRounds: 4,
        originSessionId: "092d865f-192a-48ae-8603-8a838c39d4dc",
        toolUseId: "tool-use-1",
        spawnId: "spawn-1",
      });
      await waitFor(() => blocked);

      const childFiles = readdirSync(join(openFeatureNamespace("subagent").dir, "sessions")).filter((f) => f.endsWith(".jsonl"));
      expect(childFiles).toHaveLength(1);
      const childId = childFiles[0].slice(0, -".jsonl".length);
      const midRun = (new MemoryManager({ aveDir: openFeatureNamespace("subagent").dir }).loadSession(childId) ?? []) as GenericMessage[];
      expect(midRun.map((m) => m.role)).toEqual(["user", "assistant", "tool_result"]);
      expect(midRun[1].content).toBe("child round 0");

      await interruptRunningTurnsForExit(3_000);
      await spawned;
      const final = (subStore.loadSession(childId) ?? []) as GenericMessage[];
      expect(final[final.length - 1]).toMatchObject({
        role: "assistant",
        content: "child partial",
        meta: { interrupted: true, interruptedBy: "host-exit" },
      });
    } finally {
      subStore.closeSearchIndex();
      if (prevHome === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = prevHome;
    }
  });
});
