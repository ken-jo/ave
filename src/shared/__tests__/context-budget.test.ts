import { afterEach, describe, it, expect } from "vitest";
import {
  catalogModelFor,
  getUsableContext,
  getPreflightThreshold,
  llmRouteCatalogAddress,
  resolveContextWindowForRoute,
  listingJudgesRetirement,
  resolveInputModalities,
  resolveModelContextWindow,
  resolveModelRetirement,
  resolveOutputTokenLimit,
  resolveReasoningSupport,
  resolveRouteModelRetirement,
} from "../context-budget.js";
import { FALLBACK_CONTEXT_WINDOW, MAX_CREDIBLE_CONTEXT_WINDOW } from "../model-host-policy.js";
import { freshAllVendorBlocks, llmImageInputKey } from "../llm-vendor-defaults.js";
import { llmModelListCacheKey, type LlmModelListCache, type LlmModelListCacheEntry } from "../llm-model-list.js";
import { activeModelCatalog, installModelCatalog } from "../model-catalog/active.js";
import type { CatalogModel, ModelCatalogDocument } from "../model-catalog/types.js";

describe("getUsableContext — Ave tier-fixed reservations", () => {
  it("64K → 37K usable (27K reserved for output-heavy small models)", () => {
    expect(getUsableContext(64_000)).toBe(37_000);
  });

  it("128K → 98K usable (30K reserved)", () => {
    expect(getUsableContext(128_000)).toBe(98_000);
  });

  it("200K → 160K usable (40K reserved — Anthropic default tier)", () => {
    expect(getUsableContext(200_000)).toBe(160_000);
  });

  it("1M → 960K usable (40K floor wins over 0.8× = 800K)", () => {
    expect(getUsableContext(1_000_000)).toBe(960_000);
  });

  it("2M → 1.96M usable", () => {
    expect(getUsableContext(2_000_000)).toBe(1_960_000);
  });

  it("medium 1.05M (gpt-5.4) → 1.01M usable", () => {
    expect(getUsableContext(1_050_000)).toBe(1_010_000);
  });

  it("tiny window 32K → 25.6K (0.8× wins, avoids negative)", () => {
    expect(getUsableContext(32_000)).toBe(25_600);
  });

  it("threshold edge: 40K → 32K (0.8× exactly)", () => {
    expect(getUsableContext(40_000)).toBe(32_000);
  });

  it("invalid inputs return 0", () => {
    expect(getUsableContext(0)).toBe(0);
    expect(getUsableContext(-100)).toBe(0);
    expect(getUsableContext(NaN)).toBe(0);
    expect(getUsableContext(Infinity)).toBe(0);
  });

  it("usable is always strictly less than raw for positive ctx", () => {
    for (const ctx of [16_000, 64_000, 128_000, 200_000, 400_000, 1_000_000]) {
      expect(getUsableContext(ctx)).toBeLessThan(ctx);
      expect(getUsableContext(ctx)).toBeGreaterThan(0);
    }
  });
});

