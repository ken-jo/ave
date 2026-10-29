import { describe, it, expect, vi } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnInput,
} from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { EAGER_TOOL_EXPOSURE_CEILING } from "../../shared/tool-exposure-policy.js";
import { endTurnScript } from "./conversation-loop-test-helpers.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

class RecordingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  readonly observedToolNames: string[][] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(input: StreamTurnInput): AsyncIterable<StreamEvent> {
    this.observedToolNames.push((input.tools ?? []).map((t) => t.name));
    yield* this.turns[this.index++] ?? [];
  }
}

function makeLoop(opts: {
  provider: LLMProvider;
  availablePluginIds: string[];
  inactivePluginIds?: string[];
  allowedPluginIds?: string[];
  forcedActivePluginIds?: string[];
  forcedActiveToolNames?: string[];
  extraPluginTools?: Array<{ pluginId: string; name: string }>;
  deniedToolPatterns?: string[];
  // Session activation must not persist the plugin enabled state.
  setPluginEnabled?: (pluginId: string, enabled: boolean) => Promise<void>;
}): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createDynamicTool({
    name: "request_plugin",
    description: "활성화 요청",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["pluginId"],
      properties: { pluginId: { type: "string" } },
    },
    execute: async () => ({ output: "unreachable", isError: false }),
  }),
  );
  toolRegistry.register(createDynamicTool({
    name: TOOL_SEARCH_TOOL_NAME,
    description: "도구 검색",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    execute: async () => ({ output: "unreachable", isError: false }),
  }),
  );
  toolRegistry.register(createDynamicTool({
    name: "meeting_start",
    description: "회의 시작",
    source: "plugin",
    pluginId: "com.example.meeting",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "started", isError: false }),
  }),
  );
  toolRegistry.register(createDynamicTool({
    name: "index_scan_status",
    description: "로컬 인덱서 상태 확인",
    source: "plugin",
    pluginId: "local-indexer",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "indexed", isError: false }),
  }),
  );
  for (const tool of opts.extraPluginTools ?? []) {
    toolRegistry.register(createDynamicTool({
      name: tool.name,
      description: `${tool.pluginId} ${tool.name}`,
        source: "plugin",
        pluginId: tool.pluginId,
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "ok", isError: false }),
      }),
    );
  }
  if (opts.deniedToolPatterns) {
    toolRegistry.setDenyRules(
      opts.deniedToolPatterns.map((pattern) => ({ pattern })),
    );
  }

  const inputClassifier = new InputClassifier();
  const routeEngine = new RouteEngine();

  const loop = new ConversationLoop({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: {
      build: () => "system",
      setToolScope: () => {},
    },
    inputClassifier,
    routeEngine,
    toolRegistry,
    memoryManager: {
      saveSession: () => {},
      listSessions: () => [],
    },
    pluginRuntime: {
      listPluginIds: () => opts.availablePluginIds,
      isPluginEnabled: (pluginId: string) =>
        !(opts.inactivePluginIds ?? []).includes(pluginId),
      ...(opts.setPluginEnabled
        ? { setPluginEnabled: opts.setPluginEnabled }
        : {}),
    },
    ...(opts.allowedPluginIds
      ? { allowedPluginIds: new Set(opts.allowedPluginIds) }
      : {}),
    ...(opts.forcedActivePluginIds
      ? { forcedActivePluginIds: new Set(opts.forcedActivePluginIds) }
      : {}),
    ...(opts.forcedActiveToolNames
      ? { forcedActiveToolNames: new Set(opts.forcedActiveToolNames) }
      : {}),
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = opts.provider;
  return loop;
}

describe("ConversationLoop — request_plugin meta tool (Option C)", () => {
  it("activates a plugin and exposes its full tool suite eagerly (#1176)", async () => {
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "com.example.meeting" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "활성화 완료" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      availablePluginIds: ["com.example.meeting"],
    });
    const result = await loop.runTurn("일반 질문", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    expect(result.text).toBe("활성화 완료");
    expect(provider.observedToolNames[0]).not.toContain("meeting_start");
    // Below the eager ceiling, activation exposes the full suite without tool_search.
    expect(provider.observedToolNames[1]).toContain("meeting_start");
    const messages = loop.getHistory().getMessages();
    const toolResult = messages.find((m) => m.role === "tool_result") as
      | { content: string }
      | undefined;
    expect(toolResult?.content).toContain("모두 로드됨");
    expect(toolResult?.content).not.toContain("tool_search");
  });

  it("treats same-round request_plugin -> tool_search for an eagerly loaded tool as already loaded", async () => {
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "local-indexer" },
        },
        {
          type: "tool_call",
          id: "tu-2",
          name: TOOL_SEARCH_TOOL_NAME,
          input: { query: "index_scan_status" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "tu-3", name: "index_scan_status", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "인덱서 상태를 확인했습니다." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, availablePluginIds: ["local-indexer"] });
    const result = await loop.runTurn("일반 질문", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    expect(result.text).toBe("인덱서 상태를 확인했습니다.");
    expect(provider.observedToolNames[0]).not.toContain("index_scan_status");
    expect(provider.observedToolNames[1]).toContain("index_scan_status");
    const toolResults = loop
      .getHistory()
      .getMessages()
      .filter((m) => m.role === "tool_result") as Array<{
      content: string;
      isError?: boolean;
      toolName?: string;
    }>;
    const searchResult = toolResults.find(
      (m) => m.toolName === TOOL_SEARCH_TOOL_NAME,
    );
    expect(searchResult?.isError).not.toBe(true);
    expect(searchResult?.content).toContain("이미 로드");
  });

  it("returns error tool_result for unknown pluginId", async () => {
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "nope.nope" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "미등록 플러그인입니다." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      availablePluginIds: ["com.example.meeting"],
    });
    const result = await loop.runTurn("아무거나", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    expect(result.text).toBe("미등록 플러그인입니다.");
    const messages = loop.getHistory().getMessages();
    const toolResult = messages.find((m) => m.role === "tool_result") as
      | { content: string; isError?: boolean }
      | undefined;
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toContain("알 수 없는 익스텐션 ID");
  });

  it("rejects request_plugin for a loaded but inactive plugin", async () => {
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "com.example.meeting" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "inactive rejected" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      availablePluginIds: ["com.example.meeting"],
      inactivePluginIds: ["com.example.meeting"],
    });

    await loop.runTurn("일반 질문", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.observedToolNames[0]).not.toContain("meeting_start");
    const messages = loop.getHistory().getMessages();
    const toolResult = messages.find((m) => m.role === "tool_result") as
      | { content: string; isError?: boolean }
      | undefined;
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toContain("알 수 없는 익스텐션 ID");
    expect(toolResult?.content).toContain("(없음)");
  });

  it("recomputes deferral after request_plugin crosses the eager exposure ceiling", async () => {
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "heavy-plugin" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "deferred" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const extraPluginTools = Array.from(
      { length: EAGER_TOOL_EXPOSURE_CEILING },
      (_, index) => ({
        pluginId: "heavy-plugin",
        name: `heavy_tool_${index}`,
      }),
    );
    const loop = makeLoop({
      provider,
      availablePluginIds: ["heavy-plugin"],
      extraPluginTools,
    });

    await loop.runTurn("heavy", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.observedToolNames[0]).not.toContain("heavy_tool_0");
    expect(provider.observedToolNames[1]).toContain(TOOL_SEARCH_TOOL_NAME);
    expect(provider.observedToolNames[1]).not.toContain("heavy_tool_199");
    const messages = loop.getHistory().getMessages();
    const toolResult = messages.find((m) => m.role === "tool_result") as
      | { content: string; isError?: boolean }
      | undefined;
    expect(toolResult?.isError).not.toBe(true);
    expect(toolResult?.content).toContain("tool_search");
    expect(toolResult?.content).not.toContain("모두 로드됨");
  });

  it("counts only policy-visible tools when deciding the eager exposure ceiling", async () => {
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "heavy-plugin" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "visible eager" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const extraPluginTools = Array.from(
      { length: EAGER_TOOL_EXPOSURE_CEILING },
      (_, index) => ({
        pluginId: "heavy-plugin",
        name: `heavy_tool_${index}`,
      }),
    );
    const loop = makeLoop({
      provider,
      availablePluginIds: ["heavy-plugin"],
      extraPluginTools,
      deniedToolPatterns: ["heavy_tool_199"],
    });

    await loop.runTurn("heavy", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.observedToolNames[1]).toContain("heavy_tool_198");
    expect(provider.observedToolNames[1]).not.toContain("heavy_tool_199");
    const messages = loop.getHistory().getMessages();
    const toolResult = messages.find((m) => m.role === "tool_result") as
      | { content: string; isError?: boolean }
      | undefined;
    expect(toolResult?.isError).not.toBe(true);
    expect(toolResult?.content).toContain("모두 로드됨");
    expect(toolResult?.content).not.toContain("tool_search");
  });

  it("enforces MAX_PLUGIN_EXPANSION (=2) per turn", async () => {
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "p1" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_call",
          id: "tu-2",
          name: "request_plugin",
          input: { pluginId: "p2" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_call",
          id: "tu-3",
          name: "request_plugin",
          input: { pluginId: "p3" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, availablePluginIds: ["p1", "p2", "p3"] });
    await loop.runTurn("trigger", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    const messages = loop.getHistory().getMessages();
    const toolResults = messages.filter(
      (m) => m.role === "tool_result",
    ) as Array<{ content: string; isError?: boolean }>;
    expect(toolResults.length).toBe(3);
    expect(toolResults[0].isError).not.toBe(true);
    expect(toolResults[1].isError).not.toBe(true);
    expect(toolResults[2].isError).toBe(true);
    expect(toolResults[2].content).toContain("한도 초과");
  });

  it("rejects request_plugin outside the loop allowedPluginIds scope", async () => {
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "com.example.meeting" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "blocked" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      availablePluginIds: ["com.example.meeting"],
      allowedPluginIds: [],
    });

    await loop.runTurn("일반 질문", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.observedToolNames[0]).not.toContain("meeting_start");
    const messages = loop.getHistory().getMessages();
    const toolResult = messages.find((m) => m.role === "tool_result") as
      | { content: string; isError?: boolean }
      | undefined;
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toContain("알 수 없는 익스텐션 ID");
  });

  it("keeps explicitly allowlisted tools visible even when allowedPluginIds is deny-all", async () => {
    const provider = new RecordingProvider(endTurnScript("done"));
    const loop = makeLoop({
      provider,
      availablePluginIds: ["com.example.meeting"],
      allowedPluginIds: [],
      forcedActivePluginIds: ["com.example.meeting"],
      forcedActiveToolNames: ["meeting_start"],
    });

    await loop.runTurn("일반 질문", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.observedToolNames[0]).toContain("meeting_start");
  });
});

