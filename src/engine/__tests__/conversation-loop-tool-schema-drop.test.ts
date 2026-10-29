// Drop only the provider-rejected schema and retry with the reduced tool set.
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams, TurnSummary,
} from "../llm/types.js";
import type { LLMVendor } from "../../shared/llm-vendor-defaults.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { llmModelListCacheKey } from "../../shared/llm-model-list.js";
import type { TurnDecisionEvent } from "../turn/types.js";
import { makeBasicConversationLoopDeps } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

afterEach(() => vi.restoreAllMocks());

class ToolRecordingProvider implements LLMProvider {
  private index = 0;
  readonly toolNamesPerCall: string[][] = [];
  constructor(private readonly turns: StreamEvent[][], readonly vendor: LLMVendor = "openai") {}
  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.toolNamesPerCall.push((input.tools ?? []).map((t) => t.name));
    yield* this.turns[this.index++] ?? [];
  }
}

function rejection(toolName: string): StreamEvent {
  return {
    type: "error",
    error: `400 Invalid schema for function '${toolName}'`,
    providerError: {
      origin: "provider",
      statusCode: 400,
      providerCode: "invalid_function_parameters",
      messagePreview: `Invalid schema for function '${toolName}': In context=('properties','tags'), array schema is missing items.`,
    },
  } as StreamEvent;
}

type ToolSpec = { name: string; source?: "builtin" | "mcp" };

function makeLoop(
  provider: LLMProvider,
  tools: ToolSpec[] = [{ name: "good_tool" }, { name: "bad_tool" }],
  settings = fakeLlmSettings(),
) {
  const toolRegistry = new ToolRegistry();
  for (const { name, source = "builtin" } of tools) {
    toolRegistry.register(
      createDynamicTool({
        name,
        description: `${name} description`,
        source,
        category: "read",
        ...(source === "mcp" ? { mcpServerId: "test-server" } : {}),
        jsonSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: [],
        },
        isReadOnly: () => true,
        execute: async () => ({ output: "ok", isError: false }),
      }),
    );
  }
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({
    settingsService: {
      get: () => settings,
      getSecret: () => "test-key",
    },
    toolRegistry,
  }));
  (loop as unknown as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

// Use a catalog alias without a Responses family to exercise Chat Completions.
// An uncataloged model lets the endpoint report its own reasoning parameter contract.
function chatCompletionsGpt5Settings(): ReturnType<typeof fakeLlmSettings> {
  const model = "team-alias";
  const settings = fakeLlmSettings({ provider: "openai", model, outputTokenLimit: 32_000 });
  settings.modelListCache = {
    [llmModelListCacheKey("openai", settings.vendors.openai.baseUrl)]: {
      vendor: "openai", endpoint: "https://api.openai.com/v1/models", models: [model],
      modelEntries: [{ id: model, supportedParameters: ["tools", "reasoning_effort"] }],
      fetchedAt: "2026-10-13T00:00:00.000Z",
    },
  };
  settings.vendors.openai.enableThinking = true;
  settings.vendors.openai.thinkingBudgetTokens = 16_000;
  return settings;
}

describe("ConversationLoop — the price a turn records (design §6, endpoint report)", () => {
  it("prices the primary route from its endpoint's own report when the catalog cannot", async () => {
    const model = "lab/unlisted-reasoner";
    const provider = new ToolRecordingProvider([[
      { type: "text_delta", text: "done" },
      { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 1_000, outputTokens: 100 } },
    ]], "openrouter");
    const settings = fakeLlmSettings({ provider: "openrouter", model, outputTokenLimit: 32_000 });
    settings.modelListCache = {
      [llmModelListCacheKey("openrouter", settings.vendors.openrouter.baseUrl)]: {
        vendor: "openrouter", endpoint: "https://openrouter.ai/api/v1/models", models: [model],
        modelEntries: [{ id: model, pricing: { prompt: "0.0000025", completion: "0.00001", inputCacheRead: "0.00000025" } }],
        fetchedAt: "2026-10-13T00:00:00.000Z",
      },
    };
    const loop = makeLoop(provider, [], settings);
    let summary: TurnSummary | undefined;
    await loop.runTurn("go", { onTurnSummary: (value) => { summary = value; } }, undefined, { ...userKeyboardTurn() });
    const expected = { source: "endpoint-report", rates: { inputPer1M: 2.5, outputPer1M: 10, cacheReadPer1M: 0.25 } };
    expect(summary?.modelSettings?.pricing).toEqual(expected);
    expect(summary?.usageByModel?.[0]).toMatchObject({ vendorProvider: "openrouter", vendorModel: model, pricing: expected });
  });
});