describe("getPreflightThreshold — token preflight trigger", () => {
  it.each([undefined, 400_000, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("ignores an absent, oversized or invalid prompt cap: %s", (cap) => {
    expect(getUsableContext(128_000, cap)).toBe(98_000);
    expect(getPreflightThreshold(128_000, cap)).toBe(78_400);
  });
  it("64K → floor(37K × 80%) = 29,600", () => {
    expect(getPreflightThreshold(64_000)).toBe(29_600);
  });

  it("128K → floor(98K × 80%) = 78,400", () => {
    expect(getPreflightThreshold(128_000)).toBe(78_400);
  });

  it("200K → floor(160K × 80%) = 128,000", () => {
    expect(getPreflightThreshold(200_000)).toBe(128_000);
  });

  it("1M → floor(960K × 80%) = 768,000", () => {
    expect(getPreflightThreshold(1_000_000)).toBe(768_000);
  });

  it("Other (>1M) → 80% of usable", () => {
    expect(getPreflightThreshold(2_000_000)).toBe(1_568_000);
  });

  it("Boundary <=64K (e.g. 32K small) → 80% of usable", () => {
    expect(getPreflightThreshold(32_000)).toBe(20_480);
  });

  it("invalid inputs return 0", () => {
    expect(getPreflightThreshold(0)).toBe(0);
    expect(getPreflightThreshold(-100)).toBe(0);
    expect(getPreflightThreshold(NaN)).toBe(0);
    expect(getPreflightThreshold(Infinity)).toBe(0);
  });

  it("threshold is always less than usable for positive ctx", () => {
    for (const ctx of [64_000, 128_000, 200_000, 1_000_000, 2_000_000]) {
      expect(getPreflightThreshold(ctx)).toBeLessThan(getUsableContext(ctx));
      expect(getPreflightThreshold(ctx)).toBeGreaterThan(0);
    }
  });

  it("threshold percentage is exactly 80% of usable", () => {
    for (const ctx of [64_000, 128_000, 200_000, 1_000_000, 2_000_000]) {
      const ratio = getPreflightThreshold(ctx) / getUsableContext(ctx);
      expect(ratio).toBe(0.8);
    }
  });
});

describe("resolveModelContextWindow — where the budget's denominator comes from", () => {
  it("takes the vendor block's declared window over everything else", () => {
    const resolved = resolveModelContextWindow({
      vendor: "claude",
      model: "claude-sonnet-4-5",
      configured: 300_000,
      reported: 229_376,
    });

    expect(resolved).toEqual({ contextWindow: 300_000, source: "vendor-setting" });
  });

  it("takes what the provider reported when nothing was declared", () => {
    const resolved = resolveModelContextWindow({
      vendor: "openai-compatible",
      model: "a-model-no-catalog-knows",
      reported: 229_376,
    });

    expect(resolved).toEqual({ contextWindow: 229_376, source: "provider-reported" });
  });

  it.each(["Qwen3.6-35B-A3B-NVFP4", "Nemotron-3-Nano-30B-A3B-FP8"])(
    "takes a self-hosted %s window from the endpoint's report or the user, never a built-in row",
    (model) => {
      // Self-hosted routes need a report or declaration; public catalog names cannot supply their window.
      expect(resolveModelContextWindow({ vendor: "openai-compatible", model }))
        .toEqual({ contextWindow: FALLBACK_CONTEXT_WINDOW, source: "fallback" });
      expect(resolveModelContextWindow({ vendor: "openai-compatible", model, reported: 262_144 }))
        .toEqual({ contextWindow: 262_144, source: "provider-reported" });
      expect(resolveModelContextWindow({ vendor: "openai-compatible", model, configured: 131_072 }))
        .toEqual({ contextWindow: 131_072, source: "vendor-setting" });
    },
  );

  it("names the fallback as a fallback so a caller can report the guess", () => {
    const resolved = resolveModelContextWindow({
      vendor: "openai-compatible",
      model: "a-model-no-catalog-knows",
    });

    expect(resolved).toEqual({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      source: "fallback",
    });
  });

  it("treats a malformed or non-positive declared window as not declared", () => {
    // A stored zero would disable automatic compaction.
    for (const configured of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveModelContextWindow({
          vendor: "openai-compatible",
          model: "a-model-no-catalog-knows",
          configured,
        }).source,
      ).toBe("fallback");
    }
  });

  it("refuses a window an order of magnitude past anything real", () => {
    // Reject oversized values that push compaction past any reachable threshold.
    for (const value of [MAX_CREDIBLE_CONTEXT_WINDOW + 1, 22_937_600, Number.MAX_SAFE_INTEGER]) {
      expect(
        resolveModelContextWindow({
          vendor: "openai-compatible",
          model: "a-model-no-catalog-knows",
          configured: value,
        }).source,
      ).toBe("fallback");
      expect(
        resolveModelContextWindow({
          vendor: "openai-compatible",
          model: "a-model-no-catalog-knows",
          reported: value,
        }).source,
      ).toBe("fallback");
    }
    expect(
      resolveModelContextWindow({
        vendor: "openai-compatible",
        model: "a-model-no-catalog-knows",
        configured: MAX_CREDIBLE_CONTEXT_WINDOW,
      }),
    ).toEqual({ contextWindow: MAX_CREDIBLE_CONTEXT_WINDOW, source: "vendor-setting" });
  });

  it("treats a malformed provider-reported window as absent, not as an error", () => {
    expect(
      resolveModelContextWindow({
        vendor: "openai-compatible",
        model: "a-model-no-catalog-knows",
        reported: 0,
      }),
    ).toEqual({ contextWindow: FALLBACK_CONTEXT_WINDOW, source: "fallback" });
  });
});

describe("resolveContextWindowForRoute — one answer for the engine and the ring", () => {
  function routeSettings(overrides: {
    contextWindow?: number;
    reported?: { contextLength?: number; maxOutputTokens?: number };
    baseUrl?: string;
    presetId?: string;
  } = {}) {
    const model = "a-model-no-catalog-knows";
    const vendors = freshAllVendorBlocks();
    const block = vendors["openai-compatible"];
    block.baseUrl = overrides.baseUrl ?? "https://models.invalid/v1";
    if (overrides.presetId) block.presetModels = { [overrides.presetId]: model };
    else block.model = model;
    if (overrides.contextWindow !== undefined) block.contextWindow = overrides.contextWindow;
    const modelListCache: LlmModelListCache = {};
    if (overrides.reported) {
      const key = llmModelListCacheKey(
        "openai-compatible",
        overrides.baseUrl ?? "https://models.invalid/v1",
        overrides.presetId ?? "",
      );
      modelListCache[key] = {
        vendor: "openai-compatible",
        endpoint: "https://models.invalid/v1/models",
        models: [model],
        modelEntries: [{ id: model, ...overrides.reported }],
        fetchedAt: new Date(0).toISOString(),
      };
    }
    return {
      provider: "openai-compatible" as const,
      vendors,
      modelListCache,
      ...(overrides.presetId ? { marketplaceProviderPresetId: overrides.presetId } : {}),
    };
  }

  it("reads the window the vendor block declares, over the provider's report", () => {
    expect(
      resolveContextWindowForRoute(
        routeSettings({ contextWindow: 300_000, reported: { contextLength: 229_376 } }),
      ),
    ).toMatchObject({
      model: "a-model-no-catalog-knows",
      contextWindow: 300_000,
      source: "vendor-setting",
    });
  });

  it("reads what the route's own /models handshake reported for that model", () => {
    expect(
      resolveContextWindowForRoute(
        routeSettings({ reported: { contextLength: 229_376, maxOutputTokens: 32_768 } }),
      ),
    ).toMatchObject({
      contextWindow: 229_376,
      source: "provider-reported",
      maxOutputTokens: 32_768,
    });
  });

  it("looks the preset's row up under the preset's own endpoint", () => {
    // Preset catalog lookups use the preset endpoint, not the generic provider block.
    const settings = routeSettings({
      presetId: "provider-alpha",
      baseUrl: "https://preset.invalid/v1",
      reported: { contextLength: 131_072 },
    });

    expect(
      resolveContextWindowForRoute(settings, [
        { providerId: "provider-alpha", baseUrl: "https://preset.invalid/v1" },
      ]),
    ).toMatchObject({ contextWindow: 131_072, source: "provider-reported" });
  });

  it("finds the reported row whatever case the configured model id is spelled in", () => {
    const settings = routeSettings({ reported: { contextLength: 131_072 } });
    const cached = Object.values(settings.modelListCache)[0]!;
    cached.modelEntries = [{ id: "A-Model-No-Catalog-Knows", contextLength: 131_072 }];
    cached.models = ["A-Model-No-Catalog-Knows"];

    expect(resolveContextWindowForRoute(settings)).toMatchObject({
      contextWindow: 131_072,
      source: "provider-reported",
    });
  });

  it.each([false, true].flatMap((reversed) => [
    { reversed, model: "Case-Model", contextWindow: 131_072, output: 8_192, input: ["text", "image"], tools: true },
    { reversed, model: "case-model", contextWindow: 262_144, output: 16_384, input: ["text"], tools: undefined },
  ]))("keeps case-distinct reports separate: $model ($reversed)", ({ reversed, model, contextWindow, output, input, tools }) => {
    const settings = routeSettings({ reported: {} });
    settings.vendors["openai-compatible"].model = model;
    const cached = Object.values(settings.modelListCache)[0]!;
    cached.models = ["Case-Model", "case-model"];
    cached.modelEntries = [
      { id: "Case-Model", contextLength: 131_072, maxOutputTokens: 8_192, inputModalities: ["text", "image"], supportedParameters: ["tools"] },
      { id: "case-model", contextLength: 262_144, maxOutputTokens: 16_384, inputModalities: ["text"], supportedParameters: ["temperature"] },
    ];
    if (reversed) cached.modelEntries.reverse();
    const route = resolveContextWindowForRoute(settings);
    expect(route.contextWindow).toBe(contextWindow);
    expect(route.output.effective).toBe(output);
    expect(route.inputModalities?.input).toEqual(input);
    expect(route.toolCall?.supported).toBe(tools);
  });

  it.each([false, true])("ignores an ambiguous case match instead of borrowing a report (reversed %s)", (reversed) => {
    const settings = routeSettings({ reported: {} });
    settings.vendors["openai-compatible"].model = "CASE-MODEL";
    const cached = Object.values(settings.modelListCache)[0]!;
    cached.models = ["Case-Model", "case-model"];
    cached.modelEntries = [
      { id: "Case-Model", contextLength: 131_072, maxOutputTokens: 8_192, inputModalities: ["text", "image"], supportedParameters: ["tools"] },
      { id: "case-model", contextLength: 262_144, maxOutputTokens: 16_384, inputModalities: ["text"] },
    ];
    if (reversed) cached.modelEntries.reverse();
    const route = resolveContextWindowForRoute(settings);
    expect(route.source).not.toBe("provider-reported");
    expect(route.output.effective).toBe(32_000);
    expect(route.inputModalities).toBeUndefined();
    expect(route.toolCall).toBeUndefined();
  });

  it.each(["case-model", "CASE-MODEL"])("does not borrow missing metadata from a case-distinct model: %s", (model) => {
    const settings = routeSettings({ reported: {} });
    settings.vendors["openai-compatible"].model = model;
    const cached = Object.values(settings.modelListCache)[0]!;
    cached.models = ["Case-Model", "case-model"];
    cached.modelEntries = [{ id: "Case-Model", contextLength: 131_072, maxOutputTokens: 8_192, inputModalities: ["image"], supportedParameters: ["tools"] }];
    const route = resolveContextWindowForRoute(settings);
    expect(route.source).not.toBe("provider-reported");
    expect(route.output.effective).toBe(32_000);
    expect(route.inputModalities).toBeUndefined();
    expect(route.toolCall).toBeUndefined();
  });

  it("names the same cache coordinates a refresh has to write back to", () => {
    // Reader and refresher keys must match or probes repeat forever.
    expect(
      llmRouteCatalogAddress(
        routeSettings({ presetId: "provider-alpha", baseUrl: "https://preset.invalid/v1" }),
        [{ providerId: "provider-alpha", baseUrl: "https://preset.invalid/v1" }],
      ),
    ).toEqual({
      vendor: "openai-compatible",
      baseUrl: "https://preset.invalid/v1",
      credentialScope: "provider-alpha",
    });
  });

  it("uses the catalog entry the vendor block names, below the provider's report", () => {
    const settings = routeSettings();
    settings.vendors["openai-compatible"].catalogModel = "openai/gpt-4.1";
    expect(resolveContextWindowForRoute(settings)).toMatchObject({ source: "model-catalog", catalogEntry: "openai/gpt-4.1" });
    const reported = routeSettings({ reported: { contextLength: 229_376 } });
    reported.vendors["openai-compatible"].catalogModel = "openai/gpt-4.1";
    expect(resolveContextWindowForRoute(reported)).toMatchObject({ contextWindow: 229_376, source: "provider-reported" });
  });

  it("carries the route's output: the host default, clamped by what the endpoint reported", () => {
    expect(resolveContextWindowForRoute(routeSettings({ reported: { maxOutputTokens: 4_096 } })).output).toEqual({
      requested: 32_000,
      requestedSource: "host-default",
      ceiling: 4_096,
      ceilingSource: "provider-reported",
      effective: 4_096,
      effectiveSource: "provider-reported",
    });
    const explicit = routeSettings();
    explicit.vendors["openai-compatible"].outputTokenLimit = 12_000;
    expect(resolveContextWindowForRoute(explicit).output).toMatchObject({ effective: 12_000, effectiveSource: "user" });
  });

  it("does not put the block's named entry on a marketplace preset's own model", () => {
    const settings = routeSettings({ presetId: "provider-alpha", baseUrl: "https://preset.invalid/v1" });
    settings.vendors["openai-compatible"].catalogModel = "openai/gpt-4.1";
    expect(
      resolveContextWindowForRoute(settings, [{ providerId: "provider-alpha", baseUrl: "https://preset.invalid/v1" }]),
    ).toMatchObject({ source: "fallback" });
  });

  it("moves to the next source when the route has no handshake for the model", () => {
    expect(resolveContextWindowForRoute(routeSettings())).toMatchObject({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      source: "fallback",
    });
  });
});

describe("the model catalog's place in the order", () => {
  const bundled = activeModelCatalog();
  afterEach(() => installModelCatalog(bundled));

  function useCatalog(providers: Record<string, CatalogModel[]>): void {
    installModelCatalog({
      ...bundled,
      providers: Object.fromEntries(
        Object.entries(providers).map(([provider, models]) => [provider, { models: Object.fromEntries(models.map((model) => [model.id, model])) }]),
      ),
    } as ModelCatalogDocument);
  }

  it("answers after the declared and the reported window, before the pricing table", () => {
    useCatalog({ openai: [{ id: "gpt-4.1", limits: { context: 777_000 } }] });
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-4.1" })).toEqual({
      contextWindow: 777_000,
      source: "model-catalog",
      catalogEntry: "openai/gpt-4.1",
    });
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-4.1", reported: 500_000 }).source).toBe("provider-reported");
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-4.1", configured: 400_000 }).source).toBe("vendor-setting");
  });

  it("leaves a model the catalog does not know, or knows without a window, to the host fallback", () => {
    useCatalog({ openai: [{ id: "gpt-4.1", limits: {} }] });
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-4.1" })).toEqual({ contextWindow: FALLBACK_CONTEXT_WINDOW, source: "fallback" });
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-4.1-nano" })).toEqual({ contextWindow: FALLBACK_CONTEXT_WINDOW, source: "fallback" });
  });

  it("does not believe a catalog window past the credible ceiling", () => {
    useCatalog({ openai: [{ id: "gpt-4.1", limits: { context: MAX_CREDIBLE_CONTEXT_WINDOW + 1 } }] });
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-4.1" }).source).toBe("fallback");
  });

  it("never matches a self-hosted endpoint by name, and uses the entry the user names for it", () => {
    useCatalog({ openai: [{ id: "a-served-model", limits: { context: 600_000 } }] });
    expect(resolveModelContextWindow({ vendor: "openai-compatible", model: "a-served-model" }).source).toBe("fallback");
    expect(resolveModelContextWindow({ vendor: "openai-compatible", model: "a-served-model", catalogModel: "openai/a-served-model" })).toEqual({
      contextWindow: 600_000,
      source: "model-catalog",
      catalogEntry: "openai/a-served-model",
    });
  });

  it("does not fall back to a name match when the named entry is not in the catalog", () => {
    useCatalog({ anthropic: [{ id: "claude-sonnet-4-6", limits: { context: 600_000 } }] });
    expect(catalogModelFor("claude", "claude-sonnet-4-6", "anthropic/not-listed")).toBeUndefined();
    expect(resolveModelContextWindow({ vendor: "claude", model: "claude-sonnet-4-6", catalogModel: "anthropic/not-listed" }).source).toBe("fallback");
  });

  it("throws when nothing installed a catalog, instead of answering from the fallback", () => {
    const slot = (globalThis as Record<symbol, { source?: unknown; resolved?: unknown }>)[Symbol.for("ave.modelCatalog.active")]!;
    const saved = { ...slot };
    delete slot.source;
    delete slot.resolved;
    try {
      expect(() => resolveModelContextWindow({ vendor: "openai", model: "gpt-4.1" })).toThrow(/model catalog is not installed/);
    } finally {
      Object.assign(slot, saved);
    }
  });
});

