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
});
