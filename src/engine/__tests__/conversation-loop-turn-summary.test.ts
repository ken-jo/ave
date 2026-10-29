import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams, ToolSchema, TurnSummary,
} from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { PostTurnHookChain } from "../../hooks/post-turn-hook-chain.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { aveHome } from "../../shared/ave-home.js";
import { llmModelListCacheKey } from "../../shared/llm-model-list.js";
import { FallbackProvider } from "../llm/vercel/fallback-chain.js";
import { VercelUnifiedProvider } from "../llm/vercel/adapter.js";
import { estimateRequestInputProjection } from "../request-input-projection.js";
import { contextBudgetForCurrentRuntime } from "../turn/compaction.js";
import { activeModelCatalog, installModelCatalog } from "../../shared/model-catalog/active.js";
import {
  A2A_INPUT_REQUIRED_CONTROL_KIND,
  A2A_INPUT_REQUIRED_CONTROL_VERSION,
} from "../../tools/agent-send.js";
import { endTurnScript } from "./conversation-loop-test-helpers.js";
import { ScriptedTurnProvider as FakeProvider } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

// Real filesystem I/O can schedule lock retries after fake time has advanced.
const retrySleep = vi.hoisted(() => ({ skip: false }));
vi.mock("../../shared/abortable-deadline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/abortable-deadline.js")>();
  return { ...actual, sleep: (ms: number, signal?: AbortSignal) => retrySleep.skip ? Promise.resolve() : actual.sleep(ms, signal) };
});

afterEach(() => {
  vi.useRealTimers();
});

const CODEX_USAGE_SUBSCRIPTION = {
  kind: "subscription",
  provider: "codex",
  model: "gpt-5.5-codex",
} as const;

function fakeUsageReportingSubscriptionSettings() {
  return {
    // Keep an inactive API-key vendor to verify subscription execution and accounting own the turn.
    ...fakeLlmSettings({ provider: "claude", model: "claude-sonnet-4-6" }),
    activeChatRuntime: CODEX_USAGE_SUBSCRIPTION,
  };
}

function createUsageReportingSubscriptionProvider(): LLMProvider {
  const primary: LLMProvider = {
    vendor: "openai",
    subscriptionRuntime: CODEX_USAGE_SUBSCRIPTION,
    async *streamTurn(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: "subscription answer" };
      yield {
        type: "message_complete",
        stopReason: "end_turn",
        subscriptionUsage: {
          provider: "codex",
          model: "gpt-5.5-codex",
          source: "provider-reported",
          billable: false,
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 500,
          cacheWriteTokens: 100,
          reasoningOutputTokens: 30,
          contextWindow: 64_000,
          totalTokens: 1_830,
        },
      };
    },
  };
  return new FallbackProvider(primary, [], () => "test-key");
}