/** Catalog snapshot changes require reviewing these resolved limits. */
describe("windows the bundled catalog corrects", () => {
  it.each([
    ["openai", "gpt-5.4-pro", 1_050_000, "openai/gpt-5.4-pro"],
    ["openai", "gpt-4.1", 1_047_576, "openai/gpt-4.1"],
    ["openai", "gpt-4.1-2025-04-14", 1_047_576, "openai/gpt-4.1"],
    ["gemini", "gemini-2.5-pro", 1_048_576, "google/gemini-2.5-pro"],
    ["gemini", "gemini-2.5-flash-lite", 1_048_576, "google/gemini-2.5-flash-lite"],
  ] as const)("%s %s → %i from %s", (vendor, model, contextWindow, catalogEntry) => {
    expect(resolveModelContextWindow({ vendor, model })).toMatchObject({ contextWindow, source: "model-catalog", catalogEntry });
  });

  it("keeps the 1M window the adapter's beta header delivers for Claude 4.6", () => {
    expect(resolveModelContextWindow({ vendor: "claude", model: "claude-sonnet-4-6" })).toMatchObject({ contextWindow: 1_000_000, source: "model-catalog" });
  });

  it.each([
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307",
  ])("leaves the retired id %s, which the catalog does not list, to the host fallback", (model) => {
    // Do not infer aliases for models with no documented catalog identity.
    expect(resolveModelContextWindow({ vendor: "claude", model })).toEqual({ contextWindow: FALLBACK_CONTEXT_WINDOW, source: "fallback" });
  });

  it.each([
    ["openai", "gpt-4.1-2025-04-14", "openai/gpt-4.1"],
    ["openai", "o3-2025-04-16", "openai/o3"],
    ["openai", "o4-mini-2025-04-24", "openai/o4-mini"],
    ["claude", "claude-sonnet-4-6-20260217", "anthropic/claude-sonnet-4-6"],
    ["openai", "gpt-5.4-2026-03-05", "openai/gpt-5.4"],
  ] as const)("resolves the dated id %s %s to its listed model %s", (vendor, model, catalogEntry) => {
    expect(resolveModelContextWindow({ vendor, model })).toMatchObject({ source: "model-catalog", catalogEntry });
  });
});

