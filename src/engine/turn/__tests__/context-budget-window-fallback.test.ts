/**
 * The warning a budget resting on a guess owes the user.
 *
 * When no source knows the served model's capacity, compaction is budgeted
 * against the conservative fallback window. That is a silent misconfiguration:
 * a 229K-window deployment gets compacted at a third of its real capacity and
 * nothing in the UI says why. The host says it once, naming the model and the
 * setting that fixes it.
 *
 * Separate file because it mocks the logger for the whole module registry, and
 * the compaction suites next door run the code paths that log through it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every import, so the double it hands back has to
// be hoisted with it.
const logged = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock("../../../lib/logger.js", () => ({
  createLogger: () => logged,
}));

const requests = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[] }));

// A chat round's provider whose request is captured, then refused, so a turn
// runs through the conversation loop without a live service.
vi.mock("../../llm/provider-factory.js", async (importOriginal) => {
  const { VercelUnifiedProvider } = await import("../../llm/vercel/adapter.js");
  return {
    ...await importOriginal<typeof import("../../llm/provider-factory.js")>(),
    createProvider: (config: { vendor: never; baseUrl?: string; providerMetadata?: never }) => new VercelUnifiedProvider(
      config.vendor, "test-key", config.baseUrl,
      async (_input: unknown, init?: RequestInit) => {
        requests.bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("refused", { status: 400 });
      },
      {}, config.providerMetadata,
    ),
  };
});

import { ConversationLoop } from "../../conversation-loop.js";
import { InputClassifier } from "../../../core/input-classifier.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { forbidAmbientFetch } from "../../../__tests__/support/network-fetch-stubs.js";
import { queryLoop } from "../query-loop.js";
import { contextBudgetForCurrentRuntime, warnUnstatedReasoningOnce } from "../compaction.js";
import { planReasoning } from "../../llm/reasoning-plan.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { FALLBACK_CONTEXT_WINDOW } from "../../../shared/model-host-policy.js";
import { getPreflightThreshold } from "../../../shared/context-budget.js";

function loopOnModel(model: string, contextWindow?: number): ConversationLoop {
  const llm = fakeLlmSettings({ provider: "openai-compatible", model }) as Record<string, unknown>;
  if (contextWindow !== undefined) {
    (llm.vendors as Record<string, Record<string, unknown>>)["openai-compatible"].contextWindow =
      contextWindow;
  }
  return {
    provider: null,
    deps: {
      settingsService: {
        get: (key: string) => (key === "llm" ? llm : {}),
      },
    },
  } as unknown as ConversationLoop;
}

beforeEach(() => {
  logged.warn.mockClear();
});

describe("context budget — unknown context window", () => {
  it("warns once per route, naming the model and the setting to declare", () => {
    const loop = loopOnModel("a-model-nothing-knows");

    const budget = contextBudgetForCurrentRuntime(loop);
    contextBudgetForCurrentRuntime(loop);
    contextBudgetForCurrentRuntime(loop);

    expect(budget.contextWindowSource).toBe("fallback");
    expect(budget.preflight).toBe(getPreflightThreshold(FALLBACK_CONTEXT_WINDOW));
    expect(logged.warn).toHaveBeenCalledTimes(1);
    const message = String(logged.warn.mock.calls[0]?.[0]);
    expect(message).toContain("a-model-nothing-knows");
    expect(message).toContain("contextWindow");
  });

  it("says nothing when the route declares its window", () => {
    const budget = contextBudgetForCurrentRuntime(
      loopOnModel("another-model-nothing-knows", 229_376),
    );

    expect(budget.contextWindowSource).toBe("vendor-setting");
    expect(budget.preflight).toBe(getPreflightThreshold(229_376));
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("warns for a self-hosted model a built-in row used to describe", () => {
    // The hand-kept table seeded this deployment's 262,144 window until slice
    // 7. A self-hosted window comes from the endpoint's report or the user.
    const budget = contextBudgetForCurrentRuntime(loopOnModel("Qwen3.6-35B-A3B-NVFP4"));

    expect(budget.contextWindowSource).toBe("fallback");
    expect(logged.warn).toHaveBeenCalledTimes(1);
  });
});

describe("context budget — prompt cap and named catalog entry", () => {
  function loopOn(provider: string, model: string, block: Record<string, unknown> = {}): ConversationLoop {
    const llm = fakeLlmSettings({ provider: provider as never, model }) as Record<string, unknown>;
    Object.assign((llm.vendors as Record<string, Record<string, unknown>>)[provider]!, block);
    return {
      provider: null,
      deps: { settingsService: { get: (key: string) => (key === "llm" ? llm : {}) } },
    } as unknown as ConversationLoop;
  }

  it("bounds the threshold by the model's prompt cap and says so", () => {
    // GPT-5.2: 400K window, 272K prompt. Before: 288,000 from the window.
    const budget = contextBudgetForCurrentRuntime(loopOn("openai", "gpt-5.2"));
    expect(budget.contextWindowSource).toBe("model-catalog");
    expect(budget.preflight).toBe(217_600);
    expect(budget.usableContext).toBe(272_000);
    expect(budget.thresholdSource).toBe("input-limit");
    expect(budget.inputLimitSource).toBe("model-catalog");
    expect(budget.inputLimit).toBe(272_000);
    expect(budget.catalogEntry).toBe("openai/gpt-5.2");
  });

  it("retains catalog facts when a subscription budget uses the prompt cap", () => {
    const loop = loopOn("openai", "gpt-5.2");
    loop.provider = { subscriptionRuntime: { kind: "subscription", provider: "codex", model: "gpt-5.2" } } as never;
    const budget = contextBudgetForCurrentRuntime(loop);
    expect(budget).toMatchObject({
      preflight: 217_600, thresholdSource: "input-limit", contextWindowSource: "model-catalog",
      inputLimit: 272_000, inputLimitSource: "model-catalog", catalogEntry: "openai/gpt-5.2",
    });
  });

  it("warns once per route when the named catalog entry does not exist", () => {
    const loop = loopOn("openai-compatible", "Qwen3.6-35B-A3B-NVFP4", { catalogModel: "openai/not-a-listed-model" });
    contextBudgetForCurrentRuntime(loop);
    contextBudgetForCurrentRuntime(loop);
    expect(logged.warn).toHaveBeenCalledTimes(1);
    const message = String(logged.warn.mock.calls[0]?.[0]);
    expect(message).toContain("openai/not-a-listed-model");
    expect(message).toContain("catalogModel");
  });

  it("says nothing about a named entry the catalog lists", () => {
    const budget = contextBudgetForCurrentRuntime(loopOn("openai-compatible", "Qwen3.6-35B-A3B-NVFP4", { catalogModel: "openai/gpt-5.2" }));
    expect(budget.contextWindowSource).toBe("model-catalog");
    expect(logged.warn).not.toHaveBeenCalled();
  });
});

describe("reasoning — effort levels nobody states", () => {
  function plan(vendor: "azure-foundry" | "openai" | "claude", model: string, options: { catalogModel?: string; enableThinking?: boolean } = {}) {
    return planReasoning({
      vendor, model, enableThinking: options.enableThinking ?? true, budgetTokens: 10_000,
      ...(options.catalogModel !== undefined ? { catalogModel: options.catalogModel } : {}),
      request: { hasTools: true },
    });
  }

  it("warns once per route when an Azure deployment's levels are unstated", () => {
    // An Azure deployment alias never matches the catalog by name, so until
    // the user names the entry, thinking sends no effort and no summary.
    const route = { identity: "azure-foundry/my-gpt54-deployment", vendor: "azure-foundry", model: "my-gpt54-deployment" };
    const unstated = plan("azure-foundry", "my-gpt54-deployment");
    expect(unstated).toMatchObject({ kind: "none", source: "host-fallback" });

    warnUnstatedReasoningOnce(route, unstated);
    warnUnstatedReasoningOnce(route, unstated);

    expect(logged.warn).toHaveBeenCalledTimes(1);
    const message = String(logged.warn.mock.calls[0]?.[0]);
    expect(message).toContain("my-gpt54-deployment");
    expect(message).toContain("llm.vendors.azure-foundry.catalogModel");
  });

  it("says nothing when the levels are stated, thinking is off, or the shape decides", () => {
    const route = { identity: "azure-foundry/named-deployment", vendor: "azure-foundry", model: "named-deployment" };
    warnUnstatedReasoningOnce(route, plan("azure-foundry", "named-deployment", { catalogModel: "azure/gpt-5.4" }));
    warnUnstatedReasoningOnce(route, plan("azure-foundry", "named-deployment", { enableThinking: false }));
    warnUnstatedReasoningOnce({ identity: "openai/gpt-5.4", vendor: "openai", model: "gpt-5.4" }, plan("openai", "gpt-5.4"));
    warnUnstatedReasoningOnce({ identity: "claude/claude-sonnet-4-20250514", vendor: "claude", model: "claude-sonnet-4-20250514" }, plan("claude", "claude-sonnet-4-20250514"));
    expect(logged.warn).not.toHaveBeenCalled();
  });
});

describe("reasoning — a chat round on a model whose levels nobody states", () => {
  async function roundOn(model: string, catalogModel?: string): Promise<Record<string, unknown>> {
    forbidAmbientFetch();
    requests.bodies.length = 0;
    const llm = fakeLlmSettings({ provider: "openai", model });
    llm.vendors.openai.enableThinking = true;
    if (catalogModel !== undefined) llm.vendors.openai.catalogModel = catalogModel;
    const loop = new ConversationLoop({
      settingsService: { get: (key: string) => key === "marketplace" ? { installedProviderPresets: [] } : llm, getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system", setToolScope: vi.fn() },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry: new ToolRegistry(),
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    loop.history.append({ role: "user", content: "reply" });
    await queryLoop(loop, "system", loop.resolveToolScope("reply"), undefined, undefined, null, {
      inputOrigin: "user-keyboard", toolTrustOrigin: "user-keyboard", maxRounds: 1,
    });
    expect(requests.bodies).toHaveLength(1);
    return requests.bodies[0]!;
  }

  const reasoningWarnings = () => logged.warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("reasoning:"));

  it("sends no effort and says so, naming the setting that supplies the levels", async () => {
    // gpt-5.1-codex is not in the catalog: thinking is on, but no effort or summary goes out.
    const body = await roundOn("gpt-5.1-codex");
    expect(body.reasoning).toBeUndefined();
    expect(reasoningWarnings()).toHaveLength(1);
    expect(reasoningWarnings()[0]).toContain("llm.vendors.openai.catalogModel");
  });

  it("says nothing once the route names the entry it serves", async () => {
    const body = await roundOn("gpt-5.1-codex-named", "openai/gpt-5.3-codex");
    expect(body.reasoning).toMatchObject({ effort: "medium" });
    expect(reasoningWarnings()).toHaveLength(0);
  });
});
