import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { MemoryReviewerService } from "../../memory/memory-reviewer-service.js";
import { compactionModelRouteKey } from "../../shared/compaction-model.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { ConversationLoop, type ConversationLoopDeps } from "../conversation-loop.js";
import { createProvider } from "../llm/provider-factory.js";
import type { LLMProvider, LLMVendor, ProviderConfig } from "../llm/types.js";
import { compactWithBoundary } from "../structured-compact.js";
import { makeConversationLoopDeps } from "./conversation-loop-test-helpers.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

vi.mock("../llm/provider-factory.js", async (original) => ({
  ...await original<typeof import("../llm/provider-factory.js")>(),
  createProvider: vi.fn(),
}));
vi.mock("../structured-compact.js", async (original) => ({
  ...await original<typeof import("../structured-compact.js")>(),
  compactWithBoundary: vi.fn(),
}));

function fixture(
  failure = "503 selected summary model unavailable",
  {
    compactionModel = "summary-model",
    fallbackVendor = "claude",
    failures = Infinity,
  }: { compactionModel?: string; fallbackVendor?: LLMVendor; failures?: number } = {},
) {
  const llm = structuredClone(DEFAULT_SETTINGS.llm);
  llm.provider = "openai";
  llm.vendors.openai = {
    ...getLlmVendorSettings(llm.vendors, "openai"),
    model: "chat-model",
    baseUrl: "https://primary.example.test/v1",
  };
  llm.vendors.claude = {
    ...getLlmVendorSettings(llm.vendors, "claude"),
    baseUrl: "https://fallback.example.test/v1",
  };
  llm.compactionModel = compactionModel;
  llm.compactionModelRoute = compactionModelRouteKey(llm);
  llm.fallbackChain = [{ provider: fallbackVendor, model: "fallback-model" }];
  const calls: { vendor: LLMVendor; model: string; endpoint?: string }[] = [];
  let failedAttempts = 0;
  vi.mocked(createProvider).mockImplementation((config: ProviderConfig): LLMProvider => ({
    vendor: config.vendor,
    async *streamTurn(params) {
      calls.push({ vendor: config.vendor, model: params.model, endpoint: config.baseUrl });
      if (params.model === (compactionModel || "chat-model") && failedAttempts++ < failures) {
        throw new Error(failure);
      }
      yield { type: "text_delta", text: "available summary" };
      yield { type: "message_complete", stopReason: "end_turn" };
    },
  }));
  const deps = makeConversationLoopDeps({
    memoryReviewer: new MemoryReviewerService({ resolveActiveChatOneShot: () => null }),
  });
  const get = deps.settingsService.get.bind(deps.settingsService);
  deps.settingsService = {
    ...deps.settingsService,
    get: (key: string) => key === "llm" ? llm : get(key as never),
    getSecret: () => "fixture-secret",
  } as unknown as ConversationLoopDeps["settingsService"];
  return { loop: new ConversationLoop(deps), calls, llm };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

async function settle<T>(operation: Promise<T>): Promise<T> {
  // Attach handlers before driving retry timers so expected failures never become unhandled rejections.
  const outcome = operation.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.value;
}

describe("explicit compaction model failure", () => {
  it("propagates missing-model errors without fallback", async () => {
    const { loop, calls } = fixture("404 model_not_found");
    await expect(loop.generateCompactionText("history")).rejects.toThrow("model_not_found");
    expect(calls).toHaveLength(1);
  });

  it("fails clearly when the selected summary model is unavailable", async () => {
    const { loop, calls } = fixture();
    await expect(settle(loop.generateCompactionText("history"))).rejects.toThrow("503 selected summary model unavailable");
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.model === "summary-model")).toBe(true);
    expect(calls.every((call) => call.vendor === "openai" && call.endpoint === "https://primary.example.test/v1")).toBe(true);
    expect(createProvider).toHaveBeenCalledTimes(2);
    await expect(loop.generateText("normal generation")).resolves.toBe("available summary");
    expect(calls.at(-1)?.model).toBe("chat-model");
  });

  it("does not substitute a fallback model on the same provider", async () => {
    const { loop, calls } = fixture(undefined, { fallbackVendor: "openai" });
    await expect(settle(loop.generateCompactionText("history"))).rejects.toThrow("503 selected summary model unavailable");
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.model === "summary-model")).toBe(true);
  });

  it("can recover through retries on the selected model", async () => {
    const { loop, calls } = fixture(undefined, { failures: 2 });
    await expect(settle(loop.generateCompactionText("history"))).resolves.toBe("available summary");
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.model === "summary-model" && call.vendor === "openai" && call.endpoint === "https://primary.example.test/v1")).toBe(true);
  });

  it("retains configured fallback when the compaction model selection is empty", async () => {
    const { loop, calls } = fixture(undefined, { compactionModel: "" });
    await expect(settle(loop.generateCompactionText("history"))).resolves.toBe("available summary");
    expect(calls).toHaveLength(6);
    expect(calls.slice(0, 5).every((call) => call.model === "chat-model")).toBe(true);
    expect(calls.at(-1)).toEqual({ vendor: "claude", model: "fallback-model", endpoint: "https://fallback.example.test/v1" });
  });

  it("retains the current-model path when a saved selection belongs to another route", async () => {
    const { loop, calls, llm } = fixture(undefined, { compactionModel: "" });
    llm.compactionModel = "inactive-summary-model";
    llm.compactionModelRoute = "inactive-route";
    await expect(settle(loop.generateCompactionText("history"))).resolves.toBe("available summary");
    expect(calls[0]?.model).toBe("chat-model");
    expect(calls.at(-1)?.model).toBe("fallback-model");
  });

  it.each(["manual", "auto"] as const)("keeps %s compaction failures on the existing error path without rewriting history", async (trigger) => {
    const { loop, calls } = fixture();
    loop.history.append({ role: "user", content: "question" });
    loop.history.append({ role: "assistant", content: "answer" });
    const before = loop.history.getMessages();
    vi.mocked(compactWithBoundary).mockImplementationOnce(async ({ memoryReviewer }) => {
      await memoryReviewer.review("recap", "history");
      throw new Error("Summary unexpectedly succeeded");
    });
    const onCompactOccurred = vi.fn();
    if (trigger === "manual") {
      const result = await settle(loop.manualCompact({ onCompactOccurred }));
      expect(result).toMatchObject({ compacted: false, compactedAt: null, removedMessageCount: 0 });
      expect(result.summary).toContain("503 selected summary model unavailable");
    } else {
      const trace = vi.spyOn(loop.tracer, "step");
      const scope = loop.resolveToolScope("");
      const projection = loop.createRequestProjectionContext(scope, null, undefined, loop.rebuildToolSchemas(scope));
      await expect(settle(loop.runPreflightGuard(projection, undefined, { onCompactOccurred }, { forceReason: "rate-limit" }))).resolves.toBe(false);
      expect(trace).toHaveBeenCalledWith("COMPACTION_RESULT", expect.objectContaining({
        status: "error", message: "503 selected summary model unavailable",
      }));
    }
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.model === "summary-model")).toBe(true);
    expect(onCompactOccurred).not.toHaveBeenCalled();
    expect(loop.history.getMessages()).toEqual(before);
    expect(loop.isCompacting).toBe(false);
  });
});


