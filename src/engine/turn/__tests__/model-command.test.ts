import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputClassifier } from "../../../core/input-classifier.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ConversationLoop } from "../../conversation-loop.js";
import type { LLMProvider, ProviderConfig, StreamEvent, StreamTurnParams } from "../../llm/types.js";
import { t } from "../../../i18n/index.js";
import { llmModelListCacheKey } from "../../../shared/llm-model-list.js";
import { contextBudgetForCurrentRuntime } from "../compaction.js";
import type { ActiveChatRuntime } from "../../../shared/subscription-runtime.js";
import { userKeyboardTurn } from "../../../__tests__/support/user-keyboard-turn.js";

const state = vi.hoisted(() => ({
  configs: [] as ProviderConfig[],
  requests: [] as StreamTurnParams[],
  endpointModels: undefined as string[] | undefined,
  refreshes: 0,
}));

vi.mock("../../llm/model-list.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../llm/model-list.js")>(),
  refreshRouteModelList: async (params: {
    settingsService: { get(key: "llm"): { modelListCache?: Record<string, unknown> } };
    address: { vendor: string; baseUrl?: string; credentialScope?: string };
  }) => {
    state.refreshes += 1;
    if (!state.endpointModels) return false;
    const { llmModelListCacheKey } = await import("../../../shared/llm-model-list.js");
    const llm = params.settingsService.get("llm");
    llm.modelListCache = {
      ...llm.modelListCache,
      [llmModelListCacheKey(params.address.vendor, params.address.baseUrl, params.address.credentialScope)]: {
        vendor: params.address.vendor,
        endpoint: "https://llm.example.test/v1/models",
        models: state.endpointModels,
        fetchedAt: new Date().toISOString(),
      },
    };
    return true;
  },
}));

vi.mock("../../llm/provider-factory.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../llm/provider-factory.js")>(),
  createProvider: (config: ProviderConfig) => {
    state.configs.push(config);
    return {
      vendor: config.vendor,
      async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
        state.requests.push(params);
        yield { type: "text_delta", text: "done" };
        yield { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } };
      },
    };
  },
}));

