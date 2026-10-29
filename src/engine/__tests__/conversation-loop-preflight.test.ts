import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { makeHistoryExceedingEstimateThreshold } from "./conversation-loop-test-helpers.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import type { TurnDecisionEvent } from "../turn/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { getModelPreflightThreshold, estimateMessagesTokens } from "../auto-compact.js";
import { estimateRequestInputProjection } from "../request-input-projection.js";
import { t } from "../../i18n/index.js";
import { MemoryReviewerService } from "../../memory/memory-reviewer-service.js";
import {
  makeConversationLoopDeps as makeDeps,
  makeConversationLoopMemoryManager as makeMemoryManager,
  makeConversationLoopMemoryReviewer as makeMemoryReviewer,
  makeConversationLoopSettings as makeSettings,
  makeConversationTurnProvider as makeTurnProvider,
  makeSyntheticCompactResult,
} from "./conversation-loop-test-helpers.js";
import { ScriptedTurnProvider as ScriptedProvider } from "./support/conversation-loop-fixtures.js";
import { PermissionManager } from "../../permissions/permission-manager.js";

vi.mock("../structured-compact.js", () => ({
  DEFAULT_PRESERVE_RECENT_TURNS: 5,
  compactWithBoundary: vi.fn(),
  renderBoundaryAsPreamble: vi.fn(() => "## Compact preamble"),
  withSummaryBoundary: vi.fn((messages: unknown) => messages),
}));

import { compactWithBoundary } from "../structured-compact.js";
import { CompressionStatus } from "../../shared/compact-status.js";

beforeEach(() => {
  vi.mocked(compactWithBoundary).mockClear();
});

function makeSyntheticNoopResult(messages: GenericMessage[]): import("../structured-compact.js").CompactWithBoundaryResult {
  return {
    status: CompressionStatus.NOOP,
    boundary: null,
    newHistory: messages,
    removedCount: 0,
    estimatedAfter: 0,
    truncatedCount: 0,
  };
}

function makeSyntheticContentTruncatedResult(messages: GenericMessage[]): import("../structured-compact.js").CompactWithBoundaryResult {
  return {
    status: CompressionStatus.CONTENT_TRUNCATED,
    boundary: null,
    newHistory: messages.slice(-2),
    removedCount: 2,
    estimatedAfter: 100,
    truncatedDir: "/tmp/ave-truncated",
    truncatedCount: 2,
  };
}

