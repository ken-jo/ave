import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaseDenialAudit } from "../lease-denial-audit.js";

afterEach(() => vi.useRealTimers());

describe("credential refusal audit", () => {
  it("writes one immediate refusal and one bounded summary for a 60-second burst", () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const audit = new LeaseDenialAudit({ log });
    for (let i = 0; i < 100; i++) {
      audit.record("plugin-a", "hostFetch", { code: "lease-unavailable" });
    }
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      type: "plugin_hostapi_denied", input: "plugin=plugin-a method=hostFetch code=lease-unavailable count=1",
    });
    vi.advanceTimersByTime(60_000);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0].input).toContain("count=99");
    audit.record("plugin-a", "hostFetch", { code: "lease-unavailable" });
    expect(log).toHaveBeenCalledTimes(3);
  });

  it("emits only bounded fields from the closed error vocabulary", () => {
    const log = vi.fn();
    const audit = new LeaseDenialAudit({ log });
    audit.record("plugin-a", "hostFetch", {
      code: "credential-conflict",
      detail: { header: "authorization", secret: "never-log-this" },
    });
    expect(log.mock.calls[0]?.[0].input).toBe(
      "plugin=plugin-a method=hostFetch code=credential-conflict count=1 header=authorization",
    );
    audit.record("plugin-a", "hostFetch", {
      code: "lease-audience-denied",
      detail: { origin: "https://api.example.test", hop: 1, secret: "never-log-this" },
    });
    expect(log.mock.calls[1]?.[0].input).toBe(
      "plugin=plugin-a method=hostFetch code=lease-audience-denied count=1 origin=https://api.example.test hop=1",
    );
  });
});