describe("ConversationLoop — session-scoped on-demand activation (Option C, disabled+allow-listed)", () => {
  it("activates an allow-listed DISABLED plugin for the session WITHOUT persisting (non-persistent)", async () => {
    const setPluginEnabled = vi.fn(async () => {});
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "local-indexer" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "활성화 완료" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      // Session activation must carry plugin scope across later turns.
      [
        { type: "text_delta", text: "다음 턴" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      availablePluginIds: ["local-indexer"],
      inactivePluginIds: ["local-indexer"],
      allowedPluginIds: ["local-indexer"],
      setPluginEnabled,
    });

    await loop.runTurn("야간 재스캔", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    await loop.runTurn("다시 확인", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.observedToolNames[0]).not.toContain("index_scan_status");
    expect(provider.observedToolNames[1]).toContain("index_scan_status");
    expect(provider.observedToolNames[2]).toContain("index_scan_status");

    const toolResult = loop
      .getHistory()
      .getMessages()
      .find((m) => m.role === "tool_result") as
      | { isError?: boolean }
      | undefined;
    expect(toolResult?.isError).not.toBe(true);

    // Session activation must leave the registry enabled state unchanged.
    expect(setPluginEnabled).not.toHaveBeenCalled();
  });

  it("keeps a NON-allow-listed disabled plugin blocked at the request gate", async () => {
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "com.example.meeting" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "blocked" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      availablePluginIds: ["local-indexer", "com.example.meeting"],
      inactivePluginIds: ["local-indexer", "com.example.meeting"],
      allowedPluginIds: ["local-indexer"],
    });

    await loop.runTurn("회의 시작", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.observedToolNames[0]).not.toContain("meeting_start");
    const toolResult = loop
      .getHistory()
      .getMessages()
      .find((m) => m.role === "tool_result") as
      | { content: string; isError?: boolean }
      | undefined;
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toContain("알 수 없는 익스텐션 ID");
  });

  it("main chat (allowedPluginIds undefined) cannot activate a disabled plugin — gates intact", async () => {
    const setPluginEnabled = vi.fn(async () => {});
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "local-indexer" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "blocked" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      availablePluginIds: ["local-indexer"],
      inactivePluginIds: ["local-indexer"],
      setPluginEnabled,
    });

    await loop.runTurn("일반 질문", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.observedToolNames[0]).not.toContain("index_scan_status");
    expect(provider.observedToolNames[1]).not.toContain("index_scan_status");
    const toolResult = loop
      .getHistory()
      .getMessages()
      .find((m) => m.role === "tool_result") as
      | { content: string; isError?: boolean }
      | undefined;
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toContain("알 수 없는 익스텐션 ID");
    expect(setPluginEnabled).not.toHaveBeenCalled();
  });
});

