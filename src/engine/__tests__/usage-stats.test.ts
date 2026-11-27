import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  computeUsageSummary,
  computeMonthlyProjection,
  getUsageRange,
  getUsageSummary,
  type UsageTurnEntry,
  type UsageTrendPoint,
} from "../usage-stats.js";
import { computeCost, knownModelPricing, resolveModelPricing } from "../llm/pricing.js";
import { resolvePricingOverrides } from "../../shared/pricing-overrides.js";

function turn(partial: Partial<UsageTurnEntry>): UsageTurnEntry {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "s1",
    type: "turn",
    route: "claude/claude-sonnet-4-6",
    tokenUsage: { inputTokens: 1000, outputTokens: 500 },
    ...partial,
  };
}

it("classifies label-only usage as unpriced in totals and projections", () => {
  const summary = computeUsageSummary([turn({
    route: "openai/gpt-5.4",
    tokenUsage: { inputTokens: 100_000, outputTokens: 0 },
  })], new Date());
  for (const totals of [summary.today, summary.thisWeek, summary.thisMonth, ...summary.perModel, ...summary.perVendor, ...summary.trend, ...summary.topConversations]) {
    expect(totals).toMatchObject({ cost: 0, unknownCostTurns: 1, legacyRouteUnrecordedTurns: 1 });
  }
  expect(computeMonthlyProjection(summary.trend)).toBeUndefined();
});

it("uses recorded request prices for historical usage", () => {
  const entries = [turn({
    route: "openai/gpt-5.4",
    usageByModel: [{
      vendorProvider: "openai", vendorModel: "gpt-5.4",
      tokenUsage: { inputTokens: 100_000, outputTokens: 0 },
      pricing: { source: "user", rates: { inputPer1M: 1, outputPer1M: 0 } },
    }],
  })];
  const summary = computeUsageSummary(entries, new Date());
  expect(summary.today.cost).toBeCloseTo(0.1, 9);
  expect(summary.perModel[0].cost).toBeCloseTo(0.1, 9);
});

it("keeps the recorded endpoint-price reason when the current catalog prices the model", () => {
  const summary = computeUsageSummary([turn({
    usageByModel: [{
      vendorProvider: "openai", vendorModel: "gpt-5.4",
      tokenUsage: { inputTokens: 100_000, outputTokens: 0 },
      pricing: { source: "unknown", reason: "endpoint-price-unavailable" },
    }],
  })], new Date());
  expect(summary.today.unknownCostTurns).toBe(1);
  expect(summary.today.endpointPriceUnavailableTurns).toBe(1);
  expect(computeMonthlyProjection(summary.trend)).toBeUndefined();
});

it("uses the recorded primary price only for matching older request segments", () => {
  const summary = computeUsageSummary([turn({
    route: "openai/gpt-5.4",
    modelSettings: { pricing: { source: "user", rates: { inputPer1M: 1, outputPer1M: 0 } } },
    usageByModel: [
      { vendorProvider: "openai", vendorModel: "gpt-5.4", tokenUsage: { inputTokens: 100_000, outputTokens: 0 } },
      { vendorProvider: "claude", vendorModel: "claude-sonnet-4-6", tokenUsage: { inputTokens: 100_000, outputTokens: 0 } },
    ],
  })], new Date());
  expect(summary.today.cost).toBeCloseTo(0.1, 9);
  expect(summary.today.legacyRouteUnrecordedTurns).toBe(1);
});

