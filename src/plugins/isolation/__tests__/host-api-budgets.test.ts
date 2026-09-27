import { afterEach, describe, expect, it, vi } from "vitest";
import { HostApiBudgets, type HostApiBudgetAudit } from "../host-api-budgets.js";

afterEach(() => vi.useRealTimers());

describe("dispatcher token buckets", () => {
  it("enforces separate method bursts and refills at their sustained rates", () => {
    let now = 0;
    const budgets = new HostApiBudgets("sample", () => {}, () => now);
    for (let index = 0; index < 200; index += 1) expect(budgets.take("getSecret")).toBe(0);
    expect(budgets.take("getSecret")).toBe(20);
    expect(budgets.take("storage.read")).toBe(0);
    for (let index = 0; index < 60; index += 1) expect(budgets.take("hostFetch")).toBe(0);
    expect(budgets.take("hostFetch")).toBe(50);
    for (let index = 0; index < 30; index += 1) expect(budgets.take("resolveApiKey")).toBe(0);
    expect(budgets.take("resolveApiKey")).toBe(100);
    now += 100;
    expect(budgets.take("getSecret")).toBe(0);
    expect(budgets.take("hostFetch")).toBe(0);
    expect(budgets.take("resolveApiKey")).toBe(0);
    budgets.end();
  });

  it.each([
    ["getSecret", 200, 20],
    ["hostFetch", 60, 50],
    ["resolveApiKey", 30, 100],
  ] as const)("reports the exact final millisecond before %s refills", (method, burst, refillMs) => {
    let now = 0;
    const budgets = new HostApiBudgets("sample", () => {}, () => now);
    for (let index = 0; index < burst; index += 1) expect(budgets.take(method)).toBe(0);
    now = refillMs - 1;
    expect(budgets.take(method)).toBe(1);
    now = refillMs;
    expect(budgets.take(method)).toBe(0);
    budgets.end();
  });

  it("shares the log budget across context.log and logEvent, and keeps emitEvent separate", () => {
    const budgets = new HostApiBudgets("sample", () => {}, () => 0);
    for (let index = 0; index < 499; index += 1) expect(budgets.take("notifications/ave/log")).toBe(0);
    expect(budgets.take("logEvent")).toBe(0);
    expect(budgets.take("notifications/ave/log")).toBe(10);
    expect(budgets.take("emitEvent")).toBe(0);
    budgets.end();
  });

  it("keeps the configured indexer batch cadence inside both lease request buckets", () => {
    let now = 0;
    const budgets = new HostApiBudgets("sample", () => {}, () => now);
    // 400 first attempts per minute for two minutes, one resolve and fetch per
    // batch. Retries and concurrent query traffic need separate acceptance data.
    for (let index = 0; index < 800; index += 1) {
      now = index * 150;
      expect(budgets.take("resolveApiKey"), `resolve batch ${index}`).toBe(0);
      expect(budgets.take("hostFetch"), `fetch batch ${index}`).toBe(0);
    }
    budgets.end();
  });
});

describe("bounded denial diagnostics", () => {
  it("writes the first refusal and one aggregate per minute without caller input", async () => {
    vi.useFakeTimers();
    const entries: HostApiBudgetAudit[] = [];
    const budgets = new HostApiBudgets("sample", (entry) => entries.push(entry));
    for (let index = 0; index < 1000; index += 1) {
      budgets.deny("hostFetch", "rate-limited", "hostFetch");
    }
    expect(entries).toEqual([{
      type: "plugin_rate_limited", pluginId: "sample", method: "hostFetch",
      code: "rate-limited", bucket: "hostFetch", count: 1, summary: false,
    }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(entries[1]).toMatchObject({ count: 999, summary: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(entries).toHaveLength(2);
    budgets.end();
  });
});
