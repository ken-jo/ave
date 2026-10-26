/** Fetching model lists and using seeded options are independent policy columns; test every declared mode. */
import { describe, expect, it, vi } from "vitest";
import {
  MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES,
  MARKETPLACE_PROVIDER_MODEL_DISCOVERY_BEHAVIOR,
  type MarketplaceProviderModelDiscoveryPolicy,
} from "../marketplace-package-assets.js";
import { listLlmModelsFromSettings } from "../../engine/llm/model-list.js";
import { mergeLlmPatch } from "../../data/settings-normalization.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { llmModelListCacheKey } from "../llm-model-list.js";

/** Use independent expectations so a wrong policy table cannot validate itself. */
const EXPECTED: Record<
  MarketplaceProviderModelDiscoveryPolicy,
  { allowsFetch: boolean; usesSeededOptions: boolean }
> = {
  static: { allowsFetch: false, usesSeededOptions: true },
  "models-api": { allowsFetch: true, usesSeededOptions: false },
  "openrouter-models-api": { allowsFetch: true, usesSeededOptions: false },
  manual: { allowsFetch: false, usesSeededOptions: true },
};

const PRESET_ID = "acme-provider";
const PRESET_BASE_URL = "https://acme.example.com/v1";

function makeSettingsService() {
  return {
    get: vi.fn((key: string) => {
      if (key === "llm") {
        return {
          provider: "openrouter",
          vendors: {
            openrouter: {
              model: "openrouter/free",
              baseUrl: "https://openrouter.ai/api/v1",
              enableThinking: true,
              thinkingBudgetTokens: 10_000,
            },
          },
        };
      }
      if (key === "marketplace") return { installedProviderPresets: [] };
      throw new Error(`unexpected settings key: ${key}`);
    }),
    getSecret: vi.fn(() => "sk-test"),
  };
}

function installedPreset(policy: MarketplaceProviderModelDiscoveryPolicy) {
  return {
    providerId: PRESET_ID,
    label: "Acme",
    baseUrl: PRESET_BASE_URL,
    modelOptions: ["acme/one"],
    requiresApiKey: true,
    modelDiscoveryPolicy: policy,
  };
}

describe("model discovery policy — the table is total over the union", () => {
  it("declares behaviour for every member, and the union has no undeclared member", () => {
    for (const policy of MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES) {
      expect(MARKETPLACE_PROVIDER_MODEL_DISCOVERY_BEHAVIOR[policy]).toEqual(EXPECTED[policy]);
    }
    expect(Object.keys(MARKETPLACE_PROVIDER_MODEL_DISCOVERY_BEHAVIOR).sort()).toEqual(
      [...MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES].sort(),
    );
  });
});

describe("engine fetch gate follows the authority for every union member", () => {
  it.each([...MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES])(
    "%s",
    async (policy) => {
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: "acme/one" }] }), { status: 200 }),
      ) as unknown as typeof fetch;

      const result = await listLlmModelsFromSettings(
        makeSettingsService() as never,
        { vendor: "openrouter", modelDiscoveryPolicy: policy },
        {
          fetchImpl,
          fetchPublicHttpResponseImpl: (async (...args: unknown[]) =>
            (fetchImpl as unknown as (...a: unknown[]) => unknown)(...args)) as never,
          ensurePublicUrl: (async (url: string) => url) as never,
        },
      );

      if (EXPECTED[policy].allowsFetch) {
        expect(fetchImpl).toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ ok: false, error: "model-list-not-supported" });
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    },
  );
});

describe("settings normalization drops seeded-policy model-list caches for every union member", () => {
  it.each([...MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES])(
    "%s",
    (policy) => {
      const key = llmModelListCacheKey("openai-compatible", PRESET_BASE_URL, PRESET_ID);
      const merged = mergeLlmPatch(
        DEFAULT_SETTINGS.llm,
        {
          modelListCache: {
            [key]: {
              vendor: "openai-compatible",
              endpoint: `${PRESET_BASE_URL}/models`,
              baseUrl: PRESET_BASE_URL,
              credentialScope: PRESET_ID,
              models: ["acme/one"],
              fetchedAt: "2026-08-01T00:00:00.000Z",
            },
          },
        } as never,
        [installedPreset(policy)] as never,
      );

      const retained = Object.keys(merged.modelListCache ?? {}).length > 0;
      // Seeded-only presets cannot refresh credential-scoped caches, so discard stale entries.
      expect(retained).toBe(!EXPECTED[policy].usesSeededOptions);
    },
  );
});
