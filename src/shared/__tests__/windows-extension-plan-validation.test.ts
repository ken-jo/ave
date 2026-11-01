import { describe, expect, it } from "vitest";
import { assertSandboxWindowsExtensionPlan } from "../sandbox-capability-info.js";
import { planWindowsExtensionHolder } from "../../permissions/mxc-extension-readiness.js";

function ready() {
  return planWindowsExtensionHolder({ requested: true, mxc: { state: "available" },
    fallback: { version: "0.0.80", ready: true } });
}

describe("serialized extension backend plan", () => {
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
    ["hostLoopback", "closed"], ["inboundProtection", "container"], ["dnsProtection", "confined"],
    ["ancestorAccess", "file-read"], ["ancestorNameExposure", false],
  ])("rejects an impossible %s=%s claim", (key, value) => {
    expect(() => assertSandboxWindowsExtensionPlan({ ...ready(), [key]: value })).toThrow(/Invalid Windows/);
  });

  it("does not accept a rejected deadline as settled degradation", () => {
    expect(() => assertSandboxWindowsExtensionPlan({ ...ready(), selectedBackend: "none", readiness: "unavailable", reason: "readiness-deadline", egressIdentity: "shared" })).toThrow(/Invalid Windows/);
  });
});