describe("resolveOutputTokenLimit — the output a request carries", () => {
  const user = { value: 64_000, source: "user" as const };
  const hostDefault = { value: 32_000, source: "host-default" as const };

  it("clamps the request to the catalog's ceiling and names the ceiling as the source", () => {
    expect(resolveOutputTokenLimit({ vendor: "openai", model: "gpt-4o", requested: hostDefault })).toEqual({
      requested: 32_000,
      requestedSource: "host-default",
      ceiling: 16_384,
      ceilingSource: "model-catalog",
      effective: 16_384,
      effectiveSource: "model-catalog",
    });
  });

  it("keeps a request under the ceiling, with the requester as the source", () => {
    expect(resolveOutputTokenLimit({ vendor: "openai", model: "gpt-5.4", requested: user })).toMatchObject({
      ceiling: 128_000,
      effective: 64_000,
      effectiveSource: "user",
    });
  });

  it("takes the ceiling the endpoint reported over the catalog's", () => {
    expect(resolveOutputTokenLimit({ vendor: "openai", model: "gpt-5.4", requested: user, reported: 8_192 })).toMatchObject({
      ceiling: 8_192,
      ceilingSource: "provider-reported",
      effective: 8_192,
      effectiveSource: "provider-reported",
    });
  });

  it("clamps nothing when no ceiling is known", () => {
    expect(resolveOutputTokenLimit({ vendor: "openai-compatible", model: "a-served-model", requested: user })).toEqual({
      requested: 64_000,
      requestedSource: "user",
      effective: 64_000,
      effectiveSource: "user",
    });
    expect(resolveOutputTokenLimit({ vendor: "openai-compatible", model: "a-served-model", requested: user, reported: 0 }).effective).toBe(64_000);
  });

  it("reads the named catalog entry's ceiling for a self-hosted route", () => {
    expect(
      resolveOutputTokenLimit({ vendor: "openai-compatible", model: "a-served-model", requested: user, catalogModel: "openai/gpt-4o" }),
    ).toMatchObject({ effective: 16_384, effectiveSource: "model-catalog" });
  });
});

/** Prompt caps bound compaction thresholds even when the context window is larger. */
describe("the prompt cap beside the window", () => {
  it("retains the named catalog source for a cap beside an endpoint-reported window", () => {
    expect(resolveModelContextWindow({
      vendor: "openai-compatible", model: "gateway-alias", reported: 600_000, catalogModel: "openai/gpt-5.2",
    })).toEqual({
      contextWindow: 600_000, source: "provider-reported", catalogEntry: "openai/gpt-5.2",
      inputLimit: 272_000, inputLimitSource: "model-catalog",
    });
  });
  it("has no prompt cap for an unknown model", () => {
    const resolved = resolveModelContextWindow({ vendor: "openai", model: "unlisted-model" });
    expect(resolved).toEqual({ contextWindow: 128_000, source: "fallback" });
    expect(getPreflightThreshold(resolved.contextWindow, resolved.inputLimit)).toBe(78_400);
  });
  it.each([
    // [vendor, model, window, cap, threshold before, threshold now]
    ["openai", "gpt-5.2", 400_000, 272_000, 288_000, 217_600],
    ["openai", "gpt-5.4", 1_050_000, 922_000, 808_000, 737_600],
  ] as const)("%s %s: window %i, prompt cap %i → threshold %i → %i", (vendor, model, window, cap, before, now) => {
    const resolved = resolveModelContextWindow({ vendor, model });
    expect(resolved).toMatchObject({ contextWindow: window, inputLimit: cap, inputLimitSource: "model-catalog" });
    expect(getPreflightThreshold(resolved.contextWindow)).toBe(before);
    expect(getPreflightThreshold(resolved.contextWindow, resolved.inputLimit)).toBe(now);
    expect(now).toBeLessThan(cap);
  });

  it("leaves no snapshot entry with a threshold past its prompt cap", () => {
    const over: string[] = [];
    for (const [provider, { models }] of Object.entries(activeModelCatalog().providers)) {
      for (const [id, entry] of Object.entries(models)) {
        const { context, input } = entry.limits;
        if (!context || !input || input >= context) continue;
        if (getPreflightThreshold(context, input) > input) over.push(`${provider}/${id}`);
      }
    }
    expect(over).toEqual([]);
  });

  it("keeps only a cap below the window", () => {
    expect(resolveModelContextWindow({ vendor: "claude", model: "claude-sonnet-4-6" })).not.toHaveProperty("inputLimit");
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-5.2", reported: 200_000 })).not.toHaveProperty("inputLimit");
  });

  it("carries no cap under a declared window: the user stated the endpoint's capacity", () => {
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-5.2", configured: 400_000 })).toEqual({
      contextWindow: 400_000,
      source: "vendor-setting",
    });
  });

  it("finds Vertex's tagged Claude entries by the id Ave uses", () => {
    expect(resolveModelContextWindow({ vendor: "vertex-ai", model: "claude-opus-4-6" })).toMatchObject({
      source: "model-catalog",
      catalogEntry: "google-vertex/claude-opus-4-6@default",
    });
  });

  it("names a catalogModel the catalog does not list, so the engine can report it", () => {
    const vendors = freshAllVendorBlocks();
    vendors["openai-compatible"].baseUrl = "https://models.invalid/v1";
    vendors["openai-compatible"].model = "a-served-model";
    vendors["openai-compatible"].catalogModel = "openai/not-a-listed-model";
    expect(resolveContextWindowForRoute({ provider: "openai-compatible", vendors })).toMatchObject({
      unresolvedCatalogModel: "openai/not-a-listed-model",
    });
    vendors["openai-compatible"].catalogModel = "openai/gpt-5.2";
    expect(resolveContextWindowForRoute({ provider: "openai-compatible", vendors })).not.toHaveProperty("unresolvedCatalogModel");
  });
});

