import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage } from "../llm/types.js";
import {
  makeConversationLoopDeps as makeDeps,
  makeConversationLoopMemoryManager as makeMemoryManager,
  makeConversationLoopMemoryReviewer as makeMemoryReviewer,
  makeConversationTurnProvider as makeProviderStub,
} from "./conversation-loop-test-helpers.js";
import { getModelPreflightThreshold } from "../auto-compact.js";
import { getPreflightThreshold } from "../../shared/context-budget.js";
import { MemoryReviewerService } from "../../memory/memory-reviewer-service.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { compactionModelRouteKey } from "../../shared/compaction-model.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { llmModelListCacheKey } from "../../shared/llm-model-list.js";
import { llmRouteCatalogAddress } from "../../shared/context-budget.js";

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

describe("manualCompact — /compact deadlock guidance (M3 scenarios)", () => {
  it("derives the separate summarizer input ceiling from its own endpoint capacity", async () => {
    const history: GenericMessage[] = [{ role: "user", content: "question" }, { role: "assistant", content: "answer" }];
    const llm = structuredClone(DEFAULT_SETTINGS.llm);
    llm.provider = "claude";
    llm.vendors.claude = { ...getLlmVendorSettings(llm.vendors, "claude"), model: "claude-sonnet-4-5" };
    llm.compactionModel = "summary-small";
    llm.compactionModelRoute = compactionModelRouteKey(llm);
    const address = llmRouteCatalogAddress(llm);
    llm.modelListCache[llmModelListCacheKey(address.vendor, address.baseUrl, address.credentialScope)] = {
      vendor: "claude", ...(address.baseUrl ? { baseUrl: address.baseUrl } : {}), endpoint: "https://models.example.test",
      fetchedAt: new Date().toISOString(), models: ["summary-small"], modelEntries: [{ id: "summary-small", contextLength: 8_000 }],
    };
    const deps = makeDeps({ memoryManager: makeMemoryManager(history) });
    const get = deps.settingsService.get.bind(deps.settingsService);
    const settingsService = { ...deps.settingsService, get: (key: string) => key === "llm" ? llm : get(key as never) } as typeof deps.settingsService;
    const loop = new ConversationLoop({ ...deps, settingsService });
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");
    loop.provider = { vendor: "claude", async *streamTurn() { yield { type: "message_complete", stopReason: "end_turn" }; } };
    vi.mocked(compactWithBoundary).mockResolvedValueOnce({ status: CompressionStatus.NOOP, boundary: null,
      newHistory: history, removedCount: 0, estimatedAfter: 0, truncatedCount: 0 });
    await loop.manualCompact();
    expect(compactWithBoundary).toHaveBeenCalledWith(expect.objectContaining({
      preflightTokens: getModelPreflightThreshold("claude", "claude-sonnet-4-5"),
      summaryInputTokens: getModelPreflightThreshold("claude", "summary-small", 8_000),
    }));
  });

  it("M3-B: removedCount=0 returns generic 'not needed' message (both small-history and deadlock branches)", async () => {
    const small: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];

    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(small) }));
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: small,
      removedCount: 0,
      estimatedAfter: 0,
      truncatedCount: 0,
    });

    const result = await loop.manualCompact();
    expect(result.compacted).toBe(false);
    expect(result.summary).toBe("컴팩트 불필요: 메시지 수가 충분히 적습니다.");
  });

  it("uses the provider-native projection for manual compact estimates", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ];
    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(history) }));
    await loop.resetAndResume("41a56357-be2a-42c7-819b-0bf0bc843b39");
    const projection = {
      totalTokens: 12_345,
      systemPromptTokens: 0,
      messageTokens: 12_345,
      toolSchemaTokens: 0,
    };
    const projectRequestInput = vi.fn(() => projection);
    const provider = { ...makeProviderStub(), projectRequestInput };
    (loop as unknown as { provider: typeof provider }).provider = provider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: history,
      removedCount: 0,
      estimatedAfter: 0,
      truncatedCount: 0,
    });
    const started = vi.fn();

    await loop.manualCompact({ onCompactStarted: started });

    expect(projectRequestInput).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.any(String),
      messages: expect.any(Array),
      toolSchemas: expect.any(Array),
    }));
    expect(started).toHaveBeenCalledWith(expect.objectContaining({
      estimatedBefore: 12_345,
    }));
  });

  it("routes subscription-runtime history through the common Memory Reviewer", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ];
    const memoryReviewer = new MemoryReviewerService({ resolveActiveChatOneShot: () => null });
    const loop = new ConversationLoop(
      makeDeps({ memoryManager: makeMemoryManager(history), memoryReviewer }),
    );
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");
    const provider = {
      ...makeProviderStub(),
      // The selected subscription model must own the threshold despite inactive API-key settings.
      subscriptionRuntime: {
        kind: "subscription" as const,
        provider: "codex" as const,
        model: "gpt-5.4-nano",
      },
    };
    (loop as unknown as { provider: typeof provider }).provider = provider;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.SUMMARIZED,
      boundary: {
        id: "subscription-boundary",
        compactNum: 1,
        summary: { goal: "", constraints: "", progress: "", decisions: "", files: [], nextSteps: "", criticalContext: "", currentPlan: "", verificationState: "", openBlockers: "", unsafePendingActions: "", lastToolBoundary: "" },
        toolBoundaryLedger: [],
        pinnedArtifacts: [],
        createdAt: new Date().toISOString(),
      } as never,
      newHistory: history.slice(-2),
      removedCount: 2,
      estimatedAfter: 100,
      truncatedCount: 0,
    });

    const result = await loop.manualCompact();

    expect(result).toMatchObject({ compacted: true, removedMessageCount: 2 });
    expect(compactWithBoundary).toHaveBeenCalledWith(expect.objectContaining({
      memoryReviewer: expect.objectContaining({ review: expect.any(Function) }),
      preflightTokens: getModelPreflightThreshold("openai", "gpt-5.4-nano"),
    }));
    const compactArgs = vi.mocked(compactWithBoundary).mock.calls[0]?.[0];
    const generate = vi.spyOn(loop, "generateCompactionText").mockResolvedValue("originating summary");
    await expect(compactArgs?.memoryReviewer.review("recap", "history", { systemPrompt: "recap contract" }))
      .resolves.toBe("originating summary");
    expect(generate).toHaveBeenCalledWith("history", expect.stringContaining("recap contract"), undefined, 1_200);
    expect(compactArgs).not.toHaveProperty("llm");
    expect(compactArgs).not.toHaveProperty("model");
  });

  it("uses an independent conservative budget for ACP subscriptions without model metadata", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ];
    // Missing subscription model IDs must not borrow the inactive provider context window.
    const memoryReviewer = makeMemoryReviewer();
    const loop = new ConversationLoop(
      makeDeps({ memoryManager: makeMemoryManager(history), memoryReviewer }),
    );
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");
    const provider = {
      ...makeProviderStub(),
      subscriptionRuntime: { kind: "subscription" as const, provider: "kimi-code" as const },
    };
    (loop as unknown as { provider: typeof provider }).provider = provider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: history,
      removedCount: 0,
      estimatedAfter: 0,
      truncatedCount: 0,
    });

    const started = vi.fn();
    await loop.manualCompact({ onCompactStarted: started });

    const expectedPreflight = getPreflightThreshold(64_000);
    expect(started).toHaveBeenCalledWith(expect.objectContaining({
      preflight: expectedPreflight,
    }));
    expect(compactWithBoundary).toHaveBeenCalledWith(expect.objectContaining({
      memoryReviewer: expect.objectContaining({ review: expect.any(Function) }),
      preflightTokens: expectedPreflight,
    }));
    const compactArgs = vi.mocked(compactWithBoundary).mock.calls[0]?.[0];
    expect(compactArgs).not.toHaveProperty("llm");
    expect(compactArgs).not.toHaveProperty("model");
  });

  it("M3-C: successful compact returns compacted=true with removedMessageCount", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "msg2" },
      { role: "assistant", content: "reply2" },
    ];

    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(history) }));
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.SUMMARIZED,
      boundary: {
        id: "b1",
        compactNum: 1,
        summary: { goal: "", constraints: "", progress: "", decisions: "", files: [], nextSteps: "", criticalContext: "", currentPlan: "", verificationState: "", openBlockers: "", unsafePendingActions: "", lastToolBoundary: "" },
        toolBoundaryLedger: [],
        pinnedArtifacts: [],
        createdAt: new Date().toISOString(),
      } as never,
      newHistory: history.slice(-2),
      removedCount: 2,
      estimatedAfter: 100,
      truncatedCount: 0,
    });

    const result = await loop.manualCompact();
    expect(result.compacted).toBe(true);
    expect(result.removedMessageCount).toBe(2);
  });

  it("Trigger: manualCompact fires onCompactStarted with triggerSource='manual'", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "x".repeat(40_000) },
    ];

    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(history) }));
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: history,
      removedCount: 0,
      estimatedAfter: 0,
      truncatedCount: 0,
    });

    const startedCb = vi.fn();
    await loop.manualCompact({ onCompactStarted: startedCb });

    expect(startedCb).toHaveBeenCalledTimes(1);
    const arg = startedCb.mock.calls[0]?.[0];
    expect(arg?.triggerSource).toBe("manual");
    expect(typeof arg?.estimatedBefore).toBe("number");
    expect(arg?.preflight).toBeGreaterThan(0);
  });
});

