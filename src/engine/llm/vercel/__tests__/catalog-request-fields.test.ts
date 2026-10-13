/**
 * The request fields the model catalog decides, read off the bytes the
 * adapter hands to `fetch` (issue #2501 slice 3): the output limit after the
 * model's ceiling, and the reasoning level after the model's accepted levels.
 * Each case names what the request carried before the catalog decided it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forbidAmbientFetch } from "../../../../__tests__/support/network-fetch-stubs.js";
import { activeModelCatalog, installModelCatalog } from "../../../../shared/model-catalog/active.js";
import type { ModelCatalogDocument } from "../../../../shared/model-catalog/types.js";
import type { LLMVendor } from "../../../../shared/llm-vendor-defaults.js";
import { VercelUnifiedProvider } from "../adapter.js";
import { planReasoning } from "../../reasoning-plan.js";
import { FallbackProvider } from "../fallback-chain.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../../types.js";
import { freshAllVendorBlocks, getLlmVendorSettings, requestedLlmOutputTokenLimit } from "../../../../shared/llm-vendor-defaults.js";
import { resolveContextWindowForRoute, resolveOutputTokenLimit } from "../../../../shared/context-budget.js";
import { llmModelListCacheKey } from "../../../../shared/llm-model-list.js";
import { collectRoundStream } from "../../../turn/stream-collector.js";
import { apiRoundLlmSettings } from "../../../turn/round-llm-settings.js";

/** The first request body the provider sent; the response is refused, which ends the turn after the request left. */
async function sentBody(
  vendor: LLMVendor,
  model: string,
  params: { outputTokenLimit?: number; thinkingBudgetTokens?: number; enableThinking?: boolean; tools?: boolean; baseUrl?: string; catalogModel?: string },
): Promise<Record<string, unknown>> {
  const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
  const provider = new VercelUnifiedProvider(vendor, "fixture-key", params.baseUrl, fetchResponse);
  for await (const _event of provider.streamTurn({
    model,
    catalogModel: params.catalogModel,
    systemPrompt: "Return the result.",
    messages: [{ role: "user", content: "Report the value." }],
    enableThinking: params.enableThinking ?? true,
    ...(params.thinkingBudgetTokens === undefined ? {} : { thinkingBudgetTokens: params.thinkingBudgetTokens }),
    ...(params.outputTokenLimit === undefined ? {} : { outputTokenLimit: params.outputTokenLimit }),
    ...(params.tools ? { tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } }] } : {}),
  })) {
    // Drain: the stream ends with the refusal.
  }
  expect(fetchResponse).toHaveBeenCalled();
  return JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
}

