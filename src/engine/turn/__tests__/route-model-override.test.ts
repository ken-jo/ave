import { beforeEach, expect, it, vi } from "vitest";
import { InputClassifier } from "../../../core/input-classifier.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ConversationLoop } from "../../conversation-loop.js";
import type { ProviderConfig, StreamEvent, StreamTurnParams } from "../../llm/types.js";
import { contextBudgetForCurrentRuntime } from "../compaction.js";

const state = vi.hoisted(() => ({
  configs: [] as ProviderConfig[],
  requests: [] as StreamTurnParams[],
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

function childLoop(catalogModel?: string) {
  const llm = fakeLlmSettings({ model: "gpt-5.2" });
  if (catalogModel) llm.vendors.openai.catalogModel = catalogModel;
  const loop = new ConversationLoop({
    modelOverride: "  gpt-4o  ",
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

beforeEach(() => { state.configs.length = 0; state.requests.length = 0; });

it.each([undefined, "openai/gpt-5.2"])("budgets the child model without inheriting the parent's named entry (%s)", (catalogModel) => {
  const { llm, loop } = childLoop(catalogModel);
  expect(state.configs[0]?.model).toBe("gpt-4o");
  expect(contextBudgetForCurrentRuntime(loop)).toMatchObject({
    model: "gpt-4o", identity: "openai/gpt-4o", catalogEntry: "openai/gpt-4o",
    usableContext: 98_000, preflight: 78_400,
  });
  expect(llm.vendors.openai.model).toBe("gpt-5.2");
  expect(llm.vendors.openai.catalogModel).toBe(catalogModel);
});

it("sends and accounts for the same child model that the adapter was constructed for", async () => {
  const { loop } = childLoop();
  const result = await loop.runTurn("reply", undefined, undefined, { inputOrigin: "user-keyboard" });
  expect(state.configs[0]?.model).toBe("gpt-4o");
  expect(state.requests[0]?.model).toBe("gpt-4o");
  expect(result.usageByModel).toEqual([
    expect.objectContaining({ vendorProvider: "openai", vendorModel: "gpt-4o" }),
  ]);
});