// Pin the timezone at module scope: every suite uses host-midnight bucket boundaries.
let previousTz: string | undefined;
beforeEach(() => {
  previousTz = process.env.TZ;
  process.env.TZ = "Asia/Seoul";
});
afterEach(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe("usage-stats", () => {
  it("aggregates today/week/month totals from turn entries", () => {
    const now = new Date("2026-04-18T12:00:00Z");
    const entries: UsageTurnEntry[] = [
      turn({ timestamp: "2026-04-18T10:00:00Z", tokenUsage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      }),
      turn({ timestamp: "2026-04-13T10:00:00Z", tokenUsage: { inputTokens: 200_000, outputTokens: 100_000 },
      }),
      turn({ timestamp: "2026-04-02T10:00:00Z", tokenUsage: { inputTokens: 50_000, outputTokens: 25_000 },
      }),
      turn({ timestamp: "2026-03-15T10:00:00Z", tokenUsage: { inputTokens: 10_000, outputTokens: 5_000 },
      }),
    ];

    const summary = computeUsageSummary(entries, now);
    expect(summary.today.inputTokens).toBe(1_000_000);
    expect(summary.today.outputTokens).toBe(500_000);
    expect(summary.thisWeek.inputTokens).toBe(1_200_000);
    expect(summary.thisMonth.inputTokens).toBe(1_250_000);
  });

  it("keeps subscription telemetry separate from API price summaries", () => {
    const now = new Date("2026-07-04T12:00:00Z");
    const summary = computeUsageSummary([
      {
        timestamp: "2026-07-04T01:00:00Z",
        sessionId: "mixed-runtime-turn",
        type: "turn",
        route: "openai/gpt-4.1",
        tokenUsage: { inputTokens: 1_000, outputTokens: 500 },
        subscriptionUsage: [
          {
            provider: "codex",
            model: "gpt-5.4",
            source: "provider-reported",
            billable: false,
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 4,
            reasoningOutputTokens: 10,
            totalTokens: 164,
          },
          {
            provider: "kimi-code",
            model: "default",
            source: "local-estimate",
            billable: false,
            inputTokens: 40,
            outputTokens: 5,
            totalTokens: 45,
          },
          // Reject raw provider payloads at persistence so they cannot pollute usage totals.
          {
            provider: "codex",
            model: "gpt-5.4",
            source: "provider-reported",
            billable: false,
            inputTokens: 999,
            outputTokens: 999,
            totalTokens: 1_998,
            rawProviderPayload: { shouldNotReachRenderer: true },
          },
        ],
      },
    ], now);

    expect(summary.today.totalTokens).toBe(1_500);
    expect(summary.perVendor.map((row) => row.vendor)).toEqual(["openai"]);
    expect(summary.perModel.map((row) => row.model)).toEqual(["gpt-4.1"]);

    expect(summary.subscription.today).toMatchObject({
      inputTokens: 140,
      outputTokens: 25,
      cacheReadTokens: 30,
      cacheWriteTokens: 4,
      reasoningOutputTokens: 10,
      totalTokens: 209,
      segments: 2,
    });
    expect(summary.subscription.sources["provider-reported"]).toMatchObject({
      totalTokens: 164,
      segments: 1,
    });
    expect(summary.subscription.sources["local-estimate"]).toMatchObject({
      totalTokens: 45,
      segments: 1,
    });
    expect(summary.subscription.perRuntime).toEqual([
      expect.objectContaining({ provider: "codex", model: "*", totalTokens: 164 }),
      expect.objectContaining({ provider: "kimi-code", model: "*", totalTokens: 45 }),
    ]);
    expect(summary.subscription.perModel).toEqual([
      expect.objectContaining({ provider: "codex", model: "gpt-5.4", totalTokens: 164 }),
      expect.objectContaining({ provider: "kimi-code", model: "default", totalTokens: 45 }),
    ]);
    expect(summary.subscription.trend).toEqual([
      expect.objectContaining({ date: "2026-07-04", totalTokens: 209 }),
    ]);
  });

  it("buckets today and the trend on the host's calendar day, not UTC's", () => {
    const now = new Date("2026-07-03T16:00:00Z");
    const entries: UsageTurnEntry[] = [
      turn({ timestamp: "2026-07-03T15:30:00Z", tokenUsage: { inputTokens: 100, outputTokens: 10 },
      }),
      turn({ timestamp: "2026-07-03T14:30:00Z", tokenUsage: { inputTokens: 300, outputTokens: 30 },
      }),
    ];

    const summary = computeUsageSummary(entries, now);
    expect(summary.today.inputTokens).toBe(100);
    expect(summary.trend.map((point) => [point.date, point.inputTokens]),
    ).toEqual([
      ["2026-07-03", 300],
      ["2026-07-04", 100],
    ]);
  });

  it("computes cost using the recorded primary price", () => {
    const entries = [turn({
      tokenUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      modelSettings: { pricing: { source: "model-catalog", rates: { inputPer1M: 3, outputPer1M: 15 } } },
    })];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].cost).toBeCloseTo(18, 5);
    expect(summary.perVendor[0].vendor).toBe("claude");
  });

  it("groups by model and session and ranks by recorded spend", () => {
    const modelSettings = { pricing: { source: "user" as const, rates: { inputPer1M: 3, outputPer1M: 15 } } };
    const entries: UsageTurnEntry[] = [
      turn({ sessionId: "expensive", modelSettings, tokenUsage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
      }),
      turn({ sessionId: "cheap", modelSettings, tokenUsage: { inputTokens: 1000, outputTokens: 500 },
      }),
      turn({ sessionId: "expensive", modelSettings, tokenUsage: { inputTokens: 500_000, outputTokens: 200_000 },
      }),
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.topConversations[0].sessionId).toBe("expensive");
    expect(summary.topConversations[0].turns).toBe(2);
    expect(summary.perModel[0].model).toBe("claude-sonnet-4-6");
  });

  it("respects env pricing override", () => {
    // Pass the environment price override through the resolver; it does not read the environment itself.
    const overrides = resolvePricingOverrides(undefined, {
      AVE_PRICING_OVERRIDE: JSON.stringify({
        claude: {
          "claude-sonnet-4-6": {
            inputPer1M: 100,
            outputPer1M: 100,
            contextWindow: 1_000_000,
          },
        },
      }),
    });
    const p = knownModelPricing(resolveModelPricing("claude", "claude-sonnet-4-6", overrides));
    expect(p?.source).toBe("user");
    expect(p?.rates.inputPer1M).toBe(100);
    expect(
      computeCost(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        p!.rates,
        "claude",
      ),
    ).toBeCloseTo(200, 5);
  });

  describe("computeCost — vendor branch coverage", () => {
    const sonnet = { inputPer1M: 3, outputPer1M: 15, contextWindow: 200_000 };
    const gpt = { inputPer1M: 2, outputPer1M: 8, contextWindow: 1_000_000 };

    it("claude — fresh + cache.read × 0.1 + cache.write × 1.25 + output (ratio fallback)", () => {
      expect(
        computeCost(
          {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadTokens: 1_000_000,
            cacheWriteTokens: 1_000_000,
          },
          sonnet,
          "claude",
        ),
      ).toBeCloseTo(22.05, 5);
    });

    it("claude — explicit cacheReadPer1M / cacheWritePer1M override the ratio fallback", () => {
      const explicit = { ...sonnet, cacheReadPer1M: 0.5, cacheWritePer1M: 6 };
      expect(
        computeCost(
          {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadTokens: 1_000_000,
            cacheWriteTokens: 1_000_000,
          },
          explicit,
          "claude",
        ),
      ).toBeCloseTo(24.5, 5);
    });

    it.each(["openai", "azure-foundry"] as const)(
      "%s — cache fields split prompt_tokens into fresh + discounted cached input",
      (vendor) => {
        expect(
          computeCost(
            {
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
              cacheReadTokens: 250_000,
              cacheWriteTokens: 0,
            },
            { ...gpt, cacheReadPer1M: 0.2 },
            vendor,
          ),
        ).toBeCloseTo(9.55, 5);
      },
    );

    it.each(["openai", "azure-foundry"] as const)(
      "%s — missing cached-input rate treats cached prompt tokens as ordinary input",
      (vendor) => {
        expect(
          computeCost(
            {
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
              cacheReadTokens: 250_000,
            },
            gpt,
            vendor,
          ),
        ).toBeCloseTo(10, 5);
      },
    );

    it.each(["gemini", "vertex-ai"] as const)(
      "%s — cache fields ignored, write deferred to storage-per-hour cron",
      (vendor) => {
        const flash = { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000,
        };
        expect(
          computeCost(
            {
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
              cacheReadTokens: 1_000_000,
              cacheWriteTokens: 1_000_000,
            },
            flash,
            vendor,
          ),
        ).toBe(0);
      },
    );

    it("NaN / undefined / negative tokens all clamp to 0 (no negative cost)", () => {
      const result = computeCost(
        {
          inputTokens: NaN as unknown as number,
          outputTokens: -100,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        sonnet,
        "claude",
      );
      // Clamp negative upstream usage so malformed data cannot produce negative billing.
      expect(result).toBe(0);
    });
  });

  it("totalTokens vendor-aware — OpenAI cacheRead is NOT double-counted", () => {
    // Cached input is already included in prompt input here; adding it again inflates totals.
    const entries: UsageTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "openai-cache-hot",
        type: "turn",
        route: "openai/gpt-4.1",
        tokenUsage: {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 500_000,
        },
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].totalTokens).toBe(1_100_000);
  });

  it("marks zero-price placeholder model costs as unknown instead of fake $0", () => {
    const entries: UsageTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "legacy-openai",
        type: "turn",
        route: "openai/o1-mini",
        tokenUsage: {
          inputTokens: 10_000,
          outputTokens: 1_000,
        },
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].cost).toBe(0);
    expect(summary.perVendor[0].unknownCostTurns).toBe(1);
    expect(summary.today.unknownCostTurns).toBe(1);
  });

  it("keeps label-only deployment usage unpriced", () => {
    const entries: UsageTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "azure-model-name",
        type: "turn",
        route: "azure-foundry/gpt-5.4-mini",
        tokenUsage: {
          inputTokens: 10_000,
          outputTokens: 1_000,
          cacheReadTokens: 5_000,
        },
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].vendor).toBe("azure-foundry");
    expect(summary.perVendor[0].unknownCostTurns).toBe(1);
    expect(summary.perVendor[0].legacyRouteUnrecordedTurns).toBe(1);
    expect(summary.perVendor[0].cost).toBe(0);
  });

  it("does not lend OpenAI's table price to an Azure deployment alias", () => {
    const entries: UsageTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "azure-model-alias",
        type: "turn",
        route: "azure-foundry/gpt-5.4-mini-prod-eastus",
        tokenUsage: { inputTokens: 10_000, outputTokens: 1_000 },
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].cost).toBe(0);
    expect(summary.perVendor[0].unknownCostTurns).toBe(1);
  });

  it("keeps token-bearing bare legacy routes in an explicit unknown bucket", () => {
    const entries: UsageTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "legacy-bare-route",
        type: "turn",
        route: "legacy",
        tokenUsage: {
          inputTokens: 10_000,
          outputTokens: 1_000,
          cacheReadTokens: 500,
        },
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].vendor).toBe("unknown");
    expect(summary.perVendor[0].model).toBe("*");
    expect(summary.perModel[0].vendor).toBe("unknown");
    expect(summary.perModel[0].model).toBe("legacy");
    expect(summary.perVendor[0].unknownCostTurns).toBe(1);
    expect(summary.perVendor[0].totalTokens).toBe(11_000);
  });

  it("keeps a per-model segment whose vendor id this build no longer knows", () => {
    // Persisted audit rows retain usage even when their vendor identifier has since changed.
    const entries: UsageTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "renamed-vendor",
        type: "turn",
        route: "nousResearch/DeepHermes-3-Llama-3-3-70B-Preview",
        tokenUsage: { inputTokens: 1_000, outputTokens: 100 },
        usageByModel: [
          {
            vendorProvider: "nousResearch",
            vendorModel: "DeepHermes-3-Llama-3-3-70B-Preview",
            tokenUsage: { inputTokens: 1_000, outputTokens: 100 },
          },
        ],
      },
    ];

    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].vendor).toBe("unknown");
    expect(summary.perVendor[0].totalTokens).toBe(1_100);
    expect(summary.perVendor[0].unknownCostTurns).toBe(1);
    expect(summary.perModel[0].model).toBe("nousResearch/DeepHermes-3-Llama-3-3-70B-Preview");
  });

  it("uses per-model audit breakdown for mixed-provider fallback turns", () => {
    const entries: UsageTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "mixed-fallback",
        type: "turn",
        route: "openai/gpt-5.4-mini",
        tokenUsage: {
          inputTokens: 2_010_000,
          outputTokens: 101_000,
          cacheReadTokens: 500_000,
          cacheWriteTokens: 200_000,
        },
        usageByModel: [
          {
            vendorProvider: "claude",
            vendorModel: "claude-sonnet-4-6",
            tokenUsage: {
              inputTokens: 1_000_000,
              outputTokens: 100_000,
              cacheReadTokens: 500_000,
              cacheWriteTokens: 200_000,
            },
          },
          {
            vendorProvider: "openai",
            vendorModel: "gpt-5.4-mini",
            tokenUsage: {
              inputTokens: 10_000,
              outputTokens: 1_000,
            },
          },
        ],
      },
    ];

    const summary = computeUsageSummary(entries, new Date());
    expect(summary.topConversations).toEqual([]);
    expect(summary.topConversationsByTokens[0].turns).toBe(1);
    expect(summary.perVendor.map((row) => row.vendor).sort()).toEqual(["claude", "openai",
    ]);
    expect(summary.perModel.map((row) => `${row.vendor}/${row.model}`).sort(),
    ).toEqual(["claude/claude-sonnet-4-6", "openai/gpt-5.4-mini"]);
    expect(
      summary.perVendor.find((row) => row.vendor === "claude")?.totalTokens,
    ).toBe(1_800_000);
    expect(
      summary.perVendor.find((row) => row.vendor === "openai")?.totalTokens,
    ).toBe(11_000);
  });

  it("selects a recorded long-context tier per request segment", () => {
    const pricing = resolveModelPricing("openai", "gpt-5.4");
    const entries: UsageTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "multi-round-openai",
        type: "turn",
        route: "openai/gpt-5.4",
        tokenUsage: {
          inputTokens: 400_000,
          outputTokens: 0,
        },
        usageByModel: [
          {
            vendorProvider: "openai",
            vendorModel: "gpt-5.4",
            pricing,
            tokenUsage: { inputTokens: 200_000, outputTokens: 0 },
          },
          {
            vendorProvider: "openai",
            vendorModel: "gpt-5.4",
            pricing,
            tokenUsage: { inputTokens: 200_000, outputTokens: 0 },
          },
        ],
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    // Price each request before aggregation; merged inputs can cross a tier no request reached.
    expect(summary.perModel[0].cost).toBeCloseTo(1, 5);
  });

  it("totalTokens vendor-aware — current Anthropic usageByModel adds cache to total", () => {
    const entries: UsageTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "claude-cache-hot",
        type: "turn",
        route: "claude/claude-sonnet-4-6",
        modelSettings: { pricing: { source: "model-catalog", rates: { inputPer1M: 3, outputPer1M: 15 } } },
        tokenUsage: {
          inputTokens: 1_700_000,
          outputTokens: 100_000,
          cacheReadTokens: 500_000,
          cacheWriteTokens: 200_000,
        },
        usageByModel: [
          {
            vendorProvider: "claude",
            vendorModel: "claude-sonnet-4-6",
            tokenUsage: {
              inputTokens: 1_000_000,
              outputTokens: 100_000,
              cacheReadTokens: 500_000,
              cacheWriteTokens: 200_000,
            },
          },
        ],
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].totalTokens).toBe(1_800_000);
    expect(summary.perVendor[0].cost).toBeCloseTo(5.4, 5);
  });

  it("normalizes legacy Claude audit rows without usageByModel before aggregation", () => {
    const entries: UsageTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "legacy-claude-cache-hot",
        type: "turn",
        route: "claude/claude-sonnet-4-6",
        tokenUsage: {
          inputTokens: 1_700_000,
          outputTokens: 100_000,
          cacheReadTokens: 500_000,
          cacheWriteTokens: 200_000,
        },
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].inputTokens).toBe(1_000_000);
    expect(summary.perVendor[0].totalTokens).toBe(1_800_000);
    expect(summary.perVendor[0]).toMatchObject({ cost: 0, unknownCostTurns: 1, legacyRouteUnrecordedTurns: 1 });
  });

  it("Anthropic billing-contract: cache reduces total cost vs uncached input", () => {
    // Cache-read usage must retain its discounted input cost in audit and summary accounting.
    const sonnet = { inputPer1M: 3, outputPer1M: 15, contextWindow: 200_000 };
    const cached = computeCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
      },
      sonnet,
      "claude",
    );
    const fresh = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      sonnet,
      "claude",
    );
    expect(cached).toBeCloseTo(0.3, 5);
    expect(fresh).toBeCloseTo(3.0, 5);
    expect(cached / fresh).toBeCloseTo(0.1, 5);
  });

  it("OpenAI billing-contract: cached input is discounted without changing total token volume", () => {
    const gpt54mini = knownModelPricing(resolveModelPricing("openai", "gpt-5.4-mini"))!.rates;
    const cached = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000 },
      gpt54mini,
      "openai",
    );
    const fresh = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      gpt54mini,
      "openai",
    );
    expect(cached).toBeCloseTo(0.1425, 5);
    expect(fresh).toBeCloseTo(0.75, 5);
    expect(cached).toBeLessThan(fresh);
  });

  it("builds a chronological trend array", () => {
    const entries: UsageTurnEntry[] = [
      turn({ timestamp: "2026-04-10T10:00:00Z" }),
      turn({ timestamp: "2026-04-12T10:00:00Z" }),
      turn({ timestamp: "2026-04-11T10:00:00Z" }),
    ];
    const summary = computeUsageSummary(
      entries,
      new Date("2026-04-12T12:00:00Z"),
    );
    expect(summary.trend.map((t) => t.date)).toEqual([
      "2026-04-10",
      "2026-04-11",
      "2026-04-12",
    ]);
  });

});