describe("request fields the catalog decides", () => {
  const bundled = activeModelCatalog();
  beforeEach(forbidAmbientFetch);
  afterEach(() => {
    installModelCatalog(bundled);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("clamps a requested output above the model's ceiling to the ceiling", async () => {
    // claude-haiku-4-5: catalog output 64,000. The Anthropic SDK happens to
    // know this model's limit as well; the OpenAI case below is one it does not.
    const body = await sentBody("claude", "claude-haiku-4-5", { outputTokenLimit: 100_000, enableThinking: false });
    expect(body.max_tokens).toBe(64_000);
  });

  it("leaves a request under the ceiling, and a model the catalog does not know, unclamped", async () => {
    expect((await sentBody("claude", "claude-haiku-4-5", { outputTokenLimit: 1_024, enableThinking: false })).max_tokens).toBe(1_024);
    expect((await sentBody("claude", "claude-3-7-sonnet-latest", { outputTokenLimit: 100_000, enableThinking: false })).max_tokens).toBe(100_000);
  });

  it("clamps an OpenAI chat request to the model's ceiling", async () => {
    // gpt-4o: catalog output 16,384. Before: 32,000.
    const body = await sentBody("openai", "gpt-4o", { outputTokenLimit: 32_000, enableThinking: false });
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(16_384);
  });

  it.each(["unlisted", "without-output"])("preserves a route's resolved unknown ceiling instead of matching its name again: %s", async (entry) => {
    installModelCatalog({ ...bundled, providers: {
      ...bundled.providers,
      openai: { models: { ...bundled.providers.openai!.models,
        "declared-model": { id: "declared-model", limits: { context: 128_000 } },
      } },
    } });
    const vendors = freshAllVendorBlocks();
    vendors.openai.model = "gpt-4";
    vendors.openai.catalogModel = entry === "unlisted" ? "openai/not-listed" : "openai/declared-model";
    vendors.openai.enableThinking = false;
    const route = resolveContextWindowForRoute({ provider: "openai", vendors });
    expect(route.output).not.toHaveProperty("ceiling");
    expect(route.output.effective).toBe(32_000);
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    await collectRoundStream({
      provider: new VercelUnifiedProvider("openai", "fixture-key", undefined, fetchResponse),
      model: route.model, systemPrompt: "Report the result.",
      messages: [{ role: "user", content: "Continue." }], toolSchemas: [],
      llmSettings: apiRoundLlmSettings(vendors.openai, route.output, "none", route),
    });
    expect(fetchResponse).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(route.output.effective);
  });

  it.each([false, true].flatMap((enableThinking) => [
    { enableThinking, reported: undefined, catalog: undefined, expected: 32_000, sent: 4_096 },
    { enableThinking, reported: 8_192, catalog: undefined, expected: 8_192, sent: 8_192 },
    { enableThinking, reported: undefined, catalog: 8_192, expected: 8_192, sent: 4_096 },
  ]))("sends an endpoint-reported ceiling past the SDK's name table and records what it sends: reported $reported, catalog $catalog (thinking $enableThinking)", async ({ enableThinking, reported, catalog, expected, sent }) => {
    // An unknown ceiling lets native serialization narrow to the SDK's model
    // limit (claude-3-haiku: 4,096). The endpoint's own report outranks that
    // name table, so its ceiling reaches the wire; a catalog ceiling does not.
    // Either way the request controls observed after the projection are what
    // the run records.
    if (catalog !== undefined) {
      installModelCatalog({
        ...bundled,
        providers: { ...bundled.providers, anthropic: { models: {
          "fixture-listed": { id: "fixture-listed", limits: { context: 200_000, output: catalog } },
        } } },
      } as ModelCatalogDocument);
    }
    const vendors = freshAllVendorBlocks();
    vendors.claude.model = "claude-3-haiku-20240307";
    vendors.claude.catalogModel = catalog === undefined ? "anthropic/not-listed" : "anthropic/fixture-listed";
    vendors.claude.enableThinking = enableThinking;
    const modelListCache = reported === undefined ? undefined : {
      [llmModelListCacheKey("claude")]: {
        vendor: "claude", models: [vendors.claude.model], endpoint: "https://provider.invalid/v1/models",
        modelEntries: [{ id: vendors.claude.model, maxOutputTokens: reported }], fetchedAt: new Date(0).toISOString(),
      },
    };
    const route = resolveContextWindowForRoute({ provider: "claude", vendors, modelListCache });
    if (reported !== undefined) expect(route.output.ceilingSource).toBe("provider-reported");
    else if (catalog !== undefined) expect(route.output.ceilingSource).toBe("model-catalog");
    else expect(route.output).not.toHaveProperty("ceiling");
    expect(route.output.effective).toBe(expected);
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    const onRequestControls = vi.fn<NonNullable<StreamTurnParams["onRequestControls"]>>();
    await collectRoundStream({
      provider: new VercelUnifiedProvider("claude", "fixture-key", undefined, fetchResponse),
      model: route.model, systemPrompt: "Report the result.",
      messages: [{ role: "user", content: "Continue." }], toolSchemas: [],
      llmSettings: apiRoundLlmSettings(vendors.claude, route.output, "none", route),
      onRequestControls,
    });
    expect(fetchResponse).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(sent);
    const thinking = body.thinking as { budget_tokens?: number } | undefined;
    expect(onRequestControls).toHaveBeenCalledExactlyOnceWith({
      outputTokenLimit: sent,
      ...(thinking?.budget_tokens === undefined ? {} : { thinkingBudgetTokens: thinking.budget_tokens }),
    });
    if (enableThinking) expect(thinking?.budget_tokens).toBeLessThan(sent);
  });

  it("does not infer a public output ceiling from a gateway alias", async () => {
    const body = await sentBody("openai", "gpt-4o", {
      baseUrl: "https://gateway.invalid/v1", outputTokenLimit: 32_000, enableThinking: false,
    });
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(32_000);
  });

  it("preserves effort on a tool request sent over the responses wire at a custom endpoint", async () => {
    // The custom host does not establish the model; the named entry states its levels.
    const body = await sentBody("openai", "gpt-5.4", {
      baseUrl: "https://gateway.invalid/v1", thinkingBudgetTokens: 16_000, tools: true, catalogModel: "openai/gpt-5.4",
    });
    expect(body.input).toBeDefined();
    expect(body.reasoning).toMatchObject({ effort: "high" });
    expect(planReasoning({ vendor: "openai", model: "gpt-5.4", enableThinking: true, budgetTokens: 16_000,
      baseUrl: "https://gateway.invalid/v1", catalogModel: "openai/gpt-5.4", request: { hasTools: true } }))
      .toMatchObject({ kind: "openai-effort", effort: "high", source: "model-catalog" });
  });

  it("sends no effort at a custom endpoint whose model nobody names", async () => {
    // The responses wire is still chosen (request shape), but the levels are not guessed from the name.
    const body = await sentBody("openai", "gpt-5.4", {
      baseUrl: "https://gateway.invalid/v1", thinkingBudgetTokens: 16_000, tools: true,
    });
    expect(body.input).toBeDefined();
    expect(body.reasoning).toBeUndefined();
    expect(planReasoning({ vendor: "openai", model: "gpt-5.4", enableThinking: true, budgetTokens: 16_000,
      baseUrl: "https://gateway.invalid/v1", request: { hasTools: true } }))
      .toEqual({ kind: "none", requestedEffort: "high", source: "host-fallback" });
  });

  it("sends the lowest level GPT-5 accepts for a budget that maps below it", async () => {
    // gpt-5 accepts minimal/low/medium/high. Before: the name rule clamped "none" to "low".
    const body = await sentBody("openai", "gpt-5", { thinkingBudgetTokens: 100 });
    expect(body.reasoning).toMatchObject({ effort: "minimal" });
  });

  it("sends 'none' to a model whose catalog entry accepts it", async () => {
    // gpt-5.1 accepts none. Before: the name rule held "none" to GPT-5.2+ and sent "low".
    const body = await sentBody("openai", "gpt-5.1", { thinkingBudgetTokens: 100 });
    expect(body.reasoning).toMatchObject({ effort: "none" });
  });

  it("sends no effort to a model the catalog does not know", async () => {
    // Before slice 7 a name rule sent "low" here, guessed from "gpt-5" in the id.
    const body = await sentBody("openai", "gpt-5.0-fixture", { thinkingBudgetTokens: 100 });
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("sends no reasoning control to a model the catalog says does not reason", async () => {
    const body = await sentBody("openai", "gpt-4.1", { thinkingBudgetTokens: 16_000 });
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it.each(["claude-3-5-sonnet-latest", "claude-sonnet-4-6"])(
    "honors explicit unsupported reasoning for %s on both the record and wire", async (model) => {
      installModelCatalog({
        ...bundled,
        providers: { ...bundled.providers, anthropic: { models: {
          [model]: { id: model, limits: { context: 200_000, output: 32_000 }, reasoning: { supported: false } },
        } } },
      } as ModelCatalogDocument);
      const body = await sentBody("claude", model, { thinkingBudgetTokens: 8_000, outputTokenLimit: 32_000 });
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toBeUndefined();
      expect(planReasoning({ vendor: "claude", model, enableThinking: true, budgetTokens: 8_000,
        request: { hasTools: false } }))
        .toMatchObject({ kind: "none", source: "model-catalog" });
    },
  );

  it.each(["openai-compatible", "litellm", "ollama", "lmstudio"] as const)(
    "honors an explicitly identified non-reasoning model on the %s compatibility wire", async (vendor) => {
      const catalogModel = "openai/gpt-4o";
      const baseUrl = "https://gateway.invalid/v1";
      const body = await sentBody(vendor, "served-model", {
        catalogModel, baseUrl, thinkingBudgetTokens: 8_000,
      });
      expect(body.chat_template_kwargs).toMatchObject({ enable_thinking: false });
      expect(body.thinking_token_budget).toBeUndefined();
      expect(body.thinking_budget_tokens).toBeUndefined();
      expect(planReasoning({ vendor, model: "served-model", catalogModel, baseUrl, enableThinking: true,
        budgetTokens: 8_000, request: { hasTools: false } }))
        .toMatchObject({ kind: "none", source: "model-catalog" });
    },
  );

  it("sends no effort to a reasoning model whose levels the catalog does not list", async () => {
    // Reasoning supported, no effort list: the levels are unknown, so no
    // level is sent rather than one guessed from the name.
    installModelCatalog({
      ...bundled,
      providers: { ...bundled.providers, openai: { models: { "gpt-5.4-nano": { id: "gpt-5.4-nano", limits: { context: 400_000 }, reasoning: { supported: true } } } } },
    } as ModelCatalogDocument);
    const body = await sentBody("openai", "gpt-5.4-nano", { thinkingBudgetTokens: 16_000 });
    expect(body.reasoning).toBeUndefined();
    expect(planReasoning({ vendor: "openai", model: "gpt-5.4-nano", enableThinking: true, budgetTokens: 16_000, request: { hasTools: false } }))
      .toEqual({ kind: "none", requestedEffort: "high", source: "host-fallback" });
  });

  it("records the reasoning a GPT-5 tool turn on Chat Completions actually sends", async () => {
    // An OpenAI id that names no Responses family goes over Chat Completions,
    // which answers 400 to reasoning_effort with tools on GPT-5.x; the user's
    // catalog declaration says this alias is GPT-5.4.
    const catalogModel = "openai/gpt-5.4";
    const model = "chat-alias-fixture";
    const request = { hasTools: true };
    const plan = planReasoning({ vendor: "openai", model, catalogModel, enableThinking: true, budgetTokens: 16_000, request });
    expect(plan).toMatchObject({ kind: "none", requestedEffort: "high", suppressed: "chat-completions-tool-turn" });
    const withTools = await sentBody("openai", model, { thinkingBudgetTokens: 16_000, tools: true, catalogModel });
    expect(withTools.reasoning_effort).toBeUndefined();
    // Without tools the same route carries the effort, and the plan says so.
    expect(planReasoning({ vendor: "openai", model, catalogModel, enableThinking: true, budgetTokens: 16_000, request: { ...request, hasTools: false } }))
      .toMatchObject({ kind: "openai-effort", effort: "high" });
    expect((await sentBody("openai", model, { thinkingBudgetTokens: 16_000, catalogModel })).reasoning_effort).toBe("high");
  });

  it("lowers an adaptive Claude effort to the nearest level the model accepts", async () => {
    installModelCatalog({
      ...bundled,
      providers: {
        ...bundled.providers,
        anthropic: {
          models: {
            "claude-sonnet-4-6": {
              id: "claude-sonnet-4-6",
              limits: { context: 1_000_000, output: 128_000 },
              reasoning: { supported: true, effort: ["low", "medium"] },
            },
          },
        },
      },
    } as ModelCatalogDocument);
    // Budget 20,000 maps to "max"; the fixture accepts up to "medium".
    const body = await sentBody("claude", "claude-sonnet-4-6", { thinkingBudgetTokens: 20_000 });
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toMatchObject({ effort: "medium" });
  });
});

describe("the output limit a chat round records is the one it sends", () => {
  const bundled = activeModelCatalog();
  beforeEach(forbidAmbientFetch);
  afterEach(() => { installModelCatalog(bundled); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it.each([
    ["openai", "gpt-4o", undefined, "max_completion_tokens"],
    ["openai", "gpt-5.4-mini", undefined, "max_output_tokens"],
    ["azure-foundry", "deployment-alias", "https://synthetic.openai.azure.com/openai/v1", "max_output_tokens"],
    ["claude", "claude-sonnet-4-6", undefined, "max_tokens"],
    ["gemini", "gemini-2.5-pro", undefined, "generationConfig"],
    ["vertex-ai", "gemini-2.5-pro", "https://unused.invalid/v1", "generationConfig"],
    ["openai-compatible", "served-model", "https://gateway.invalid/v1", "max_tokens"],
    ["openrouter", "served-model", "https://openrouter.ai/api/v1", "max_tokens"],
  ] as const)("preserves the resolved ceiling through the %s %s adapter", async (vendor, model, baseUrl, field) => {
    // A synthetic SDK key prevents ambient credential discovery in this fixture.
    if (vendor === "vertex-ai") vi.stubEnv("GOOGLE_VERTEX_API_KEY", "fixture-key");
    const block = { ...getLlmVendorSettings({}, vendor), model, enableThinking: false, thinkingBudgetTokens: 0 };
    const output = resolveOutputTokenLimit({ vendor, model, reported: 8_192,
      requested: requestedLlmOutputTokenLimit(block), baseUrl });
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    await collectRoundStream({
      provider: new VercelUnifiedProvider(vendor, "fixture-key", baseUrl, fetchResponse,
        vendor === "vertex-ai" ? { vertexProject: "synthetic-project", vertexLocation: "us-central1" } : {}),
      model, systemPrompt: "Return the result.", messages: [{ role: "user", content: "Report the value." }],
      toolSchemas: [], llmSettings: apiRoundLlmSettings(block, output, "none"),
    });
    expect(fetchResponse).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    const sent = field === "generationConfig"
      ? (body.generationConfig as { maxOutputTokens: number }).maxOutputTokens
      : body[field] ?? body.max_tokens;
    expect(sent).toBe(output.effective);
    expect(output).toMatchObject({ effective: 8_192, effectiveSource: "provider-reported" });
  });

  it("uses the route's explicit catalog identity for reasoning on the record and wire", async () => {
    installModelCatalog({ ...bundled, providers: { ...bundled.providers, openai: { models: {
      ...bundled.providers.openai!.models,
      "low-effort-deployment": { id: "low-effort-deployment", limits: { context: 128_000 },
        reasoning: { supported: true, effort: ["low"] } },
    } } } } as ModelCatalogDocument);
    const baseUrl = "https://gateway.invalid/v1";
    const catalogModel = "openai/low-effort-deployment";
    const block = getLlmVendorSettings({ openai: {
      model: "gpt-5.4-mini", catalogModel, baseUrl, thinkingBudgetTokens: 16_000, enableThinking: true,
    } }, "openai");
    const output = resolveOutputTokenLimit({ vendor: "openai", model: block.model, catalogModel, baseUrl,
      requested: requestedLlmOutputTokenLimit(block) });
    const round = apiRoundLlmSettings(block, output, "none");
    const plan = planReasoning({ vendor: "openai", model: block.model, baseUrl, catalogModel, enableThinking: true,
      budgetTokens: round.thinkingBudgetTokens, request: { hasTools: false } });
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    await collectRoundStream({ provider: new VercelUnifiedProvider("openai", "fixture-key", baseUrl, fetchResponse),
      model: block.model, systemPrompt: "Return the result.", messages: [{ role: "user", content: "Report the value." }],
      toolSchemas: [], llmSettings: round });
    expect(fetchResponse).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(plan).toMatchObject({ kind: "openai-effort", effort: "low", source: "model-catalog" });
    expect(body.reasoning).toMatchObject({ effort: plan?.effort });
  });

  it("suppresses effort with tools on the chat wire for an explicitly identified deployment alias", async () => {
    const model = "deployment-alias";
    const catalogModel = "openai/gpt-5.4";
    const baseUrl = "https://gateway.invalid/v1";
    const block = { ...getLlmVendorSettings({}, "openai"), model, catalogModel, baseUrl, thinkingBudgetTokens: 16_000 };
    const output = resolveOutputTokenLimit({ vendor: "openai", model, catalogModel, baseUrl,
      requested: requestedLlmOutputTokenLimit(block) });
    const round = apiRoundLlmSettings(block, output, "none");
    const plan = planReasoning({ vendor: "openai", model, baseUrl, catalogModel, enableThinking: true,
      budgetTokens: round.thinkingBudgetTokens, request: { hasTools: true } });
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    await collectRoundStream({ provider: new VercelUnifiedProvider("openai", "fixture-key", baseUrl, fetchResponse),
      model, systemPrompt: "Return the result.", messages: [{ role: "user", content: "Report the value." }],
      toolSchemas: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      llmSettings: round });
    expect(fetchResponse).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.messages).toBeDefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(plan).toMatchObject({ kind: "none", requestedEffort: "high", suppressed: "chat-completions-tool-turn" });
  });

  async function roundBody(reported: number, outputTokenLimit: number) {
    const block = getLlmVendorSettings({ openai: { model: "gpt-5.4", enableThinking: false, thinkingBudgetTokens: 0, outputTokenLimit } }, "openai");
    const output = resolveOutputTokenLimit({
      vendor: "openai",
      model: "gpt-5.4",
      requested: requestedLlmOutputTokenLimit(block),
      reported,
    });
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    await collectRoundStream({
      provider: new VercelUnifiedProvider("openai", "fixture-key", undefined, fetchResponse),
      model: "gpt-5.4",
      systemPrompt: "Return the result.",
      messages: [{ role: "user", content: "Report the value." }],
      toolSchemas: [],
      llmSettings: apiRoundLlmSettings(block, output, "none"),
    });
    return { output, body: JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown> };
  }

  it("sends the user's limit when the endpoint reports a ceiling above the catalog's", async () => {
    // Catalog: gpt-5.4 output 128,000. Endpoint reports 200,000; the user asks 150,000.
    // Re-clamping to the catalog in the adapter would send 128,000 while the turn recorded 150,000.
    const { output, body } = await roundBody(200_000, 150_000);
    expect(output).toMatchObject({ effective: 150_000, effectiveSource: "user", ceiling: 200_000 });
    expect(body.max_output_tokens).toBe(150_000);
  });

  it("sends the reported ceiling when it is below the request", async () => {
    const { output, body } = await roundBody(8_192, 150_000);
    expect(output).toMatchObject({ effective: 8_192, effectiveSource: "provider-reported" });
    expect(body.max_output_tokens).toBe(8_192);
  });

  it.each(["openai/missing-entry", "openai/unknown-output"])(
    "does not rediscover an output ceiling after the route resolves %s as unknown", async (catalogModel) => {
      installModelCatalog({ ...bundled, providers: { ...bundled.providers, openai: { models: {
        ...bundled.providers.openai!.models,
        "unknown-output": { id: "unknown-output", limits: { context: 128_000 } },
      } } } } as ModelCatalogDocument);
      const block = getLlmVendorSettings({ openai: {
        model: "gpt-5.4-mini", catalogModel, outputTokenLimit: 150_000, enableThinking: false, thinkingBudgetTokens: 0,
      } }, "openai");
      const output = resolveOutputTokenLimit({ vendor: "openai", model: block.model, catalogModel,
        requested: requestedLlmOutputTokenLimit(block) });
      expect(output).toMatchObject({ effective: 150_000, effectiveSource: "user" });
      expect(output.ceiling).toBeUndefined();
      const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
      await collectRoundStream({ provider: new VercelUnifiedProvider("openai", "fixture-key", undefined, fetchResponse),
        model: block.model, systemPrompt: "Return the result.", messages: [{ role: "user", content: "Report the value." }],
        toolSchemas: [], llmSettings: apiRoundLlmSettings(block, output, "none") });
      expect(fetchResponse).toHaveBeenCalledOnce();
      const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
      expect(body.max_output_tokens).toBe(output.effective);
    },
  );
});

describe("a fallback model's output ceiling", () => {
  beforeEach(forbidAmbientFetch);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([200_000, null])("uses its own ceiling after the primary resolved %s", async (outputCeiling) => {
    vi.useFakeTimers();
    // The primary route carries a reported ceiling or an explicitly unknown one.
    const primary: LLMProvider = {
      vendor: "openai",
      streamTurn: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "error", error: "503 fixture unavailable", classification: "network" };
      }),
    };
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    const wrapped = new FallbackProvider(
      primary,
      [{ provider: "openai", model: "gpt-4o" }],
      () => "fixture-key",
      () => new VercelUnifiedProvider("openai", "fixture-key", undefined, fetchResponse),
    );
    const drained = (async () => {
      for await (const _event of wrapped.streamTurn({
        model: "gpt-5.4",
        systemPrompt: "Return the result.",
        messages: [{ role: "user", content: "Report the value." }],
        enableThinking: false,
        outputTokenLimit: 150_000,
        outputCeiling,
      })) {
        // Drain: the fallback's request is refused, which ends the turn.
      }
    })().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    await drained;
    expect(fetchResponse).toHaveBeenCalled();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    // The fallback's catalog ceiling bounds the request in both cases.
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(16_384);
  });

  it("does not hand the primary's reported ceiling or its source to a fallback", async () => {
    vi.useFakeTimers();
    const primary: LLMProvider = {
      vendor: "claude",
      streamTurn: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "error", error: "503 fixture unavailable", classification: "network" };
      }),
    };
    const fallbackSent: StreamTurnParams[] = [];
    const wrapped = new FallbackProvider(
      primary,
      [{ provider: "claude", model: "claude-3-haiku-20240307" }],
      () => "fixture-key",
      () => ({
        vendor: "claude",
        async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
          fallbackSent.push(params);
          yield { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      }),
    );
    const drained = (async () => {
      for await (const _event of wrapped.streamTurn({
        model: "claude-3-haiku-20240307",
        systemPrompt: "Return the result.",
        messages: [{ role: "user", content: "Report the value." }],
        enableThinking: false,
        outputTokenLimit: 8_192,
        outputCeiling: 8_192,
        outputCeilingSource: "provider-reported",
      })) {
        // Drain.
      }
    })();
    await vi.advanceTimersByTimeAsync(30_000);
    await drained;
    expect(fallbackSent).toHaveLength(1);
    expect(fallbackSent[0]).not.toHaveProperty("outputCeiling");
    expect(fallbackSent[0]).not.toHaveProperty("outputCeilingSource");
  });

  it.each([
    ["openai", "gpt-4o", 16_384, undefined],
    ["claude", "claude-sonnet-4-5", 32_000, 16_000],
  ] as const)("reapplies original generation controls to the %s fallback", async (vendor, model, expectedOutput, expectedThinking) => {
    vi.useFakeTimers();
    const block = getLlmVendorSettings({ openai: {
      model: "gpt-5.4", outputTokenLimit: 32_000, enableThinking: true, thinkingBudgetTokens: 16_000,
    } }, "openai");
    const output = resolveOutputTokenLimit({ vendor: "openai", model: block.model, reported: 4_096,
      requested: requestedLlmOutputTokenLimit(block) });
    expect(output.effective).toBe(4_096);
    const primary: LLMProvider = { vendor: "openai", async *streamTurn() {
      yield { type: "error", error: "503 fixture unavailable", classification: "network" };
    } };
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    const wrapped = new FallbackProvider(primary, [{ provider: vendor, model }], () => "fixture-key",
      () => new VercelUnifiedProvider(vendor, "fixture-key", undefined, fetchResponse));
    const drained = collectRoundStream({ provider: wrapped, model: block.model, systemPrompt: "Return the result.",
      messages: [{ role: "user", content: "Report the value." }], toolSchemas: [],
      llmSettings: apiRoundLlmSettings(block, output, "none") });
    await vi.advanceTimersByTimeAsync(30_000);
    await drained;
    expect(fetchResponse).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(expectedOutput);
    if (expectedThinking !== undefined) expect(body.thinking).toMatchObject({ budget_tokens: expectedThinking });
  });
});
