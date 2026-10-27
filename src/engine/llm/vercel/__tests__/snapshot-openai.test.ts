import { describe, it, expect, vi } from "vitest";
import { collectStreamEvents as collect } from "./test-helpers.js";
import type { StreamEvent } from "../../types.js";
import { usesOpenAIResponsesWire } from "../../reasoning-plan.js";
import { resolveReasoningSupport } from "../../../../shared/context-budget.js";
import { MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT } from "../../output-token-limit.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../../../tools/registry.js";
import { unusedNetworkFetch } from "../../../../__tests__/support/network-fetch-stubs.js";

describe("VercelUnifiedProvider openai — reasoning_effort mapping", () => {

  it("selects the response protocol from catalog reasoning or a deployment route", () => {
    const wireFor = (vendor: string, model: string) =>
      usesOpenAIResponsesWire(vendor, model, resolveReasoningSupport({ vendor, model }));
    // Catalog reasoning routes must not fall back to a chat protocol that rejects their tool turns.
    for (const model of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5", "o1", "o3-mini", "o4-mini"]) {
      expect(wireFor("openai", model)).toBe(true);
    }
    expect(wireFor("openai", "gpt-4.1")).toBe(false);
    expect(wireFor("openai", "gpt-4o")).toBe(false);
    expect(wireFor("azure-foundry", "gpt-4o")).toBe(true);
    expect(wireFor("openai", "acme-unlisted-model")).toBe(false);
    expect(usesOpenAIResponsesWire("openai", "acme-unlisted-model", { supported: true, source: "endpoint-report", control: "reasoning" })).toBe(true);
    expect(usesOpenAIResponsesWire("openai", "acme-unlisted-model", { supported: true, source: "endpoint-report", control: "reasoning_effort" })).toBe(false);
    // Catalog identity cannot establish a custom endpoint protocol.
    const custom = "https://gateway.invalid/v1";
    expect(usesOpenAIResponsesWire("openai", "gpt-6.1-sol", undefined, custom)).toBe(false);
    expect(usesOpenAIResponsesWire("openai", "gpt-6.1-sol", resolveReasoningSupport({ vendor: "openai", model: "gpt-6.1-sol" }), custom)).toBe(false);
    expect(usesOpenAIResponsesWire("openai", "opaque-model", { supported: true, source: "endpoint-report", control: "reasoning" }, custom)).toBe(true);
  });
});

describe("VercelUnifiedProvider — reasoning_effort 'none' clamp (#1574)", () => {
  const captureProviderOptions = async (
    model: string,
    thinkingBudgetTokens: number,
    catalogModel?: string,
  ): Promise<Record<string, unknown> | undefined> => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
        yield { type: "text-delta", id: "t1", text: "ok" };
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");
    await collect(
      provider.streamTurn({
        model,
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
        thinkingBudgetTokens,
        ...(catalogModel !== undefined ? { catalogModel } : {}),
      }),
    );
    const callArg = streamTextSpy.mock.calls[0]![0] as {
      providerOptions?: { openai?: { reasoningEffort?: string } };
    };
    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
    return callArg.providerOptions?.openai;
  };

  it("uses the lowest user rung for a small custom budget", async () => {
    const openai = await captureProviderOptions("gpt-5-mini", 100);
    expect(openai?.reasoningEffort).toBe("low");
  });

  it("keeps thinking enabled for a named entry and small custom budget", async () => {
    const openai = await captureProviderOptions("gpt-5.2", 100, "openai/gpt-5.2");
    expect(openai?.reasoningEffort).toBe("low");
  });

  it("sends no effort when nobody states the levels the model accepts", async () => {
    // Unknown catalog IDs must not receive effort guessed from their names.
    expect(await captureProviderOptions("gpt-5.2-unlisted-fixture", 100)).toBeUndefined();
    expect(await captureProviderOptions("gpt-5-mini-unlisted-fixture", 10_000)).toBeUndefined();
  });
});