describe("runPreflightGuard — estimate-based trigger", () => {
  it("calls compactWithBoundary when estimateMessagesTokens ≥ threshold", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    expect(threshold).toBeGreaterThan(0);

    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const estimated = estimateMessagesTokens(history);
    expect(estimated).toBeGreaterThanOrEqual(threshold);

    const mem = makeMemoryManager(history);
    const memoryReviewer = new MemoryReviewerService({ resolveActiveChatOneShot: () => null });
    const loop = new ConversationLoop(
      makeDeps({ settingsService: settings, memoryManager: mem, memoryReviewer }),
    );
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));
    const lifecycle = vi.spyOn(loop, "fireLifecycleEvent");

    const compactOccurredCb = vi.fn();
    await loop.runTurn(
      "hello",
      { onCompactOccurred: compactOccurredCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactWithBoundary).toHaveBeenCalledWith(expect.objectContaining({
      memoryReviewer: expect.objectContaining({ review: expect.any(Function) }),
      preflightTokens: threshold,
    }));
    const compactArgs = vi.mocked(compactWithBoundary).mock.calls[0]?.[0];
    const generate = vi.spyOn(loop, "generateCompactionText").mockResolvedValue("originating summary");
    await expect(compactArgs?.memoryReviewer.review("recap", "history", { systemPrompt: "recap contract" }))
      .resolves.toBe("originating summary");
    expect(generate).toHaveBeenCalledWith("history", expect.stringContaining("recap contract"), undefined, 1_200);
    expect(compactArgs).not.toHaveProperty("llm");
    expect(compactArgs).not.toHaveProperty("model");
    expect(compactOccurredCb).toHaveBeenCalled();
    expect(lifecycle).toHaveBeenCalledWith("PreCompact", expect.objectContaining({ reason: "auto-compact" }));
    expect(lifecycle).toHaveBeenCalledWith("PostCompact", expect.objectContaining({ reason: "auto-compact" }));
    lifecycle.mockRestore();
  });

  it("uses the provider-native projection for initial preflight", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history: GenericMessage[] = [{ role: "user", content: "short history" }];
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    await loop.resetAndResume("600d7495-e531-406e-8c73-da41ce614754");
    const projection = {
      totalTokens: threshold + 1,
      systemPromptTokens: 0,
      messageTokens: threshold + 1,
      toolSchemaTokens: 0,
    };
    const projectRequestInput = vi.fn(() => projection);
    const provider = { ...makeTurnProvider(), projectRequestInput };
    (loop as unknown as { provider: typeof provider }).provider = provider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticNoopResult(history));
    const compactStarted = vi.fn();

    await loop.runTurn(
      "small current input",
      { onCompactStarted: compactStarted },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(projectRequestInput).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.any(String),
      messages: expect.any(Array),
      toolSchemas: expect.any(Array),
    }));
    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactStarted).toHaveBeenCalledWith(expect.objectContaining({
      estimatedBefore: threshold + 1,
    }));
  });

  it("persists post-compact context SOT on the boundary and clears preserved stale turn summaries", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    const history: GenericMessage[] = [
      ...makeHistoryExceedingEstimateThreshold(threshold),
      { role: "user", content: "latest q" },
      {
        role: "assistant",
        content: "latest a",
        meta: {
          turnSummary: {
            turnDurationMs: 1_000,
            toolCount: 0,
            cumulativeToolMs: 0,
            tokensIn: threshold + 5_000,
            freshInputTokens: 100,
            tokensOut: 10,
          },
        },
      },
    ];
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({
      settingsService: settings,
      memoryManager: mem,
      systemPromptBuilder: {
        build: () => "system",
        setToolScope: vi.fn(),
        setOriginSource: vi.fn(),
        setActiveSessionId: vi.fn(),
        setActiveRolePrompt: vi.fn(),
      } as never,
    }));
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));

    await loop.runTurn(
      "trigger compact",
      {},
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const messages = loop.getHistory().getMessages();
    const checkpointProjectionMessages = messages.slice(0, -1);
    const contextTokensAfter = messages[0]?.meta?.checkpointMeta?.contextTokensAfter;
    // The compact boundary carries the summary in post-compact history.
    expect(contextTokensAfter).toBe(
      estimateRequestInputProjection({
        systemPrompt: "system",
        messages: checkpointProjectionMessages,
        toolSchemas: [],
      }).totalTokens,
    );
    const preservedOldAnswer = messages.find((message) => message.content === "latest a");
    expect(preservedOldAnswer?.meta?.turnSummary).toBeUndefined();
  });

  it("persists content-truncated compacts as checkpoint context carriers", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticContentTruncatedResult(history));

    await loop.runTurn(
      "trigger content truncation",
      {},
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const messages = loop.getHistory().getMessages();
    expect(messages[0]?.meta?.checkpointMeta).toMatchObject({
      compactStatus: CompressionStatus.CONTENT_TRUNCATED,
      contextTokensAfter: expect.any(Number),
      truncatedDir: "/tmp/ave-truncated",
    });
    expect(messages[0]?.meta?.checkpointMeta?.contextTokensAfter).toBeGreaterThan(100);
    expect((mem as { saveCheckpointSnapshot: ReturnType<typeof vi.fn> }).saveCheckpointSnapshot)
      .toHaveBeenCalledWith("abe633f3-a47a-4758-874e-abe9160daf36", 1, expect.any(Array));
  });
});