describe("computeMonthlyProjection", () => {
  it("returns 0 for empty trend", () => {
    expect(computeMonthlyProjection([])).toBe(0);
  });

  it("projects avg-per-day × 30", () => {
    const trend: UsageTrendPoint[] = [
      {
        date: "2026-04-01",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 1.0,
      },
      {
        date: "2026-04-02",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 3.0,
      },
    ];
    expect(computeMonthlyProjection(trend)).toBeCloseTo(60, 5);
  });

  it("projects correctly for a single day", () => {
    const trend: UsageTrendPoint[] = [
      {
        date: "2026-04-01",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 0.5,
      },
    ];
    expect(computeMonthlyProjection(trend)).toBeCloseTo(15, 5);
  });
});

describe("saved turn usage", () => {
  it("keeps measurable usage, excludes dates and duplicates, and flags partial coverage", async () => {
    const now = new Date(2026, 5, 16, 12);
    const priorDay = new Date(2026, 5, 15, 12);
    const saved = {
      role: "assistant",
      meta: {
        messageId: "saved-turn",
        createdAt: now.getTime(),
        turnSummary: {
          tokensIn: 9999,
          freshInputTokens: 100,
          tokensOut: 20,
          vendorProvider: "openai",
          vendorModel: "gpt-4o",
          modelSettings: { pricing: { source: "user", rates: { inputPer1M: 10, outputPer1M: 20 } } },
        },
      },
    };
    const sessions = {
      listSessions: vi.fn(() => [
        { id: "primary" }, { id: "fork" }, { id: "unreadable" },
      ] as unknown as ReturnType<Parameters<typeof getUsageRange>[0]["listSessions"]>),
      loadSession: vi.fn((id: string) => {
        if (id === "unreadable") throw new Error("Unreadable session");
        return id === "fork" ? [saved] : [
          saved,
          { role: "assistant", meta: { createdAt: now.getTime() } },
          { ...saved, meta: { ...saved.meta, messageId: "older", createdAt: priorDay.getTime() } },
        ];
      }),
    };

    const range = await getUsageRange(sessions, { dateFrom: "2026-06-16", dateTo: "2026-06-16" }, now);
    expect(range).toMatchObject({
      auditIncomplete: true,
      today: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0.0014 },
      perModel: [{ vendor: "openai", model: "gpt-4o", totalTokens: 120 }],
    });
    expect(range.trend).toHaveLength(1);
    const rolling = await getUsageSummary(sessions, 2, now);
    expect(rolling.thisMonth.totalTokens).toBe(240);
  });
});