describe("a route's input modalities and tool support", () => {
  function apiRoute(provider: "openai" | "openai-compatible", model: string, block: {
    catalogModel?: string;
    reportedInput?: string[];
    supportedParameters?: string[];
    imageInput?: boolean;
  } = {}) {
    const vendors = freshAllVendorBlocks();
    const fields = vendors[provider];
    fields.model = model;
    if (provider === "openai-compatible") fields.baseUrl = "https://models.invalid/v1";
    if (block.catalogModel !== undefined) fields.catalogModel = block.catalogModel;
    if (block.imageInput !== undefined) fields.imageInput = { [llmImageInputKey(model)]: block.imageInput };
    const modelListCache: LlmModelListCache = {};
    if (block.reportedInput !== undefined || block.supportedParameters !== undefined) {
      modelListCache[llmModelListCacheKey(provider, fields.baseUrl, "")] = {
        vendor: provider,
        endpoint: "https://models.invalid/v1/models",
        models: [model],
        modelEntries: [{
          id: model,
          ...(block.reportedInput !== undefined ? { inputModalities: block.reportedInput } : {}),
          ...(block.supportedParameters !== undefined ? { supportedParameters: block.supportedParameters } : {}),
        }],
        fetchedAt: new Date(0).toISOString(),
      };
    }
    return { provider, vendors, modelListCache };
  }

  it("reads the catalog entry's input modalities", () => {
    expect(resolveContextWindowForRoute(apiRoute("openai", "gpt-4")).inputModalities).toEqual({
      input: ["text"],
      source: "model-catalog",
      catalogEntry: "openai/gpt-4",
    });
  });

  it("takes what the endpoint reported over the catalog, and ignores an empty report", () => {
    expect(resolveContextWindowForRoute(apiRoute("openai-compatible", "a-served-model", { reportedInput: ["text", "image"] })).inputModalities)
      .toEqual({ input: ["text", "image"], source: "provider-reported" });
    expect(resolveInputModalities({ vendor: "openai", model: "gpt-4", reported: [] })).toMatchObject({ source: "model-catalog" });
    expect(resolveInputModalities({ vendor: "openai", model: "gpt-4", reported: ["Text", "IMAGE"] })?.input).toEqual(["text", "image"]);
  });

  it("reads the entry the user named for a self-hosted route, and nothing when it is not listed", () => {
    expect(resolveContextWindowForRoute(apiRoute("openai-compatible", "a-served-model", { catalogModel: "openai/gpt-4o" })).inputModalities)
      .toMatchObject({ input: expect.arrayContaining(["image"]), source: "model-catalog", catalogEntry: "openai/gpt-4o" });
    expect(resolveContextWindowForRoute(apiRoute("openai-compatible", "gpt-4o", { catalogModel: "openai/not-a-listed-model" })))
      .not.toHaveProperty("inputModalities");
  });

  it.each([
    { catalogModel: "openai/gpt-4", reportedInput: ["text", "image"], input: ["text"] },
    { catalogModel: "openai/gpt-4o", reportedInput: ["text"], input: ["text", "image", "pdf"] },
  ])("keeps the user's named input modalities above endpoint reports: %j", ({ catalogModel, reportedInput, input }) => {
    expect(resolveContextWindowForRoute(apiRoute("openai-compatible", "opaque-model", { catalogModel, reportedInput })).inputModalities)
      .toEqual({ input, source: "model-catalog", catalogEntry: catalogModel });
  });

  it("keeps the user's named positive tool capability above endpoint reports", () => {
    expect(resolveContextWindowForRoute(apiRoute("openai-compatible", "opaque-model", {
      catalogModel: "openai/gpt-4o", supportedParameters: ["tools"],
    })).toolCall).toEqual({ supported: true, source: "model-catalog", catalogEntry: "openai/gpt-4o" });
  });

  it.each([true, false])("uses a saved image declaration before every capability source: %s", (imageInput) => {
    const route = apiRoute("openai-compatible", "opaque-model", {
      imageInput, catalogModel: imageInput ? "openai/gpt-4" : "openai/gpt-4o",
      reportedInput: imageInput ? ["text"] : ["text", "image"],
    });
    expect(resolveContextWindowForRoute(route).inputModalities).toMatchObject({ source: "vendor-setting" });
    expect(resolveContextWindowForRoute(route).inputModalities?.input.includes("image")).toBe(imageInput);
  });

  it("keeps declarations on their model and preset route, with unknown models conservative by default", () => {
    const route = apiRoute("openai-compatible", "opaque-model", { imageInput: true });
    expect(resolveContextWindowForRoute(route).inputModalities?.input).toContain("image");
    route.vendors["openai-compatible"].model = "other-model";
    expect(resolveContextWindowForRoute(route).inputModalities).toBeUndefined();
    route.vendors["openai-compatible"].presetModels = { "fixture-provider": "opaque-model" };
    const presetRoute = { ...route, marketplaceProviderPresetId: "fixture-provider" };
    expect(resolveContextWindowForRoute(presetRoute).inputModalities).toBeUndefined();
    route.vendors["openai-compatible"].imageInput![llmImageInputKey("opaque-model", "fixture-provider")] = false;
    expect(resolveContextWindowForRoute(presetRoute).inputModalities).toEqual({ input: [], source: "vendor-setting" });
  });

  it("declares image support without inventing other input modalities", () => {
    expect(resolveInputModalities({ vendor: "openai-compatible", model: "opaque-model", imageInput: true }))
      .toEqual({ input: ["image"], source: "vendor-setting" });
    expect(resolveInputModalities({ vendor: "openai-compatible", model: "opaque-model", imageInput: false, reported: ["text", "audio", "image"] }))
      .toEqual({ input: ["text", "audio"], source: "vendor-setting" });
  });

  it("carries the catalog's toolCall, and nothing where the catalog does not say", () => {
    expect(resolveContextWindowForRoute(apiRoute("openai", "gpt-3.5-turbo")).toolCall).toEqual({
      supported: false,
      source: "model-catalog",
      catalogEntry: "openai/gpt-3.5-turbo",
    });
    expect(resolveContextWindowForRoute(apiRoute("openai", "gpt-5.4")).toolCall).toMatchObject({ supported: true });
    expect(resolveContextWindowForRoute(apiRoute("openai-compatible", "a-served-model"))).not.toHaveProperty("toolCall");
  });

  it("keeps tools when the endpoint explicitly supports them despite the catalog", () => {
    expect(resolveContextWindowForRoute(apiRoute("openai", "gpt-3.5-turbo", {
      supportedParameters: ["tools"],
    })).toolCall).toEqual({ supported: true, source: "provider-reported" });
  });

  it("preserves the user's named no-tools entry above endpoint support", () => {
    expect(resolveContextWindowForRoute(apiRoute("openai-compatible", "a-served-model", {
      catalogModel: "openai/gpt-3.5-turbo",
      supportedParameters: [" Tools "],
    })).toolCall).toEqual({ supported: false, source: "model-catalog", catalogEntry: "openai/gpt-3.5-turbo" });
  });

  it.each([{ supportedParameters: [] }, { supportedParameters: ["reasoning"] }])("does not infer tool support from an incomplete parameter report %j", ({ supportedParameters }) => {
    expect(resolveContextWindowForRoute(apiRoute("openai", "gpt-3.5-turbo", { supportedParameters })).toolCall)
      .toMatchObject({ supported: false, source: "model-catalog" });
    expect(resolveContextWindowForRoute(apiRoute("openai", "gpt-5.4", { supportedParameters })).toolCall)
      .toMatchObject({ supported: true, source: "model-catalog" });
    expect(resolveContextWindowForRoute(apiRoute("openai-compatible", "a-served-model", { supportedParameters })))
      .not.toHaveProperty("toolCall");
  });
});

