import "../../../../../test/renderer/setup.js";

import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { syncPricingOverrides, usePricingOverrides } from "../use-pricing-overrides.js";

const ROW = { vendor: "openai", model: "gpt-5.4", inputPer1M: 1, outputPer1M: 2 };

describe("usePricingOverrides", () => {
  afterEach(async () => {
    await syncPricingOverrides({ getPricingOverrides: async () => [] });
  });

  it("publishes the list main reports to every subscriber", async () => {
    const { result } = renderHook(() => usePricingOverrides());
    expect(result.current).toEqual([]);
    await act(async () => {
      await syncPricingOverrides({ getPricingOverrides: async () => [ROW] });
    });
    expect(result.current).toEqual([ROW]);
  });

  it("drops a reply that a newer request overtook", async () => {
    let releaseSlow!: (value: unknown) => void;
    const slow = syncPricingOverrides({ getPricingOverrides: () => new Promise((resolve) => { releaseSlow = resolve; }) });
    await syncPricingOverrides({ getPricingOverrides: async () => [ROW] });
    releaseSlow([{ ...ROW, inputPer1M: 9 }]);
    await slow;
    const { result } = renderHook(() => usePricingOverrides());
    expect(result.current).toEqual([ROW]);
  });

  it("refuses an answer that is not a list rather than reading it as no corrections", async () => {
    await syncPricingOverrides({ getPricingOverrides: async () => [ROW] });
    await expect(syncPricingOverrides({ getPricingOverrides: async () => ({ ok: false }) })).rejects.toThrow(/not a list/);
    const { result } = renderHook(() => usePricingOverrides());
    expect(result.current).toEqual([ROW]);
  });
});
