// Persist accepted input before provider calls; failed calls or streams must retain prior rounds.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import { historyToEntries } from "../../ui/renderer/utils/history.js";
import { computeToolActivity } from "../../ui/renderer/utils/tool-activity.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { endTurnScript } from "./conversation-loop-test-helpers.js";
import { makeBasicConversationLoopDeps } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

const SESSION_ID = "b5a06893-46a9-493a-8a3e-f277ba673230";

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(
    private readonly turns: (StreamEvent[] | Error)[],
    private readonly onStreamStart?: () => void,
  ) {}

  async *streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.onStreamStart?.();
    const turn = this.turns[this.index++];
    if (turn instanceof Error) throw turn;
    yield* turn ?? [];
  }
}

function buildLoop(
  memoryManager: MemoryManager,
  toolRegistry: ToolRegistry,
  provider: LLMProvider,
): ConversationLoop {
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({
    toolRegistry,
    memoryManager,
  }));
  (loop as { provider: LLMProvider | null }).provider = provider;
  loop.replaceSessionIdentity(SESSION_ID);
  return loop;
}

// Authorization-key parse failures must become per-call error results, never reject the turn.
function inputRejectingTool(message: string) {
  return createDynamicTool({
    name: "input_rejecting_tool",
    description: "rejects its own input at the approval boundary",
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    approvalCacheKey: () => {
      throw new Error(message);
    },
    execute: async () => ({ output: "never reached", isError: false }),
  });
}

function persisted(memoryManager: MemoryManager): GenericMessage[] {
  return (memoryManager.loadSession(SESSION_ID) ?? []) as GenericMessage[];
}

async function withTmpMemory(
  run: (memoryManager: MemoryManager) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ave-durability-"));
  try {
    await run(new MemoryManager({ aveDir: dir }));
  } finally {
    await cleanupTmpDir(dir);
  }
}