describe("context limits behind a custom endpoint", () => {
  it.each([
    "us.api.openai.com", "eu.api.openai.com", "au.api.openai.com", "ca.api.openai.com",
    "jp.api.openai.com", "in.api.openai.com", "sg.api.openai.com", "kr.api.openai.com",
    "gb.api.openai.com", "ae.api.openai.com", "mtls.api.openai.com",
    "mtls-us.api.openai.com", "mtls-eu.api.openai.com",
  ])("retains public model limits at a native regional or certificate origin: %s", (host) => {
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-5.2", baseUrl: `https://${host}/v1` }))
      .toMatchObject({ contextWindow: 400_000, source: "model-catalog", inputLimit: 272_000 });
  });

  it("does not infer a deployment's model identity from its resource hostname", () => {
    expect(resolveModelContextWindow({ vendor: "azure-foundry", model: "gpt-5.2", baseUrl: "https://synthetic.openai.azure.com/openai/v1" }))
      .toEqual({ contextWindow: 128_000, source: "fallback" });
  });

  it("budgets a location-managed SDK route independently of an unused endpoint field", () => {
    const vendors = freshAllVendorBlocks();
    vendors["vertex-ai"].model = "gemini-2.5-flash";
    vendors["vertex-ai"].baseUrl = "https://unused.invalid/v1";
    const modelListCache: LlmModelListCache = {
      [llmModelListCacheKey("vertex-ai", "https://unused.invalid/v1")]: {
        vendor: "vertex-ai", endpoint: "https://unused.invalid/v1/models", models: ["gemini-2.5-flash"],
        modelEntries: [{ id: "gemini-2.5-flash", contextLength: 64_000 }], fetchedAt: new Date(0).toISOString(),
      },
    };
    const route = resolveContextWindowForRoute({ provider: "vertex-ai", vendors, modelListCache });
    expect(route).toMatchObject({ contextWindow: 1_048_576, source: "model-catalog" });
    expect(route.baseUrl).toBeUndefined();
  });

  it("ignores generic endpoint reports under the default cache key for a location-managed SDK route", () => {
    const vendors = freshAllVendorBlocks();
    vendors["vertex-ai"].model = "gemini-2.5-flash";
    vendors["vertex-ai"].baseUrl = "https://unused.invalid/v1";
    const modelListCache: LlmModelListCache = {
      [llmModelListCacheKey("vertex-ai")]: {
        vendor: "vertex-ai", endpoint: "https://unused.invalid/v1/models", models: ["gemini-2.5-flash", "managed-unknown"],
        modelEntries: [
          { id: "gemini-2.5-flash", contextLength: 64_000, maxOutputTokens: 1_024 },
          { id: "managed-unknown", contextLength: 64_000 },
        ],
        fetchedAt: new Date(0).toISOString(),
      },
    };
    expect(resolveContextWindowForRoute({ provider: "vertex-ai", vendors, modelListCache }))
      .toMatchObject({ contextWindow: 1_048_576, source: "model-catalog" });
    vendors["vertex-ai"].model = "managed-unknown";
    expect(resolveContextWindowForRoute({ provider: "vertex-ai", vendors, modelListCache }))
      .toMatchObject({ contextWindow: 128_000, source: "fallback" });
    vendors["vertex-ai"].contextWindow = 229_376;
    expect(resolveContextWindowForRoute({ provider: "vertex-ai", vendors, modelListCache }))
      .toMatchObject({ contextWindow: 229_376, source: "vendor-setting" });
    delete vendors["vertex-ai"].contextWindow;
    vendors["vertex-ai"].catalogModel = "google-vertex/gemini-2.5-flash";
    expect(resolveContextWindowForRoute({ provider: "vertex-ai", vendors, modelListCache }))
      .toMatchObject({ contextWindow: 1_048_576, source: "model-catalog" });
  });

  function gatewayRoute(reported?: number) {
    const vendors = freshAllVendorBlocks();
    vendors.openai.baseUrl = "https://gateway.invalid/v1";
    // A gateway alias is not the same-name public model and cannot inherit its capacity.
    vendors.openai.model = "gpt-5.2";
    const modelListCache: LlmModelListCache = {
      [llmModelListCacheKey("openai", vendors.openai.baseUrl)]: {
        vendor: "openai", endpoint: "https://gateway.invalid/v1/models", models: ["gpt-5.2"],
        modelEntries: [{ id: "gpt-5.2", ...(reported !== undefined ? { contextLength: reported } : {}) }],
        fetchedAt: new Date(0).toISOString(),
      },
    };
    return { provider: "openai" as const, vendors, modelListCache };
  }

  it("does not infer catalog or pricing limits for an aliased id at another host", () => {
    expect(resolveContextWindowForRoute(gatewayRoute())).toEqual({
      baseUrl: "https://gateway.invalid/v1",
      model: "gpt-5.2", contextWindow: 128_000, source: "fallback",
      output: { requested: 32_000, requestedSource: "host-default", effective: 32_000, effectiveSource: "host-default" },
    });
  });

  it("uses the gateway's own report without a same-name public prompt cap", () => {
    expect(resolveContextWindowForRoute(gatewayRoute(512_000))).toEqual({
      baseUrl: "https://gateway.invalid/v1",
      model: "gpt-5.2", contextWindow: 512_000, source: "provider-reported",
      output: { requested: 32_000, requestedSource: "host-default", effective: 32_000, effectiveSource: "host-default" },
    });
  });

  it("does not infer input or tool capabilities for an aliased id at another host", () => {
    // Gateway aliases cannot inherit public input or tool capabilities.
    const route = gatewayRoute();
    route.vendors.openai.model = "gpt-3.5-turbo";
    const resolved = resolveContextWindowForRoute(route);
    expect(resolved).not.toHaveProperty("toolCall");
    expect(resolved).not.toHaveProperty("inputModalities");
    route.vendors.openai.baseUrl = "https://api.openai.com/v1";
    expect(resolveContextWindowForRoute(route).toolCall).toEqual({
      supported: false, source: "model-catalog", catalogEntry: "openai/gpt-3.5-turbo",
    });
  });

  it("does not recover an unknown named entry from public pricing at a custom host", () => {
    const route = gatewayRoute();
    route.vendors.openai.catalogModel = "openai/not-listed";
    expect(resolveContextWindowForRoute(route)).toMatchObject({
      contextWindow: 128_000, source: "fallback", unresolvedCatalogModel: "openai/not-listed",
    });
  });

  it("honors a declared capacity and an explicitly named model behind a gateway", () => {
    const route = gatewayRoute();
    route.vendors.openai.catalogModel = "openai/gpt-5.2";
    expect(resolveContextWindowForRoute(route)).toMatchObject({
      contextWindow: 400_000, source: "model-catalog", catalogEntry: "openai/gpt-5.2", inputLimit: 272_000,
    });
    route.vendors.openai.contextWindow = 64_000;
    expect(resolveContextWindowForRoute(route)).toEqual({
      baseUrl: "https://gateway.invalid/v1", catalogModel: "openai/gpt-5.2",
      model: "gpt-5.2", contextWindow: 64_000, source: "vendor-setting",
      output: { requested: 32_000, requestedSource: "host-default", ceiling: 128_000, ceilingSource: "model-catalog",
        effective: 32_000, effectiveSource: "host-default" },
      inputModalities: expect.objectContaining({ source: "model-catalog", catalogEntry: "openai/gpt-5.2" }),
      toolCall: expect.objectContaining({ source: "model-catalog", catalogEntry: "openai/gpt-5.2" }),
      reasoning: expect.objectContaining({ supported: true, source: "model-catalog", catalogEntry: "openai/gpt-5.2" }),
    });
  });

  it("keeps a declared catalog identity over a name match while the endpoint reports the window", () => {
    const route = gatewayRoute(512_000);
    route.vendors.openai.catalogModel = "openai/gpt-5.4";
    const resolved = resolveContextWindowForRoute(route);
    expect(resolved.contextWindow).toBe(512_000);
    expect(resolved.source).toBe("provider-reported");
    // An explicit named entry must not inherit a same-name public prompt cap.
    expect(resolved).not.toHaveProperty("inputLimit");
  });

  it("keeps catalog resolution at the mapped vendor's native host", () => {
    const route = gatewayRoute();
    route.vendors.openai.baseUrl = "https://api.openai.com/v1/";
    expect(resolveContextWindowForRoute(route)).toMatchObject({
      contextWindow: 400_000, source: "model-catalog", inputLimit: 272_000,
    });
  });
});

