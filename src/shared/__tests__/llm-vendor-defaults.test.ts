import { describe, it, expect } from "vitest";
import { resolveModelRetirement } from "../context-budget.js";
import {
  BUILT_IN_LLM_VENDOR_IDS,
  DEFAULT_VISIBLE_LLM_VENDOR_IDS,
  INSTALLED_LLM_VENDOR_IDS,
  KNOWN_LEGACY_LLM_VENDOR_IDS,
  isLLMVendor,
  isOpenAICompatiblePresetVendor,
  LLM_VENDORS,
  LLM_VENDOR_DEFAULTS,
  OPENAI_COMPATIBLE_PRESET_VENDOR_IDS,
  OPENAI_COMPATIBLE_VENDOR_PRESETS,
  llmVendorModelOptions,
  MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS,
  canUseLlmVendorWithoutApiKey,
  freshAllVendorBlocks,
  freshVendorBlocks,
  getLlmVendorSettings,
  llmImageInputKey,
  llmRouteImageInput,
  requestedLlmOutputTokenLimit,
  getLlmThinkingBudgetLimit,
  getLlmThinkingBudgetRungs,
  type LLMVendorSettings,
  isApiKeyOptionalLlmVendor,
  isDefaultVisibleLLMVendor,
  isMarketplaceEligibleLLMVendor,
  isSelfHostedTrustedNetworkVendor,
  isSelfHostedVllmVendor,
  DEFAULT_LLM_VENDOR,
  narrowLlmVendor,
  isRetiredLLMVendor,
  RETIRED_LLM_VENDOR_IDS,
} from "../llm-vendor-defaults.js";
import { DEFAULT_LLM_OUTPUT_TOKEN_LIMIT } from "../model-host-policy.js";
import { CATALOG_PROVIDERS_BY_VENDOR } from "../model-catalog/provider-map.js";

describe("upstream-prefixed model ids", () => {
  it("declares exactly the presets whose model ids identify an upstream provider", () => {
    expect(Object.entries(OPENAI_COMPATIBLE_VENDOR_PRESETS)
      .filter(([, preset]) => preset.upstreamPrefixedModelIds === true)
      .map(([id]) => id).sort())
      .toEqual(["kilo", "openrouter", "requesty", "vercel-ai-gateway"]);
  });
});