function makeLoop(llm: ReturnType<typeof fakeLlmSettings> & { activeChatRuntime?: ActiveChatRuntime } = fakeLlmSettings({ model: "gpt-5.4" })) {
  const loop = new ConversationLoop({
    settingsService: { get: () => llm, getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system", setToolScope: vi.fn() },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    disableSessionPersistence: true,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  return { llm, loop };
}

beforeEach(() => {
  state.configs.length = 0;
  state.requests.length = 0;
  state.endpointModels = undefined;
  state.refreshes = 0;
});

function customEndpointLoop() {
  const llm = fakeLlmSettings({ provider: "openai-compatible", model: "served-model" });
  llm.vendors["openai-compatible"].baseUrl = "https://llm.example.test/v1";
  return makeLoop(llm);
}

describe("/model", () => {
  it("reports the configured model when called without an argument", async () => {
    const { loop } = makeLoop();
    const result = await loop.handleCommand("model", "", "user-keyboard");
    expect(result.route).toBe("command");
    expect(result.text).toContain("gpt-5.4");
  });

  it("switches the next round to the requested model without touching settings", async () => {
    const { llm, loop } = makeLoop();
    const result = await loop.handleCommand("model", " gpt-5.4-mini ", "user-keyboard");
    expect(result.text).toContain("gpt-5.4-mini");
    expect(state.configs.at(-1)?.model).toBe("gpt-5.4-mini");
    expect(contextBudgetForCurrentRuntime(loop)).toMatchObject({ model: "gpt-5.4-mini" });

    await loop.runTurn("reply", undefined, undefined, { ...userKeyboardTurn() });
    expect(state.requests.at(-1)?.model).toBe("gpt-5.4-mini");
    expect(llm.vendors.openai.model).toBe("gpt-5.4");
  });

  it("returns to the configured model with `default`", async () => {
    const { loop } = makeLoop();
    await loop.handleCommand("model", "gpt-5.4-mini", "user-keyboard");
    const result = await loop.handleCommand("model", "default", "user-keyboard");
    expect(result.text).toContain("gpt-5.4");
    expect(state.configs.at(-1)?.model).toBe("gpt-5.4");
  });

  it("drops the choice when the loop starts another session", async () => {
    const { loop } = makeLoop();
    await loop.handleCommand("model", "gpt-5.4-mini", "user-keyboard");
    await loop.newConversation();
    expect(state.configs.at(-1)?.model).toBe("gpt-5.4");
    expect(contextBudgetForCurrentRuntime(loop)).toMatchObject({ model: "gpt-5.4" });
  });

  it("refuses an id with whitespace or control characters", async () => {
    const { loop } = makeLoop();
    const before = state.configs.length;
    const result = await loop.handleCommand("model", "two words", "user-keyboard");
    expect(result.text).not.toContain("two words");
    expect(state.configs.length).toBe(before);
  });

  it("refuses a subscription runtime that owns its model", async () => {
    const runtime: ActiveChatRuntime = { kind: "subscription", provider: "claude-code" };
    const llm = { ...fakeLlmSettings({ model: "gpt-5.4" }), activeChatRuntime: runtime };
    const { loop } = makeLoop(llm);
    const result = await loop.handleCommand("model", "gpt-5.4-mini", "user-keyboard");
    expect(loop.deps.modelOverride).toBeUndefined();
    expect(result.text).toContain("/model");
  });

  it("rejects an id neither the catalog nor the endpoint names, and does not switch", async () => {
    const { loop } = makeLoop();
    const before = state.configs.length;
    const result = await loop.handleCommand("model", "gpt-nonexistent-9", "user-keyboard");
    expect(result.text).toBe(t("be_conversationLoop.cmdModelUnknown", { model: "gpt-nonexistent-9" }));
    expect(loop.deps.modelOverride).toBeUndefined();
    expect(state.configs.length).toBe(before);
    expect(state.refreshes).toBe(1);
  });

  it("rejects a spelling the catalog only matches loosely", async () => {
    const { loop } = makeLoop();
    const result = await loop.handleCommand("model", "GPT-5-4-MINI", "user-keyboard");
    expect(result.text).toBe(t("be_conversationLoop.cmdModelUnknown", { model: "GPT-5-4-MINI" }));
    expect(loop.deps.modelOverride).toBeUndefined();
  });

  it("accepts a new model the vendor's endpoint reports before the catalog knows it", async () => {
    state.endpointModels = ["gpt-5.4", "gpt-next-preview"];
    const { loop } = makeLoop();
    const result = await loop.handleCommand("model", "gpt-next-preview", "user-keyboard");
    expect(result.text).toContain("gpt-next-preview");
    expect(loop.deps.modelOverride).toBe("gpt-next-preview");
  });

  it("refuses a catalog model the route's complete listing no longer serves", async () => {
    const { llm, loop } = makeLoop();
    llm.modelListCache = {
      [llmModelListCacheKey("openai")]: {
        vendor: "openai",
        endpoint: "https://api.openai.com/v1/models",
        models: ["gpt-5.4"],
        complete: true,
        fetchedAt: new Date().toISOString(),
      },
    };
    const result = await loop.handleCommand("model", "gpt-5.4-mini", "user-keyboard");
    expect(result.text).toBe(t("be_conversationLoop.cmdModelRetired", { model: "gpt-5.4-mini" }));
    expect(loop.deps.modelOverride).toBeUndefined();
  });

  it("refuses a custom endpoint's model when no model list can be fetched", async () => {
    const { loop } = customEndpointLoop();
    const result = await loop.handleCommand("model", "served-model-2", "user-keyboard");
    expect(result.text).toBe(t("be_conversationLoop.cmdModelUnverifiable", { model: "served-model-2" }));
    expect(loop.deps.modelOverride).toBeUndefined();
  });

  it("checks a custom endpoint's model against the list it reports", async () => {
    state.endpointModels = ["served-model", "served-model-2"];
    const { loop } = customEndpointLoop();
    expect((await loop.handleCommand("model", "other-model", "user-keyboard")).text)
      .toBe(t("be_conversationLoop.cmdModelUnknown", { model: "other-model" }));
    expect(loop.deps.modelOverride).toBeUndefined();
    await loop.handleCommand("model", "served-model-2", "user-keyboard");
    expect(loop.deps.modelOverride).toBe("served-model-2");
  });

  function codexLoop(catalog: () => Promise<readonly string[]>) {
    const runtime: ActiveChatRuntime = { kind: "subscription", provider: "codex", model: "gpt-5.5-codex" };
    const llm = { ...fakeLlmSettings({ model: "gpt-5.4" }), activeChatRuntime: runtime };
    const { loop } = makeLoop(llm);
    (loop as { provider: LLMProvider | null }).provider = {
      vendor: "openai",
      subscriptionRuntime: runtime,
      listSubscriptionModels: catalog,
      async *streamTurn(): AsyncIterable<StreamEvent> {},
    };
    return loop;
  }

  it("switches a Codex subscription to a model its live catalog offers", async () => {
    const loop = codexLoop(async () => ["gpt-5.5-codex", "gpt-5.5-codex-mini"]);
    const result = await loop.handleCommand("model", "gpt-5.5-codex-mini", "user-keyboard");
    expect(result.text).toBe(t("be_conversationLoop.cmdModelSet", { model: "gpt-5.5-codex-mini" }));
    expect(loop.deps.modelOverride).toBe("gpt-5.5-codex-mini");
  });

  it("rejects a model the Codex catalog does not offer, and refuses when the catalog is unreachable", async () => {
    const loop = codexLoop(async () => ["gpt-5.5-codex"]);
    expect((await loop.handleCommand("model", "gpt-5.4-mini", "user-keyboard")).text)
      .toBe(t("be_conversationLoop.cmdModelUnknown", { model: "gpt-5.4-mini" }));
    const offline = codexLoop(async () => { throw new Error("subscription-chat-unavailable"); });
    expect((await offline.handleCommand("model", "gpt-5.5-codex-mini", "user-keyboard")).text)
      .toBe(t("be_conversationLoop.cmdModelUnverifiable", { model: "gpt-5.5-codex-mini" }));
    expect(loop.deps.modelOverride).toBeUndefined();
    expect(offline.deps.modelOverride).toBeUndefined();
  });

  it("switches an Azure deployment but says the name is unverified", async () => {
    const llm = fakeLlmSettings({ provider: "azure-foundry", model: "my-gpt-deployment" });
    llm.vendors["azure-foundry"].baseUrl = "https://example-resource.openai.azure.com/openai/v1";
    const { loop } = makeLoop(llm);
    const result = await loop.handleCommand("model", "team-deployment-2", "user-keyboard");
    expect(result.text).toBe(t("be_conversationLoop.cmdModelSetUnverifiedDeployment", { model: "team-deployment-2" }));
    expect(result.text).not.toBe(t("be_conversationLoop.cmdModelSet", { model: "team-deployment-2" }));
    expect(loop.deps.modelOverride).toBe("team-deployment-2");
    expect(state.refreshes).toBe(0);
  });

  it("is refused from a non-keyboard origin", async () => {
    const { loop } = makeLoop();
    await loop.handleCommand("model", "gpt-5.4-mini", "agent-message");
    expect(loop.deps.modelOverride).toBeUndefined();
  });
});