describe("runPreflightGuard — context-token secondary trigger", () => {
  it("calls compactWithBoundary when last context-fill SOT >= threshold even if estimate is below", async () => {
    // Reported context pressure must trigger compaction when the character estimator undercounts.

    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    const shortHistory: GenericMessage[] = [
      { role: "user", content: "short message" },
      { role: "assistant", content: "ok" },
    ];
    const estimated = estimateMessagesTokens(shortHistory);
    expect(estimated).toBeLessThan(threshold);

    const mem = makeMemoryManager(shortHistory);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    (loop as unknown as { lastContextInputTokens: number })
      .lastContextInputTokens = threshold + 1_000;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(shortHistory));

    const compactOccurredCb = vi.fn();
    await loop.runTurn(
      "next turn",
      { onCompactOccurred: compactOccurredCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactOccurredCb).toHaveBeenCalled();
  });

  it("does NOT compact only because cumulative input billing crossed threshold", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    const shortHistory: GenericMessage[] = [
      { role: "user", content: "short message" },
      { role: "assistant", content: "ok" },
    ];
    expect(estimateMessagesTokens(shortHistory)).toBeLessThan(threshold);

    const mem = makeMemoryManager(shortHistory);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    (loop as unknown as { cumulativeUsage: { inputTokens: number; outputTokens: number } })
      .cumulativeUsage = { inputTokens: threshold + 1_000, outputTokens: 500 };
    (loop as unknown as { lastContextInputTokens: number })
      .lastContextInputTokens = threshold - 1_000;

    const compactOccurredCb = vi.fn();
    await loop.runTurn(
      "next turn",
      { onCompactOccurred: compactOccurredCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(compactOccurredCb).not.toHaveBeenCalled();
  });

  it("adds the pending user input delta to the calibrated context-token preflight signal", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    const shortHistory: GenericMessage[] = [
      { role: "user", content: "short message" },
      { role: "assistant", content: "ok" },
    ];
    const baselineEstimate = estimateMessagesTokens(shortHistory);
    const baselineProjection = estimateRequestInputProjection({
      systemPrompt: "system",
      messages: shortHistory,
      toolSchemas: [],
    }).totalTokens;
    expect(baselineEstimate).toBeLessThan(threshold);

    const mem = makeMemoryManager(shortHistory);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    (loop as unknown as { lastContextInputTokens: number }).lastContextInputTokens = threshold - 100;
    (loop as unknown as { lastContextInputProjectionTokens: number }).lastContextInputProjectionTokens = baselineProjection;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(shortHistory));

    const compactStartedCb = vi.fn();
    await loop.runTurn(
      "p".repeat(800),
      { onCompactStarted: compactStartedCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactStartedCb).toHaveBeenCalledWith(
      expect.objectContaining({ triggerSource: "context-tokens" }),
    );
  });
});