describe("automatic compaction failure visibility", () => {
  it("reports summary-model exhaustion without terminating a usable chat route", async () => {
    const { loop, calls } = fixture();
    vi.mocked(compactWithBoundary).mockImplementationOnce(async ({ memoryReviewer }) => {
      await memoryReviewer.review("recap", "history");
      throw new Error("Summary unexpectedly succeeded");
    });
    vi.spyOn(loop, "estimateCurrentRequestProjection").mockReturnValue({
      totalTokens: 90_000, systemPromptTokens: 0, messageTokens: 90_000, toolSchemaTokens: 0,
    });
    const onError = vi.fn();
    const onTextDelta = vi.fn();
    const result = await settle(loop.runTurn("hello", { onError, onTextDelta }, undefined, { ...userKeyboardTurn() }));
    expect(calls.filter((call) => call.model === "summary-model")).toHaveLength(5);
    expect(calls.some((call) => call.model === "fallback-model")).toBe(false);
    expect(onError).toHaveBeenCalledExactlyOnceWith("Automatic compaction failed", undefined, undefined, "compaction");
    expect(onTextDelta).toHaveBeenCalledWith("available summary");
    expect(result.stopReason).toBe("end_turn");
  });
});


describe("cancelled compaction", () => {
  it("does not publish a maintenance failure for a user cancellation", async () => {
    const { loop } = fixture();
    loop.history.append({ role: "user", content: "question" });
    loop.history.append({ role: "assistant", content: "answer" });
    const before = loop.history.getMessages();
    const controller = new AbortController();
    vi.mocked(compactWithBoundary).mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("cancelled");
    });
    const scope = loop.resolveToolScope("");
    const projection = loop.createRequestProjectionContext(scope, null, undefined, loop.rebuildToolSchemas(scope));
    const onError = vi.fn();
    await expect(loop.runPreflightGuard(projection, controller.signal, { onError }, { forceReason: "rate-limit" })).resolves.toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(loop.history.getMessages()).toEqual(before);
  });
});