describe("ConversationLoop — provider-as-oracle tool-schema guard (#1182)", () => {
  it("records the reasoning of the retry after the last rejected tool is removed", async () => {
    const provider = new ToolRecordingProvider([
      [rejection("bad_tool")],
      [{ type: "text_delta", text: "done" }, { type: "message_complete", stopReason: "end_turn" }],
    ], "openai");
    const settings = chatCompletionsGpt5Settings();
    const loop = makeLoop(provider, [{ name: "bad_tool" }], settings);
    let summary: TurnSummary | undefined;
    await loop.runTurn("go", { onTurnSummary: (value) => { summary = value; } }, undefined,
      { ...userKeyboardTurn() });
    expect(provider.toolNamesPerCall).toEqual([["bad_tool"], []]);
    expect(summary?.modelSettings?.reasoning).toMatchObject({ kind: "openai-effort", effort: "high" });
    expect(summary?.modelSettings?.reasoning).not.toHaveProperty("suppressed");
  });

  it("keeps the previous request record when a runtime switch prevents the reduced-tool retry", async () => {
    const provider = new ToolRecordingProvider([[rejection("bad_tool")]], "openai");
    const settings = chatCompletionsGpt5Settings();
    let switched = false;
    Object.defineProperty(settings, "activeChatRuntime", { get: () => switched
      ? { kind: "subscription", provider: "codex", model: "gpt-5.5-codex" }
      : undefined });
    const loop = makeLoop(provider, [{ name: "bad_tool" }], settings);
    const logTurn = vi.spyOn(loop.auditLogger, "logTurn");
    const result = await loop.runTurn("go", {
      onDecision: (event) => { if (event.kind === "tool_schema.drop") switched = true; },
    }, undefined, { ...userKeyboardTurn() });
    expect(provider.toolNamesPerCall).toEqual([["bad_tool"]]);
    expect(result.stopReason).toBe("interrupted");
    expect(logTurn).toHaveBeenCalledWith(expect.objectContaining({ modelSettings: expect.objectContaining({
      reasoning: expect.objectContaining({ kind: "openai-effort", effort: "high" }),
    }) }));
  });

  it("drops the rejected tool and retries the round with the reduced tool set", async () => {
    const provider = new ToolRecordingProvider([
      [rejection("bad_tool")],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop(provider);

    const result = await loop.runTurn("go", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(result.text).toContain("done");
    expect(result.stopReason).toBe("end_turn");
    expect(provider.toolNamesPerCall).toHaveLength(2);
    expect(provider.toolNamesPerCall[0]).toEqual(
      expect.arrayContaining(["good_tool", "bad_tool"]),
    );
    expect(provider.toolNamesPerCall[1]).toContain("good_tool");
    expect(provider.toolNamesPerCall[1]).not.toContain("bad_tool");
  });

  it("reports the drop as a loop decision naming the tool the provider rejected", async () => {
    const provider = new ToolRecordingProvider([
      [rejection("bad_tool")],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop(provider);
    const decisions: TurnDecisionEvent[] = [];

    await loop.runTurn("go", {
      onDecision: (event) => { decisions.push(event); },
    }, undefined, { ...userKeyboardTurn() });

    expect(decisions).toContainEqual(expect.objectContaining({
      kind: "tool_schema.drop",
      branch: "dropped",
      reason: "bad_tool",
      data: expect.objectContaining({ dropped: 1 }),
    }));
  });

  it("does not loop forever when the same tool is reported again after being dropped", async () => {
    // Repeated rejection of an already-dropped tool must surface instead of retrying forever.
    const provider = new ToolRecordingProvider([
      [rejection("bad_tool")],
      [rejection("bad_tool")],
    ]);
    const loop = makeLoop(provider);

    const result = await loop.runTurn("go", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.toolNamesPerCall).toHaveLength(2);
    expect(provider.toolNamesPerCall[1]).not.toContain("bad_tool");
    expect(result.stopReason).toBe("stream-error");
  });

  it("drops an MCP-sourced tool the same way (MCP tools have no plugin-load lint — the oracle is their only guard)", async () => {
    const provider = new ToolRecordingProvider([
      [rejection("mcp_bad_tool")],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop(provider, [
      { name: "good_tool", source: "builtin" },
      { name: "mcp_bad_tool", source: "mcp" },
    ]);

    const result = await loop.runTurn("go", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(result.stopReason).toBe("end_turn");
    expect(provider.toolNamesPerCall).toHaveLength(2);
    expect(provider.toolNamesPerCall[0]).toEqual(
      expect.arrayContaining(["good_tool", "mcp_bad_tool"]),
    );
    expect(provider.toolNamesPerCall[1]).toContain("good_tool");
    expect(provider.toolNamesPerCall[1]).not.toContain("mcp_bad_tool");
  });

  it("does not drop tools for a non-schema provider error (rate limit)", async () => {
    const provider = new ToolRecordingProvider([
      [
        {
          type: "error",
          error: "429 Rate limit reached; please retry the bad_tool call later",
          providerError: {
            origin: "provider",
            statusCode: 429,
            providerCode: "rate_limit_exceeded",
            messagePreview:
              "Rate limit reached; please retry the bad_tool call later",
          },
        } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);

    const result = await loop.runTurn("go", undefined, undefined, {
      ...userKeyboardTurn(),
    });

    expect(provider.toolNamesPerCall).toHaveLength(1);
    expect(result.stopReason).toBe("stream-error");
  });
});