describe("transcript durability", () => {
  it("persists the user message before the first provider call", async () => {
    await withTmpMemory(async (memoryManager) => {
      let onDiskAtStreamStart: GenericMessage[] = [];
      const provider = new ScriptedProvider(
        endTurnScript("hi"),
        () => {
          onDiskAtStreamStart = persisted(memoryManager);
        },
      );

      await buildLoop(memoryManager, new ToolRegistry(), provider).runTurn(
        "질문입니다",
        undefined,
        undefined,
        { ...userKeyboardTurn() },
      );

      expect(onDiskAtStreamStart).toHaveLength(1);
      expect(onDiskAtStreamStart[0]).toMatchObject({
        role: "user",
        content: "질문입니다",
      });
    });
  });

  it("keeps the user message durable when the turn throws before any round", async () => {
    await withTmpMemory(async (memoryManager) => {
      const loop = buildLoop(memoryManager, new ToolRegistry(), new ScriptedProvider([]));
      (loop as unknown as {
        deps: { systemPromptBuilder: { build: () => string } };
      }).deps.systemPromptBuilder.build = () => {
        throw new Error("prompt assembly failed");
      };

      await expect(
        loop.runTurn("사라지면 안 되는 질문", undefined, undefined, {
          ...userKeyboardTurn(),
        }),
      ).rejects.toThrow("prompt assembly failed");

      const messages = persisted(memoryManager);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: "user",
        content: "사라지면 안 되는 질문",
      });
    });
  });

  it("degrades a tool's own input rejection to an error tool_result, not a lost turn", async () => {
    await withTmpMemory(async (memoryManager) => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(
        createDynamicTool({
          name: "ok_tool",
          description: "succeeds",
          source: "builtin",
          category: "read",
          jsonSchema: { type: "object", properties: {} },
          execute: async () => ({ output: "tool round 1 output", isError: false }),
        }),
      );
      toolRegistry.register(inputRejectingTool("timeoutSeconds too_big"));

      const provider = new ScriptedProvider([
        [
          { type: "text_delta", text: "먼저 도구를 실행합니다" },
          { type: "tool_call", id: "call-1", name: "ok_tool", input: {} },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "이제 두 번째 도구" },
          { type: "tool_call", id: "call-2", name: "input_rejecting_tool", input: {} },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "인자를 고쳐서 다시 시도하겠습니다" },
          { type: "message_complete", stopReason: "end_turn" },
        ],
      ]);

      const result = await buildLoop(memoryManager, toolRegistry, provider).runTurn(
        "두 라운드 작업",
        undefined,
        undefined,
        { ...userKeyboardTurn() },
      );
      expect(result.stopReason).not.toBe("stream-error");

      const messages = persisted(memoryManager);
      expect(messages[0]).toMatchObject({ role: "user", content: "두 라운드 작업" });
      expect(messages[2]).toMatchObject({
        role: "tool_result",
        toolUseId: "call-1",
        content: "tool round 1 output",
      });

      const rejected = messages.find(
        (m) => m.role === "tool_result" && m.toolUseId === "call-2",
      );
      expect(rejected).toMatchObject({ isError: true });
      expect(String(rejected?.content)).toContain("timeoutSeconds too_big");
      expect(
        messages.some(
          (m) => m.role === "assistant" && m.content === "인자를 고쳐서 다시 시도하겠습니다",
        ),
      ).toBe(true);
    });
  });

  it("persists a stream failure's partial turn with the stream-error marker", async () => {
    await withTmpMemory(async (memoryManager) => {
      const provider = new ScriptedProvider([
        [
          { type: "text_delta", text: "부분 응답" },
          { type: "error", error: "provider exploded" },
        ],
      ]);

      const result = await buildLoop(
        memoryManager,
        new ToolRegistry(),
        provider,
      ).runTurn("스트림 실패", undefined, undefined, { ...userKeyboardTurn() });

      expect(result.stopReason).toBe("stream-error");
      const messages = persisted(memoryManager);
      expect(messages[0]).toMatchObject({ role: "user", content: "스트림 실패" });
      const notice = messages.find(
        (m) => m.role === "assistant" && m.meta?.systemNotice === "stream-error",
      );
      expect(notice).toBeDefined();
    });
  });

  it("replays a persisted mid-turn failure through historyToEntries", async () => {
    await withTmpMemory(async (memoryManager) => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(inputRejectingTool("boom"));
      const provider = new ScriptedProvider([
        [
          { type: "text_delta", text: "작업 시작" },
          { type: "tool_call", id: "call-1", name: "input_rejecting_tool", input: {} },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [{ type: "message_complete", stopReason: "end_turn" }],
      ]);
      const loop = buildLoop(memoryManager, toolRegistry, provider);

      await loop.runTurn("리로드 확인", undefined, undefined, {
        ...userKeyboardTurn(),
      });

      // Reload repairs tool pairs before the renderer projects persisted history.
      const reloadLoop = buildLoop(memoryManager, new ToolRegistry(), provider);
      expect(await reloadLoop.loadSession(SESSION_ID)).toBe(true);
      const entries = historyToEntries(
        reloadLoop
          .getHistory()
          .getMessages()
          .map((message, index) => serializeHistoryMessage(message, index)),
      );

      expect(entries.some((e) => e.kind === "user" && e.text === "리로드 확인")).toBe(true);
      expect(entries.some((e) => e.kind === "assistant" && e.text === "작업 시작")).toBe(true);
    });
  });

  it("persists each tool call's registry origin so a reload keeps plugin/MCP counts", async () => {
    await withTmpMemory(async (memoryManager) => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(
        createDynamicTool({
          name: "probe_plugin_tool",
          description: "plugin-owned",
          source: "plugin",
          pluginId: "probe-plugin",
          category: "read",
          jsonSchema: { type: "object", properties: {} },
          execute: async () => ({ output: "plugin ok", isError: false }),
        }),
      );
      toolRegistry.register(
        createDynamicTool({
          name: "probe_mcp_tool",
          description: "server-owned",
          source: "mcp",
          mcpServerId: "probe-server",
          category: "read",
          jsonSchema: { type: "object", properties: {} },
          execute: async () => ({ output: "mcp ok", isError: false }),
        }),
      );
      const provider = new ScriptedProvider([
        [
          { type: "tool_call", id: "call-plugin", name: "probe_plugin_tool", input: {} },
          { type: "tool_call", id: "call-mcp", name: "probe_mcp_tool", input: {} },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [{ type: "text_delta", text: "끝" }, { type: "message_complete", stopReason: "end_turn" }],
      ]);

      await buildLoop(memoryManager, toolRegistry, provider).runTurn(
        "출처 확인",
        undefined,
        undefined,
        { ...userKeyboardTurn() },
      );

      // An empty registry proves tool attribution was persisted rather than looked up live.
      const reloadLoop = buildLoop(memoryManager, new ToolRegistry(), provider);
      expect(await reloadLoop.loadSession(SESSION_ID)).toBe(true);
      const serialized = reloadLoop
        .getHistory()
        .getMessages()
        .map((message, index) => serializeHistoryMessage(message, index));

      const toolCalls = serialized.find((m) => m.role === "assistant" && m.toolCalls)?.toolCalls;
      expect(toolCalls).toEqual([
        expect.objectContaining({
          id: "call-plugin",
          name: "probe_plugin_tool",
          source: "plugin",
          category: "read",
          pluginId: "probe-plugin",
        }),
        expect.objectContaining({
          id: "call-mcp",
          name: "probe_mcp_tool",
          source: "mcp",
          category: "read",
          mcpServerId: "probe-server",
        }),
      ]);

      const activity = computeToolActivity(historyToEntries(serialized));
      expect(activity.pluginCallCount).toBe(1);
      expect(activity.mcpCallCount).toBe(1);
    });
  });
});