describe("queryLoop — rate-limit reactive compact", () => {
  it("runs auto-compact when provider reports rate_limit_exceeded for TPM", async () => {
    const settings = makeSettings(true, "gpt-5.4-mini", "openai");
    const history: GenericMessage[] = [
      { role: "user", content: "prior" },
      { role: "assistant", content: "ok" },
    ];
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    await loop.resetAndResume("3db55c54-315c-4806-83d0-954cb477fc3f");

    const message =
      "Rate limit reached for gpt-5.4-mini on tokens per min (TPM): Limit 200000, Used 161755, Requested 45096. Please try again in 2.055s.";
    const provider = new ScriptedProvider([
      [
        {
          type: "error",
          error: message,
          providerError: {
            origin: "provider",
            providerType: "tokens",
            providerCode: "rate_limit_exceeded",
            classification: "rate-limit",
            messagePreview: message,
            rateLimit: {
              kind: "tokens-per-minute",
              limit: 200_000,
              used: 161_755,
              requested: 45_096,
              retryAfterSeconds: 2.055,
            },
          },
        },
      ],
    ]);
    (loop as unknown as { provider: LLMProvider }).provider = provider;
    vi.mocked(compactWithBoundary).mockImplementationOnce(async ({ messages }) =>
      makeSyntheticCompactResult(messages as GenericMessage[]),
    );

    const compactStartedCb = vi.fn();
    const compactOccurredCb = vi.fn();
    const errorCb = vi.fn();
    const textDeltaCb = vi.fn();
    const result = await loop.runTurn(
      "trigger rate limit",
      {
        onCompactStarted: compactStartedCb,
        onCompactOccurred: compactOccurredCb,
        onError: errorCb,
        onTextDelta: textDeltaCb,
      },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalledTimes(1);
    // In-turn recovery must preserve tool rounds; preserving user turns pins the entire active turn.
    expect(compactWithBoundary).toHaveBeenCalledWith(
      expect.objectContaining({ preserveUnit: "tool-rounds" }),
    );
    expect(compactStartedCb).toHaveBeenCalledWith(
      expect.objectContaining({ triggerSource: "rate-limit" }),
    );
    expect(compactOccurredCb).toHaveBeenCalledTimes(1);
    expect(errorCb).not.toHaveBeenCalled();
    expect(textDeltaCb).toHaveBeenCalledWith(expect.stringContaining("자동 압축"));
    expect(result.text).toContain("압축된 컨텍스트");
  });

  it("does not compact for request-per-minute rate limits", async () => {
    const settings = makeSettings(true, "gpt-5.4-mini", "openai");
    const loop = new ConversationLoop(makeDeps({ settingsService: settings }));
    await loop.resetAndResume("976a47ca-22a3-466f-89cf-d23575553788");

    const message = "Rate limit reached on requests per minute (RPM): Limit 100, Used 100, Requested 1.";
    const provider = new ScriptedProvider([
      [
        {
          type: "error",
          error: message,
          providerError: {
            origin: "provider",
            providerType: "requests",
            providerCode: "rate_limit_exceeded",
            classification: "rate-limit",
            messagePreview: message,
            rateLimit: { kind: "requests-per-minute", limit: 100, used: 100, requested: 1 },
          },
        },
      ],
    ]);
    (loop as unknown as { provider: LLMProvider }).provider = provider;
    vi.mocked(compactWithBoundary).mockResolvedValue(makeSyntheticCompactResult([]));

    const errorCb = vi.fn();
    await loop.runTurn(
      "trigger rpm",
      { onError: errorCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(errorCb).toHaveBeenCalled();
  });

  it("does not repeat TPM reactive compact before a clean turn re-arms recovery", async () => {
    const settings = makeSettings(true, "gpt-5.4-mini", "openai");
    const loop = new ConversationLoop(makeDeps({ settingsService: settings }));
    await loop.resetAndResume("963e666f-23d2-4eae-86eb-c025879ef0c9");

    const message =
      "Rate limit reached for gpt-5.4-mini on tokens per min (TPM): Limit 200000, Used 161755, Requested 45096. Please try again in 2.055s.";
    const tpmError: StreamEvent = {
      type: "error",
      error: message,
      providerError: {
        origin: "provider",
        providerType: "tokens",
        providerCode: "rate_limit_exceeded",
        classification: "rate-limit",
        messagePreview: message,
        rateLimit: {
          kind: "tokens-per-minute",
          limit: 200_000,
          used: 161_755,
          requested: 45_096,
          retryAfterSeconds: 2.055,
        },
      },
    };
    const provider = new ScriptedProvider([[tpmError], [tpmError]]);
    (loop as unknown as { provider: LLMProvider }).provider = provider;
    vi.mocked(compactWithBoundary).mockImplementationOnce(async ({ messages }) =>
      makeSyntheticCompactResult(messages as GenericMessage[]),
    );

    const firstErrorCb = vi.fn();
    await loop.runTurn(
      "first tpm",
      { onError: firstErrorCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const secondErrorCb = vi.fn();
    await loop.runTurn(
      "second tpm",
      { onError: secondErrorCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalledTimes(1);
    expect(firstErrorCb).not.toHaveBeenCalled();
    expect(secondErrorCb).toHaveBeenCalled();
  });
});

describe("runPreflightGuard — request projection source", () => {
  it("compacts when system prompt overhead crosses threshold even if message estimate is below", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const shortHistory: GenericMessage[] = [
      { role: "user", content: "short message" },
      { role: "assistant", content: "ok" },
    ];
    expect(estimateMessagesTokens(shortHistory)).toBeLessThan(threshold);

    const mem = makeMemoryManager(shortHistory);
    const loop = new ConversationLoop(makeDeps({
      settingsService: settings,
      memoryManager: mem,
      systemPromptBuilder: {
        build: () => "system-overhead ".repeat(threshold),
        setToolScope: vi.fn(),
        setOriginSource: vi.fn(),
        setActiveSessionId: vi.fn(),
        setActiveRolePrompt: vi.fn(),
      } as never,
    }));
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(shortHistory));

    const compactStartedCb = vi.fn();
    await loop.runTurn(
      "next turn",
      { onCompactStarted: compactStartedCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactStartedCb).toHaveBeenCalledWith(
      expect.objectContaining({ triggerSource: "estimate" }),
    );
  });
});

describe("runPreflightGuard — message count is not a trigger", () => {
  it("does NOT compact at 50 messages when token signals are below threshold", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history: GenericMessage[] = Array.from({ length: 49 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `short ${i}`,
    }));
    expect(estimateMessagesTokens(history)).toBeLessThan(threshold);

    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    (loop as unknown as { lastContextInputTokens: number })
      .lastContextInputTokens = threshold - 1_000;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));

    const compactStartedCb = vi.fn();
    await loop.runTurn(
      "message 50",
      { onCompactStarted: compactStartedCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(compactStartedCb).not.toHaveBeenCalled();
  });
});

describe("runPreflightGuard — skip conditions", () => {
  it("does NOT call compactWithBoundary when autoCompact is OFF", async () => {
    const settings = makeSettings(false, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticNoopResult([]));

    const compactOccurredCb = vi.fn();
    await loop.runTurn(
      "hello",
      { onCompactOccurred: compactOccurredCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(compactOccurredCb).not.toHaveBeenCalled();
  });

  it("does NOT call compactWithBoundary when disableSessionPersistence is set", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(
      makeDeps({ settingsService: settings, memoryManager: mem, disableSessionPersistence: true }),
    );
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticNoopResult([]));

    const compactOccurredCb = vi.fn();
    await loop.runTurn(
      "hello",
      { onCompactOccurred: compactOccurredCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(compactOccurredCb).not.toHaveBeenCalled();
  });
});

describe("runPreflightGuard — force-recover hard-cap (#917)", () => {
  it("blocks compactWithBoundary after MAX_FORCE_RECOVER_PER_SESSION exhaustion and fires onRecoveryExhausted", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    await loop.resetAndResume("ce88811d-036a-41cb-8b23-b1f47019842f");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    (loop as unknown as { contextErrorPending: boolean }).contextErrorPending = true;
    (loop as unknown as { contextErrorRecoveryCount: number }).contextErrorRecoveryCount = 3;

    vi.mocked(compactWithBoundary).mockResolvedValue(makeSyntheticCompactResult(history));

    const recoveryExhaustedCb = vi.fn();
    const compactStartedCb = vi.fn();
    await loop.runTurn(
      "trigger turn",
      { onRecoveryExhausted: recoveryExhaustedCb, onCompactStarted: compactStartedCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(recoveryExhaustedCb).toHaveBeenCalledTimes(1);
    expect(compactStartedCb).not.toHaveBeenCalled();
  });

  it("recoveryExhausted blocks subsequent turns until a clean turn re-arms it", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    await loop.resetAndResume("22c2d4bb-b1aa-4a8e-8cf6-2b448106ba8d");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    (loop as unknown as { recoveryExhausted: boolean }).recoveryExhausted = true;

    vi.mocked(compactWithBoundary).mockResolvedValue(makeSyntheticCompactResult(history));

    const compactStartedCb1 = vi.fn();
    await loop.runTurn(
      "turn while exhausted",
      { onCompactStarted: compactStartedCb1 },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(compactStartedCb1).not.toHaveBeenCalled();

    expect((loop as unknown as { recoveryExhausted: boolean }).recoveryExhausted).toBe(false);
    expect((loop as unknown as { contextErrorRecoveryCount: number }).contextErrorRecoveryCount).toBe(0);

    vi.mocked(compactWithBoundary).mockClear();
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));
    (loop as unknown as { contextErrorPending: boolean }).contextErrorPending = true;

    const compactStartedCb2 = vi.fn();
    await loop.runTurn(
      "turn after re-arm",
      { onCompactStarted: compactStartedCb2 },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactStartedCb2).toHaveBeenCalled();
  });
});

describe("getPreflightThreshold — 80% usable-context trigger", () => {
  it("200K context threshold is 80% of 160K usable = 128K", async () => {
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    expect(threshold).toBe(128_000);
  });

  it("128K context threshold is 80% of 98K usable = 78.4K", async () => {
    const threshold = getModelPreflightThreshold("openai", "gpt-4o");
    expect(threshold).toBe(78_400);
  });
});

// Preflight must measure context growth within a tool loop, not only at turn start.
class ToolLoopProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  roundsStarted = 0;

  constructor(private readonly toolRounds: number) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    const round = this.roundsStarted++;
    if (round < this.toolRounds) {
      yield { type: "tool_call", id: `tu-${round}`, name: "probe", input: { n: round } };
      yield { type: "message_complete", stopReason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

class NudgeAndCompactProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly requests: StreamTurnParams[] = [];
  private round = 0;

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.requests.push(input);
    const round = this.round++;
    if (round < 2) {
      yield { type: "tool_call", id: `tu-${round}`, name: "probe", input: { n: round } };
      yield { type: "message_complete", stopReason: "tool_use" };
      return;
    }
    if (round <= 3) {
      yield { type: "reasoning_delta", text: REASONING_BLOCK };
      yield { type: "message_complete", stopReason: "end_turn" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

const REASONING_BLOCK = "weigh the next step. ".repeat(200);

function makeProbeRegistry(resultChars: number) {
  const registry = new ToolRegistry();
  registry.register(
    createDynamicTool({
      name: "probe",
      description: "returns a sizeable result",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: { n: { type: "number" } } },
      execute: async () => ({ output: "R".repeat(resultChars), isError: false }),
    }),
  );
  return registry;
}

async function makeToolLoopSetup(resultChars: number, toolRounds: number) {
  const sessionId = "5c1f0f6d-0f0a-4a1e-9a3f-0b7cb6f2b1de";
  const provider = new ToolLoopProvider(toolRounds);
  const loop = new ConversationLoop(
    makeDeps({
      settingsService: makeSettings(true, "gpt-4o", "openai"),
      memoryManager: makeMemoryManager([], sessionId),
      memoryReviewer: makeMemoryReviewer(),
      toolRegistry: makeProbeRegistry(resultChars) as unknown as ReturnType<typeof makeDeps>["toolRegistry"],
      permissionManager: new PermissionManager(),
    }),
  );
  await loop.resetAndResume(sessionId);
  (loop as unknown as { provider: LLMProvider }).provider = provider;
  return { loop, provider };
}

describe("round-loop token preflight — a turn that grows its own context", () => {
  beforeEach(() => {
    process.env.AVE_DEV_PREFLIGHT_OVERRIDE = "5000";
    vi.mocked(compactWithBoundary).mockImplementation(
      async ({ messages }) => makeSyntheticCompactResult(messages),
    );
  });
  afterEach(() => {
    delete process.env.AVE_DEV_PREFLIGHT_OVERRIDE;
    vi.mocked(compactWithBoundary).mockReset();
  });

  it("compacts mid-turn once the accumulated tool results cross the threshold", async () => {
    // Keep results below the per-result cap so they cross preflight without being stubbed first.
    const { loop, provider } = await makeToolLoopSetup(6_000, 8);
    const decisions: TurnDecisionEvent[] = [];
    const roundsWhenCompacted: number[] = [];
    vi.mocked(compactWithBoundary).mockImplementation(async ({ messages }) => {
      roundsWhenCompacted.push(provider.roundsStarted);
      return makeSyntheticCompactResult(messages);
    });

    await loop.runTurn(
      "run the probe until you are done",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalled();
    expect(roundsWhenCompacted[0]).toBeGreaterThan(0);
    expect(decisions).toContainEqual(
      expect.objectContaining({ kind: "compact.auto", branch: "fired" }),
    );
    // The protected window must count tool rounds to allow active-turn compaction.
    expect(compactWithBoundary).toHaveBeenCalledWith(
      expect.objectContaining({ preserveUnit: "tool-rounds" }),
    );
  });

  it("sends one instruction row, once, when the re-prompt round is also the compacting round", async () => {
    // Measuring and rebuilding a round must not spend or consume its pending re-prompt twice.
    const sessionId = "7c9d2b41-3e18-4c05-8b6a-9d4f1e0a2c73";
    // Preflight must measure pending replay and instructions as part of the assembled request.
    process.env.AVE_DEV_PREFLIGHT_OVERRIDE = "1400";
    const provider = new NudgeAndCompactProvider();
    const deps = makeDeps({
      settingsService: makeSettings(true, "gpt-4o", "openai"),
      memoryManager: makeMemoryManager([], sessionId),
      memoryReviewer: makeMemoryReviewer(),
      toolRegistry: makeProbeRegistry(2_000) as unknown as ReturnType<typeof makeDeps>["toolRegistry"],
      permissionManager: new PermissionManager(),
    });
    const loop = new ConversationLoop(deps);
    await loop.resetAndResume(sessionId);
    (loop as unknown as { provider: LLMProvider }).provider = provider;
    const decisions: TurnDecisionEvent[] = [];

    await loop.runTurn(
      "run the probe until you are done",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(decisions).toContainEqual(
      expect.objectContaining({ kind: "compact.auto", branch: "fired" }),
    );
    const instruction = t("be_conversationLoop.reasoningOnlyContinuePrompt");
    const rePromptRequest = provider.requests[3]!;
    const rePromptRound = rePromptRequest.messages;
    expect(rePromptRequest.systemPrompt).toBe(provider.requests[0]!.systemPrompt);
    expect(rePromptRound[0]?.meta?.compactBoundary).toBe(true);
    expect(compactWithBoundary).toHaveBeenCalledTimes(1);
    const compactInput = vi.mocked(compactWithBoundary).mock.calls[0]![0];
    const projectionInput = {
      ...rePromptRequest,
      toolSchemas: rePromptRequest.tools ?? [],
    };
    const rawHistoryProjection = estimateRequestInputProjection({
      ...projectionInput,
      messages: compactInput.messages,
    }, provider);
    expect(rawHistoryProjection.totalTokens).toBeLessThan(getModelPreflightThreshold("openai", "gpt-4o"));
    // Boundary pressure must match the pending content actually sent after compaction.
    const sentProjection = estimateRequestInputProjection(projectionInput, provider);
    expect(rePromptRound[0]?.meta?.checkpointMeta?.contextTokensAfter).toBe(sentProjection.totalTokens);
    expect(
      rePromptRound.filter(
        (message) =>
          typeof message.content === "string" && message.content.includes(instruction),
      ),
    ).toHaveLength(1);
    expect(decisions.filter((event) => event.kind === "reasoning_only.continuation")).toEqual([
      expect.objectContaining({ branch: "continue", data: expect.objectContaining({ nudgesRun: 0 }) }),
      expect.objectContaining({ branch: "continue", data: expect.objectContaining({ nudgesRun: 1 }) }),
    ]);
  });

  it("leaves the turn-start guard on the between-turns preserve unit", async () => {
    const sessionId = "6ad1f0be-7b2c-4a9e-8f31-2c4d7e9a0b58";
    const history = makeHistoryExceedingEstimateThreshold(5_000);
    const loop = new ConversationLoop(
      makeDeps({
        settingsService: makeSettings(true, "gpt-4o", "openai"),
        memoryManager: makeMemoryManager(history, sessionId),
        memoryReviewer: makeMemoryReviewer(),
      }),
    );
    await loop.resetAndResume(sessionId);
    (loop as unknown as { provider: LLMProvider }).provider = new ToolLoopProvider(0);

    await loop.runTurn("one more question", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    expect(compactWithBoundary).toHaveBeenCalledWith(
      expect.not.objectContaining({ preserveUnit: expect.anything() }),
    );
  });

  it("leaves the turn-start guard as the only compaction when the history arrives over the threshold", async () => {
    // Turn-start preflight already covers the first call; round preflight must not compact it twice.
    const sessionId = "0f2b7a63-1a26-4f0e-9c1e-6a1a6a2b31c7";
    const history = makeHistoryExceedingEstimateThreshold(5_000);
    const provider = new ToolLoopProvider(0);
    const roundsWhenCompacted: number[] = [];
    vi.mocked(compactWithBoundary).mockImplementation(async ({ messages }) => {
      roundsWhenCompacted.push(provider.roundsStarted);
      return makeSyntheticCompactResult(messages);
    });
    const loop = new ConversationLoop(
      makeDeps({
        settingsService: makeSettings(true, "gpt-4o", "openai"),
        memoryManager: makeMemoryManager(history, sessionId),
        memoryReviewer: makeMemoryReviewer(),
      }),
    );
    await loop.resetAndResume(sessionId);
    (loop as unknown as { provider: LLMProvider }).provider = provider;
    const decisions: TurnDecisionEvent[] = [];

    await loop.runTurn(
      "one more question",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(roundsWhenCompacted).toEqual([0]);
    expect(decisions.filter((event) => event.kind === "compact.auto")).toEqual([]);
  });

  it("leaves a turn that stays under the threshold alone", async () => {
    const { loop } = await makeToolLoopSetup(200, 6);
    const decisions: TurnDecisionEvent[] = [];

    await loop.runTurn(
      "run the probe until you are done",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(decisions.filter((event) => event.kind === "compact.auto")).toEqual([]);
  });

  it("does not fire again on the next round when a compaction left the projection over the threshold", async () => {
    // Partial progress must not immediately re-arm compaction while still above the threshold.
    const { loop } = await makeToolLoopSetup(1_200, 40);
    const decisions: TurnDecisionEvent[] = [];
    vi.mocked(compactWithBoundary).mockImplementation(async ({ messages }) => ({
      status: CompressionStatus.SUMMARIZED,
      boundary: makeSyntheticCompactResult(messages).boundary,
      newHistory: messages.slice(1),
      removedCount: 1,
      estimatedAfter: 0,
      truncatedCount: 0,
    }));

    await loop.runTurn(
      "run the probe until you are done",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const held = decisions.filter(
      (event) => event.kind === "compact.auto" && event.branch === "rearm-hold",
    ).length;
    expect(vi.mocked(compactWithBoundary).mock.calls.length).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(0);
  });

  it("does not spend a compaction per round when compaction cannot reduce the history", async () => {
    // No-op compaction must not spend another model call on every subsequent round.
    const { loop } = await makeToolLoopSetup(1_200, 40);
    const decisions: TurnDecisionEvent[] = [];
    vi.mocked(compactWithBoundary).mockImplementation(
      async ({ messages }) => makeSyntheticNoopResult(messages),
    );

    await loop.runTurn(
      "run the probe until you are done",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const attempts = vi.mocked(compactWithBoundary).mock.calls.length;
    const held = decisions.filter(
      (event) => event.kind === "compact.auto" && event.branch === "rearm-hold",
    ).length;
    expect(attempts).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(0);
  });
});
