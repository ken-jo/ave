import { describe, it, expect, vi } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams,
} from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../tools/registry.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { EAGER_TOOL_EXPOSURE_CEILING } from "../../shared/tool-exposure-policy.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import type { TurnDecisionEvent } from "../turn/types.js";
import { endTurnScript } from "./conversation-loop-test-helpers.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

type CapturedToolExposure = {
  loadedToolCount: number;
  deferredCatalogCount: number;
  deferralEligibleLoadedCount: number;
  deferredLoadedRatio: number | null;
};

class RecordingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  readonly observedToolNames: string[][] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.observedToolNames.push((input.tools ?? []).map((t) => t.name));
    yield* this.turns[this.index++] ?? [];
  }
}

function readonlyPluginTool(name: string, pluginId: string) {
  return createDynamicTool({
    name,
    description: `${name} desc`,
    source: "plugin" as const,
    category: "read" as const,
    pluginId,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  });
}

function makeLoop(opts: {
  provider: LLMProvider;
  headless?: boolean;
  auditLogger?: AuditLogger;
  inactivePluginIds?: Set<string>;
  extraMeetingTools?: number;
}): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(
    createDynamicTool({
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
  toolRegistry.register(
    readonlyPluginTool("meeting_start", "com.example.meeting"),
  );
  toolRegistry.register(
    readonlyPluginTool("meeting_stop", "com.example.meeting"),
  );
  toolRegistry.register(readonlyPluginTool("email_list", "com.example.email"));
  toolRegistry.register(
    readonlyPluginTool("samplemail_email_list", "com.example.samplemail"),
  );
  toolRegistry.register(
    createDynamicTool({
      name: "mcp_fetch",
      description: "MCP fetch",
      source: "mcp",
      category: "read",
      mcpServerId: "browser",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "mcp", isError: false }),
    }),
  );
  for (let i = 0; i < (opts.extraMeetingTools ?? 0); i += 1) {
    toolRegistry.register(
      readonlyPluginTool(`meeting_extra_${i}`, "com.example.meeting"),
    );
  }

  const inputClassifier = new InputClassifier();
  const routeEngine = new RouteEngine();
  const inactive = opts.inactivePluginIds ?? new Set<string>();

  const loop = new ConversationLoop({
    settingsService: {
      get: (key: string) => (key === "experimental" ? {} : fakeLlmSettings()),
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
      listPluginIds: () => [
        "com.example.meeting",
        "com.example.email",
        "com.example.samplemail",
      ],
      isPluginEnabled: (pluginId: string) => !inactive.has(pluginId),
    },
    // Plugin scope is host-selected; natural-language keywords cannot activate tools.
    forcedActivePluginIds: ["com.example.meeting"],
    headless: opts.headless,
    ...(opts.auditLogger ? { auditLogger: opts.auditLogger } : {}),
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as unknown as { provider: LLMProvider | null }).provider =
    opts.provider;
  return loop;
}

describe("ConversationLoop — eager active-plugin tool exposure (#1176)", () => {
  it("exposes the active plugin's whole suite eagerly with zero tool_search (indexer-like)", async () => {
    const provider = new RecordingProvider([
      [
        { type: "tool_call", id: "tu-1", name: "meeting_stop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "완료" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider });
    const result = await loop.runTurn("회의 정리해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    expect(result.text).toBe("완료");

    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).toContain("meeting_stop");
    expect(provider.observedToolNames[0]).not.toContain("email_list");
    const searchCalls = loop
      .getHistory()
      .getMessages()
      .filter(
        (m) => m.role === "tool_result" && m.toolName === TOOL_SEARCH_TOOL_NAME,
      );
    expect(searchCalls).toHaveLength(0);
  });

  it("emits an empty catalog and a 0 deferred ratio in eager mode", async () => {
    const provider = new RecordingProvider(endTurnScript("ok"));
    const auditLogger = new AuditLogger();
    const captured: CapturedToolExposure[] = [];
    vi.spyOn(auditLogger, "logTurn").mockImplementation(
      (params: { toolExposure?: CapturedToolExposure }) => {
        if (params.toolExposure) captured.push(params.toolExposure);
      },
    );
    const loop = makeLoop({ provider, auditLogger });
    await loop.runTurn("회의 정리해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(captured).toHaveLength(1);
    const exposure = captured[0];
    expect(exposure.deferralEligibleLoadedCount).toBe(3);
    expect(exposure.deferredCatalogCount).toBe(0);
    expect(exposure.deferredLoadedRatio).toBe(0);
  });
});

describe("ConversationLoop — active/inactive plugin gating (#1176)", () => {
  it("hides a disabled plugin's tools from both schema and catalog", async () => {
    const provider = new RecordingProvider(endTurnScript("ok"));
    const loop = makeLoop({
      provider,
      inactivePluginIds: new Set(["com.example.meeting"]),
    });
    await loop.runTurn("회의 정리해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.observedToolNames[0]).not.toContain("meeting_start");
    expect(provider.observedToolNames[0]).not.toContain("meeting_stop");
    expect(provider.observedToolNames[0]).toContain(TOOL_SEARCH_TOOL_NAME);
  });

  it("re-exposes the suite once the plugin is active again", async () => {
    const provider = new RecordingProvider(endTurnScript("ok"));
    const loop = makeLoop({ provider });
    await loop.runTurn("회의 정리해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).toContain("meeting_stop");
  });

  // Forced scope bypasses carry-forward; only the per-turn enabled check can drop disabled tools.
  it("re-disabling a forced-active plugin drops its tools even though onPluginDisabled cannot prune forced scope", async () => {
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "meeting scoped" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "after disable" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const inactivePluginIds = new Set<string>();
    const loop = makeLoop({ provider, inactivePluginIds });
    await loop.runTurn("회의 정리해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    expect(provider.observedToolNames[0]).toContain("meeting_start");

    inactivePluginIds.add("com.example.meeting");
    loop.onPluginDisabled("com.example.meeting");
    await loop.runTurn("계속 진행해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    expect(provider.observedToolNames[1]).not.toContain("meeting_start");
    expect(provider.observedToolNames[1]).not.toContain("meeting_stop");
  });
});

describe("ConversationLoop — deferral ceiling (#1176)", () => {
  it("falls back to deferral at/above the eligible-tool ceiling", async () => {
    // Exclude MCP in headless mode to make the plugin-only ceiling count exact.
    const extra = EAGER_TOOL_EXPOSURE_CEILING;
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: TOOL_SEARCH_TOOL_NAME,
          input: { query: "meeting_stop" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "tu-2", name: "meeting_stop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "완료" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      extraMeetingTools: extra,
      headless: true,
    });
    const result = await loop.runTurn("회의 정리해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    expect(result.text).toBe("완료");

    expect(provider.observedToolNames[0]).not.toContain("meeting_start");
    expect(provider.observedToolNames[0]).not.toContain("meeting_stop");
    expect(provider.observedToolNames[0]).toContain(TOOL_SEARCH_TOOL_NAME);
    expect(provider.observedToolNames[1]).toContain("meeting_stop");
  });

  it("reports the promotion as a loop decision so the round it bought is attributable", async () => {
    const provider = new RecordingProvider([
      [
        {
          type: "tool_call",
          id: "tu-1",
          name: TOOL_SEARCH_TOOL_NAME,
          input: { query: "meeting_stop" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "완료" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      extraMeetingTools: EAGER_TOOL_EXPOSURE_CEILING,
      headless: true,
    });
    const decisions: TurnDecisionEvent[] = [];

    await loop.runTurn("회의 정리해줘", {
      onDecision: (event) => { decisions.push(event); },
    }, undefined, { ...userKeyboardTurn() });

    expect(decisions).toContainEqual(expect.objectContaining({
      kind: "tool_search",
      branch: "promoted",
      data: expect.objectContaining({ requested: 1 }),
    }));
  });

  it("does NOT count builtins toward the ceiling (eager just below it)", async () => {
    // Builtins do not count toward the eager ceiling.
    const extra = EAGER_TOOL_EXPOSURE_CEILING - 3;
    const provider = new RecordingProvider([
      [
        { type: "tool_call", id: "tu-1", name: "meeting_stop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "완료" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      extraMeetingTools: extra,
      headless: true,
    });
    const result = await loop.runTurn("회의 정리해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });
    expect(result.text).toBe("완료");

    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).toContain("meeting_stop");
    const searchCalls = loop
      .getHistory()
      .getMessages()
      .filter(
        (m) => m.role === "tool_result" && m.toolName === TOOL_SEARCH_TOOL_NAME,
      );
    expect(searchCalls).toHaveLength(0);
  });

  it("treats exactly the ceiling as the deferral boundary", async () => {
    // Deferral begins inclusively at the ceiling.
    const extra = EAGER_TOOL_EXPOSURE_CEILING - 2;
    const provider = new RecordingProvider(endTurnScript("ok"));
    const loop = makeLoop({
      provider,
      extraMeetingTools: extra,
      headless: true,
    });
    await loop.runTurn("회의 정리해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.observedToolNames[0]).not.toContain("meeting_start");
    expect(provider.observedToolNames[0]).not.toContain("meeting_stop");
    expect(provider.observedToolNames[0]).toContain(TOOL_SEARCH_TOOL_NAME);
  });
});

describe("ConversationLoop — headless MCP scope (#1176 eager)", () => {
  it("keeps MCP tools out of a headless turn (eager mode, no MCP in scope)", async () => {
    const provider = new RecordingProvider(endTurnScript("no mcp"));
    const loop = makeLoop({ provider, headless: true });
    const result = await loop.runTurn("회의 정리해줘", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(result.text).toBe("no mcp");
    expect(provider.observedToolNames[0]).not.toContain("mcp_fetch");
    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).toContain("meeting_stop");
  });
});