describe("resolveModelRetirement — design §6.1", () => {
  const listing = (models: string[], complete = true): LlmModelListCacheEntry => ({
    vendor: "openai",
    endpoint: "https://api.openai.com/v1/models",
    models,
    ...(complete ? { complete: true as const } : {}),
    fetchedAt: "2026-10-13T00:00:00.000Z",
  });

  it("ranks the vendor's listing above the catalog: a deprecated model it dropped is retired", () => {
    expect(resolveModelRetirement({ vendor: "openai", model: "o4-mini", listing: listing(["gpt-5.4"]) })).toBe("unlisted");
    expect(resolveModelRetirement({ vendor: "openai", model: "o4-mini", listing: listing(["o4-mini"]) })).toBe("catalog-deprecated");
  });

  it("puts a model the active catalog marks deprecated in the deprecated tier where the route establishes it", () => {
    expect(activeModelCatalog().providers.openai?.models["o4-mini"]?.status).toBe("deprecated");
    expect(resolveModelRetirement({ vendor: "openai", model: "o4-mini" })).toBe("catalog-deprecated");
    expect(resolveModelRetirement({ vendor: "openai", model: "o4-mini-2025-04-16" })).toBe("catalog-deprecated");
  });

  it("does not retire by catalog where the route does not establish the model", () => {
    expect(resolveModelRetirement({ vendor: "azure-foundry", model: "o4-mini" })).toBeUndefined();
    expect(resolveModelRetirement({ vendor: "openai", model: "o4-mini", baseUrl: "https://proxy.invalid/v1" })).toBeUndefined();
    expect(resolveModelRetirement({ vendor: "openai-compatible", model: "o4-mini" })).toBeUndefined();
  });

  it("keeps a model the catalog lists without a deprecated status", () => {
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-4o" })).toBeUndefined();
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-5.4" })).toBeUndefined();
  });

  it("retires a model the vendor's own complete listing no longer names", () => {
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-4o", listing: listing(["gpt-5.4"]) })).toBe("unlisted");
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-4o", listing: listing(["GPT-4O"]) })).toBeUndefined();
    expect(resolveModelRetirement({
      vendor: "deepseek", model: "deepseek-v4-pro", listing: { ...listing(["deepseek-flash"]), vendor: "deepseek" },
    })).toBe("unlisted");
  });

  it("judges only an id the catalog knows exactly: an unknown id may be served without being listed", () => {
    const complete = listing(["gpt-5.4", "gpt-4o"]);
    // Fine-tunes are account-owned identities, not public catalog ids.
    expect(resolveModelRetirement({ vendor: "openai", model: "ft:gpt-4o-mini:fixture-org::abc123", listing: complete }))
      .toBeUndefined();
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-9-fixture", listing: complete })).toBeUndefined();
    expect(listingJudgesRetirement("doubao")).toBe(true);
    expect(resolveModelRetirement({
      vendor: "doubao", model: "ep-20260101000000-fixture", listing: { ...listing(["doubao-seed-fixture"]), vendor: "doubao" },
    })).toBeUndefined();
    expect(resolveModelRetirement({
      vendor: "fireworks", model: "accounts/fixture-account/models/fixture-ft",
      listing: { ...listing(["accounts/fireworks/models/fixture"]), vendor: "fireworks" },
    })).toBeUndefined();
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-4.1", listing: complete })).toBe("unlisted");
  });

  it("proves nothing from a partial, missing or non-native listing", () => {
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-4o", listing: listing(["gpt-5.4"], false) })).toBeUndefined();
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-4o" })).toBeUndefined();
    for (const [vendor, baseUrl] of [
      ["openai", "https://proxy.invalid/v1"],
      ["azure-foundry", "https://synthetic.openai.azure.com/openai/v1"],
      ["openai-compatible", "https://models.invalid/v1"],
      ["ollama", "http://127.0.0.1:11434/v1"],
      ["lmstudio", undefined],
      ["openrouter", undefined],
      ["requesty", undefined],
      ["vercel-ai-gateway", undefined],
      ["huggingface", undefined],
      ["aihubmix", undefined],
      ["kilo", undefined],
      ["litellm", undefined],
    ] as const) {
      expect(listingJudgesRetirement(vendor, baseUrl), `${vendor} ${baseUrl}`).toBe(false);
      expect(resolveModelRetirement({ vendor, model: "fixture-model", ...(baseUrl ? { baseUrl } : {}), listing: listing(["other"]) }))
        .toBeUndefined();
    }
    expect(listingJudgesRetirement("openai")).toBe(true);
    expect(listingJudgesRetirement("openai", "https://api.openai.com/v1")).toBe(true);
    expect(listingJudgesRetirement("deepseek")).toBe(true);
  });

  it("proves nothing about a model the catalog dates after the listing was taken", () => {
    // A listing predating release is stale evidence, not proof of retirement.
    const before = { ...listing(["gpt-4o"]), fetchedAt: "2026-03-04T23:00:00.000Z" };
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-5.4", listing: before })).toBeUndefined();
    const sameDay = { ...listing(["gpt-4o"]), fetchedAt: "2026-03-05T20:00:00.000Z" };
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-5.4", listing: sameDay })).toBeUndefined();
    const undated = { ...listing(["gpt-4o"]), fetchedAt: "not-a-time" };
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-5.4", listing: undated })).toBeUndefined();
    expect(resolveModelRetirement({ vendor: "openai", model: "gpt-5.4", listing: listing(["gpt-4o"]) })).toBe("unlisted");
  });

  it("reads a release date given only to the month as the whole month", () => {
    // Month-only release dates cannot prove absence within that same month.
    expect(activeModelCatalog().providers["alibaba-cn"]?.models["qwen-mt-plus"]?.releaseDate).toBe("2025-01");
    const qwen = (fetchedAt: string) => ({ ...listing(["qwen-plus"]), vendor: "qwen", fetchedAt });
    expect(resolveModelRetirement({ vendor: "qwen", model: "qwen-mt-plus", listing: qwen("2025-01-20T00:00:00.000Z") }))
      .toBeUndefined();
    expect(resolveModelRetirement({ vendor: "qwen", model: "qwen-mt-plus", listing: qwen("2025-02-01T00:00:00.000Z") }))
      .toBe("unlisted");
  });

  it("never judges Vertex AI from a listing: its SDK answers no standard /models", () => {
    expect(listingJudgesRetirement("vertex-ai")).toBe(false);
    expect(resolveModelRetirement({ vendor: "vertex-ai", model: "gemini-3.5-flash", listing: listing(["other"]) }))
      .toBeUndefined();
  });

  it("judges the active route from the listing cached at its own address", () => {
    const vendors = freshAllVendorBlocks();
    vendors.openai = { ...vendors.openai, model: "gpt-4o" };
    const key = llmModelListCacheKey("openai", undefined, undefined);
    const llm = { provider: "openai" as const, vendors, modelListCache: { [key]: listing(["gpt-5.4"]) } };
    expect(resolveRouteModelRetirement(llm)).toBe("unlisted");
    expect(resolveRouteModelRetirement({ ...llm, modelListCache: {} })).toBeUndefined();
  });
});

