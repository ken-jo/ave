import { describe, it, expect } from "vitest";
import { resolveModelRetirement } from "../context-budget.js";
import {
  BUILT_IN_LLM_VENDOR_IDS,
  DEFAULT_VISIBLE_LLM_VENDOR_IDS,
  INSTALLED_LLM_VENDOR_IDS,
  KNOWN_LEGACY_LLM_VENDOR_IDS,
  isLLMVendor,
  LLM_VENDORS,
  LLM_VENDOR_DEFAULTS,
  LLM_VENDOR_MODEL_OPTIONS,
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
    // Compile-time proof: passing `raw` to a function whose parameter is
    // typed `LLMVendor` only succeeds when the guard has narrowed it.
    // No hand-written exhaustive map needed — the call site itself is the
    // proof, and a future vendor added to LLM_VENDORS does not invalidate
    // this test.
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
    [16_001, 32_000, 16_000],
    [32_000, undefined, 16_000],
    [14_000, 16_000, 8_000],
    [48_000, 64_000, 32_000],
    [10_000, 25_001, 10_000],
    [20_000, 25_001, 16_000],
    [10_000, 1, 0],
    [0, 32_000, 0],
  ])("normalizes thinking %s with output %s to %i", (thinkingBudgetTokens, outputTokenLimit, expected) => {
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
    "replaces invalid thinking input %s with the bounded default", (value) => {
      const stored = { ...LLM_VENDOR_DEFAULTS.openai, thinkingBudgetTokens: value as number };
      expect(getLlmVendorSettings({ openai: stored }, "openai").thinkingBudgetTokens).toBe(8_000);
      expect(getLlmVendorSettings({ openai: { ...stored, outputTokenLimit: 8_000 } }, "openai").thinkingBudgetTokens).toBe(4_000);
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
    } }, "openai").thinkingBudgetTokens).toBe(cap);
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
      expect(budgets.every((budget) => [4_000, 8_000, 16_000, 32_000].includes(budget))).toBe(true);
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
    // Cline had 49 built-in provider IDs when this expansion was mirrored
    // (2026-06-29). Ave intentionally skips subscription/CLI-only providers,
    // but keeps the OpenAI-compatible preset surface broad enough to be
    // comparable rather than a small handful of hardcoded vendors.
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

  it("uses gpt-5.4-mini as the OpenAI default model", () => {
    expect(LLM_VENDOR_DEFAULTS.openai.model).toBe("gpt-5.4-mini");
  });

  it("defaults to the balanced 5.5 model and offers newer releases first", () => {
    expect(LLM_VENDOR_DEFAULTS.claude.model).toBe("claude-sonnet-5-5");
    expect(LLM_VENDOR_MODEL_OPTIONS.claude.slice(0, 4)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
    ]);
    expect(LLM_VENDOR_DEFAULTS.openrouter.model).toBe("anthropic/claude-sonnet-5.5");
  });

  it.each([
    ["openrouter", "anthropic/claude-sonnet-5.5"],
    ["requesty", "claude-sonnet-5-5"],
    ["vercel-ai-gateway", "anthropic/claude-sonnet-5.5"],
    ["kilo", "anthropic/claude-sonnet-5.5"],
  ] as const)("offers the catalog-confirmed model id for %s", (vendor, model) => {
    expect(LLM_VENDOR_MODEL_OPTIONS[vendor]).toContain(model);
  });

  it("offers the OpenRouter free router as an explicit selectable model", () => {
    expect(LLM_VENDOR_MODEL_OPTIONS.openrouter).toContain("openrouter/free");
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
    // The endpoints that actually honor chat_template_kwargs +
    // continue_final_message.
    expect(isSelfHostedVllmVendor("openai-compatible")).toBe(true);
    expect(isSelfHostedVllmVendor("litellm")).toBe(true);
    expect(isSelfHostedVllmVendor("ollama")).toBe(true);
    expect(isSelfHostedVllmVendor("lmstudio")).toBe(true);
    // Commercial OpenAI-compatible gateways route through the same adapter but
    // do NOT run a vLLM chat template — they must be excluded so the adapter
    // never leaks chat_template_kwargs to them (the OpenRouter 400/422 bug).
    expect(isSelfHostedVllmVendor("openrouter")).toBe(false);
    expect(isSelfHostedVllmVendor("groq")).toBe(false);
    expect(isSelfHostedVllmVendor("together")).toBe(false);
    expect(isSelfHostedVllmVendor("deepseek")).toBe(false);
    expect(isSelfHostedVllmVendor("mistral")).toBe(false);
    expect(isSelfHostedVllmVendor("xai")).toBe(false);
    // Non-openai-compatible vendors are false too.
    expect(isSelfHostedVllmVendor("openai")).toBe(false);
    expect(isSelfHostedVllmVendor("claude")).toBe(false);
  });

  it("classifies the self-hosted trusted-network class for private/loopback + insecure-credentialed HTTP", () => {
    // Network-trust SOT — distinct concept from the vLLM request-extension set,
    // even though it mirrors the same ids today. Editing one must not move the
    // other; this pins the current membership.
    expect(isSelfHostedTrustedNetworkVendor("openai-compatible")).toBe(true);
    expect(isSelfHostedTrustedNetworkVendor("litellm")).toBe(true);
    expect(isSelfHostedTrustedNetworkVendor("ollama")).toBe(true);
    expect(isSelfHostedTrustedNetworkVendor("lmstudio")).toBe(true);
    // Commercial OpenAI-compatible gateways are NOT network-trusted.
    expect(isSelfHostedTrustedNetworkVendor("openrouter")).toBe(false);
    expect(isSelfHostedTrustedNetworkVendor("groq")).toBe(false);
    expect(isSelfHostedTrustedNetworkVendor("deepseek")).toBe(false);
    // First-party vendors are excluded too.
    expect(isSelfHostedTrustedNetworkVendor("openai")).toBe(false);
    expect(isSelfHostedTrustedNetworkVendor("claude")).toBe(false);
  });

  it("requires a configured base URL before treating a provider as keyless-ready", () => {
    expect(canUseLlmVendorWithoutApiKey("openai-compatible", { baseUrl: "http://localhost:8000/v1" })).toBe(true);
    expect(canUseLlmVendorWithoutApiKey("openai-compatible", { baseUrl: "  " })).toBe(false);
    expect(canUseLlmVendorWithoutApiKey("openrouter", { baseUrl: "https://openrouter.ai/api/v1" })).toBe(false);
  });

  it("does not offer gpt-4o in user-selectable LLM model options", () => {
    for (const v of LLM_VENDORS) {
      expect(LLM_VENDOR_MODEL_OPTIONS[v]).not.toContain("gpt-4o");
      expect(LLM_VENDOR_DEFAULTS[v].model).not.toBe("gpt-4o");
    }
  });

  it("ships no default or curated model the active catalog deprecates (design §6.1)", () => {
    const retired = LLM_VENDORS.flatMap((vendor) =>
      [LLM_VENDOR_DEFAULTS[vendor].model, ...LLM_VENDOR_MODEL_OPTIONS[vendor]]
        .filter((model) => model && resolveModelRetirement({ vendor, model }) !== undefined)
        .map((model) => `${vendor}/${model}`));
    expect(retired).toEqual([]);
  });

  it("keeps a stored model id as saved; no name list retires it", () => {
    // Retirement is judged from the catalog and the vendor's own listing
    // (resolveModelRetirement), never by rewriting the id on read.
    expect(getLlmVendorSettings({ openai: { model: "gpt-4o" } } as never, "openai").model).toBe("gpt-4o");
    expect(getLlmVendorSettings({ "azure-foundry": { model: "gpt-4o" } } as never, "azure-foundry").model).toBe("gpt-4o");
  });

  it("uses gemini-2.5-flash as the Gemini default model", () => {
    expect(LLM_VENDOR_DEFAULTS.gemini.model).toBe("gemini-2.5-flash");
  });

  it("enables thinking by default for every provider", () => {
    for (const v of LLM_VENDORS) {
      expect(LLM_VENDOR_DEFAULTS[v].enableThinking).toBe(true);
    }
  });

  it("freshVendorBlocks() preserves the default-visible thinking-enabled blocks", () => {
    const blocks = freshVendorBlocks();
    expect(blocks.openai.model).toBe("gpt-5.4-mini");
    expect(blocks.gemini.model).toBe("gemini-2.5-flash");
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
    // A surviving 0 would zero the preflight threshold and switch
    // auto-compaction off for the route without saying so anywhere.
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

  it("includes each provider's default model in its dropdown options", () => {
    for (const v of LLM_VENDORS) {
      const options = LLM_VENDOR_MODEL_OPTIONS[v];
      const defaultModel = LLM_VENDOR_DEFAULTS[v].model;
      // Handshake-only providers (openai-compatible) ship no static catalog and
      // no default model — the list is fetched live from the endpoint's /models
      // handshake, so there is nothing to cross-check here.
      if (options.length === 0) {
        expect(defaultModel, `${v} handshake-only default must be empty`).toBe("");
        continue;
      }
      expect(options).toContain(defaultModel);
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
    // A block that carried the default could not say whether the user chose
    // it, so a saved 32000 came to mean "never set" (the one-time migration
    // in settings-store.ts drops those).
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
      // The transport reads any non-positive or non-integer value as "no cap",
      // so a value that survived here would look applied and do nothing.
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