describe("provider protocol for a reasoning model on a tool turn", () => {
  it("sends gpt-6.1-sol over Responses with its effort, not over Chat Completions without it", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn((_options: unknown) => ({
      stream: (async function* () {
        yield { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } };
      })(),
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));
    try {
      const { VercelUnifiedProvider } = await import("../adapter.js");
      const provider = new VercelUnifiedProvider("openai", "test-key");
      await collect(provider.streamTurn({
        model: "gpt-6.1-sol",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "use tool" }],
        enableThinking: true,
        thinkingBudgetTokens: 10_000,
        tools: [{ name: "index_scan", description: "scan", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
      }));
      const callArg = streamTextSpy.mock.calls[0]![0] as {
        model: { __mock: string };
        providerOptions?: { openai?: { reasoningEffort?: string } };
      };
      expect(callArg.model.__mock).toBe("responses");
      expect(callArg.providerOptions?.openai?.reasoningEffort).toBe("medium");
    } finally {
      vi.doUnmock("ai");
      vi.doUnmock("@ai-sdk/openai");
    }
  });
});

describe("VercelUnifiedProvider — stream idle ceiling (#1574)", () => {
  it("aborts a stalled provider stream after the idle ceiling", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(
          (opts: { abortSignal?: AbortSignal }) => ({
            stream: (async function* () {
              yield { type: "text-delta", id: "t1", text: "partial" };
              // Stall until the composed idle-ceiling signal aborts.
              await new Promise((_resolve, reject) => {
                const s = opts.abortSignal;
                if (s?.aborted) {
                  reject(s.reason ?? new Error("aborted"));
                  return;
                }
                s?.addEventListener(
                  "abort",
                  () => reject(s.reason ?? new Error("aborted")),
                  { once: true },
                );
              });
            })(),
          }),
        ),
      };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");

    const events: StreamEvent[] = [];
    const drain = (async () => {
      for await (const event of provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      })) {
        events.push(event);
      }
    })();

    // Flush the first delta to arm the idle timer before advancing fake time.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(300_001);
    await drain;
    vi.useRealTimers();

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });
});

