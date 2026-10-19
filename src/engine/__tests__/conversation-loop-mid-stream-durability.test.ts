/**
 * Mid-stream durability: a turn's rounds survive the process going away.
 *
 * `conversation-loop-transcript-durability.test.ts` pins the c019c815a
 * guarantees (user message on disk before the first provider call, a turn
 * that THROWS keeps its rounds). A `finally` never runs when the process
 * quits, crashes or is killed, so these cases pin what replaces it:
 *
 *   1. each completed round and tool_result is on disk while the turn is
 *      still running — appended, without a whole-session save per round,
 *   2. the streaming text is snapshotted and folds back in on reload,
 *   3. a normal completion leaves exactly one copy of every row,
 *   4. the quit path stops running turns as `host-exit` and the reload offers
 *      Continue, which resumes from the persisted rows,
 *   5. sub-agent children get the same journal through the same runTurn.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
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
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import { historyToEntries, interruptedTurnOffer } from "../../ui/renderer/utils/history.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { interruptRunningTurnsForExit } from "../turn/turn-journal.js";
import { SubAgentRunner, exactToolScope } from "../subagent-runner.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";

const SESSION_ID = "5d1e2f3a-46a9-493a-8a3e-f277ba673230";

type Step = StreamEvent[] | "block" | ((params: StreamTurnParams) => AsyncIterable<StreamEvent>);

/** Plays scripted rounds; `"block"` streams nothing and waits for the turn's abort. */
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

/** Streams `text` then holds the stream open until the turn is aborted. */
function streamThenBlock(text: string, onStreamed: () => void): Step {
  return async function* (params) {
    yield { type: "text_delta", text };
    onStreamed();
    yield* waitForAbort(params);
  };
}

function okTool(name: string, output: string) {
  return createDynamicTool({
    name,
    description: name,
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
        // A second reader of the same files: what a relaunch would see now.
        onDiskAtRound2 = (new MemoryManager({ aveDir: dir }).loadSession(SESSION_ID) ?? []) as GenericMessage[];
        savesBeforeRound2 = saveSpy.mock.calls.length;
      },
    );

    await buildLoop(memoryManager, toolRegistry, provider).runTurn("세 라운드", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    expect(onDiskAtRound2.map((m) => [m.role, m.role === "tool_result" ? m.toolUseId : m.content])).toEqual([
      ["user", "세 라운드"],
      ["assistant", "라운드 1"],
      ["tool_result", "call-1"],
      ["assistant", "라운드 2"],
      ["tool_result", "call-2"],
    ]);
    // Only the turn-accepted save ran before round 3: rounds 1–2 were appended.
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
      inputOrigin: "user-keyboard",
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
    const turn = loop.runTurn("부분 응답", undefined, undefined, { inputOrigin: "user-keyboard" });
    const sidecar = turnInflightPath(join(dir, "sessions"), SESSION_ID);
    await waitFor(() => streamed);
    // The first snapshot of a round is written without waiting a full interval.
    await waitFor(() => existsSync(sidecar) && JSON.parse(readFileSync(sidecar, "utf-8")).partial !== undefined);

    // Simulate the death: copy the files as they are now into a fresh home and
    // read them there, where no turn of this process holds the journal.
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
    const turn = loop.runTurn("종료 테스트", undefined, undefined, { inputOrigin: "user-keyboard" });
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

    // Relaunch: the session reopens with the partial answer and Continue.
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
      inputOrigin: "user-keyboard",
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

      // Mid-run, the child's first round is already in the sub-agent store.
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