describe("resolveReasoningSupport — one answer for the chooser and the engine", () => {
  it("reads the endpoint's report of a reasoning parameter, preferring the unified object", () => {
    for (const [parameters, control] of [
      [["tools", "reasoning", "include_reasoning"], "reasoning"],
      [["reasoning_effort", "include_reasoning"], "reasoning_effort"],
      [["include_reasoning"], "include_reasoning"],
      [["Reasoning"], "reasoning"],
    ] as const) {
      expect(resolveReasoningSupport({ vendor: "openrouter", model: "lab/unlisted-reasoner", reported: { supportedParameters: parameters } }))
        .toEqual({ supported: true, source: "endpoint-report", control });
    }
  });

  it("reads a reasoning price as support with no parameter to send", () => {
    expect(resolveReasoningSupport({
      vendor: "openai-compatible", model: "served-model", reported: { pricing: { internalReasoning: "0.000002" } },
    })).toEqual({ supported: true, source: "endpoint-report" });
  });

  it("is unknown when nobody states it, and a report without a reasoning parameter is not a denial", () => {
    expect(resolveReasoningSupport({ vendor: "openai-compatible", model: "served-model" })).toBeUndefined();
    expect(resolveReasoningSupport({ vendor: "openai-compatible", model: "served-model", reported: { supportedParameters: ["tools"] } }))
      .toBeUndefined();
  });

  it("orders the user's named entry, then the report, then the catalog's identity", () => {
    // Explicit named entries outrank reports; reports outrank implicit catalog matches.
    expect(resolveReasoningSupport({
      vendor: "openai", model: "alias", catalogModel: "openai/gpt-4.1", reported: { supportedParameters: ["reasoning_effort"] },
    })).toMatchObject({ supported: false, source: "model-catalog", catalogEntry: "openai/gpt-4.1" });
    expect(resolveReasoningSupport({ vendor: "openai", model: "gpt-4.1", reported: { supportedParameters: ["reasoning_effort"] } }))
      .toMatchObject({ source: "endpoint-report", control: "reasoning_effort" });
    expect(resolveReasoningSupport({ vendor: "openai", model: "gpt-5.4" }))
      .toMatchObject({ supported: true, source: "model-catalog", catalogEntry: "openai/gpt-5.4", efforts: expect.arrayContaining(["high"]) });
  });

  it("puts the route's report on the resolved route", () => {
    const vendors = freshAllVendorBlocks();
    vendors.openrouter = { ...vendors.openrouter, model: "lab/unlisted-reasoner" };
    const cache: LlmModelListCache = {
      [llmModelListCacheKey("openrouter", vendors.openrouter.baseUrl)]: {
        vendor: "openrouter", endpoint: "https://openrouter.ai/api/v1/models", models: ["lab/unlisted-reasoner"],
        modelEntries: [{ id: "lab/unlisted-reasoner", supportedParameters: ["reasoning"], pricing: { prompt: "0.000001", completion: "0.000002" } }],
        fetchedAt: "2026-10-13T00:00:00.000Z",
      },
    };
    const route = resolveContextWindowForRoute({ provider: "openrouter", vendors, modelListCache: cache });
    expect(route.reasoning).toEqual({ supported: true, source: "endpoint-report", control: "reasoning" });
    expect(route.reportedPricing).toEqual({ prompt: "0.000001", completion: "0.000002" });
  });
});
