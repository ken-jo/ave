import { describe, expect, it } from "vitest";
import { SubscriptionPlanUsageStore } from "../subscription-plan-usage-store.js";
import { normalizePlanUsageWindow } from "../../shared/subscription-plan-usage.js";

const START = 1_900_000_000_000;
const RESET = START + 3_600_000;

describe("subscription quota samples", () => {
  it("projects only after two increasing reports in the same reset window", () => {
    const store = new SubscriptionPlanUsageStore();
    store.update("codex", [{ id: "codex:primary", usedPercent: 20, resetsAt: RESET }], START);
    expect(store.get("codex", START)?.windows[0]?.projectedLimitAt).toBeUndefined();
    store.update("codex", [{ id: "codex:primary", usedPercent: 40, resetsAt: RESET }], START + 600_000);
    expect(store.get("codex", START + 600_000)?.windows[0]?.projectedLimitAt).toBe(START + 2_400_000);
    expect(store.get("codex", RESET)).toBeUndefined();
  });

  it("suppresses predictions for safe pace, counter decreases, changed resets and absent gauges", () => {
    for (const next of [
      { usedPercent: 21, resetsAt: RESET },
      { usedPercent: 10, resetsAt: RESET },
      { usedPercent: 40, resetsAt: RESET + 1_000 },
      { resetsAt: RESET },
      { usedPercent: 40 },
      { usedPercent: 100, resetsAt: RESET },
    ]) {
      const store = new SubscriptionPlanUsageStore();
      store.update("claude-code", [{ id: "five_hour", usedPercent: 20, resetsAt: RESET }], START);
      store.update("claude-code", [{ id: "five_hour", ...next }], START + 600_000);
      expect(store.get("claude-code", START + 600_000)?.windows[0]?.projectedLimitAt).toBeUndefined();
    }
  });

  it("keeps each window's independent observation time and replaces missing percentages", () => {
    const store = new SubscriptionPlanUsageStore();
    store.update("claude-code", [{ id: "five_hour", usedPercent: 20, resetsAt: RESET }], START);
    store.update("claude-code", [{ id: "seven_day", usedPercent: 1, resetsAt: RESET }], START + 300_000);
    store.update("claude-code", [{ id: "five_hour", usedPercent: 40, resetsAt: RESET }], START + 600_000);
    expect(store.get("claude-code", START + 600_000)?.windows.find((row) => row.id === "five_hour")?.projectedLimitAt)
      .toBe(START + 2_400_000);
    store.update("claude-code", [{ id: "five_hour", resetsAt: RESET }], START + 700_000);
    expect(store.get("claude-code", START + 700_000)?.windows.find((row) => row.id === "five_hour"))
      .not.toHaveProperty("usedPercent");
  });

  it("isolates accounts, ignores duplicate or older samples and clears on authentication change", () => {
    const store = new SubscriptionPlanUsageStore();
    const rows = [{ id: "primary", usedPercent: 0, resetsAt: RESET }];
    expect(store.update("codex", rows, START)).toBe(true);
    expect(store.update("codex", rows, START + 100)).toBe(false);
    expect(store.update("codex", [{ id: "primary", usedPercent: 90, resetsAt: RESET }], START - 100)).toBe(false);
    expect(store.get("kimi-code", START)).toBeUndefined();
    expect(store.get("codex", START)?.windows[0]?.usedPercent).toBe(0);
    store.clear("codex");
    expect(store.get("codex", START)).toBeUndefined();
  });

  it("rejects malformed gauges and copies only the safe projection", () => {
    for (const usedPercent of [NaN, Infinity, -1, 101, "0", null]) {
      expect(normalizePlanUsageWindow({ id: "primary", usedPercent })).toBeUndefined();
    }
    expect(normalizePlanUsageWindow({ id: "private account name", usedPercent: 10 })).toBeUndefined();
    expect(normalizePlanUsageWindow({ id: "primary" })).toBeUndefined();
    expect(normalizePlanUsageWindow({ id: "primary", usedPercent: 10, accessToken: "secret" }))
      .toEqual({ id: "primary", usedPercent: 10 });
  });

  it("retains ordering after unchanged reports and does not expose mutable stored rows", () => {
    const store = new SubscriptionPlanUsageStore();
    store.update("codex", [{ id: "primary", usedPercent: 20, resetsAt: RESET }], START);
    store.update("codex", [{ id: "primary", usedPercent: 40, resetsAt: RESET }], START + 600_000);
    expect(store.get("codex", START)?.windows[0]?.projectedLimitAt).toBeDefined();
    store.update("codex", [{ id: "primary", usedPercent: 40, resetsAt: RESET }], START + 700_000);
    expect(store.get("codex", START)?.windows[0]?.projectedLimitAt).toBeUndefined();
    expect(store.update("codex", [], START + 650_000)).toBe(false);
    expect(store.update("codex", [{ id: "primary", usedPercent: 90, resetsAt: RESET }], START + 650_000)).toBe(false);
    const row = store.get("codex", START)?.windows[0] as { usedPercent: number };
    row.usedPercent = 99;
    expect(store.get("codex", START)?.windows[0]?.usedPercent).toBe(40);
    expect(store.update("codex", [], START + 800_000)).toBe(true);
    expect(store.get("codex", START)).toBeUndefined();
  });
});