function createLoopWithRegistry(
  provider: LLMProvider,
  toolRegistry: ToolRegistry,
  overrides: Partial<ConstructorParameters<typeof ConversationLoop>[0]> = {},
): ConversationLoop {
  const inputClassifier = new InputClassifier();
  const routeEngine = new RouteEngine();
  const loop = new ConversationLoop({
    settingsService: {
      get: () => fakeLlmSettings({ model: "gpt-5.4-mini" }),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    inputClassifier,
    routeEngine,
    toolRegistry,
    memoryManager: {
      saveSession: () => {},
      listSessions: () => [],
    },
    ...overrides,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

function visibleToolSchemas(toolRegistry: ToolRegistry): ToolSchema[] {
  return toolRegistry.getToolSchemasForScope({
    activePluginIds: new Set<string>(),
    includeBuiltins: true,
    includeMcp: false,
    includeEgress: true,
  }).map((schema) => ({
    name: schema.name,
    description: schema.description,
    inputSchema: schema.input_schema as ToolSchema["inputSchema"],
  }));
}

describe("ConversationLoop onTurnSummary", () => {
  it("emits the aggregate footer with step count, token usage, and per-tool breakdown", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "list_directory",
      description: "List files",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"],
        },
      isReadOnly: () => true,
      execute: async () => ({ output: "src\npackage.json", isError: false }),
    }),
    );
    toolRegistry.register(createDynamicTool({
      name: "read_file",
      description: "Read file",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"],
        },
      isReadOnly: () => true,
      execute: async () => ({ output: "contents", isError: false }),
    }),
    );

    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "looking" },
        { type: "tool_call", id: "t-1", name: "list_directory", input: { path: "src" },
        },
        { type: "tool_call", id: "t-2", name: "read_file", input: { path: "a" },
        },
        { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 20 },
        },
      ],
      [
        { type: "text_delta", text: "more" },
        { type: "tool_call", id: "t-3", name: "read_file", input: { path: "b" },
        },
        { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 80, outputTokens: 15 },
        },
      ],
      [
        { type: "text_delta", text: "answer" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 60, outputTokens: 10 },
        },
      ],
    ]);
    const loop = createLoopWithRegistry(provider, toolRegistry);

    let summary: {
          turnDurationMs: number;
          toolCount: number;
          cumulativeToolMs: number;
          tokensIn: number;
          tokensOut: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          breakdown?: Record<string, { count: number; ms: number }>;
        }
      | null = null;

    await loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { ...userKeyboardTurn() },
    );

    expect(summary).not.toBeNull();
    expect(summary!.toolCount).toBe(3);
    // Input tokens measure final projected context; output and cache tokens aggregate all rounds.
    expect(summary!.tokensIn).toBeGreaterThan(60);
    expect(summary!.tokensOut).toBe(45);
    expect(summary!.turnDurationMs).toBeGreaterThanOrEqual(0);
    // In-process tool wall time may round below one millisecond, but never below zero.
    expect(summary!.cumulativeToolMs).toBeGreaterThanOrEqual(0);
    expect(summary!.breakdown).toBeDefined();
    expect(summary!.breakdown!["read_file"].count).toBe(2);
    expect(summary!.breakdown!["list_directory"].count).toBe(1);
  });

  it("sends the effective output limit and records the route's resolved model settings", async () => {
    // The negotiated completion ceiling must constrain requests and appear in the turn record.
    const sent: Array<{ outputTokenLimit?: number }> = [];
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn(params) {
        sent.push({ outputTokenLimit: params.outputTokenLimit });
        yield { type: "text_delta", text: "answer" };
        yield { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 60, outputTokens: 10 } };
      },
    };
    const auditLogger = new AuditLogger();
    const logTurn = vi.spyOn(auditLogger, "logTurn");
    const loop = createLoopWithRegistry(provider, new ToolRegistry(), {
      settingsService: {
        get: () => ({
          ...fakeLlmSettings({ provider: "openai", model: "gpt-5.4-mini" }),
          modelListCache: {
            [llmModelListCacheKey("openai")]: {
              vendor: "openai",
              endpoint: "https://api.openai.com/v1/models",
              models: ["gpt-5.4-mini"],
              modelEntries: [{ id: "gpt-5.4-mini", maxOutputTokens: 8_192 }],
              fetchedAt: new Date(0).toISOString(),
            },
          },
        }),
        getSecret: () => "test-key",
      },
      auditLogger,
    } as never);
    let summary: TurnSummary | null = null;

    try {
      await loop.runTurn("질문", { onTurnSummary: (s) => { summary = s; } }, undefined, { ...userKeyboardTurn() });
    } finally {
      await auditLogger.close();
    }
    expect(auditLogger.getWriterStats().pendingWrites).toBe(0);
    expect(sent).toEqual([{ outputTokenLimit: 8_192 }]);
    const recorded = {
      modelCatalogSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      contextWindow: {
        tokens: 400_000,
        source: "model-catalog",
        catalogEntry: "openai/gpt-5.4-mini",
        inputLimit: { tokens: 272_000, source: "model-catalog" },
      },
      output: {
        requested: 32_000,
        requestedSource: "host-default",
        ceiling: 8_192,
        ceilingSource: "provider-reported",
        effective: 8_192,
        effectiveSource: "provider-reported",
      },
      reasoning: { kind: "openai-effort", requestedEffort: "medium", effort: "medium", source: "model-catalog" },
      pricing: {
        source: "model-catalog",
        catalogEntry: "openai/gpt-5.4-mini",
        rates: { inputPer1M: 0.75, outputPer1M: 4.5, cacheReadPer1M: 0.075 },
      },
    };
    expect(summary!.modelSettings).toEqual({ ...recorded, remainingContextOutputTokens: expect.any(Number) });
    expect(logTurn).toHaveBeenCalledWith(expect.objectContaining({ modelSettings: recorded }));
  });

  it.each(["unlisted", "without-output"].flatMap((entry) => [
    { entry, vendor: "openai" as const, model: "gpt-4", catalogProvider: "openai" },
    { entry, vendor: "claude" as const, model: "claude-3-haiku-20240307", catalogProvider: "anthropic" },
  ]))("records the unknown route ceiling and what every HTTP round serializes: $vendor ($entry)", async ({ entry, vendor, model, catalogProvider }) => {
    const catalog = activeModelCatalog();
    installModelCatalog({ ...catalog, providers: {
      ...catalog.providers,
      [catalogProvider]: { models: { ...catalog.providers[catalogProvider]!.models,
        "declared-model": { id: "declared-model", limits: { context: 128_000 } },
      } },
    } });
    const settings = fakeLlmSettings({ provider: vendor, model });
    settings.vendors[vendor].catalogModel = `${catalogProvider}/${entry === "unlisted" ? "not-listed" : "declared-model"}`;
    settings.vendors[vendor].enableThinking = false;
    const fetchResponse = vi.fn<typeof fetch>(async (): Promise<Response> => {
      const firstRound = fetchResponse.mock.calls.length === 1;
      if (vendor === "claude") {
        const contentEvents = firstRound ? [
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "ceiling-read", name: "read_value", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        ] : [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
        ];
        const events = [
          { type: "message_start", message: { id: "fixture-response", model, role: "assistant", usage: { input_tokens: 60 } } },
          ...contentEvents,
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: firstRound ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
          { type: "message_stop" },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(`data: ${JSON.stringify({
        id: "fixture-response", object: "chat.completion.chunk", created: 0, model,
        choices: [{ index: 0, delta: firstRound
          ? { role: "assistant", tool_calls: [{ index: 0, id: "ceiling-read", type: "function", function: { name: "read_value", arguments: "{}" } }] }
          : { role: "assistant", content: "answer" },
        finish_reason: firstRound ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 },
      })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const readValue = vi.fn(async () => ({ output: "value", isError: false }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "read_value", description: "Read the value.", source: "builtin", category: "read",
      jsonSchema: { type: "object", properties: {} }, isReadOnly: () => true, execute: readValue,
    }));
    const auditLogger = new AuditLogger();
    const logTurn = vi.spyOn(auditLogger, "logTurn");
    const loop = createLoopWithRegistry(new VercelUnifiedProvider(vendor, "fixture-key", "https://provider.invalid/v1", fetchResponse), toolRegistry, {
      settingsService: { get: () => settings, getSecret: () => "fixture-key" }, auditLogger,
    } as never);
    let summary: TurnSummary | undefined;
    try {
      const result = await loop.runTurn("Report the result.", { onTurnSummary: (value) => { summary = value; } }, undefined, { ...userKeyboardTurn() });
      expect(result.text).toBe("answer");
      expect(readValue).toHaveBeenCalledOnce();
      expect(fetchResponse).toHaveBeenCalledTimes(2);
      const output = { requested: 32_000, requestedSource: "host-default", effective: 32_000, effectiveSource: "host-default" };
      expect(summary?.modelSettings?.output).toEqual(output);
      expect(logTurn).toHaveBeenCalledWith(expect.objectContaining({ modelSettings: expect.objectContaining({ output }) }));
      // Record native serialization limits even when the route ceiling is unknown.
      const sent = vendor === "claude" ? 4_096 : 32_000;
      for (const [, init] of fetchResponse.mock.calls) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.max_tokens ?? body.max_completion_tokens).toBe(sent);
      }
      if (vendor === "claude") {
        expect(summary?.modelSettings?.requestControls).toEqual({ outputTokenLimit: 4_096 });
      } else {
        expect(summary?.modelSettings).not.toHaveProperty("requestControls");
      }
    } finally {
      await auditLogger.close();
      installModelCatalog(catalog);
    }
    expect(auditLogger.getWriterStats().pendingWrites).toBe(0);
  });

  it("sends no tool definitions to a model the catalog says takes none, and records that", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "read_file",
      description: "Read file",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      isReadOnly: () => true,
      execute: async () => ({ output: "contents", isError: false }),
    }));
    const turnOn = async (model: string) => {
      const sentTools: Array<string[] | undefined> = [];
      const provider: LLMProvider = {
        vendor: "openai",
        async *streamTurn(params) {
          sentTools.push(params.tools?.map((tool) => tool.name));
          yield { type: "text_delta", text: "answer" };
          yield { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 60, outputTokens: 10 } };
        },
      };
      const loop = createLoopWithRegistry(provider, toolRegistry, {
        settingsService: { get: () => fakeLlmSettings({ provider: "openai", model }), getSecret: () => "test-key" },
      } as never);
      let summary: TurnSummary | null = null;
      await loop.runTurn("질문", { onTurnSummary: (s) => { summary = s; } }, undefined, { ...userKeyboardTurn() });
      return { sentTools, modelSettings: summary!.modelSettings };
    };

    const withheld = await turnOn("gpt-3.5-turbo");
    expect(withheld.sentTools).toEqual([undefined]);
    expect(withheld.modelSettings?.tools).toEqual({ sent: false, source: "model-catalog", catalogEntry: "openai/gpt-3.5-turbo" });
    const sent = await turnOn("gpt-5.4-mini");
    expect(sent.sentTools[0]).toContain("read_file");
    expect(sent.modelSettings).not.toHaveProperty("tools");
  });

  it("carries named route capabilities on every round alongside the recorded tool omission", async () => {
    const settings = fakeLlmSettings({ provider: "openai", model: "gpt-4.1" });
    settings.vendors.openai.catalogModel = "openai/gpt-3.5-turbo";
    const requests: StreamTurnParams[] = [];
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn(params) {
        requests.push(params);
        if (requests.length === 1) yield { type: "reasoning_delta", text: "Plan the answer." };
        else yield { type: "text_delta", text: "answer" };
        yield { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 60, outputTokens: 10 } };
      },
    };
    const loop = createLoopWithRegistry(provider, new ToolRegistry(), {
      settingsService: { get: () => settings, getSecret: () => "test-key" },
    } as never);
    let summary: TurnSummary | undefined;
    await loop.runTurn("Report the result.", { onTurnSummary: (value) => { summary = value; } }, undefined, { ...userKeyboardTurn() });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.tools).toBeUndefined();
      expect(request.modelCapabilities).toEqual({
        inputModalities: { input: ["text"], source: "model-catalog", catalogEntry: "openai/gpt-3.5-turbo" },
        toolCall: { supported: false, source: "model-catalog", catalogEntry: "openai/gpt-3.5-turbo" },
        reasoning: { supported: false, source: "model-catalog", catalogEntry: "openai/gpt-3.5-turbo" },
      });
      const toolCall = request.modelCapabilities?.toolCall;
      if (toolCall?.supported !== false) throw new Error("Expected tools to be withheld");
      expect(summary?.modelSettings?.tools).toEqual({
        sent: false, source: toolCall.source,
        catalogEntry: toolCall.catalogEntry,
      });
    }
  });

  it.each([false, true])("preserves the named route's HTTP tool omission with endpoint support %s", async (reportedTools) => {
    const settings = fakeLlmSettings({ provider: "openai", model: "gpt-4.1" });
    settings.vendors.openai.catalogModel = "openai/gpt-3.5-turbo";
    if (reportedTools) {
      settings.modelListCache = {
        [llmModelListCacheKey("openai", settings.vendors.openai.baseUrl, "")]: {
          vendor: "openai", models: ["gpt-4.1"], endpoint: "https://provider.invalid/v1/models",
          modelEntries: [{ id: "gpt-4.1", supportedParameters: ["tools"] }],
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response(
      `data: ${JSON.stringify({
        id: "fixture-response", object: "chat.completion.chunk", created: 0, model: "gpt-4.1",
        choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 },
      })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "read_file", description: "Read file", source: "builtin", category: "read",
      jsonSchema: { type: "object", properties: {} }, isReadOnly: () => true,
      execute: async () => ({ output: "contents", isError: false }),
    }));
    const loop = createLoopWithRegistry(new VercelUnifiedProvider("openai", "fixture-key", "https://provider.invalid/v1", fetchResponse), toolRegistry, {
      settingsService: { get: () => settings, getSecret: () => "test-key" },
    } as never);
    let summary: TurnSummary | undefined;
    const result = await loop.runTurn("Report the result.", { onTurnSummary: (value) => { summary = value; } }, undefined, { ...userKeyboardTurn() });
    expect(result.text).toBe("answer");
    expect(fetchResponse).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
    expect(summary?.modelSettings?.tools).toEqual({ sent: false, source: "model-catalog", catalogEntry: "openai/gpt-3.5-turbo" });
  });

  it("omits primary route settings when a fallback keeps the same vendor and model", async () => {
    vi.useFakeTimers();
    let signalPrimaryStarted!: () => void;
    const primaryStarted = new Promise<void>((resolve) => { signalPrimaryStarted = resolve; });
    const settings = fakeLlmSettings({ provider: "openai", model: "gpt-3.5-turbo" });
    settings.vendors.openai.catalogModel = "openai/gpt-4.1";
    const primary: LLMProvider = {
      vendor: "openai",
      async *streamTurn() { signalPrimaryStarted(); yield { type: "error", error: "503 fixture unavailable", classification: "network" }; },
    };
    const fallback = new FallbackProvider(primary, [{ provider: "openai", model: "gpt-3.5-turbo", baseUrl: "https://fallback.invalid/v1" }], () => "fixture-key", () => new FakeProvider([[
      { type: "text_delta", text: "fallback answer" },
      { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 60, outputTokens: 10 } },
    ]]));
    const memoryManager = new MemoryManager({ aveDir: aveHome() });
    const beginJournal = vi.spyOn(memoryManager, "beginTurnJournal");
    const loop = createLoopWithRegistry(fallback, new ToolRegistry(), {
      memoryManager,
      settingsService: { get: () => settings, getSecret: () => "test-key" },
    } as never);
    let summary: TurnSummary | undefined;
    const turn = loop.runTurn("Report the result.", { onTurnSummary: (value) => { summary = value; } }, undefined, { ...userKeyboardTurn() });
    await Promise.race([primaryStarted, turn]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await turn).text).toBe("fallback answer");
    expect(summary).toMatchObject({ vendorProvider: "openai", vendorModel: "gpt-3.5-turbo" });
    expect(summary?.modelSettings).toBeUndefined();
    expect(beginJournal).toHaveBeenCalledOnce();
    const persisted = memoryManager.loadSession(loop.getSessionId()) as GenericMessage[] | null;
    expect(persisted?.some((message) => message.role === "assistant" && message.content === "fallback answer")).toBe(true);
  });

  it("records a user price correction as the run's pricing and keeps reported reasoning tokens per request", async () => {
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn() {
        yield { type: "text_delta", text: "answer" };
        yield {
          type: "message_complete",
          stopReason: "end_turn",
          usage: { inputTokens: 60, outputTokens: 10, reasoningTokens: 4 },
        };
      },
    };
    const auditLogger = new AuditLogger();
    const logTurn = vi.spyOn(auditLogger, "logTurn");
    const loop = createLoopWithRegistry(provider, new ToolRegistry(), {
      settingsService: {
        get: () => ({
          ...fakeLlmSettings({ provider: "openai", model: "gpt-5.4-mini" }),
          pricingOverrides: [{ vendor: "openai", model: "gpt-5.4-mini", inputPer1M: 0.5, outputPer1M: 3 }],
        }),
        getSecret: () => "test-key",
      },
      auditLogger,
    } as never);
    let summary: TurnSummary | null = null;

    try {
      await loop.runTurn("질문", { onTurnSummary: (s) => { summary = s; } }, undefined, { ...userKeyboardTurn() });
    } finally {
      await auditLogger.close();
    }
    expect(auditLogger.getWriterStats().pendingWrites).toBe(0);
    expect(summary!.modelSettings?.pricing).toEqual({ source: "user", rates: { inputPer1M: 0.5, outputPer1M: 3 } });
    expect(summary!.usageByModel).toEqual([
      expect.objectContaining({ pricing: summary!.modelSettings!.pricing, tokenUsage: expect.objectContaining({ outputTokens: 10, reasoningTokens: 4 }) }),
    ]);
    expect(logTurn).toHaveBeenCalledWith(expect.objectContaining({
      usageByModel: [expect.objectContaining({ pricing: summary!.modelSettings!.pricing, tokenUsage: expect.objectContaining({ reasoningTokens: 4 }) })],
    }));
  });

  it("emits a summary for a turn whose only output was reasoning", async () => {
    const toolRegistry = new ToolRegistry();
    class AlwaysReasoningProvider implements LLMProvider {
      readonly vendor = "openai" as const;
      async *streamTurn(): AsyncIterable<StreamEvent> {
        yield { type: "reasoning_delta", text: "I should retry the install." };
        yield {
          type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 7 },
        };
      }
    }
    const loop = createLoopWithRegistry(new AlwaysReasoningProvider(), toolRegistry);

    const summaries: { tokensOut: number; endedByEndTurn?: true }[] = [];
    const result = await loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summaries.push(s);
      },
    }, undefined, { ...userKeyboardTurn() },
    );

    // Reasoning-only turns still need a summary to retain usage and cost accounting.
    expect(result.text).toBe("");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.tokensOut).toBe(21);
  });

  it("does not emit a summary for a round the provider returned blank", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 0 },
        },
      ],
    ]);
    const loop = createLoopWithRegistry(provider, toolRegistry);

    let calls = 0;
    await loop.runTurn("질문", {
      onTurnSummary: () => {
        calls += 1;
      },
    }, undefined, { ...userKeyboardTurn() },
    );

    expect(calls).toBe(0);
  });

  it("does not emit a summary for an interrupted turn", async () => {
    const toolRegistry = new ToolRegistry();
    const controller = new AbortController();
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn(): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", text: "partial" };
        controller.abort();
        yield {
          type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 3 },
        };
      },
    };
    const loop = createLoopWithRegistry(provider, toolRegistry);

    let calls = 0;
    const result = await loop.runTurn("질문", {
      onTurnSummary: () => {
        calls += 1;
      },
    }, controller.signal, { ...userKeyboardTurn() },
    );

    // Suppress summary footers for aborted and error turns with partial-round stats.
    expect(result.stopReason).toBe("interrupted");
    expect(calls).toBe(0);
  });

  it("keeps reporting usage for an input-required turn that answered before asking", async () => {
    // Input handoffs retain their completed-turn cost record.
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "agent_send",
      description: "question sender",
      source: "builtin",
      category: "meta",
      modelVisible: true,
      decisionOverride: "always-allow-with-audit",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({
        output: "sent",
        isError: false,
        metadata: {
          rawResult: {
            kind: A2A_INPUT_REQUIRED_CONTROL_KIND,
            version: A2A_INPUT_REQUIRED_CONTROL_VERSION,
            reason: "question" as const,
            prompt: "Which option?",
          },
        },
      }),
    }),
    );
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "I need one detail." },
        { type: "tool_call", id: "send-question", name: "agent_send", input: {},
        },
        { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 11, outputTokens: 4 },
        },
      ],
    ]);
    const loop = createLoopWithRegistry(provider, toolRegistry);

    const summaries: { tokensOut: number; endedByEndTurn?: true }[] = [];
    const result = await loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summaries.push(s);
      },
    }, undefined, { ...userKeyboardTurn() },
    );

    expect(result.stopReason).toBe("input-required");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.tokensOut).toBe(4);
    expect(summaries[0]!.endedByEndTurn).toBeUndefined();
  });

  it("persists turnSummary on the final post-summary save", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "저장된 답변" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 42, outputTokens: 7 },
        },
      ],
    ]);
    const saveSession = vi.fn(async () => {});
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      memoryManager: {
        saveSession,
        listSessions: () => [],
      } as never,
    });

    await loop.runTurn("질문", {}, undefined, { ...userKeyboardTurn() });

    expect(saveSession).toHaveBeenCalled();
    const lastCall = saveSession.mock.calls.at(-1);
    const savedMessages = lastCall?.[1] as GenericMessage[] | undefined;
    const finalAssistant = savedMessages?.slice().reverse().find((message) => message.role === "assistant");
    expect(finalAssistant?.meta?.turnSummary).toMatchObject({
      endedByEndTurn: true,
      tokensIn: expect.any(Number),
      tokensOut: 7,
      freshInputTokens: 42,
      vendorProvider: "openai",
      vendorModel: "gpt-5.4-mini",
    });
    expect(finalAssistant?.meta?.turnSummary?.tokensIn ?? 0).toBeGreaterThan(42,
    );
  });

  it("attributes fallback-served turns to the provider/model that actually streamed", async () => {
    vi.useFakeTimers();
    const toolRegistry = new ToolRegistry();
    let signalPrimaryStarted!: () => void;
    const primaryStarted = new Promise<void>((resolve) => { signalPrimaryStarted = resolve; });
    const primary: LLMProvider = {
      vendor: "claude",
      streamTurn: async function* () {
        signalPrimaryStarted();
        yield { type: "error", error: "500 internal server error", classification: "network",
        };
      },
    };
    const fallback = new FakeProvider([
      [
        { type: "text_delta", text: "fallback answer" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 },
        },
      ],
    ]);
    const provider = new FallbackProvider(
      primary,
      [{ provider: "openai", model: "gpt-5.4-mini" }],
      () => "test-key",
      () => fallback,
    );
    const saveSession = vi.fn(async () => {});
    const auditLogger = {
      logTurn: vi.fn(),
      logToolCall: vi.fn(),
      isPermissionAuditChainReady: () => false,
    };
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      disableSessionPersistence: false,
      settingsService: {
        get: () => fakeLlmSettings({ provider: "claude", model: "claude-sonnet-4-6" }),
        getSecret: () => "test-key",
      },
      memoryManager: { saveSession, listSessions: () => [] } as never,
      auditLogger: auditLogger as never,
    });

    let summary: { vendorProvider?: string; vendorModel?: string }
      | null = null;
    const pending = loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { ...userKeyboardTurn() },
    );
    // Finish checkpoint I/O before advancing the provider retry clock.
    await primaryStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    vi.useRealTimers();

    expect(summary).toMatchObject({
      vendorProvider: "openai",
      vendorModel: "gpt-5.4-mini",
    });
    const savedMessages = saveSession.mock.calls.at(-1)?.[1] as
      | GenericMessage[] | undefined;
    const finalAssistant = savedMessages?.slice().reverse().find((message) => message.role === "assistant");
    expect(finalAssistant?.meta?.turnSummary).toMatchObject({
      vendorProvider: "openai",
      vendorModel: "gpt-5.4-mini",
    });
    expect(auditLogger.logTurn).toHaveBeenCalledWith(
      expect.objectContaining({ route: "openai/gpt-5.4-mini" }),
    );
  });

  async function sameIdentityFallbackRecords(resumePrimary = false) {
    const model = "gpt-5.4-mini";
    const llm = fakeLlmSettings({ model });
    const primarySent: StreamTurnParams[] = [];
    const fallbackSent: StreamTurnParams[] = [];
    const provider = new FallbackProvider({
      vendor: "openai",
      async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
        primarySent.push(params);
        params.onRequestControls?.({ outputTokenLimit: params.outputTokenLimit! });
        if (primarySent.length <= 5) {
          yield { type: "error", error: "503 fixture unavailable", classification: "network" };
        } else {
          yield { type: "text_delta", text: "primary done" };
          yield { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 2 } };
        }
      },
    }, [{ provider: "openai", model }], () => "test-key", () => ({
      vendor: "openai",
      async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
        fallbackSent.push(params);
        params.onRequestControls?.({ outputTokenLimit: params.outputTokenLimit! });
        if (resumePrimary) yield { type: "tool_call", id: "fallback-call", name: "read_item", input: {} };
        else yield { type: "text_delta", text: "done" };
        yield { type: "message_complete", stopReason: resumePrimary ? "tool_use" : "end_turn", usage: { inputTokens: 10, outputTokens: 1 } };
      },
    }));
    const auditLogger = { logTurn: vi.fn(), logToolCall: vi.fn(), isPermissionAuditChainReady: () => false };
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "read_item", description: "Read an item", source: "builtin", category: "read", version: "1",
      jsonSchema: { type: "object", properties: {} }, isReadOnly: () => true,
      execute: async () => ({ output: "value", isError: false }),
    }));
    const memoryManager = new MemoryManager({ aveDir: aveHome() });
    const beginJournal = vi.spyOn(memoryManager, "beginTurnJournal");
    const endJournal = vi.spyOn(memoryManager, "endTurnJournal");
    const loop = createLoopWithRegistry(provider, registry, {
      memoryManager,
      settingsService: {
        get: () => ({ ...llm, modelListCache: {
          [llmModelListCacheKey("openai", llm.vendors.openai.baseUrl)]: {
            vendor: "openai", endpoint: "https://api.openai.com/v1/models", models: [model],
            modelEntries: [{ id: model, maxOutputTokens: 4_096 }], fetchedAt: new Date(0).toISOString(),
          },
        } }),
        getSecret: () => "test-key",
      } as never,
      auditLogger: auditLogger as never,
    });
    const onTurnSummary = vi.fn<(summary: TurnSummary) => void>();
    retrySleep.skip = true;
    try {
      await loop.runTurn("reply", { onTurnSummary }, undefined, { ...userKeyboardTurn() });
    } finally { retrySleep.skip = false; }
    expect(primarySent).toHaveLength(resumePrimary ? 6 : 5);
    expect(primarySent[0]?.model).toBe(model);
    expect(primarySent[0]?.outputTokenLimit).toBe(4_096);
    expect(fallbackSent).toHaveLength(1);
    expect(fallbackSent[0]?.model).toBe(model);
    expect(fallbackSent[0]?.outputTokenLimit).toBe(32_000);
    expect(fallbackSent[0]?.outputCeiling).toBeUndefined();
    expect(onTurnSummary).toHaveBeenCalledTimes(1);
    expect(auditLogger.logTurn).toHaveBeenCalledTimes(1);
    expect(beginJournal).toHaveBeenCalledOnce();
    expect(endJournal).toHaveBeenCalledOnce();
    const persisted = memoryManager.loadSession(loop.getSessionId()) as GenericMessage[] | null;
    expect(persisted?.some((message) => message.role === "user" && message.content === "reply")).toBe(true);
    expect(persisted?.findLast((message) => message.role === "assistant")?.meta?.turnSummary).toMatchObject({
      vendorProvider: "openai", vendorModel: model,
    });
    return { summary: onTurnSummary.mock.calls[0]![0], audit: auditLogger.logTurn.mock.calls[0]![0] };
  }

  it.each(["summary", "audit"] as const)("omits primary resolution from a same-identity fallback's %s record", async (surface) => {
    const record = (await sameIdentityFallbackRecords())[surface];
    expect(record).toBeDefined();
    expect(record.modelSettings).toBeUndefined();
  });

  it("persists fallback turns and summaries after quarantining a corrupt checkpoint ledger", async () => {
    const storage = join(aveHome(), "code-checkpoints");
    await mkdir(storage, { recursive: true });
    await writeFile(join(storage, "turns.json"), "{");
    const { summary, audit } = await sameIdentityFallbackRecords();
    expect(summary).toBeDefined();
    expect(audit).toBeDefined();
    expect((await readdir(storage)).some((name) => name.startsWith("turns.json.corrupt-"))).toBe(true);
  });

  it("records a later primary request after a fallback tool round", async () => {
    const records = await sameIdentityFallbackRecords(true);
    for (const record of [records.summary, records.audit]) {
      expect(record.modelSettings?.output).toMatchObject({ effective: 4_096, effectiveSource: "provider-reported" });
      expect(record.modelSettings?.requestControls).toEqual({ outputTokenLimit: 4_096 });
    }
  });

  it("keeps mixed-provider fallback rounds out of single-model turn badge pricing", async () => {
    vi.useFakeTimers();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "read_file",
      description: "Read file",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"],
        },
      isReadOnly: () => true,
      execute: async () => ({ output: "contents", isError: false }),
    }),
    );
    let primaryCalls = 0;
    let signalRetryRoundStarted!: () => void;
    const retryRoundStarted = new Promise<void>((resolve) => {
      signalRetryRoundStarted = resolve;
    });
    const primary: LLMProvider = {
      vendor: "claude",
      streamTurn: async function* () {
        primaryCalls += 1;
        if (primaryCalls === 1) {
          yield { type: "tool_call", id: "t-1", name: "read_file", input: { path: "a" },
          };
          yield { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 10 },
          };
          return;
        }
        signalRetryRoundStarted();
        yield { type: "error", error: "500 internal server error", classification: "network",
        };
      },
    };
    const fallback = new FakeProvider([
      [
        { type: "text_delta", text: "fallback final" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 5 },
        },
      ],
    ]);
    const provider = new FallbackProvider(
      primary,
      [{ provider: "openai", model: "gpt-5.4-mini" }],
      () => "test-key",
      () => fallback,
    );
    const saveSession = vi.fn(async () => {});
    const auditLogger = {
      logTurn: vi.fn(),
      logToolCall: vi.fn(),
      isPermissionAuditChainReady: () => false,
    };
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      settingsService: {
        get: () => fakeLlmSettings({ provider: "claude", model: "claude-sonnet-4-6" }),
        getSecret: () => "test-key",
      },
      memoryManager: { saveSession, listSessions: () => [] } as never,
      auditLogger: auditLogger as never,
    });

    let summary: { vendorProvider?: string; vendorModel?: string }
      | null = null;
    const pending = loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { ...userKeyboardTurn() },
    );
    // Wait for round-two I/O before advancing each retry timer independently.
    await retryRoundStarted;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await pending;
    vi.useRealTimers();

    expect(summary?.vendorProvider).toBeUndefined();
    expect(summary?.vendorModel).toBeUndefined();
    expect(auditLogger.logTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        usageByModel: [
          expect.objectContaining({ vendorProvider: "claude", vendorModel: "claude-sonnet-4-6",
          }),
          expect.objectContaining({ vendorProvider: "openai", vendorModel: "gpt-5.4-mini",
          }),
        ],
      }),
    );
  });

  it("persists reported subscription usage separately from API billing while retaining its audit route and projected context", async () => {
    const toolRegistry = new ToolRegistry();
    const saveSession = vi.fn(async (..._args: unknown[]) => {});
    const memoryManager = {
      saveSession,
      listSessions: () => [],
      loadSessionMetadata: () => ({}),
      saveSessionMetadata: vi.fn(async () => {}),
    };
    const settingsService = {
      get: fakeUsageReportingSubscriptionSettings,
      getSecret: () => "test-key",
    };
    const auditLogger = {
      logTurn: vi.fn(),
      logToolCall: vi.fn(),
      isPermissionAuditChainReady: () => false,
    };
    const loop = createLoopWithRegistry(
      createUsageReportingSubscriptionProvider(),
      toolRegistry,
      {
        settingsService: settingsService as never,
        memoryManager: memoryManager as never,
        auditLogger: auditLogger as never,
        postTurnHookChain: new PostTurnHookChain({
          memoryManager: memoryManager as never,
          settingsService: settingsService as never,
          auditLogger: auditLogger as never,
        }),
      },
    );
    const traceStep = vi.fn();
    loop.setTracer({ step: traceStep } as never);
    const priorApiUsage = {
      inputTokens: 19,
      outputTokens: 7,
      cacheReadTokens: 3,
    };
    (loop as unknown as { cumulativeUsage: typeof priorApiUsage }).cumulativeUsage = {
      ...priorApiUsage,
    };

    let summary: {
      tokensIn: number;
      freshInputTokens: number;
      tokensOut: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      vendorProvider?: string;
      vendorModel?: string;
      usageByModel?: unknown;
      subscriptionUsage?: unknown;
    } | null = null;
    const onLlmStatus = vi.fn();
    await loop.runTurn("질문", {
      onLlmStatus,
      onTurnSummary: (value) => {
        summary = value;
      },
    }, undefined, { ...userKeyboardTurn() });

    // Fallback status stays observable without billing its synthetic serving identity.
    expect(onLlmStatus).toHaveBeenCalledWith(expect.objectContaining({
      phase: "attempt",
      provider: "openai",
      model: "gpt-5.5-codex",
    }));
    expect(loop.getCumulativeUsage()).toEqual(priorApiUsage);
    expect((loop as unknown as { lastRoundProviderInputTokens: number })
      .lastRoundProviderInputTokens).toBe(1_000);
    expect((loop as unknown as {
      lastReportedSubscriptionContextWindow: { provider: string; model: string; contextWindow: number } | null;
    }).lastReportedSubscriptionContextWindow).toEqual({
      provider: "codex",
      model: "gpt-5.5-codex",
      contextWindow: 64_000,
    });
    expect(contextBudgetForCurrentRuntime(loop)).toMatchObject({
      preflight: 29_600,
      usableContext: 37_000,
    });

    expect(summary).not.toBeNull();
    const lastRoundProjection = (loop as unknown as {
      lastRoundInputProjection: { totalTokens: number } | null;
      lastContextInputProjectionTokens: number;
    });
    expect(summary!.tokensIn).toBe(Math.max(
      0,
      1_000
        + lastRoundProjection.lastContextInputProjectionTokens
        - (lastRoundProjection.lastRoundInputProjection?.totalTokens ?? 0),
    ));
    expect(summary).toMatchObject({ freshInputTokens: 1_000, tokensOut: 230 });
    expect(summary).toMatchObject({ cacheReadTokens: 500, cacheWriteTokens: 100 });
    expect(summary!.subscriptionUsage).toEqual([
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.5-codex",
        source: "provider-reported",
        billable: false,
        totalTokens: 1_830,
      }),
    ]);
    expect(summary).not.toHaveProperty("vendorProvider");
    expect(summary).not.toHaveProperty("vendorModel");
    expect(summary).not.toHaveProperty("usageByModel");

    const auditPayload = auditLogger.logTurn.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(auditPayload).toMatchObject({
      route: "subscription:codex/gpt-5.5-codex",
    });
    expect(auditPayload?.tokenUsage).toBeUndefined();
    expect(auditPayload?.usageByModel).toBeUndefined();
    expect(auditPayload?.subscriptionUsage).toEqual([
      expect.objectContaining({ source: "provider-reported", billable: false }),
    ]);
    expect(auditPayload).not.toHaveProperty("vendorProvider");
    expect(auditPayload).not.toHaveProperty("vendorModel");

    const savedMessages = saveSession.mock.calls.at(-1)?.[1] as
      | GenericMessage[]
      | undefined;
    const finalAssistant = savedMessages?.slice().reverse()
      .find((message) => message.role === "assistant");
    const persistedSummary = finalAssistant?.meta?.turnSummary;
    expect(persistedSummary).toMatchObject({ freshInputTokens: 1_000, tokensOut: 230 });
    expect(persistedSummary).toMatchObject({ cacheReadTokens: 500, cacheWriteTokens: 100 });
    expect(persistedSummary?.subscriptionUsage).toEqual([
      expect.objectContaining({ source: "provider-reported", billable: false }),
    ]);
    expect(persistedSummary).not.toHaveProperty("vendorProvider");
    expect(persistedSummary).not.toHaveProperty("vendorModel");
    expect(persistedSummary).not.toHaveProperty("usageByModel");

    const llmStreamTrace = traceStep.mock.calls.find((call) => call[0] === "LLM_STREAM")?.[1] as
      | { request?: Record<string, unknown> }
      | undefined;
    expect(llmStreamTrace?.request).toMatchObject({
      runtimeIdentity: "subscription:codex/gpt-5.5-codex",
      preflightThresholdTokens: expect.any(Number),
    });
    expect(llmStreamTrace?.request).not.toHaveProperty("configuredProvider");
  });

  it("uses a local estimate for subscription sessions without a provider usage report", async () => {
    const toolRegistry = new ToolRegistry();
    const auditLogger = {
      logTurn: vi.fn(),
      logToolCall: vi.fn(),
      isPermissionAuditChainReady: () => false,
    };
    const loop = createLoopWithRegistry(
      {
        vendor: "openai",
        subscriptionRuntime: CODEX_USAGE_SUBSCRIPTION,
        async *streamTurn(): AsyncIterable<StreamEvent> {
          yield { type: "text_delta", text: "estimated subscription answer" };
          yield { type: "message_complete", stopReason: "end_turn" };
        },
      },
      toolRegistry,
      {
        settingsService: {
          get: fakeUsageReportingSubscriptionSettings,
          getSecret: () => "test-key",
        } as never,
        auditLogger: auditLogger as never,
      },
    );

    await loop.runTurn("질문", {}, undefined, { ...userKeyboardTurn() });

    const auditPayload = auditLogger.logTurn.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(auditPayload).toMatchObject({
      route: "subscription:codex/gpt-5.5-codex",
    });
    expect(auditPayload?.tokenUsage).toBeUndefined();
    expect(auditPayload?.usageByModel).toBeUndefined();
    expect(auditPayload?.subscriptionUsage).toEqual([
      expect.objectContaining({
        provider: "codex",
        source: "local-estimate",
        billable: false,
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      }),
    ]);
    expect((loop as unknown as { lastRoundProviderInputTokens: number })
      .lastRoundProviderInputTokens).toBe(0);
    expect((loop as unknown as { lastReportedSubscriptionContextWindow: unknown })
      .lastReportedSubscriptionContextWindow).toBeNull();
  });

  it("does not reuse an earlier subscription telemetry baseline after a telemetry-less final tool round", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "baseline_probe",
      description: "Return a bounded probe result.",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: {} },
      isReadOnly: () => true,
      execute: async () => ({ output: "probe complete", isError: false }),
    }));
    let calls = 0;
    const provider: LLMProvider = {
      vendor: "openai",
      subscriptionRuntime: CODEX_USAGE_SUBSCRIPTION,
      async *streamTurn(): AsyncIterable<StreamEvent> {
        if (calls++ === 0) {
          yield { type: "tool_call", id: "baseline-probe-1", name: "baseline_probe", input: {} };
          yield {
            type: "message_complete",
            stopReason: "tool_use",
            subscriptionUsage: {
              provider: "codex",
              model: "gpt-5.5-codex",
              source: "provider-reported",
              billable: false,
              inputTokens: 777,
              outputTokens: 1,
              totalTokens: 778,
              contextWindow: 64_000,
            },
          };
          return;
        }
        yield { type: "text_delta", text: "final answer without telemetry" };
        yield { type: "message_complete", stopReason: "end_turn" };
      },
    };
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      settingsService: {
        get: fakeUsageReportingSubscriptionSettings,
        getSecret: () => "test-key",
      } as never,
    });

    await loop.runTurn("run the probe", {}, undefined, { ...userKeyboardTurn() });

    expect(calls).toBe(2);
    expect((loop as unknown as { lastRoundProviderInputTokens: number })
      .lastRoundProviderInputTokens).toBe(0);
    expect((loop as unknown as { lastReportedSubscriptionContextWindow: unknown })
      .lastReportedSubscriptionContextWindow).toBeNull();
  });

  it("persists turnSummary on the marker-stripped post-turn transcript", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "정리 완료<title>숨김 제목</title>[checkpoint]",
        },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 30, outputTokens: 6 },
        },
      ],
    ]);
    const saveSession = vi.fn(async () => {});
    const memoryManager = {
      saveSession,
      listSessions: () => [],
      loadSessionMetadata: () => ({}),
      saveSessionMetadata: vi.fn(async () => {}),
    };
    const settingsService = {
      get: () => fakeLlmSettings({ model: "gpt-5.4-mini" }),
      getSecret: () => "test-key",
    };
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      settingsService,
      memoryManager,
      postTurnHookChain: new PostTurnHookChain({
        memoryManager: memoryManager as never,
        settingsService: settingsService as never,
      }),
    });

    await loop.runTurn("질문", {}, undefined, { ...userKeyboardTurn() });

    const savedMessages = saveSession.mock.calls.at(-1)?.[1] as
      | GenericMessage[] | undefined;
    const finalAssistant = savedMessages?.slice().reverse().find((message) => message.role === "assistant");
    expect(finalAssistant?.content).toBe("정리 완료");
    expect(finalAssistant?.content).not.toContain("<title>");
    expect(finalAssistant?.content).not.toContain("[checkpoint]");
    expect(finalAssistant?.meta?.turnSummary).toMatchObject({
      tokensIn: expect.any(Number),
      tokensOut: 6,
      freshInputTokens: 30,
      vendorProvider: "openai",
      vendorModel: "gpt-5.4-mini",
    });
    expect(finalAssistant?.meta?.turnSummary?.tokensIn ?? 0).toBeGreaterThan(30,
    );
  });

  it("does not emit a turnSummary footer when the durable final save fails", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "저장 실패 답변" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 9, outputTokens: 2 },
        },
      ],
    ]);
    const saveSession = vi.fn(async () => {
      throw new Error("disk unavailable");
    });
    const memoryManager = {
      saveSession,
      listSessions: () => [],
    };
    const settingsService = {
      get: () => fakeLlmSettings({ model: "gpt-5.4-mini" }),
      getSecret: () => "test-key",
    };
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      settingsService,
      memoryManager,
      postTurnHookChain: new PostTurnHookChain({
        memoryManager: memoryManager as never,
        settingsService: settingsService as never,
      }),
    });
    let summaryCalls = 0;

    const result = await loop.runTurn("질문", {
      onTurnSummary: () => {
        summaryCalls += 1;
      },
    }, undefined, { ...userKeyboardTurn() },
    );

    expect(result.text).toBe("저장 실패 답변");
    expect(summaryCalls).toBe(0);
    expect(saveSession).toHaveBeenCalled();
  });

  it("persists imported trigger provenance on plugin-emitted user turns", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "처리했습니다" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 3 },
        },
      ],
    ]);
    const saveSession = vi.fn(async () => {});
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      memoryManager: { saveSession, listSessions: () => [] } as never,
    });
    const input = '<imported-from-proactive source="overlay:daily-briefing">\n오늘 브리핑\n</imported-from-proactive>';

    await loop.runTurn(input, {}, undefined, { inputOrigin: "plugin-emitted" });

    const savedMessages = saveSession.mock.calls.at(-1)?.[1] as
      | GenericMessage[] | undefined;
    const savedUser = savedMessages?.find((message) => message.role === "user");
    expect(savedUser?.meta?.displayText).toBe("오늘 브리핑");
    expect(savedUser?.meta?.importedTrigger).toMatchObject({
      source: "overlay:daily-briefing",
      prompt: input,
      summary: "오늘 브리핑",
      toolCallCount: 0,
    });
  });

  it("persists natural-language input without host keyword routing metadata", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "메일을 확인했습니다" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 4 },
        },
      ],
    ]);
    const saveSession = vi.fn(async () => {});
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      memoryManager: { saveSession, listSessions: () => [] } as never,
    });

    await loop.runTurn("지금 메일 읽어줘", {}, undefined, { ...userKeyboardTurn(),
    });

    const savedMessages = saveSession.mock.calls.at(-1)?.[1] as
      | GenericMessage[] | undefined;
    const savedUser = savedMessages?.find((message) => message.role === "user");
    expect(savedUser?.content).toBe("지금 메일 읽어줘");
    expect(savedUser?.meta?.displayText).toBeUndefined();
  });

  it("does not emit a summary or notification when stopReason is context-error", async () => {
    // Context errors must not report stale provider input tokens in a turn summary.
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "error", error: "prompt is too long for this model",
        } as StreamEvent,
      ],
    ]);
    const loop = createLoopWithRegistry(provider, toolRegistry);

    let summaryCallCount = 0;
    const result = await loop.runTurn("질문", {
      onTurnSummary: () => {
        summaryCallCount += 1;
      },
    }, undefined, { ...userKeyboardTurn() },
    );

    expect(result.stopReason).toBe("context-error");
    expect(summaryCallCount).toBe(0);
    expect(result.text).toContain("한도를 초과");
  });

  it("reports estimated context tokens when provider usage is unavailable", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider(endTurnScript("ok"));
    const loop = createLoopWithRegistry(provider, toolRegistry);

    let summary: { tokensIn: number; tokensOut: number; toolCount: number;
    }
      | null = null;
    await loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { ...userKeyboardTurn() },
    );

    expect(summary).not.toBeNull();
    expect(summary!.tokensIn).toBeGreaterThan(0);
    expect(summary!.tokensOut).toBe(0);
    expect(summary!.toolCount).toBe(0);
  });

  it("uses engine request projection when provider usage is unavailable", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "large_schema_tool",
      description: "Tool with intentionally large schema description ".repeat(200,
        ),
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "query text ".repeat(200) },
        },
        required: ["query"],
      },
      isReadOnly: () => true,
      execute: async () => ({ output: "ok", isError: false }),
    }),
    );
    const provider = new FakeProvider(endTurnScript("ok"));
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      systemPromptBuilder: {
        build: () => "system prompt overhead ".repeat(300),
        setToolScope: vi.fn(),
        setOriginSource: vi.fn(),
        setActiveSessionId: vi.fn(),
        setActiveRolePrompt: vi.fn(),
      } as never,
    });

    let summary: { tokensIn: number; tokensOut: number; toolCount: number;
    }
      | null = null;
    await loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { ...userKeyboardTurn() },
    );

    expect(summary).not.toBeNull();
    expect(summary!.tokensIn).toBeGreaterThan(3_000);
    expect(summary!.tokensOut).toBe(0);
  });

  it("derives post-tool turnSummary.tokensIn from engine projection when tool results carry over", async () => {
    const largeToolResult = "large search result payload ".repeat(250);
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "large_search",
      description: "Return a large search result",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"],
        },
      isReadOnly: () => true,
      execute: async () => ({ output: largeToolResult, isError: false }),
    }),
    );
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "searching" },
        { type: "tool_call", id: "large-1", name: "large_search", input: { query: "budget" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "large result summarized" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const saveSession = vi.fn(async () => {});
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      memoryManager: { saveSession, listSessions: () => [] } as never,
    });

    let summary: { tokensIn: number; tokensOut: number; freshInputTokens: number;
    }
      | null = null;
    await loop.runTurn("큰 검색 결과를 요약해줘", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { ...userKeyboardTurn() },
    );

    const savedMessages = saveSession.mock.calls.at(-1)?.[1] as
      | GenericMessage[] | undefined;
    expect(savedMessages).toBeDefined();
    const toolResult = savedMessages?.find((message) => message.role === "tool_result",
    );
    expect(toolResult?.content).toBe(largeToolResult);
    expect(toolResult?.meta?.truncated).toBeUndefined();
    const expectedProjection = estimateRequestInputProjection({
      systemPrompt: "system",
      messages: savedMessages ?? [],
      toolSchemas: visibleToolSchemas(toolRegistry),
    });
    const savedAssistant = savedMessages?.slice().reverse().find((message) => message.role === "assistant");

    expect(summary).not.toBeNull();
    expect(summary!.tokensIn).toBe(expectedProjection.totalTokens);
    expect(summary!.tokensIn).toBeGreaterThan(1_000);
    expect(summary!.tokensOut).toBe(0);
    expect(summary!.freshInputTokens).toBe(0);
    expect(savedAssistant?.meta?.turnSummary?.tokensIn).toBe(expectedProjection.totalTokens,
    );
  });
});
