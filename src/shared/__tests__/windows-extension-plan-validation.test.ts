import { describe, expect, it } from "vitest";
import { assertSandboxWindowsExtensionPlan, egressProtocolCoverageFor } from "../sandbox-capability-info.js";
import { planWindowsExtensionHolder } from "../../permissions/mxc-extension-readiness.js";

function ready() {
  return planWindowsExtensionHolder({ requested: true, mxc: { state: "available" },
    fallback: { version: "0.0.80", ready: true } });
}

describe("serialized extension backend plan", () => {
  it("reports the selected MXC extension route's protocol limits", () => {
    const plan = ready();
    expect(plan).toMatchObject({
      selectedBackend: "mxc", readiness: "ready",
      egressProtocolCoverage: { dns: "host-resolver", rawIp: "unknown" },
    });
  });

  it("reports unknown protocol coverage for the fallback route", () => {
    const fallback = planWindowsExtensionHolder({
      requested: true, mxc: { state: "unavailable", reason: "native-validation-required" },
      fallback: { version: "0.0.80", ready: true },
    });
    expect(fallback.selectedBackend).toBe("srt-win");
    expect(fallback.egressProtocolCoverage).toEqual({ dns: "unknown", rawIp: "unknown" });
  });

  it("accepts every produced state and fallback reason", () => {
    const input = { requested: true, fallback: { version: "0.0.80", ready: true } };
    for (const plan of [
      ready(),
      planWindowsExtensionHolder({ ...input, requested: false, mxc: { state: "available" } }),
      planWindowsExtensionHolder({ ...input, mxc: { state: "checking" } }),
      planWindowsExtensionHolder({ ...input, mxc: { state: "unavailable", reason: "native-validation-required" } }),
      planWindowsExtensionHolder({ ...input, mxc: { state: "unavailable", reason: "readiness-deadline" } }),
      planWindowsExtensionHolder({ ...input, fallback: { version: "0.0.80", ready: false }, mxc: { state: "unavailable", reason: "readiness-deadline" } }),
      planWindowsExtensionHolder({ ...input, fallback: { version: "0.0.80", ready: false }, mxc: { state: "unavailable", reason: "runtime-start-failed" } }),
      planWindowsExtensionHolder({ ...input, admittedAncestorBackend: "srt-win", mxc: { state: "unavailable", reason: "runtime-start-failed" } }),
    ]) expect(() => assertSandboxWindowsExtensionPlan(JSON.parse(JSON.stringify(plan)))).not.toThrow();
  });

  it("requires every declared field and rejects unknown fields", () => {
    for (const key of Object.keys(ready())) {
      const missing: Record<string, unknown> = { ...ready() };
      delete missing[key];
      expect(() => assertSandboxWindowsExtensionPlan(missing), key).toThrow(/Invalid Windows/);
    }
    expect(() => assertSandboxWindowsExtensionPlan({ ...ready(), active: true })).toThrow(/Invalid Windows/);
  });

  it.each([
    ["requestedBackend", "none"], ["selectedBackend", "none"], ["readiness", "fallback"],
    ["reason", "checking"], ["fallbackVersion", "0.0.80"], ["fallbackVersion", "0.0.81"],
    ["uiPolicy", "ui-disabled"], ["egressIdentity", "shared"], ["proxyOwnerVerified", true],
    ["hostLoopback", "closed"], ["inboundProtection", "container"],
    ["ancestorAccess", "file-read"], ["ancestorNameExposure", false],
  ])("rejects an impossible %s=%s claim", (key, value) => {
    expect(() => assertSandboxWindowsExtensionPlan({ ...ready(), [key]: value })).toThrow(/Invalid Windows/);
  });

  it("rejects protocol overclaims and unexpected coverage fields", () => {
    for (const egressProtocolCoverage of [
      { dns: "brokered", rawIp: "unknown" },
      { dns: "host-resolver", rawIp: "blocked" },
      { dns: "host-resolver", rawIp: "unknown", extra: true },
      { dns: "host-resolver" },
    ]) {
      expect(() => assertSandboxWindowsExtensionPlan({ ...ready(), egressProtocolCoverage })).toThrow(/Invalid Windows/);
    }
  });

  it("accepts an expired deadline as a start with no backend, never as a rejection", () => {
    const none = { ...ready(), selectedBackend: "none", reason: "readiness-deadline", egressIdentity: "shared", egressProtocolCoverage: egressProtocolCoverageFor("none") };
    expect(() => assertSandboxWindowsExtensionPlan({ ...none, readiness: "unavailable" })).not.toThrow();
    expect(() => assertSandboxWindowsExtensionPlan({ ...none, readiness: "rejected" })).toThrow(/Invalid Windows/);
    expect(planWindowsExtensionHolder({ requested: true, fallback: { version: "0.0.80", ready: false }, mxc: { state: "unavailable", reason: "readiness-deadline" } }))
      .toMatchObject({ selectedBackend: "none", readiness: "unavailable", reason: "readiness-deadline" });
  });
});
