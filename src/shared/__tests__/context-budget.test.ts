import { afterEach, describe, it, expect } from "vitest";
import {
  catalogModelFor,
  getUsableContext,
  getPreflightThreshold,
  llmRouteCatalogAddress,
  MAX_CREDIBLE_CONTEXT_WINDOW,
  resolveContextWindowForRoute,
  resolveModelContextWindow,
} from "../context-budget.js";
import { FALLBACK_PRICING } from "../pricing-data.js";
import { freshAllVendorBlocks } from "../llm-vendor-defaults.js";
import { llmModelListCacheKey, type LlmModelListCache } from "../llm-model-list.js";
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

  it("reads the pricing catalog when neither input is present", () => {
    const resolved = resolveModelContextWindow({
      vendor: "openai-compatible",
      model: "Qwen3.6-35B-A3B-NVFP4",
    });

    expect(resolved).toEqual({ contextWindow: 262_144, source: "pricing-catalog" });
  });

  it("matches the catalog entry whatever case the served id is spelled in", () => {
    const resolved = resolveModelContextWindow({
      vendor: "openai-compatible",
      model: "qwen3.6-35b-a3b-nvfp4",
    });

    expect(resolved).toEqual({ contextWindow: 262_144, source: "pricing-catalog" });
  });

  it("names the fallback as a fallback so a caller can report the guess", () => {
    const resolved = resolveModelContextWindow({
      vendor: "openai-compatible",
      model: "a-model-no-catalog-knows",
    });

    expect(resolved).toEqual({
      contextWindow: FALLBACK_PRICING.contextWindow,
      source: "fallback",
    });
  });

  it("treats a malformed or non-positive declared window as not declared", () => {
    // A stored 0 that survived would zero the preflight threshold and switch
    // auto-compaction off for the route entirely.
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
    // A typo'd extra digit on 229,376 reads as 2,293,760, whose preflight
    // threshold no conversation reaches: compaction would never run again and
    // the turn would die on a provider context error instead.
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
    // The largest real windows still pass.
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
    ).toEqual({ contextWindow: FALLBACK_PRICING.contextWindow, source: "fallback" });
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
    // A preset is a provider in its own right reached through the
    // openai-compatible vendor: its catalogue synced against its own address,
    // so keying the lookup on the generic block's would find nothing.
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

  it("names the same cache coordinates a refresh has to write back to", () => {
    // A refresher that keys the row differently writes an answer the reader
    // never finds, so the probe repeats forever.
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

  it("does not put the block's named entry on a marketplace preset's own model", () => {
    const settings = routeSettings({ presetId: "provider-alpha", baseUrl: "https://preset.invalid/v1" });
    settings.vendors["openai-compatible"].catalogModel = "openai/gpt-4.1";
    expect(
      resolveContextWindowForRoute(settings, [{ providerId: "provider-alpha", baseUrl: "https://preset.invalid/v1" }]),
    ).toMatchObject({ source: "fallback" });
  });

  it("moves to the next source when the route has no handshake for the model", () => {
    expect(resolveContextWindowForRoute(routeSettings())).toMatchObject({
      contextWindow: FALLBACK_PRICING.contextWindow,
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

  it("leaves a model the catalog does not know, or knows without a window, to the pricing table", () => {
    useCatalog({ openai: [{ id: "gpt-4.1", limits: {} }] });
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-4.1" })).toEqual({ contextWindow: 1_000_000, source: "pricing-catalog" });
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-4.1-nano" })).toEqual({ contextWindow: 1_000_000, source: "pricing-catalog" });
  });

  it("does not believe a catalog window past the credible ceiling", () => {
    useCatalog({ openai: [{ id: "gpt-4.1", limits: { context: MAX_CREDIBLE_CONTEXT_WINDOW + 1 } }] });
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-4.1" }).source).toBe("pricing-catalog");
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
    expect(resolveModelContextWindow({ vendor: "claude", model: "claude-sonnet-4-6", catalogModel: "anthropic/not-listed" }).source).toBe("pricing-catalog");
  });

  it("throws when nothing installed a catalog, instead of answering from the table", () => {
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

/**
 * What the bundled snapshot of 2026-10-12 changes against the hand-kept
 * table, row by row. Each assertion failed before the catalog joined the
 * order (the table's value is in the comment). A snapshot refresh that moves
 * one of these is a reviewed behavior change: update the row with it.
 */
describe("windows the bundled catalog corrects", () => {
  it.each([
    ["openai", "gpt-5.4-pro", 1_050_000, "openai/gpt-5.4-pro"], // table: 1,100,000
    ["openai", "gpt-4.1", 1_047_576, "openai/gpt-4.1"], // table: 1,000,000
    ["openai", "gpt-4.1-2025-04-14", 1_047_576, "openai/gpt-4.1"], // table: 1,000,000
    ["gemini", "gemini-2.5-pro", 1_048_576, "google/gemini-2.5-pro"], // table: 1,000,000
    ["gemini", "gemini-2.5-flash-lite", 1_048_576, "google/gemini-2.5-flash-lite"], // table: 128,000
  ] as const)("%s %s → %i from %s", (vendor, model, contextWindow, catalogEntry) => {
    expect(resolveModelContextWindow({ vendor, model })).toMatchObject({ contextWindow, source: "model-catalog", catalogEntry });
  });

  it("keeps the 1M window the adapter's beta header delivers for Claude 4.6", () => {
    expect(resolveModelContextWindow({ vendor: "claude", model: "claude-sonnet-4-6" })).toMatchObject({ contextWindow: 1_000_000, source: "model-catalog" });
  });

  it("leaves dated ids the catalog has no entry for to the table", () => {
    expect(resolveModelContextWindow({ vendor: "claude", model: "claude-sonnet-4-20250514" })).toEqual({ contextWindow: 200_000, source: "pricing-catalog" });
  });
});

/**
 * A prompt cap below the window bounds the budget. Before, the threshold came
 * from the window alone: GPT-5.2 (400K window, 272K prompt) compacted at
 * 288,000 — past the prompt the endpoint accepts — and about 100 snapshot
 * entries had a threshold above their cap.
 */
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
    // A reported window at or under the catalog's cap leaves the cap nothing to bound.
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

describe("context limits behind a custom endpoint", () => {
  function gatewayRoute(reported?: number) {
    const vendors = freshAllVendorBlocks();
    vendors.openai.baseUrl = "https://gateway.invalid/v1";
    // The gateway exposes this id for a 64K deployment; an id-only model
    // list supplies no capacity. A public model of the same name is unrelated.
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
      model: "gpt-5.2", contextWindow: 128_000, source: "fallback",
    });
  });

  it("uses the gateway's own report without a same-name public prompt cap", () => {
    expect(resolveContextWindowForRoute(gatewayRoute(512_000))).toEqual({
      model: "gpt-5.2", contextWindow: 512_000, source: "provider-reported",
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
      model: "gpt-5.2", contextWindow: 64_000, source: "vendor-setting",
    });
  });

  it("keeps a declared catalog identity over a name match while the endpoint reports the window", () => {
    const route = gatewayRoute(512_000);
    route.vendors.openai.catalogModel = "openai/gpt-5.4";
    const resolved = resolveContextWindowForRoute(route);
    expect(resolved.contextWindow).toBe(512_000);
    expect(resolved.source).toBe("provider-reported");
    // The named entry's 922K input ceiling does not bound this window; the
    // same-name public entry's 272K ceiling must not replace the declaration.
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
