import { describe, expect, it } from "vitest";
import { normalizeTelemetry } from "../../data/settings-normalization.js";
import { telemetryEndpointHosts, telemetryLevel, telemetryLevelFlags, telemetryPatchError, validateTelemetryEndpoint } from "../telemetry-policy.js";

describe("telemetry consent levels", () => {
  it.each(["off", "crash", "error", "all"] as const)("keeps explicit %s authoritative over legacy flags", (level) => {
    const normalized = normalizeTelemetry({ level, enabled: true, crashReportingEnabled: true });
    expect(normalized.level).toBe(level);
    expect(normalized).toMatchObject(telemetryLevelFlags(level));
  });
  it("migrates legacy consent without enabling an entirely disabled profile", () => {
    expect(normalizeTelemetry({ enabled: false, crashReportingEnabled: false }).level).toBe("off");
    expect(normalizeTelemetry({ enabled: false, crashReportingEnabled: true }).level).toBe("crash");
    expect(telemetryLevel({ enabled: true })).toBe("all");
  });
  it("preserves an explicit legacy crash opt-out across load and reload", () => {
    const migrated = normalizeTelemetry({ enabled: true, crashReportingEnabled: false });
    expect(migrated.level).toBe("all");
    expect(migrated.crashReportingEnabled).toBe(false);
    expect(normalizeTelemetry(migrated).crashReportingEnabled).toBe(false);
  });
  it("drops retired reporting configuration while retaining the consent level", () => {
    expect(normalizeTelemetry({ level: "off", sentryDsn: "https://retired.example/1" })).not.toHaveProperty("sentryDsn");
  });
  it("rejects a malformed cross-boundary level", () => {
    expect(telemetryPatchError({ level: "yes" }, { isPackaged: true })).toBe("invalid-telemetry-level");
  });
});

describe("reporting endpoint save policy", () => {
  const opts = { isPackaged: true, allowlistEnv: "reports.example" };
  it.each(["http://reports.example/report", "https://other.example/report", "https://user:secret@reports.example/report", "https://reports.example/report#secret"])("rejects an unauthorized endpoint %s before save", (endpoint) => {
    expect(telemetryPatchError({ endpoint }, opts)).toBe("invalid-telemetry-endpoint");
    expect(telemetryPatchError({ crashReportEndpoint: endpoint }, opts)).toBe("invalid-telemetry-endpoint");
  });
  it("accepts an allowed HTTPS endpoint and an explicit clearing", () => {
    expect(telemetryPatchError({ endpoint: "https://reports.example/report" }, opts)).toBeUndefined();
    expect(telemetryPatchError({ crashReportEndpoint: "" }, opts)).toBeUndefined();
  });
  it("never displays the packaged loopback host as allowed", () => {
    expect(telemetryEndpointHosts(undefined, true)).toEqual([]);
    expect(telemetryEndpointHosts(undefined, false)).toEqual(["localhost"]);
    for (const host of telemetryEndpointHosts("localhost,reports.example", true)) {
      expect(validateTelemetryEndpoint(`https://${host}/reports`, opts).valid).toBe(true);
    }
  });
});
