// Capture signatures per stream step and echo them verbatim; aggregate responses can lose them.
import { describe, it, expect, vi } from "vitest";
import { collectStreamEvents as collect, streamFromArray as fromArray } from "./test-helpers.js";
import type { StreamEvent } from "../../types.js";
import {
  genericToModelMessages,
  fullStreamToStreamEvent,
} from "../adapter.js";
import { claudeRequestShape } from "../../../../shared/model-host-policy.js";
import { catalogModelFor } from "../../../../shared/context-budget.js";
import { extractSignatureSafely } from "../signature-shim.js";

describe("Claude helpers — budget → thinking effort mapping", () => {

  it("reads the reasoning control from catalog metadata without inferring a future version", () => {
    expect(claudeRequestShape(catalogModelFor("claude", "claude-haiku-4-5")?.model).numericThinking).toBe(true);
    expect(claudeRequestShape(catalogModelFor("claude", "claude-sonnet-5-5")?.model).adaptiveThinking).toBe(true);
    expect(claudeRequestShape(catalogModelFor("claude", "claude-sonnet-99")?.model).adaptiveThinking).toBe(false);
  });});

describe("signature-shim — extractSignatureSafely", () => {
  it("returns signature when present", () => {
    expect(
      extractSignatureSafely({
        providerMetadata: { anthropic: { signature: "abc123" } },
      }),
    ).toBe("abc123");
  });

  it("returns null and warns when signature is missing (#12433 edge)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(extractSignatureSafely({})).toBeNull();
    expect(
      extractSignatureSafely({ providerMetadata: { anthropic: {} } }),
    ).toBeNull();
    expect(
      extractSignatureSafely({
        providerMetadata: { anthropic: { signature: "" } },
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("message-mapper — thinkingBlocks → assistant.reasoning parts (P3)", () => {
  it("prepends reasoning parts BEFORE text and tool-call parts, carrying signatures", () => {
    const result = genericToModelMessages([
      {
        role: "assistant",
        content: "visible",
        thinkingBlocks: [
          { thinking: "step-1 thought", signature: "sig-1" },
          { thinking: "step-2 thought", signature: "sig-2" },
        ],
        toolCalls: [{ id: "c1", name: "index_scan", input: { q: "x" } }],
      },
    ]);

    const asst = result[0] as { role: string; content: Array<Record<string, unknown>> };
    expect(asst.role).toBe("assistant");
    expect(asst.content.map((p) => p.type)).toEqual([
      "reasoning",
      "reasoning",
      "text",
      "tool-call",
    ]);
    expect(asst.content[0]).toEqual({
      type: "reasoning",
      text: "step-1 thought",
      providerOptions: { anthropic: { signature: "sig-1" } },
    });
    expect(asst.content[1]).toEqual({
      type: "reasoning",
      text: "step-2 thought",
      providerOptions: { anthropic: { signature: "sig-2" } },
    });
  });

  it("drops thinking blocks with missing/empty signature (log-and-skip)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = genericToModelMessages([
      {
        role: "assistant",
        content: "x",
        thinkingBlocks: [
          { thinking: "ok", signature: "sig-a" },
          { thinking: "dropped", signature: "" },
        ],
      },
    ]);
    const asst = result[0] as { content: Array<Record<string, unknown>> };
    const reasonings = asst.content.filter((p) => p.type === "reasoning");
    expect(reasonings).toHaveLength(1);
    expect((reasonings[0] as { text: string }).text).toBe("ok");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("stream-mapper — Claude signature capture per-step", () => {
  it("stays silent about an unsigned reasoning block on a non-Anthropic wire", async () => {
    // Unsigned routes must not emit a missing-signature warning for every reasoning block.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canned = [
      { type: "start" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "thinking out loud" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-delta", id: "t1", text: "answer" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 5, outputTokens: 9 },
      },
    ];
    const events = await collect(
      fullStreamToStreamEvent(fromArray(canned), "openai-compatible"),
    );
    const last = events.at(-1);
    expect(last?.type).toBe("message_complete");
    if (last?.type === "message_complete") {
      expect(last.thinkingBlocks ?? []).toEqual([]);
    }
    expect(events.some((e) => e.type === "reasoning_delta")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("accumulates reasoning per block id and attaches signature on reasoning-end", async () => {
    const canned = [
      { type: "start" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "hmm " },
      { type: "reasoning-delta", id: "r1", text: "ok" },
      {
        type: "reasoning-end",
        id: "r1",
        providerMetadata: { anthropic: { signature: "sig-block-1" } },
      },
      { type: "text-delta", id: "t1", text: "answer" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 5, outputTokens: 9 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned), "claude"));
    const last = events.at(-1);
    expect(last?.type).toBe("message_complete");
    if (last?.type === "message_complete") {
      expect(last.thinkingBlocks).toEqual([
        { thinking: "hmm ok", signature: "sig-block-1" },
      ]);
      expect(last.stopReason).toBe("end_turn");
    }
  });

  it("captures TWO thinking blocks across interleaved thinking+tool chain", async () => {
    const canned = [
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "step-1" },
      {
        type: "reasoning-end",
        id: "r1",
        providerMetadata: { anthropic: { signature: "sig-1" } },
      },
      {
        type: "tool-call",
        toolCallId: "call_a",
        toolName: "index_scan",
        input: { q: "foo" },
      },
      { type: "reasoning-start", id: "r2" },
      { type: "reasoning-delta", id: "r2", text: "step-2" },
      {
        type: "reasoning-end",
        id: "r2",
        providerMetadata: { anthropic: { signature: "sig-2" } },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        totalUsage: { inputTokens: 1, outputTokens: 2 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned), "claude"));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.thinkingBlocks).toEqual([
        { thinking: "step-1", signature: "sig-1" },
        { thinking: "step-2", signature: "sig-2" },
      ]);
      expect(last.stopReason).toBe("tool_use");
    }
  });

  it("maps finishReason 'length' to a distinct 'max_tokens' stopReason (not end_turn)", async () => {
    const canned = [
      { type: "text-delta", id: "t1", text: "truncated" },
      {
        type: "finish",
        finishReason: "length",
        totalUsage: { inputTokens: 3, outputTokens: 4 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned), "claude"));
    const last = events.at(-1);
    expect(last?.type).toBe("message_complete");
    if (last?.type === "message_complete") {
      expect(last.stopReason).toBe("max_tokens");
    }
  });

  it("short-reasoning-then-tool with missing signature → log-and-skip (#12433)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canned = [
      { type: "reasoning-start", id: "r1" },
      {
        type: "reasoning-end",
        id: "r1",
      },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "t",
        input: {},
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        totalUsage: { inputTokens: 1, outputTokens: 1 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned), "claude"));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.thinkingBlocks).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[signature-shim]"),
    );
    warn.mockRestore();
  });

  it("surfaces anthropic cache tokens from providerMetadata on finish", async () => {
    const canned = [
      { type: "text-delta", id: "t1", text: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 10, outputTokens: 2 },
        providerMetadata: {
          anthropic: {
            cacheCreationInputTokens: 42,
            cacheReadInputTokens: 7,
          },
        },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned), "claude"));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.usage?.cacheReadTokens).toBe(7);
      expect(last.usage?.cacheWriteTokens).toBe(42);
    }
  });

  it("omits cache fields entirely when neither providerMetadata nor cachedInputTokens present", async () => {
    const canned = [
      { type: "text-delta", id: "t1", text: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 5, outputTokens: 1 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned), "claude"));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      // Omit undefined usage keys; absent and zero cache counts have different accounting semantics.
      expect(last.usage).toBeDefined();
      expect("cacheReadTokens" in (last.usage ?? {})).toBe(false);
      expect("cacheWriteTokens" in (last.usage ?? {})).toBe(false);
    }
  });

  it("falls back to Vercel SDK normalized cachedInputTokens when providerMetadata absent (Gemini/OpenAI path)", async () => {
    const canned = [
      { type: "text-delta", id: "t1", text: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: 100,
          outputTokens: 5,
          cachedInputTokens: 30,
        },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned), "claude"));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.usage?.cacheReadTokens).toBe(30);
      expect("cacheWriteTokens" in (last.usage ?? {})).toBe(false);
    }
  });

  it("uses AI SDK 6 inputTokenDetails for canonical cache read/write tokens", async () => {
    const canned = [
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: 100,
          outputTokens: 5,
          cachedInputTokens: 10,
          inputTokenDetails: {
            noCacheTokens: 70,
            cacheReadTokens: 20,
            cacheWriteTokens: 10,
          },
        },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned), "claude"));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.usage).toEqual({
        inputTokens: 100,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
      });
    }
  });

  it("carries the reported reasoning part of the output from outputTokenDetails", async () => {
    const canned = [
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 100, outputTokens: 40, outputTokenDetails: { textTokens: 15, reasoningTokens: 25 } },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned), "openai"));
    const last = events.at(-1);
    expect(last?.type).toBe("message_complete");
    expect(last?.type === "message_complete" && last.usage).toEqual({ inputTokens: 100, outputTokens: 40, reasoningTokens: 25 });
  });

  it("providerMetadata.anthropic takes precedence over SDK cachedInputTokens for cacheReadTokens", async () => {
    const canned = [
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 50, outputTokens: 2, cachedInputTokens: 10 },
        providerMetadata: {
          anthropic: {
            cacheReadInputTokens: 999,
            cacheCreationInputTokens: 5,
          },
        },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned), "claude"));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.usage?.cacheReadTokens).toBe(999);
      expect(last.usage?.cacheWriteTokens).toBe(5);
    }
  });
});

