import { strict as assert } from "node:assert";
import { systemSubagentRouteIdentity } from "../../shared/system-subagent-model.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ConversationLoop } from "../conversation-loop.js";
import { createProvider } from "../llm/provider-factory.js";
import type { LLMProvider, ProviderConfig, StreamTurnParams } from "../llm/types.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import type { SubscriptionChatRuntimeSelection, SubscriptionRuntimeId } from "../../shared/subscription-runtime.js";

vi.mock("../llm/provider-factory.js", async (original) => ({
  ...await original<typeof import("../llm/provider-factory.js")>(),
  createProvider: vi.fn(),
}));

function makeLoop(selected = false) {
  const llm = structuredClone(DEFAULT_SETTINGS.llm);
  llm.provider = "openai";
  llm.vendors.openai = { ...getLlmVendorSettings(llm.vendors, "openai"), model: "chat-model", baseUrl: "https://chat.example.test/v1" };
  llm.vendors.claude = { ...getLlmVendorSettings(llm.vendors, "claude"), model: "summary-model", baseUrl: "https://summary.example.test/v1" };
  const summaryRoute = systemSubagentRouteIdentity(llm, "claude");
  assert(summaryRoute);
  llm.compactionModelSelection = selected ? { vendor: "claude", model: "summary-model", route: summaryRoute } : null;
  const requests: Array<{ vendor: string; params: StreamTurnParams }> = [];
  const providerFor = (vendor: string, subscriptionRuntime?: LLMProvider["subscriptionRuntime"]): LLMProvider => ({
    vendor: vendor as LLMProvider["vendor"],
    ...(subscriptionRuntime ? { subscriptionRuntime } : {}),
    async *streamTurn(params) {
      requests.push({ vendor, params });
      yield { type: "text_delta", text: "summary" };
      yield { type: "message_complete", stopReason: "end_turn" };
    },
  });
  vi.mocked(createProvider).mockImplementation((config: ProviderConfig) => providerFor(config.vendor));
  const subscriptionProviderFactory = vi.fn((selection: SubscriptionChatRuntimeSelection) => providerFor("openai", selection));
  const sessions = { saveSession: vi.fn(), listSessions: vi.fn(() => []) };
  const loop = new ConversationLoop({
    settingsService: { get: (key: string) => key === "llm" ? llm : DEFAULT_SETTINGS.marketplace, getSecret: vi.fn(() => "route-secret") },
    systemPromptBuilder: { build: () => "system" },
    toolRegistry: new ToolRegistry(),
    memoryManager: { sessions },
    networkFetch: fetch,
    subscriptionProviderFactory,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  return { loop, llm, requests, sessions, subscriptionProviderFactory };
}

beforeEach(() => vi.clearAllMocks());

describe("hidden compaction instance routing", () => {
  it.each(["codex", "chatgpt-plan", "claude-code", "kimi-code", "grok-build"] satisfies SubscriptionRuntimeId[])(
    "uses the selected separate route with a %s main runtime", async (provider) => {
      const { loop, llm, requests, sessions, subscriptionProviderFactory } = makeLoop(true);
      llm.activeChatRuntime = { kind: "subscription", provider };
      await loop.refreshProvider();
      expect(loop.provider?.subscriptionRuntime).toEqual(llm.activeChatRuntime);
      const mainProvider = loop.provider;
      const subscriptionCalls = subscriptionProviderFactory.mock.calls.length;
      sessions.saveSession.mockClear();
      await expect(loop.generateCompactionText("history", "recap", undefined, 1_200)).resolves.toBe("summary");
      expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
        vendor: "claude", model: "summary-model", apiKey: "route-secret", baseUrl: "https://summary.example.test/v1",
      }));
      expect(requests).toEqual([{ vendor: "claude", params: expect.objectContaining({ model: "summary-model", tools: [], systemPrompt: "recap", outputTokenLimit: 1_200 }) }]);
      expect(loop.provider).toBe(mainProvider);
      expect(subscriptionProviderFactory).toHaveBeenCalledTimes(subscriptionCalls);
      expect(sessions.saveSession).not.toHaveBeenCalled();
      expect(sessions.listSessions()).toEqual([]);
      expect(loop.history.getMessages()).toEqual([]);
    },
  );

  it("follows the current session model through a fresh instance when unset", async () => {
    const { loop, requests } = makeLoop();
    await loop.setSessionModelOverride("session-model");
    const mainProvider = loop.provider;
    const builds = vi.mocked(createProvider).mock.calls.length;
    await loop.generateCompactionText("history");
    expect(requests[0]?.params.model).toBe("session-model");
    expect(createProvider).toHaveBeenCalledTimes(builds + 1);
    expect(loop.provider).toBe(mainProvider);
  });

  it.each(["chatgpt-plan", "claude-code"] as const)("follows %s when unset", async (provider) => {
    const { loop, llm, requests, subscriptionProviderFactory } = makeLoop();
    llm.activeChatRuntime = { kind: "subscription", provider, model: "chat-native-model" };
    await loop.refreshProvider();
    expect(loop.provider?.subscriptionRuntime).toEqual(llm.activeChatRuntime);
    await loop.generateCompactionText("history");
    expect(subscriptionProviderFactory).toHaveBeenLastCalledWith(llm.activeChatRuntime);
    expect(requests[0]?.params.model).toBe("chat-native-model");
  });

  it("fails clearly when the selected provider disconnects", async () => {
    const { loop } = makeLoop(true);
    vi.spyOn(loop.deps.settingsService, "getSecret").mockResolvedValue(null);
    await expect(loop.generateCompactionText("history")).rejects.toThrow("System subagent model is unavailable: claude/summary-model");
  });

  it("fails clearly when the selected model disappears", async () => {
    const { loop, llm, requests } = makeLoop(true);
    assert(llm.compactionModelSelection);
    llm.compactionModelSelection = { ...llm.compactionModelSelection, model: "missing-summary-model" };
    await expect(loop.generateCompactionText("history")).rejects.toThrow("System subagent model is unavailable: claude/missing-summary-model");
    expect(requests).toEqual([]);
  });

  it("keeps ordinary generations on the main route", async () => {
    const { loop, requests, llm } = makeLoop(true);
    await loop.generateCompactionText("history");
    await loop.generateText("normal");
    expect(requests.map(({ vendor, params }) => [vendor, params.model])).toEqual([["claude", "summary-model"], ["openai", "chat-model"]]);
    expect(llm.vendors.openai?.model).toBe("chat-model");
  });
});
