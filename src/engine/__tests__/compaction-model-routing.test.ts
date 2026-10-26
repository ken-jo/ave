import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ConversationLoop } from "../conversation-loop.js";
import { createProvider } from "../llm/provider-factory.js";
import type { LLMProvider, ProviderConfig, StreamTurnParams } from "../llm/types.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { compactionModelRouteKey } from "../../shared/compaction-model.js";

vi.mock("../llm/provider-factory.js", async (original) => ({
  ...await original<typeof import("../llm/provider-factory.js")>(),
  createProvider: vi.fn(),
}));

function makeLoop(compactionModel = "") {
  const llm = structuredClone(DEFAULT_SETTINGS.llm);
  llm.provider = "openai";
  llm.vendors.openai = { ...getLlmVendorSettings(llm.vendors, "openai"), model: "chat-model", baseUrl: "https://models.example.test/v1" };
  llm.compactionModel = compactionModel;
  llm.compactionModelRoute = compactionModelRouteKey(llm);
  const requests: StreamTurnParams[] = [];
  vi.mocked(createProvider).mockImplementation((config: ProviderConfig): LLMProvider => ({
    vendor: config.vendor,
    async *streamTurn(params) {
      requests.push(params);
      yield { type: "text_delta", text: "summary" };
      yield { type: "message_complete", stopReason: "end_turn" };
    },
  }));
  const loop = new ConversationLoop({
    settingsService: { get: () => llm, getSecret: () => "route-secret" },
    systemPromptBuilder: { build: () => "system" },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  return { loop, llm, requests };
}

beforeEach(() => vi.clearAllMocks());

describe("compaction model routing", () => {
  it("leaves a saved model inactive after the provider endpoint changes", async () => {
    const { loop, llm, requests } = makeLoop("summary-model");
    llm.vendors.openai!.baseUrl = "https://different.example.test/v1";
    await loop.generateCompactionText("history");
    expect(requests[0]?.model).toBe("chat-model");
  });
  it("follows the originating session model when the selection is empty", async () => {
    const { loop, requests } = makeLoop();
    loop.setSessionModelOverride("session-model");
    await loop.generateCompactionText("history");
    expect(requests[0]?.model).toBe("session-model");
  });

  it("keeps unsupported runtimes on their own current model despite an inactive saved override", async () => {
    const { loop, llm, requests } = makeLoop("inactive-summary-model");
    llm.activeChatRuntime = { kind: "subscription", provider: "kimi-code" };
    const callsBefore = vi.mocked(createProvider).mock.calls.length;
    loop.provider = {
      vendor: "openai",
      subscriptionRuntime: { kind: "subscription", provider: "kimi-code" },
      async *streamTurn(params) {
        requests.push(params);
        yield { type: "text_delta", text: "summary" };
        yield { type: "message_complete", stopReason: "end_turn" };
      },
    };
    await loop.generateCompactionText("history");
    expect(requests[0]?.model).toBe("default");
    expect(createProvider).toHaveBeenCalledTimes(callsBefore);
  });

  it("keeps the chat model when no separate model is selected", async () => {
    const { loop, requests } = makeLoop();
    await expect(loop.generateCompactionText("history", "recap", undefined, 1_200)).resolves.toBe("summary");
    expect(requests[0]).toMatchObject({ model: "chat-model", tools: [], outputTokenLimit: 1_200 });
  });

  it("uses the separate model on the same endpoint and secret without changing normal generations", async () => {
    const { loop, requests, llm } = makeLoop("summary-model");
    const abort = new AbortController();
    await loop.generateCompactionText("history", "recap", abort.signal, 1_200);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
      vendor: "openai", model: "summary-model", apiKey: "route-secret", baseUrl: "https://models.example.test/v1",
    }));
    expect(requests[0]).toMatchObject({ model: "summary-model", tools: [], systemPrompt: "recap", outputTokenLimit: 1_200 });
    await loop.generateText("normal");
    expect(requests[1]?.model).toBe("chat-model");
    expect(llm.vendors.openai?.model).toBe("chat-model");
  });
});