// Loops without disable callbacks must re-read runtime enabled state before carrying scope forward.
describe("ConversationLoop — disable invalidates carried-forward scope without onPluginDisabled", () => {
  it("drops a session-activated plugin the turn after it is disabled (side-chat shape)", async () => {
    const inactivePluginIds: string[] = [];
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "com.example.meeting" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "활성화됨" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "계속" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    // With no forced or allowed plugin IDs, only carried scope can expose the plugin next turn.
    const loop = makeLoop({
      provider,
      availablePluginIds: ["com.example.meeting"],
      inactivePluginIds,
    });

    await loop.runTurn("회의 정리해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    expect(provider.observedToolNames[1]).toContain("meeting_start");
    expect(
      (loop as unknown as { lastTurnScope: Set<string> | null }).lastTurnScope,
    ).toContain("com.example.meeting");

    // Omit the disable callback to match loops not wired to the runtime notification.
    inactivePluginIds.push("com.example.meeting");

    await loop.runTurn("계속 진행해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.observedToolNames[2]).not.toContain("meeting_start");
    expect(provider.observedToolNames[2]).toContain("request_plugin");
  });

  it("keeps the plugin in scope while it stays enabled (control)", async () => {
    const inactivePluginIds: string[] = [];
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: "request_plugin",
          input: { pluginId: "com.example.meeting" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "활성화됨" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "계속" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      availablePluginIds: ["com.example.meeting"],
      inactivePluginIds,
    });

    await loop.runTurn("회의 정리해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    await loop.runTurn("계속 진행해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    // The unchanged-plugin control prevents an always-empty carried scope from passing.
    expect(provider.observedToolNames[2]).toContain("meeting_start");
  });
});
