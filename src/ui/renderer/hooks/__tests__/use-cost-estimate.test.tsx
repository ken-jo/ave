import "../../../../../test/renderer/setup.js";

import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { syncPricingOverrides } from "../use-pricing-overrides.js";
import { estimateOutgoingUserMessageTokens } from "../../../../shared/multimodal-token-estimate.js";
import { useCostEstimate } from "../use-cost-estimate.js";
import { costTier } from "../../../../lib/cost-estimator.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";

describe("useCostEstimate", () => {
  it("uses the latest context carrier instead of reserializing stale visible history", () => {
    const staleVisibleHistory = "x".repeat(2_000_000);
    const entries: ChatEntry[] = [
      { kind: "assistant", text: staleVisibleHistory, streaming: false },
      { kind: "context_usage", tokensIn: 42_000, source: "compact-estimate" },
    ];

    const { result } = renderHook(() =>
      useCostEstimate({
        entries,
        draft: { text: "hi" },
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
        maxOutputTokens: 1_000,
      }),
    );

    expect(result.current.costEstimate.inputTokens).toBe(
      42_000 + estimateOutgoingUserMessageTokens("hi"),
    );
    expect(result.current.costEstimate.inputTokens).toBeLessThan(50_000);
  });

  it("adds image attachment token estimates to the pre-send input cost", () => {
    const image = {
      type: "image" as const,
      image: "data:image/png;base64,abc",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      bytes: 4096,
    };
    const { result: withoutImage } = renderHook(() =>
      useCostEstimate({
        entries: [],
        draft: { text: "inspect" },
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
        maxOutputTokens: 1_000,
      }),
    );
    const { result: withImage } = renderHook(() =>
      useCostEstimate({
        entries: [],
        draft: { text: "inspect", attachments: [image] },
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
        maxOutputTokens: 1_000,
      }),
    );

    expect(withImage.current.costEstimate.inputTokens)
      .toBeGreaterThan(withoutImage.current.costEstimate.inputTokens);
  });

  it("uses the same Korean and resource-text draft estimate as the provider-wire path", () => {
    const attachments = [
      { type: "text" as const, text: "<resource>서버가 제공한 긴 리소스 본문</resource>" },
      {
        type: "image" as const,
        image: "data:image/png;base64,abc",
        mimeType: "image/png",
        width: 2048,
        height: 512,
      },
    ];
    const entries: ChatEntry[] = [{ kind: "context_usage", tokensIn: 7_000, source: "compact-estimate" }];
    const draft = "한글 사용자 질문";

    const { result } = renderHook(() =>
      useCostEstimate({
        entries,
        draft: { text: draft, attachments },
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
        maxOutputTokens: 1_000,
      }),
    );

    expect(result.current.costEstimate.inputTokens).toBe(
      7_000 + estimateOutgoingUserMessageTokens(draft, attachments),
    );
  });

  it("marks zero-price placeholder models as pricing unknown instead of showing a fake zero cost", () => {
    const { result } = renderHook(() =>
      useCostEstimate({
        entries: [],
        draft: { text: "hi" },
        llmVendor: "openai",
        // A zero row in the hand-kept table that the catalog does not price.
        llmModel: "o1-mini",
        maxOutputTokens: 1_000,
      }),
    );

    expect(result.current.costEstimate.inputTokens).toBeGreaterThan(0);
    expect(result.current.costEstimate.total).toBe(0);
    expect(result.current.costEstimate.pricingKnown).toBe(false);
    expect(result.current.costBadgeClass).toBe("text-muted-foreground");
  });

  it("does not derive an API cost estimate when the runtime has no verified billing contract", () => {
    const { result } = renderHook(() =>
      useCostEstimate({
        entries: [],
        draft: { text: "subscription runtime draft" },
        // These deliberately stale API values must be ignored.
        llmVendor: "openai",
        llmModel: "gpt-5.4-nano",
        maxOutputTokens: 1_000,
        enabled: false,
      }),
    );

    expect(result.current.costEstimate).toBeUndefined();
    expect(result.current.costBadgeClass).toBeUndefined();
  });
});
describe("useCostEstimate — the output limit is the range's upper end, not the tier", () => {
  // About 2K tokens of input, an effective output limit of 32,000.
  const carrier = (outputs: number[]): ChatEntry[] => [
    ...outputs.map((tokensOut) => ({ kind: "turn_summary", tokensIn: 2_000, tokensOut } as unknown as ChatEntry)),
    { kind: "context_usage", tokensIn: 2_000, source: "compact-estimate" },
  ];
  const estimate = (vendor: string, model: string, outputs: number[]) =>
    renderHook(() => useCostEstimate({ entries: carrier(outputs), draft: { text: "" }, llmVendor: vendor, llmModel: model, maxOutputTokens: 32_000 })).result.current;

  it.each([
    // [vendor, model, most a turn may cost, tier before (from the most)]
    ["claude", "claude-sonnet-4-6", 0.486, "text-warning"],
    ["openai", "gpt-5.4-mini", 0.1455, "text-warning"],
  ] as const)("%s %s: shows up to $%f, and tiers on the input before any turn has completed", (vendor, model, most, before) => {
    const { costEstimate, costBadgeClass } = estimate(vendor, model, []);
    expect(costEstimate.total).toBeCloseTo(most, 3);
    // The tier the maximum alone would give, which colored every draft.
    expect(costTierClassFor(costEstimate.total)).toBe(before);
    expect(costEstimate.expected).toMatchObject({ tokens: 0, basis: "none" });
    expect(costEstimate.expected!.total).toBeCloseTo(costEstimate.inputCost, 6);
    expect(costBadgeClass).toBe("text-muted-foreground");
  });

  it.each([
    // Recent turns averaged 1,500 output tokens.
    ["claude", "claude-sonnet-4-6", 0.0285, "text-success"],
    ["openai", "gpt-5.4-mini", 0.0082, "text-muted-foreground"],
  ] as const)("%s %s: tiers on the output this conversation's turns produced", (vendor, model, expectedTotal, tier) => {
    const { costEstimate, costBadgeClass } = estimate(vendor, model, [1_000, 2_000]);
    expect(costEstimate.expected).toMatchObject({ tokens: 1_500, basis: "recent-turns" });
    expect(costEstimate.expected!.total).toBeCloseTo(expectedTotal, 3);
    expect(costBadgeClass).toBe(tier);
  });
});