describe("isLLMVendor", () => {
  it("accepts every member of LLM_VENDORS", () => {
    for (const v of LLM_VENDORS) {
      expect(isLLMVendor(v)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isLLMVendor("anthropic")).toBe(false);
    expect(isLLMVendor("unknown-vendor")).toBe(false);
    expect(isLLMVendor("")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isLLMVendor(undefined)).toBe(false);
    expect(isLLMVendor(null)).toBe(false);
    expect(isLLMVendor(42)).toBe(false);
    expect(isLLMVendor({ vendor: "claude" })).toBe(false);
    expect(isLLMVendor(["claude"])).toBe(false);
    expect(isLLMVendor(true)).toBe(false);
  });

  it("narrows the type so downstream callers receive a typed LLMVendor", () => {
    // The typed call proves guard narrowing without duplicating the vendor set.
    const acceptVendor = (v: import("../llm-vendor-defaults.js").LLMVendor) => v;
    const raw: unknown = "claude";
    if (isLLMVendor(raw)) {
      expect(acceptVendor(raw)).toBe("claude");
    } else {
      expect.fail("raw should have narrowed to LLMVendor");
    }
  });
});

describe("model image declarations", () => {
  it("normalizes scoped boolean declarations and removes malformed or cleared values", () => {
    const key = llmImageInputKey("opaque-model");
    const presetKey = llmImageInputKey("opaque-model", "fixture-provider");
    const block = getLlmVendorSettings({ "openai-compatible": {
      ...LLM_VENDOR_DEFAULTS["openai-compatible"],
      imageInput: { [key]: true, [presetKey]: false, bad: true, '["",""]': true, '["","cleared"]': undefined, '["","invalid"]': "true" as never },
    } }, "openai-compatible");
    expect(block.imageInput).toEqual({ [key]: true, [presetKey]: false });
    expect(llmRouteImageInput(block, "opaque-model")).toBe(true);
    expect(llmRouteImageInput(block, "opaque-model", "fixture-provider")).toBe(false);
    expect(llmRouteImageInput(block, "other-model")).toBeUndefined();
    expect(getLlmVendorSettings({ "openai-compatible": { ...block, imageInput: { [key]: undefined } } }, "openai-compatible").imageInput).toBeUndefined();
  });
});

describe("LLMVendorSettings", () => {
  it.each([
    [undefined, undefined, 8_000],
    [10_000, undefined, 10_000],
    [14_000, undefined, 14_000],
    [16_000, 32_000, 16_000],
    [16_001, 32_000, 16_001],
    [32_000, undefined, 32_000],
    [14_000, 16_000, 14_000],
    [48_000, 64_000, 48_000],
    [10_000, 25_001, 10_000],
    [20_000, 25_001, 20_000],
    [10_000, 1, 10_000],
    [0, 32_000, 0],
  ])("preserves thinking intent %s with output %s as %i", (thinkingBudgetTokens, outputTokenLimit, expected) => {
    const block = getLlmVendorSettings({
      openai: { ...LLM_VENDOR_DEFAULTS.openai, thinkingBudgetTokens: thinkingBudgetTokens as number, outputTokenLimit },
    }, "openai");
    expect(block.thinkingBudgetTokens).toBe(expected);
    expect(block.outputTokenLimit).toBe(outputTokenLimit);
    expect(requestedLlmOutputTokenLimit(block)).toEqual(
      outputTokenLimit === undefined ? { value: 32_000, source: "host-default" } : { value: outputTokenLimit, source: "user" },
    );
  });

  it.each([NaN, Infinity, -Infinity, -1, 1.5, "20000", null, {}, Number.MAX_VALUE])(
    "replaces invalid thinking input %s with the default", (value) => {
      const stored = { ...LLM_VENDOR_DEFAULTS.openai, thinkingBudgetTokens: value as number };
      expect(getLlmVendorSettings({ openai: stored }, "openai").thinkingBudgetTokens).toBe(8_000);
      expect(getLlmVendorSettings({ openai: { ...stored, outputTokenLimit: 8_000 } }, "openai").thinkingBudgetTokens).toBe(8_000);
    },
  );

  it("shows only low, medium and high at the default output ceiling", () => {
    expect(getLlmThinkingBudgetRungs(32_000)).toEqual([
      { key: "low", budget: 4_000 },
      { key: "medium", budget: 8_000 },
      { key: "high", budget: 16_000 },
    ]);
    expect(LLM_VENDOR_DEFAULTS.openai.thinkingBudgetTokens).toBe(8_000);
    expect(getLlmThinkingBudgetRungs(16_000).map((rung) => rung.budget)).toEqual([4_000, 8_000]);
    expect(getLlmThinkingBudgetRungs(64_000).map((rung) => rung.budget)).toEqual([4_000, 8_000, 16_000, 32_000]);
    expect(getLlmThinkingBudgetRungs(4_000)).toEqual([]);
  });

  it.each([
    [4_000, 3_999, []],
    [4_001, 4_000, [4_000]],
    [8_000, 4_000, [4_000]],
    [8_001, 8_000, [4_000, 8_000]],
    [16_000, 8_000, [4_000, 8_000]],
    [16_001, 16_000, [4_000, 8_000, 16_000]],
    [32_000, 16_000, [4_000, 8_000, 16_000]],
    [32_001, 32_000, [4_000, 8_000, 16_000, 32_000]],
  ] as const)("admits only presets strictly below output %i", (outputTokenLimit, cap, budgets) => {
    expect(getLlmThinkingBudgetLimit(outputTokenLimit)).toBe(cap);
    expect(getLlmThinkingBudgetRungs(outputTokenLimit).map((rung) => rung.budget)).toEqual(budgets);
    expect(getLlmVendorSettings({ openai: {
      ...LLM_VENDOR_DEFAULTS.openai, outputTokenLimit, thinkingBudgetTokens: 32_000,
    } }, "openai").thinkingBudgetTokens).toBe(32_000);
  });

  it.each([
    [1_025, 1_024], [2_000, 1_999], [2_047, 2_046], [2_048, 2_047],
  ])("retains numeric thinking capacity below the first preset with output %i", (outputTokenLimit, cap) => {
    expect(getLlmThinkingBudgetLimit(outputTokenLimit)).toBe(cap);
    expect(getLlmVendorSettings({ openai: {
      ...LLM_VENDOR_DEFAULTS.openai, outputTokenLimit, thinkingBudgetTokens: 1_024,
    } }, "openai").thinkingBudgetTokens).toBe(1_024);
  });

  it.each([1, 2, 3, 4, 7, 9, 10, 11, 12, 25_001, 32_000, Number.MAX_SAFE_INTEGER])(
    "offers distinct bounded integer depths for output %i", (outputTokenLimit) => {
      const budgets = getLlmThinkingBudgetRungs(outputTokenLimit).map((rung) => rung.budget);
      expect(budgets.every((budget) => [4_000, 8_000, 16_000, 32_000, 64_000].includes(budget))).toBe(true);
      expect(new Set(budgets).size).toBe(budgets.length);
      expect(budgets).toEqual([...budgets].sort((a, b) => a - b));
      expect(budgets.every((budget) => Number.isSafeInteger(budget) && budget > 0 && budget < outputTokenLimit)).toBe(true);
    },
  );

  it("freshVendorBlocks() returns default-visible mutable copies", () => {
    const blocks = freshVendorBlocks();
    expect(Object.keys(blocks).sort()).toEqual(
      [...DEFAULT_VISIBLE_LLM_VENDOR_IDS].sort(),
    );
  });

  it("freshAllVendorBlocks() remains available for exhaustive fixtures", () => {
    const blocks = freshAllVendorBlocks();
    expect(Object.keys(blocks)).toHaveLength(LLM_VENDORS.length);
  });
});

describe("LLM vendor defaults", () => {
  it("keeps provider count in the Cline-scale range", () => {
    expect(LLM_VENDORS.length).toBeGreaterThanOrEqual(40);
    expect(isLLMVendor("openrouter")).toBe(true);
    expect(isLLMVendor("ollama")).toBe(true);
    expect(isLLMVendor("lmstudio")).toBe(true);
  });

  it("keeps only five providers in the default visible surface", () => {
    expect(BUILT_IN_LLM_VENDOR_IDS).toEqual([
      "openai",
      "claude",
      "gemini",
      "openrouter",
      "openai-compatible",
    ]);
    expect(DEFAULT_VISIBLE_LLM_VENDOR_IDS).toEqual([
      "openai",
      "claude",
      "gemini",
      "openrouter",
      "openai-compatible",
    ]);
    expect(DEFAULT_VISIBLE_LLM_VENDOR_IDS).toHaveLength(5);
    for (const vendor of DEFAULT_VISIBLE_LLM_VENDOR_IDS) {
      expect(isLLMVendor(vendor)).toBe(true);
      expect(isDefaultVisibleLLMVendor(vendor)).toBe(true);
      expect(MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS).not.toContain(vendor);
    }
    expect(MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS).toContain("azure-foundry");
    expect(MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS).toContain("groq");
    expect(MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS).toContain("ollama");
    expect(isMarketplaceEligibleLLMVendor("groq")).toBe(true);
    expect(isMarketplaceEligibleLLMVendor("openrouter")).toBe(false);
    expect(isMarketplaceEligibleLLMVendor("unknown-vendor")).toBe(false);
  });

  it("keeps built-in, marketplace-installed seed, and known legacy provider ids explicit", () => {
    expect(DEFAULT_VISIBLE_LLM_VENDOR_IDS).toBe(BUILT_IN_LLM_VENDOR_IDS);
    expect(INSTALLED_LLM_VENDOR_IDS).toEqual(MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS);
    expect(KNOWN_LEGACY_LLM_VENDOR_IDS).toEqual(INSTALLED_LLM_VENDOR_IDS);
    expect(INSTALLED_LLM_VENDOR_IDS).not.toContain("openai");
    expect(INSTALLED_LLM_VENDOR_IDS).not.toContain("openrouter");
    expect(INSTALLED_LLM_VENDOR_IDS).toContain("azure-foundry");
    expect(INSTALLED_LLM_VENDOR_IDS).toContain("groq");
    expect(KNOWN_LEGACY_LLM_VENDOR_IDS).toContain("vertex-ai");
    expect([...BUILT_IN_LLM_VENDOR_IDS, ...KNOWN_LEGACY_LLM_VENDOR_IDS].sort())
      .toEqual([...LLM_VENDORS].sort());
  });

  it("requires a model choice on every fresh vendor route", () => {
    for (const vendor of LLM_VENDORS) {
      expect(LLM_VENDOR_DEFAULTS[vendor].model, vendor).toBe("");
    }
  });

  it("offers the OpenRouter free router as an explicit selectable model", () => {
    expect(llmVendorModelOptions("openrouter")).toContain("openrouter/free");
  });

  it("marks only local or OpenAI-compatible endpoints as API-key optional", () => {
    expect(isApiKeyOptionalLlmVendor("openai-compatible")).toBe(true);
    expect(isApiKeyOptionalLlmVendor("litellm")).toBe(true);
    expect(isApiKeyOptionalLlmVendor("ollama")).toBe(true);
    expect(isApiKeyOptionalLlmVendor("lmstudio")).toBe(true);
    expect(isApiKeyOptionalLlmVendor("openrouter")).toBe(false);
    expect(isApiKeyOptionalLlmVendor("openai")).toBe(false);
  });

  it("classifies only the self-hosted vLLM class for vLLM request extensions", () => {
    expect(isSelfHostedVllmVendor("openai-compatible")).toBe(true);
    expect(isSelfHostedVllmVendor("litellm")).toBe(true);
    expect(isSelfHostedVllmVendor("ollama")).toBe(true);
    expect(isSelfHostedVllmVendor("lmstudio")).toBe(true);
    // Compatible gateways must not receive local chat-template extensions.
    expect(isSelfHostedVllmVendor("openrouter")).toBe(false);
    expect(isSelfHostedVllmVendor("groq")).toBe(false);
    expect(isSelfHostedVllmVendor("together")).toBe(false);
    expect(isSelfHostedVllmVendor("deepseek")).toBe(false);
    expect(isSelfHostedVllmVendor("mistral")).toBe(false);
    expect(isSelfHostedVllmVendor("xai")).toBe(false);
    expect(isSelfHostedVllmVendor("openai")).toBe(false);
    expect(isSelfHostedVllmVendor("claude")).toBe(false);
  });

  it("classifies the self-hosted trusted-network class for private/loopback + insecure-credentialed HTTP", () => {
    // Network trust and request extensions are independent policies even when their memberships match.
    expect(isSelfHostedTrustedNetworkVendor("openai-compatible")).toBe(true);
    expect(isSelfHostedTrustedNetworkVendor("litellm")).toBe(true);
    expect(isSelfHostedTrustedNetworkVendor("ollama")).toBe(true);
    expect(isSelfHostedTrustedNetworkVendor("lmstudio")).toBe(true);
    expect(isSelfHostedTrustedNetworkVendor("openrouter")).toBe(false);
    expect(isSelfHostedTrustedNetworkVendor("groq")).toBe(false);
    expect(isSelfHostedTrustedNetworkVendor("deepseek")).toBe(false);
    expect(isSelfHostedTrustedNetworkVendor("openai")).toBe(false);
    expect(isSelfHostedTrustedNetworkVendor("claude")).toBe(false);
  });

  it("requires a configured base URL before treating a provider as keyless-ready", () => {
    expect(canUseLlmVendorWithoutApiKey("openai-compatible", { baseUrl: "http://localhost:8000/v1" })).toBe(true);
    expect(canUseLlmVendorWithoutApiKey("openai-compatible", { baseUrl: "  " })).toBe(false);
    expect(canUseLlmVendorWithoutApiKey("openrouter", { baseUrl: "https://openrouter.ai/api/v1" })).toBe(false);
  });

  it("never starts a vendor on gpt-4o", () => {
    // Offering catalog ids and selecting defaults are separate policies.
    for (const v of LLM_VENDORS) {
      expect(LLM_VENDOR_DEFAULTS[v].model).not.toBe("gpt-4o");
    }
  });

  it("ships no default or curated model the active catalog deprecates (design §6.1)", () => {
    const retired = LLM_VENDORS.flatMap((vendor) =>
      [LLM_VENDOR_DEFAULTS[vendor].model, ...llmVendorModelOptions(vendor)]
        .filter((model) => model && resolveModelRetirement({ vendor, model }) !== undefined)
        .map((model) => `${vendor}/${model}`));
    expect(retired).toEqual([]);
  });

  it("keeps a stored model id as saved; no name list retires it", () => {
    // Determine retirement from catalog and vendor listings; never rewrite ids on read.
    expect(getLlmVendorSettings({ openai: { model: "gpt-4o" } } as never, "openai").model).toBe("gpt-4o");
    expect(getLlmVendorSettings({ "azure-foundry": { model: "gpt-4o" } } as never, "azure-foundry").model).toBe("gpt-4o");
  });

  it("leaves catalog routes unselected", () => {
    expect(LLM_VENDOR_DEFAULTS.gemini.model).toBe("");
  });

  it("enables thinking by default for every provider", () => {
    for (const v of LLM_VENDORS) {
      expect(LLM_VENDOR_DEFAULTS[v].enableThinking).toBe(true);
    }
  });

  it("freshVendorBlocks() preserves the default-visible thinking-enabled blocks", () => {
    const blocks = freshVendorBlocks();
    expect(blocks.openai.model).toBe("");
    expect(blocks.gemini.model).toBe("");
    expect(blocks.groq).toBeUndefined();
    for (const v of DEFAULT_VISIBLE_LLM_VENDOR_IDS) {
      expect(blocks[v].enableThinking).toBe(true);
    }
  });

  it("getLlmVendorSettings() materializes missing marketplace blocks from defaults", () => {
    const block = getLlmVendorSettings(freshVendorBlocks(), "groq");
    expect(block.model).toBe(LLM_VENDOR_DEFAULTS.groq.model);
    expect(block.enableThinking).toBe(true);
  });

  it("carries a declared contextWindow through, and leaves it unset by default", () => {
    const declared = getLlmVendorSettings(
      { "openai-compatible": { ...LLM_VENDOR_DEFAULTS["openai-compatible"], contextWindow: 229_376 } },
      "openai-compatible",
    );
    expect(declared.contextWindow).toBe(229_376);
    expect(getLlmVendorSettings(freshVendorBlocks(), "openai-compatible").contextWindow)
      .toBeUndefined();
  });

  it("drops a stored contextWindow that is not a usable positive integer", () => {
    // Reject zero windows so compaction cannot be silently disabled.
    for (const stored of [0, -1, 4.5, Number.NaN, "229376", null]) {
      const block = getLlmVendorSettings(
        {
          "openai-compatible": {
            ...LLM_VENDOR_DEFAULTS["openai-compatible"],
            contextWindow: stored,
          } as unknown as LLMVendorSettings,
        },
        "openai-compatible",
      );
      expect(block.contextWindow, `stored ${String(stored)} must not survive`).toBeUndefined();
    }
  });

  it("carries a named catalog entry through trimmed, and drops one that is not <provider>/<id>", () => {
    const named = (catalogModel: unknown) => getLlmVendorSettings(
      {
        "openai-compatible": {
          ...LLM_VENDOR_DEFAULTS["openai-compatible"],
          catalogModel,
        } as unknown as LLMVendorSettings,
      },
      "openai-compatible",
    ).catalogModel;
    expect(named(" openai/gpt-4.1 ")).toBe("openai/gpt-4.1");
    expect(named("openrouter/lab/model")).toBe("openrouter/lab/model");
    for (const stored of ["gpt-4.1", "/gpt-4.1", "openai/", "open ai/gpt", "openai/gpt 4", 42, null, `openai/${"x".repeat(300)}`]) {
      expect(named(stored), `stored ${String(stored)} must not survive`).toBeUndefined();
    }
    expect(getLlmVendorSettings(freshVendorBlocks(), "openai-compatible").catalogModel).toBeUndefined();
  });

  it("offers what the catalog lists for a vendor it describes, not a hand-written seed", () => {
    expect(llmVendorModelOptions("openai")).toEqual(expect.arrayContaining(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]));
    expect(llmVendorModelOptions("claude")).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]));
    expect(llmVendorModelOptions("gemini")).toEqual(expect.arrayContaining(["gemini-3.8-flash", "gemini-3.5-flash-lite"]));
    expect(llmVendorModelOptions("moonshot")).toEqual(expect.arrayContaining(["kimi-k3"]));
  });

  it("keeps hand-picked options only for a preset no catalog provider describes", () => {
    const declaresWithCatalog: string[] = [];
    const missingWithoutCatalog: string[] = [];
    for (const vendor of OPENAI_COMPATIBLE_PRESET_VENDOR_IDS) {
      const handPicked = OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].modelOptions;
      if (CATALOG_PROVIDERS_BY_VENDOR[vendor].length > 0) {
        if (handPicked !== undefined) declaresWithCatalog.push(vendor);
      } else if (!handPicked || handPicked.length === 0) {
        missingWithoutCatalog.push(vendor);
      }
    }
    expect(declaresWithCatalog).toEqual([]);
    expect(missingWithoutCatalog).toEqual([]);
    expect(llmVendorModelOptions("ollama")).toEqual(OPENAI_COMPATIBLE_VENDOR_PRESETS.ollama.modelOptions);
    expect(llmVendorModelOptions("openai-compatible")).toEqual([]);
  });

  it("offers current catalog choices before any credential without selecting one", () => {
    expect(llmVendorModelOptions("claude")).toEqual(expect.arrayContaining([
      "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1",
    ]));
    expect(llmVendorModelOptions("openai")[0]).toBe("gpt-6.1-sol");
    expect(LLM_VENDOR_DEFAULTS.claude.model).toBe("");
  });

  it("keeps endpoint preset recommendations separate from route selections", () => {
    for (const v of LLM_VENDORS) {
      if (CATALOG_PROVIDERS_BY_VENDOR[v].length > 0) continue;
      const options = llmVendorModelOptions(v);
      const defaultModel = LLM_VENDOR_DEFAULTS[v].model;
      // Handshake-only providers fetch model lists live and have no static default to cross-check.
      if (options.length === 0) {
        expect(defaultModel, `${v} handshake-only default must be empty`).toBe("");
        continue;
      }
      expect(defaultModel).toBe("");
      if (isOpenAICompatiblePresetVendor(v)) expect(options).toContain(OPENAI_COMPATIBLE_VENDOR_PRESETS[v].defaultModel);
    }
  });
});

