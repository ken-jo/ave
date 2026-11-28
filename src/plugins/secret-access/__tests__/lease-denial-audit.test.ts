import { collectPermissionEvents } from "../../../__tests__/support/permission-events.js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { LeaseDenialAudit } from "../lease-denial-audit.js";

afterEach(() => vi.useRealTimers());

describe("credential refusal audit", () => {
  it("writes one immediate refusal and one bounded summary for a 60-second burst", () => {
    vi.useFakeTimers();
    const logs = collectPermissionEvents();
    onTestFinished(logs.restore);
    const audit = new LeaseDenialAudit();
    for (let i = 0; i < 100; i++) {
      audit.record("plugin-a", "hostFetch", { code: "lease-unavailable" });
    }
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      event: "plugin_secret_lease_denied", pluginId: "plugin-a", method: "hostFetch", code: "lease-unavailable", count: 1,
    });
    vi.advanceTimersByTime(60_000);
    expect(logs.events).toHaveLength(2);
    expect(logs.events[1]?.count).toBe(99);
    audit.record("plugin-a", "hostFetch", { code: "lease-unavailable" });
    expect(logs.events).toHaveLength(3);
  });

  it("emits only bounded fields from the closed error vocabulary", () => {
    const logs = collectPermissionEvents();
    onTestFinished(logs.restore);
    const audit = new LeaseDenialAudit();
    audit.record("plugin-a", "hostFetch", {
      code: "credential-conflict",
      detail: { header: "authorization", secret: "never-log-this" },
    });
    expect(logs.events[0]).toMatchObject({ code: "credential-conflict", count: 1, header: "authorization" });
    audit.record("plugin-a", "hostFetch", {
      code: "lease-audience-denied",
      detail: { origin: "https://api.example.test", hop: 1, secret: "never-log-this" },
    });
    expect(logs.events[1]).toMatchObject({ code: "lease-audience-denied", count: 1, hop: 1 });
    expect(JSON.stringify(logs.events)).not.toContain("never-log-this");
    expect(JSON.stringify(logs.events)).not.toContain("https://api.example.test");
  });
});