function costTierClassFor(total: number): string {
  const tier = costTier(total);
  return tier === "trivial" ? "text-muted-foreground" : tier === "low" ? "text-success" : tier === "medium" ? "text-warning" : "text-destructive";
}

describe("useCostEstimate — prices through the catalog, with provenance", () => {
  const atPrompt = (tokensIn: number): ChatEntry[] => [{ kind: "context_usage", tokensIn, source: "compact-estimate" }];
  const estimateFor = (vendor: string, model: string, entries: ChatEntry[], maxOutputTokens = 0) =>
    renderHook(() => useCostEstimate({ entries, draft: { text: "" }, llmVendor: vendor, llmModel: model, maxOutputTokens })).result.current.costEstimate;

  afterEach(async () => {
    await syncPricingOverrides({ getPricingOverrides: async () => [] });
  });

  it("names the catalog as the source of the rates", () => {
    expect(estimateFor("gemini", "gemini-2.5-pro", atPrompt(1_000))).toMatchObject({ pricingKnown: true, pricingSource: "model-catalog" });
  });

  it("prices a prompt past a tier boundary at the tier's rates, input and output alike", () => {
    const draftTokens = estimateOutgoingUserMessageTokens("");
    // Claude Haiku 5.5: $0.10 / $0.50 up to 100,000 prompt tokens, $0.50 / $2.50 above.
    const within = estimateFor("claude", "claude-haiku-5-5", atPrompt(100_000 - draftTokens), 10_000);
    const over = estimateFor("claude", "claude-haiku-5-5", atPrompt(100_001 - draftTokens), 10_000);
    expect(within.inputCost).toBeCloseTo(0.1 * 0.1, 9);
    expect(within.outputCost).toBeCloseTo(0.01 * 0.5, 9);
    expect(over.inputCost).toBeCloseTo((100_001 / 1_000_000) * 0.5, 9);
    expect(over.outputCost).toBeCloseTo(0.01 * 2.5, 9);
  });

  it("applies the price correction main reports, as the usage dashboard does", async () => {
    await act(async () => {
      await syncPricingOverrides({
        getPricingOverrides: async () => [{ vendor: "gemini", model: "gemini-2.5-pro", inputPer1M: 1, outputPer1M: 2 }],
      });
    });
    const corrected = estimateFor("gemini", "gemini-2.5-pro", atPrompt(1_000_000), 1_000_000);
    // Taken whole: no catalog tier lifts the corrected rates past 200K.
    expect(corrected).toMatchObject({ pricingSource: "user", inputCost: 1, outputCost: 2 });
  });

  it("prices from the route's own price report where the catalog cannot", () => {
    const { result } = renderHook(() => useCostEstimate({
      entries: atPrompt(1_000_000), draft: { text: "" }, llmVendor: "openrouter", llmModel: "lab/unlisted-reasoner", maxOutputTokens: 1_000_000,
      pricingRoute: { reported: { prompt: "0.000001", completion: "0.000002" } },
    }));
    expect(result.current.costEstimate).toMatchObject({ pricingKnown: true, pricingSource: "endpoint-report" });
    expect(result.current.costEstimate.outputCost).toBeCloseTo(2, 9);
  });

  it("says the catalog listed a zero instead of showing $0", () => {
    const listedZero = estimateFor("zai", "glm-4.7-flash", atPrompt(1_000), 1_000);
    expect(listedZero).toMatchObject({ pricingKnown: false, catalogListsZero: "zai/glm-4.7-flash" });
    expect(listedZero.pricingSource).toBeUndefined();
  });
});