describe("narrowLlmVendor", () => {
  it("returns a known vendor unchanged and the default for anything else", () => {
    expect(narrowLlmVendor("claude")).toBe("claude");
    expect(narrowLlmVendor("not-a-vendor")).toBe(DEFAULT_LLM_VENDOR);
    expect(narrowLlmVendor(undefined)).toBe(DEFAULT_LLM_VENDOR);
    expect(narrowLlmVendor(42)).toBe(DEFAULT_LLM_VENDOR);
  });
});

describe("retired vendor ids", () => {
  it("rejects retired provider ids without aliasing them", () => {
    expect(RETIRED_LLM_VENDOR_IDS).toEqual(["copilot"]);
    expect(isLLMVendor("copilot")).toBe(false);
    expect(isRetiredLLMVendor("copilot")).toBe(true);
    expect(isRetiredLLMVendor("openai")).toBe(false);
    expect(narrowLlmVendor("copilot")).toBe(DEFAULT_LLM_VENDOR);
  });
});

describe("getLlmVendorSettings output ceiling", () => {
  it("carries a positive integer ceiling through unchanged", () => {
    const block = getLlmVendorSettings(
      { openai: { ...LLM_VENDOR_DEFAULTS.openai, outputTokenLimit: 16_384 } },
      "openai",
    );
    expect(block.outputTokenLimit).toBe(16_384);
  });

  it("leaves the default out of every block and reports it as the host's", () => {
    // Drop legacy seeded output limits so an unset value remains distinguishable from a user choice.
    expect(DEFAULT_LLM_OUTPUT_TOKEN_LIMIT).toBe(32_000);
    for (const vendor of LLM_VENDORS) {
      expect(LLM_VENDOR_DEFAULTS[vendor].outputTokenLimit).toBeUndefined();
      const block = getLlmVendorSettings(undefined, vendor);
      expect(block.outputTokenLimit).toBeUndefined();
      expect(requestedLlmOutputTokenLimit(block)).toEqual({ value: DEFAULT_LLM_OUTPUT_TOKEN_LIMIT, source: "host-default" });
    }
  });

  it.each([0, -1, 12.5, Number.NaN, "16384"])(
    "drops a malformed limit %p, leaving the host default",
    (stored) => {
      // Reject invalid caps; the transport otherwise treats them as no limit.
      const block = getLlmVendorSettings(
        {
          openai: {
            ...LLM_VENDOR_DEFAULTS.openai,
            outputTokenLimit: stored as never,
          },
        },
        "openai",
      );
      expect(block.outputTokenLimit).toBeUndefined();
      expect(requestedLlmOutputTokenLimit(block)).toEqual({ value: DEFAULT_LLM_OUTPUT_TOKEN_LIMIT, source: "host-default" });
    },
  );
});
