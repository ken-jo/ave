/**
 * `/model` — show or switch the session's model through the loop's model
 * override, the same value the provider and the context budget read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function makeLoop(llm = fakeLlmSettings({ model: "gpt-5.4" })) {
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

beforeEach(() => { state.configs.length = 0; state.requests.length = 0; });

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

    await loop.runTurn("reply", undefined, undefined, { inputOrigin: "user-keyboard" });
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
    const llm = fakeLlmSettings({ model: "gpt-5.4" });
    llm.activeChatRuntime = { kind: "subscription", provider: "claude-code" } as typeof llm.activeChatRuntime;
    const { loop } = makeLoop(llm);
    const result = await loop.handleCommand("model", "gpt-5.4-mini", "user-keyboard");
    expect(loop.deps.modelOverride).toBeUndefined();
    expect(result.text).toContain("/model");
  });

  it("is refused from a non-keyboard origin", async () => {
    const { loop } = makeLoop();
    await loop.handleCommand("model", "gpt-5.4-mini", "agent-message");
    expect(loop.deps.modelOverride).toBeUndefined();
  });
});