describe("VercelUnifiedProvider openai — L1/L2/L3 (mocked streamText)", () => {
  it("vanilla gpt-5.4-mini turn: text_delta sequence + message_complete", async () => {
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "hello " };
            yield { type: "text-delta", id: "t1", text: "world" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 3, outputTokens: 2 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => {
        const mk = () => ({ __mock: true });
        return {
          responses: mk,
          chat: mk,
        };
      },
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");

    const events = await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "text_delta",
      "message_complete",
    ]);

    const text = events
      .filter(
        (e): e is Extract<StreamEvent, { type: "text_delta" }> =>
          e.type === "text_delta",
      )
      .map((e) => e.text)
      .join("");
    expect(text).toBe("hello world");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });

  it("tool turn on gpt-5.4-mini goes through Responses API (.responses())", async () => {
    vi.resetModules();
    const responsesSpy = vi.fn(() => ({ __mock: "responses" }));
    const chatSpy = vi.fn(() => ({ __mock: "chat" }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "index_scan",
              input: { q: "foo" },
            };
            yield {
              type: "finish",
              finishReason: "tool-calls",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: responsesSpy,
        chat: chatSpy,
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");

    const events = await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "use tool" }],
        tools: [
          {
            name: "index_scan",
            description: "scan",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        ],
      }),
    );

    expect(responsesSpy).toHaveBeenCalledWith("gpt-5.4-mini");
    expect(chatSpy).not.toHaveBeenCalled();

    const toolEv = events.find((e) => e.type === "tool_call");
    expect(toolEv).toBeDefined();
    if (toolEv?.type === "tool_call") {
      expect(toolEv.name).toBe("index_scan");
      expect(toolEv.input).toEqual({ q: "foo" });
    }
    const finish = events.find((e) => e.type === "message_complete");
    expect(finish).toBeDefined();
    if (finish?.type === "message_complete") {
      expect(finish.stopReason).toBe("tool_use");
    }

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });

  it("aliases Ave tool_search on OpenAI Responses wire and restores stream events", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
        yield {
          type: "text-delta",
          id: "txt-1",
          text: "현재 빌트인 도구에는 `ave",
        };
        yield {
          type: "text-delta",
          id: "txt-1",
          text: "\\_tool",
        };
        yield {
          type: "text-delta",
          id: "txt-1",
          text: "_search` 가 있습니다.",
        };
        yield {
          type: "tool-call",
          toolCallId: "tu-2",
          toolName: "ave_tool_search",
          input: { query: "index_scan_status" },
        };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");

    const events = await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "call tool_search({ query }) when needed",
        messages: [
          { role: "user", content: "로컬 인덱서 확인해보자" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tu-0",
                name: "request_plugin",
                input: { pluginId: "local-indexer" },
              },
            ],
          },
          {
            role: "tool_result",
            toolUseId: "tu-0",
            toolName: "request_plugin",
            content: "local-indexer 카탈로그가 활성화되었습니다.",
          },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tu-1",
                name: TOOL_SEARCH_TOOL_NAME,
                input: { query: "index_scan_status" },
              },
            ],
          },
          {
            role: "tool_result",
            toolUseId: "tu-1",
            toolName: TOOL_SEARCH_TOOL_NAME,
            content: "필요한 도구는 ave_tool_search 로 로드하세요.",
          },
        ],
        tools: [
          {
            name: TOOL_SEARCH_TOOL_NAME,
            description: "도구 검색",
            inputSchema: {
              type: "object",
              required: ["query"],
              properties: { query: { type: "string" } },
            },
          },
        ],
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as {
      instructions?: string;
      tools?: Record<string, unknown>;
      messages?: Array<{ role: string; content: unknown[] }>;
    };
    expect(callArg.instructions).toBe("call tool_search({ query }) when needed");
    expect(Object.keys(callArg.tools ?? {})).toEqual(["ave_tool_search"]);
    expect(callArg.messages?.[1]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tu-0",
          toolName: "request_plugin",
          input: { pluginId: "local-indexer" },
        },
      ],
    });
    expect(callArg.messages?.[2]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tu-0",
          toolName: "request_plugin",
          output: {
            type: "text",
            value: "local-indexer 카탈로그가 활성화되었습니다.",
          },
        },
      ],
    });
    expect(callArg.messages?.[3]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tu-1",
          toolName: "ave_tool_search",
          input: { query: "index_scan_status" },
        },
      ],
    });
    expect(callArg.messages?.[4]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tu-1",
          toolName: "ave_tool_search",
          output: {
            type: "text",
            value: "필요한 도구는 tool_search 로 로드하세요.",
          },
        },
      ],
    });

    expect(events
      .filter((event): event is Extract<StreamEvent, { type: "text_delta" }> =>
        event.type === "text_delta")
      .map((event) => event.text)
      .join("")).toBe("현재 빌트인 도구에는 `tool_search` 가 있습니다.");
    const toolEv = events.find((event) => event.type === "tool_call");
    expect(toolEv).toMatchObject({
      type: "tool_call",
      id: "tu-2",
      name: TOOL_SEARCH_TOOL_NAME,
      input: { query: "index_scan_status" },
    });

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });

  it("legacy gpt-4.1 goes through Chat Completions (.chat())", async () => {
    vi.resetModules();
    const responsesSpy = vi.fn(() => ({ __mock: "responses" }));
    const chatSpy = vi.fn(() => ({ __mock: "chat" }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "ok" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: responsesSpy,
        chat: chatSpy,
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");

    await collect(
      provider.streamTurn({
        model: "gpt-4.1",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chatSpy).toHaveBeenCalledWith("gpt-4.1");
    expect(responsesSpy).not.toHaveBeenCalled();

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });
});

describe("VercelUnifiedProvider openai — L1/L2/L3 (mocked streamText)", () => {
  it("OpenAI Responses API keeps reasoning_effort on tool turns (no legacy guard)", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "t",
          input: {},
        };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");

    await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
        thinkingBudgetTokens: 10_000,
        tools: [
          {
            name: "t",
            description: "t",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.providerOptions).toEqual({
      openai: { reasoningEffort: "medium", reasoningSummary: "detailed", forceReasoning: true },
    });

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });
});

describe("VercelUnifiedProvider openai-compatible", () => {
  it("requires baseUrl and routes through createOpenAICompatible", async () => {
    vi.resetModules();
    const compatFactory = vi.fn(() => ({ __mock: "compat" }));
    const createCompatSpy = vi.fn(() => compatFactory);

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "ok" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: createCompatSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "k",
      "https://example.test/v1",
    );

    const events = await collect(
      provider.streamTurn({
        model: "custom-model-1",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createCompatSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://example.test/v1",
        apiKey: "k",
        name: "ave-compat",
        includeUsage: true,
      }),
    );
    expect(compatFactory).toHaveBeenCalledWith("custom-model-1");
    expect(events.at(-1)?.type).toBe("message_complete");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("prefers marketplace provider metadata baseUrl over the vendor block baseUrl", async () => {
    vi.resetModules();
    const compatFactory = vi.fn(() => ({ __mock: "marketplace-compat" }));
    const createCompatSpy = vi.fn(() => compatFactory);

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "ok" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: createCompatSpy,
    }));

    const providerMetadata = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: false,
    };
    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "",
      "https://stale.example/v1",
      undefined,
      {},
      providerMetadata,
    );

    await collect(
      provider.streamTurn({
        model: "future/free",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createCompatSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://future.example/v1",
        apiKey: "",
        name: "ave-compat",
        includeUsage: true,
      }),
    );
    expect(compatFactory).toHaveBeenCalledWith("future/free");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("routes installed preset vendors through createOpenAICompatible", async () => {
    vi.resetModules();
    const compatFactory = vi.fn(() => ({ __mock: "openrouter" }));
    const createCompatSpy = vi.fn(() => compatFactory);

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "ok" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: createCompatSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openrouter",
      "or-key",
      "https://openrouter.ai/api/v1",
    );

    await collect(
      provider.streamTurn({
        model: "anthropic/claude-sonnet-4.6",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(provider.vendor).toBe("openrouter");
    expect(createCompatSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: "or-key",
        name: "ave-compat",
        includeUsage: true,
      }),
    );
    expect(compatFactory).toHaveBeenCalledWith("anthropic/claude-sonnet-4.6");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("forwards enable_thinking per request via chat_template_kwargs (multi-user toggle)", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: vi.fn(() => vi.fn(() => ({ __mock: "compat" }))),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "k",
      "https://example.test/v1",
    );

    // Per-request toggles isolate concurrent users with opposite settings.
    for (const enableThinking of [true, false]) {
      streamTextSpy.mockClear();
      await collect(
        provider.streamTurn({
          model: "qwen3.6",
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          enableThinking,
        }),
      );
      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: expect.objectContaining({
            aveCompat: {
              chat_template_kwargs: { enable_thinking: enableThinking },
              // Send budgets only while thinking is on, using both supported backend parameter spellings.
              ...(enableThinking
                ? {
                    thinking_token_budget: 10_000,
                    thinking_budget_tokens: 10_000,
                  }
                : {}),
            },
          }),
        }),
      );
    }

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("forwards the configured reasoning budget, not just the on/off switch", async () => {
    // A default-reasoning model still needs a finite budget to leave room for its answer.
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: vi.fn(() => vi.fn(() => ({ __mock: "compat" }))),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "k",
      "https://example.test/v1",
    );

    for (const thinkingBudgetTokens of [1024, 32_000]) {
      streamTextSpy.mockClear();
      await collect(
        provider.streamTurn({
          model: "qwen3.6",
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          enableThinking: true,
          thinkingBudgetTokens,
        }),
      );
      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: expect.objectContaining({
            aveCompat: expect.objectContaining({
              thinking_token_budget: thinkingBudgetTokens,
              // Send both budget spellings because compatible servers silently ignore the unsupported key.
              thinking_budget_tokens: thinkingBudgetTokens,
            }),
          }),
        }),
      );
    }

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("spells the passthrough key the way the SDK looks it up", async () => {
    // Use the canonical camelCase provider-options key; deprecated aliases warn on every request.
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: vi.fn(() => vi.fn(() => ({ __mock: "compat" }))),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "k",
      "https://example.test/v1",
    );
    await collect(
      provider.streamTurn({
        model: "qwen3.6",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
      }),
    );

    // The parameterless spy records an empty tuple type despite receiving a runtime argument.
    const [callArg] = streamTextSpy.mock.calls[0] as unknown as [
      { providerOptions: Record<string, unknown> },
    ];
    const providerOptions = callArg.providerOptions;
    expect(Object.keys(providerOptions)).toContain("aveCompat");
    expect(Object.keys(providerOptions)).not.toContain("ave-compat");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("does NOT forward chat_template_kwargs to commercial gateways (openrouter/groq)", async () => {
    // Hosted compatible gateways must not receive self-hosted chat-template options.
    for (const vendor of ["openrouter", "groq"] as const) {
      vi.resetModules();
      const streamTextSpy = vi.fn(() => ({
        stream: (async function* () {
          yield {
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1 },
          };
        })(),
      }));
      vi.doMock("ai", async () => {
        const actual = await vi.importActual<typeof import("ai")>("ai");
        return { ...actual, streamText: streamTextSpy };
      });
      vi.doMock("@ai-sdk/openai-compatible", () => ({
        createOpenAICompatible: vi.fn(() => vi.fn(() => ({ __mock: "compat" }))),
      }));

      const { VercelUnifiedProvider } = await import("../adapter.js");
      const provider = new VercelUnifiedProvider(
        vendor,
        "k",
        "https://gateway.example/v1",
      );

      await collect(
        provider.streamTurn({
          model: "some/model",
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          enableThinking: true,
        }),
      );

      const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.providerOptions, `${vendor} must not carry providerOptions`)
        .toBeUndefined();

      vi.doUnmock("ai");
      vi.doUnmock("@ai-sdk/openai-compatible");
    }
  });

  it("injects continue_final_message + add_generation_prompt:false when continuationPrefill is set", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
        yield {
          type: "finish",
          finishReason: "length",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: vi.fn(() => vi.fn(() => ({ __mock: "compat" }))),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "k",
      "https://example.test/v1",
    );

    await collect(
      provider.streamTurn({
        model: "qwen3.6",
        systemPrompt: "sys",
        messages: [
          { role: "user", content: "write a long answer" },
          { role: "assistant", content: "Part one " },
        ],
        continuationPrefill: true,
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as {
      providerOptions: { aveCompat: Record<string, unknown> };
      messages: Array<{ role: string }>;
    };
    expect(callArg.providerOptions.aveCompat).toMatchObject({
      continue_final_message: true,
      add_generation_prompt: false,
    });
    // Assistant-prefill continuation requires the last wire message to be assistant.
    expect(callArg.messages.at(-1)?.role).toBe("assistant");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("omits continue_final_message when continuationPrefill is absent", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: vi.fn(() => vi.fn(() => ({ __mock: "compat" }))),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "k",
      "https://example.test/v1",
    );

    await collect(
      provider.streamTurn({
        model: "qwen3.6",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const compatOptions = (streamTextSpy.mock.calls[0]![0] as {
      providerOptions: { aveCompat: Record<string, unknown> };
    }).providerOptions.aveCompat;
    expect("continue_final_message" in compatOptions).toBe(false);
    expect("add_generation_prompt" in compatOptions).toBe(false);

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("rejects credentialed HTTP baseUrl before constructing the provider client", async () => {
    vi.resetModules();
    const createCompatSpy = vi.fn(() => vi.fn(() => ({ __mock: "compat" })));
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: createCompatSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "k",
      "http://router.example/v1",
    );

    const events = await collect(
      provider.streamTurn({
        model: "qwen3.6",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(events[0]).toMatchObject({
      type: "error",
      providerError: {
        messagePreview: expect.stringContaining(
          "credentialed baseUrl must use https",
        ),
      },
    });
    expect(createCompatSpy).not.toHaveBeenCalled();

    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("allows credentialed HTTP only with an exact-origin guarded provider fetch", async () => {
    vi.resetModules();
    const createCompatSpy = vi.fn(() => vi.fn(() => ({ __mock: "compat" })));
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: createCompatSpy,
    }));

    const { createGuardedModelProviderFetch } = await import("../../marketplace-provider-fetch.js");
    const trustedFetch = createGuardedModelProviderFetch(
      "http://10.10.2.100:30000/v1",
      unusedNetworkFetch,
    );
    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "internal-key",
      "http://10.10.2.100:30000/v1",
      trustedFetch,
    );

    await collect(
      provider.streamTurn({
        model: "Qwen3.6-35B-A3B-NVFP4",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createCompatSpy).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "internal-key",
      baseURL: "http://10.10.2.100:30000/v1",
    }));

    vi.doUnmock("@ai-sdk/openai-compatible");
  });
});

describe("custom endpoint request protocol", () => {
  it("retains effort with tools without inferring a custom endpoint's protocol from catalog identity", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "t",
          input: {},
        };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai",
      "test-key",
      "https://proxy.example/v1",
    );

    await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
        thinkingBudgetTokens: 10_000,
        // The user named entry establishes the model; the custom host does not.
        catalogModel: "openai/gpt-5.4-mini",
        tools: [
          {
            name: "t",
            description: "t",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.model).toMatchObject({ __mock: "chat" });
    expect(callArg.providerOptions).toMatchObject({ openai: { reasoningEffort: "medium", reasoningSummary: "detailed" } });

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });
});

describe("VercelUnifiedProvider — sampling params removed (CTRL simplification)", () => {
  // Sampling defaults belong to vendor SDKs; host output ceilings remain separate request controls.
  const runAndCaptureStreamTextArgs = async (
    vendor: "openai",
    model: string,
    outputTokenLimit?: number,
  ): Promise<Record<string, unknown>> => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
        yield { type: "text-delta", id: "t1", text: "ok" };
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(vendor, "test-key");

    await collect(
      provider.streamTurn({
        model,
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        ...(outputTokenLimit === undefined ? {} : { outputTokenLimit }),
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
    return callArg;
  };

  it("OpenAI + reasoning model (gpt-5.4-mini): no temperature/seed in request", async () => {
    const args = await runAndCaptureStreamTextArgs("openai", "gpt-5.4-mini");
    expect("temperature" in args).toBe(false);
    expect("seed" in args).toBe(false);
    expect("maxOutputTokens" in args).toBe(false);
  });

  it("OpenAI + reasoning model (o3-mini): no temperature/seed in request", async () => {
    const args = await runAndCaptureStreamTextArgs("openai", "o3-mini");
    expect("temperature" in args).toBe(false);
    expect("seed" in args).toBe(false);
  });

  it("OpenAI + non-reasoning model (gpt-4.1): no temperature/seed in request", async () => {
    const args = await runAndCaptureStreamTextArgs("openai", "gpt-4.1");
    expect("temperature" in args).toBe(false);
    expect("seed" in args).toBe(false);
  });

  it("maps a host-owned outputTokenLimit to AI SDK maxOutputTokens verbatim", async () => {
    // Apply background ceilings at their caller; transport-wide clamping would also restrict user chat.
    const args = await runAndCaptureStreamTextArgs(
      "openai", "gpt-4.1", MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT * 2,
    );
    expect(args.maxOutputTokens).toBe(MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT * 2);
    expect("outputTokenLimit" in args).toBe(false);
  });
});
