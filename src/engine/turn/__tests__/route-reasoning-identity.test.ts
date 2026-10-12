import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forbidAmbientFetch } from "../../../__tests__/support/network-fetch-stubs.js";
import { InputClassifier } from "../../../core/input-classifier.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ConversationLoop } from "../../conversation-loop.js";
import type { ProviderConfig, StreamEvent } from "../../llm/types.js";
import { VercelUnifiedProvider } from "../../llm/vercel/adapter.js";
import { queryLoop } from "../query-loop.js";

const state = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[] }));

vi.mock("../../llm/provider-factory.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../llm/provider-factory.js")>(),
  createProvider: (config: ProviderConfig) => new VercelUnifiedProvider(
    config.vendor, "test-key", config.baseUrl,
    async (_input, init) => {
      state.bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      // The request has left the adapter; refuse it to end without a live service.
      return new Response("refused", { status: 400 });
    },
    {}, config.providerMetadata,
  ),
}));

async function requestOn(route: "child" | "preset" | "generic") {
  const llm = route === "child"
    ? fakeLlmSettings({ model: "gpt-5.2" })
    : fakeLlmSettings({ provider: "openai-compatible", model: "served-child",
        ...(route === "preset" ? { marketplaceProviderPresetId: "fixture-preset" } : {}),
      });
  if (route !== "child") llm.vendors[llm.provider].baseUrl = "https://gateway.invalid/v1";
  llm.vendors[llm.provider].catalogModel = route === "child" ? "openai/gpt-5.2" : "openai/gpt-4o";
  const loop = new ConversationLoop({
    ...(route === "child" ? { modelOverride: "gpt-4o" } : {}),
    settingsService: {
      get: (key: string) => key === "marketplace" ? {
        installedProviderPresets: [{ providerId: "fixture-preset", baseUrl: "https://gateway.invalid/v1" }],
      } : llm,
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system", setToolScope: vi.fn() },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    disableSessionPersistence: true,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  loop.history.append({ role: "user", content: "reply" });
  const result = await queryLoop(loop, "system", loop.resolveToolScope("reply"), undefined, undefined, null, {
    inputOrigin: "user-keyboard", toolTrustOrigin: "user-keyboard", maxRounds: 1,
  });
  expect(state.bodies).toHaveLength(1);
  expect(result.modelSettings).toBeDefined();
  return { body: state.bodies[0]!, record: result.modelSettings! };
}

beforeEach(() => { state.bodies.length = 0; forbidAmbientFetch(); });
afterEach(() => vi.unstubAllGlobals());

it.each(["wire", "record"] as const)("uses the child model's reasoning identity on the %s", async (surface) => {
  const { body, record } = await requestOn("child");
  if (surface === "wire") {
    expect(body.model).toBe("gpt-4o");
    expect(body.reasoning_effort).toBeUndefined();
    expect(record.output.effective).toBe(16_384);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(record.output.effective);
  } else {
    expect(record.reasoning).toEqual({ kind: "none", source: "model-catalog" });
  }
});

it.each(["wire", "record"] as const)("does not project the generic row's named identity onto a preset's %s", async (surface) => {
  const { body, record } = await requestOn("preset");
  if (surface === "wire") {
    expect(body.chat_template_kwargs).toMatchObject({ enable_thinking: true });
    expect(body.thinking_token_budget).toBe(8_000);
    expect(record.output.effective).toBe(32_000);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(record.output.effective);
  } else {
    expect(record.reasoning).toBeUndefined();
  }
});

it("retains the named identity for the generic row's own model", async () => {
  const { body, record } = await requestOn("generic");
  expect(body.chat_template_kwargs).toMatchObject({ enable_thinking: false });
  expect(body.thinking_token_budget).toBeUndefined();
  expect(record.reasoning).toEqual({ kind: "none", source: "model-catalog" });
});

it("records reasoning independently of a dormant endpoint on an SDK-managed route", async () => {
  const llm = fakeLlmSettings({ provider: "vertex-ai", model: "gemini-2.5-flash-image" });
  llm.vendors["vertex-ai"].baseUrl = "https://unused.invalid/v1";
  const loop = new ConversationLoop({
    settingsService: { get: () => llm, getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system", setToolScope: vi.fn() },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    disableSessionPersistence: true,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  const streamTurn = vi.fn(async function* (): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "done" };
    yield { type: "message_complete", stopReason: "end_turn" };
  });
  loop.provider = { vendor: "vertex-ai", streamTurn };
  loop.history.append({ role: "user", content: "reply" });
  const result = await queryLoop(loop, "system", loop.resolveToolScope("reply"), undefined, undefined, null, {
    inputOrigin: "user-keyboard", toolTrustOrigin: "user-keyboard", maxRounds: 1,
  });
  expect(streamTurn).toHaveBeenCalledTimes(1);
  expect(state.bodies).toHaveLength(0);
  expect(result.modelSettings?.reasoning).toEqual({ kind: "none", source: "model-catalog" });
});