describe("manualCompact — #811 m2 PreCompact / PostCompact lifecycle events", () => {
  function stubManager() {
    return {
      setTrustedHooks: vi.fn(),
      setTrustedRegistry: vi.fn(),
      size: () => 0,
      runPreToolUse: vi.fn(),
      runPostToolUse: vi.fn(),
      runPermissionRequest: vi.fn(),
      runLifecycleEvent: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
    };
  }

  it("fires PreCompact (reason=manual) then PostCompact around an applied compaction", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "msg2" },
      { role: "assistant", content: "reply2" },
    ];
    const mgr = stubManager();
    const loop = new ConversationLoop(
      makeDeps({ memoryManager: makeMemoryManager(history), scriptHookManager: mgr as never }),
    );
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.SUMMARIZED,
      boundary: {
        id: "b1",
        compactNum: 1,
        summary: { goal: "", constraints: "", progress: "", decisions: "", files: [], nextSteps: "", criticalContext: "", currentPlan: "", verificationState: "", openBlockers: "", unsafePendingActions: "", lastToolBoundary: "" },
        toolBoundaryLedger: [],
        pinnedArtifacts: [],
        createdAt: new Date().toISOString(),
      } as never,
      newHistory: history.slice(-2),
      removedCount: 2,
      estimatedAfter: 100,
      truncatedCount: 0,
    });

    await loop.manualCompact();

    const pre = mgr.runLifecycleEvent.mock.calls.find((c) => c[0] === "PreCompact");
    const post = mgr.runLifecycleEvent.mock.calls.find((c) => c[0] === "PostCompact");
    expect(pre).toBeDefined();
    expect((pre?.[3] as { reason: string }).reason).toBe("manual");
    expect(typeof (pre?.[3] as { tokenEstimate: number }).tokenEstimate).toBe("number");

    expect(post).toBeDefined();
    const postPayload = post?.[3] as {
      reason: string;
      messagesBefore: number; messagesAfter: number; tokensBefore: number; tokensAfter: number;
    };
    expect(postPayload.reason).toBe("manual");
    expect(postPayload.messagesBefore).toBe(4);
    expect(typeof postPayload.messagesAfter).toBe("number");
    expect(typeof postPayload.tokensBefore).toBe("number");
    expect(typeof postPayload.tokensAfter).toBe("number");
  });

  it("a NOOP compact fires PreCompact but NOT PostCompact (no mutation applied)", async () => {
    const small: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const mgr = stubManager();
    const loop = new ConversationLoop(
      makeDeps({ memoryManager: makeMemoryManager(small), scriptHookManager: mgr as never }),
    );
    await loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: small,
      removedCount: 0,
      estimatedAfter: 0,
      truncatedCount: 0,
    });

    await loop.manualCompact();

    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "PreCompact")).toBe(true);
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "PostCompact")).toBe(false);
  });
});