describe("VercelUnifiedProvider claude — adapter wiring (mocked streamText)", () => {
  it("projects adaptive thinking and effort without a numeric interleaving opt-in", async () => {
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
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => ({
        languageModel: (_m: string) => ({ __mock: "claude" }),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("claude", "test-key");

    await collect(
      provider.streamTurn({
        model: "claude-sonnet-5-5",
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

    expect(streamTextSpy).toHaveBeenCalledOnce();
    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.providerOptions).toEqual({
      anthropic: {
        thinking: { type: "adaptive" },
        effort: "medium",
      },
    });
    // Adaptive thinking interleaves with the default context window without beta headers.
    expect(callArg.headers).toBeUndefined();

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/anthropic");
  });

  it("claude-3.x — no beta header", async () => {
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
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => ({
        languageModel: (_m: string) => ({ __mock: "claude" }),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("claude", "test-key");

    await collect(
      provider.streamTurn({
        model: "claude-3-5-sonnet-20241022",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    // Unsupported model policies must not add context or interleaving beta headers.
    expect(callArg.headers).toBeUndefined();

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/anthropic");
  });

  it("an unclassified model carries no inferred thinking control", async () => {
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
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => ({
        languageModel: (_m: string) => ({ __mock: "claude" }),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("claude", "test-key");

    await collect(
      provider.streamTurn({
        model: "claude-3-5-sonnet-latest",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
        thinkingBudgetTokens: 5000,
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.providerOptions).toBeUndefined();
    // No tools means no interleaving beta header.
    expect(callArg.headers).toBeUndefined();

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/anthropic");
  });

  it("thinking disabled → no providerOptions, no beta header", async () => {
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
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => ({
        languageModel: (_m: string) => ({ __mock: "claude" }),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("claude", "test-key");

    await collect(
      provider.streamTurn({
        model: "claude-sonnet-4-6",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
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
    expect(callArg.providerOptions).toBeUndefined();
    expect(callArg.headers).toBeUndefined();

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/anthropic");
  });
});

describe("Claude — L4 signature byte-equality round-trip", () => {
  it("signatures captured on turn 1 are echoed verbatim into turn 2 assistant.reasoning", async () => {
    // Capture signed blocks from one turn and verify byte-identical replay on the next.
    const turn1Stream = [
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "plan A" },
      {
        type: "reasoning-end",
        id: "r1",
        providerMetadata: {
          anthropic: { signature: "SIG_AAA_BYTE_EQUAL_01" },
        },
      },
      { type: "reasoning-start", id: "r2" },
      { type: "reasoning-delta", id: "r2", text: "plan B" },
      {
        type: "reasoning-end",
        id: "r2",
        providerMetadata: {
          anthropic: { signature: "SIG_BBB_BYTE_EQUAL_02" },
        },
      },
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "index_scan",
        input: { q: "x" },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        totalUsage: { inputTokens: 3, outputTokens: 4 },
      },
    ];

    const turn1Events = await collect(
      fullStreamToStreamEvent(fromArray(turn1Stream), "claude"),
    );
    const complete = turn1Events.find((e) => e.type === "message_complete");
    expect(complete?.type).toBe("message_complete");
    if (complete?.type !== "message_complete") return;
    expect(complete.thinkingBlocks).toEqual([
      { thinking: "plan A", signature: "SIG_AAA_BYTE_EQUAL_01" },
      { thinking: "plan B", signature: "SIG_BBB_BYTE_EQUAL_02" },
    ]);

    const turn2Request = genericToModelMessages([
      { role: "user", content: "please continue" },
      {
        role: "assistant",
        content: "",
        thinkingBlocks: complete.thinkingBlocks!,
        toolCalls: [{ id: "tc1", name: "index_scan", input: { q: "x" } }],
      },
      {
        role: "tool_result",
        toolUseId: "tc1",
        toolName: "index_scan",
        content: "result",
      },
    ]);

    const asst = turn2Request[1] as { content: Array<Record<string, unknown>> };
    const reasoningParts = asst.content.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(2);
    expect(
      (reasoningParts[0] as {
        providerOptions: { anthropic: { signature: string } };
      }).providerOptions.anthropic.signature,
    ).toBe("SIG_AAA_BYTE_EQUAL_01");
    expect(
      (reasoningParts[1] as {
        providerOptions: { anthropic: { signature: string } };
      }).providerOptions.anthropic.signature,
    ).toBe("SIG_BBB_BYTE_EQUAL_02");

    expect(asst.content.map((p) => p.type)).toEqual([
      "reasoning",
      "reasoning",
      "tool-call",
    ]);
  });
});

describe("message-mapper — cross-vendor thinkingBlocks leak prevention", () => {
  it("strips thinkingBlocks when vendor=gemini (must never send Claude signed thoughts to Gemini)", () => {
    const result = genericToModelMessages(
      [
        {
          role: "assistant",
          content: "visible text",
          thinkingBlocks: [
            { thinking: "secret thought", signature: "sig-secret-1" },
          ],
        },
      ],
      "gemini",
    );

    const asst = result[0] as { role: string; content: Array<Record<string, unknown>> };
    expect(asst.role).toBe("assistant");
    // Foreign routes must not receive signed reasoning blocks.
    const reasoningParts = asst.content.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(0);
    expect(asst.content.some((p) => p.type === "text")).toBe(true);
  });

  it("strips thinkingBlocks when vendor=openai (signed thoughts must not reach OpenAI)", () => {
    const result = genericToModelMessages(
      [
        {
          role: "assistant",
          content: "answer",
          thinkingBlocks: [
            { thinking: "internal reasoning", signature: "sig-secret-2" },
          ],
        },
      ],
      "openai",
    );

    const asst = result[0] as { content: Array<Record<string, unknown>> };
    const reasoningParts = asst.content.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(0);
  });

  it("preserves thinkingBlocks when vendor=claude (round-trip must be intact)", () => {
    const result = genericToModelMessages(
      [
        {
          role: "assistant",
          content: "answer",
          thinkingBlocks: [
            { thinking: "claude thought", signature: "sig-claude-ok" },
          ],
        },
      ],
      "claude",
    );

    const asst = result[0] as { content: Array<Record<string, unknown>> };
    const reasoningParts = asst.content.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(1);
    expect(
      (reasoningParts[0] as { providerOptions: { anthropic: { signature: string } } })
        .providerOptions.anthropic.signature,
    ).toBe("sig-claude-ok");
  });
});
