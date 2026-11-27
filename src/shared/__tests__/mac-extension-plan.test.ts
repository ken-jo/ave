import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSandboxMacExtensionPlan, isMacExtensionPlan, type SandboxMacExtensionPlan } from "../sandbox-capability-info.js";
import * as capability from "../../permissions/sandbox-capability.js";

const off: SandboxMacExtensionPlan = { platform: "darwin", requestedBackend: "none", selectedBackend: "none", readiness: "off", reason: "not-requested", egressIdentity: "shared" };
const ready: SandboxMacExtensionPlan = { platform: "darwin", requestedBackend: "mxc", selectedBackend: "mxc", readiness: "ready", reason: "ready", egressIdentity: "shared" };

afterEach(() => {
  capability.__resetMacExtensionPlanForTest();
  vi.unstubAllGlobals();
});

describe("one extension plan on every platform", () => {
  it("accepts each macOS state with its own reason and refuses contradictions", () => {
    for (const plan of [off, ready, { ...ready, selectedBackend: "none", readiness: "checking", reason: "checking" },
      ...(["sweep-unproven", "watcher-unavailable", "integrity", "binary-missing", "holder-start-failed"] as const)
        .map(reason => ({ ...ready, selectedBackend: "none", readiness: "unavailable", reason }))]) {
      expect(() => assertSandboxMacExtensionPlan(plan)).not.toThrow();
    }
    for (const plan of [
      { ...off, reason: "ready" }, { ...ready, selectedBackend: "none" }, { ...ready, readiness: "fallback" },
      { ...ready, egressIdentity: "kernel-channel" }, { ...ready, readiness: "unavailable", selectedBackend: "none", reason: "ready" },
      { ...ready, uiPolicy: "ui-enabled" }, { ...ready, platform: "win32" },
    ]) {
      expect(() => assertSandboxMacExtensionPlan(plan)).toThrow("Invalid macOS extension backend plan");
    }
  });

  it("tells the macOS arm from the Windows arm, which keeps its exact shape", () => {
    expect(isMacExtensionPlan(ready)).toBe(true);
    expect(isMacExtensionPlan(undefined)).toBe(false);
    expect(isMacExtensionPlan({ requestedBackend: "none", selectedBackend: "none", readiness: "off" } as never)).toBe(false);
  });

  it("publishes the macOS plan on darwin only, interning identical content", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      capability.setMacExtensionPlan(off);
      const first = capability.getExtensionBackendPlan();
      expect(first).toEqual(off);
      const generation = capability.getSandboxGeneration();
      capability.setMacExtensionPlan({ ...off });
      expect(capability.getExtensionBackendPlan()).toBe(first);
      expect(capability.getSandboxGeneration()).toBe(generation);
      capability.setMacExtensionPlan(ready);
      expect(capability.getExtensionBackendPlan()).toEqual(ready);
      expect(capability.getSandboxGeneration()).not.toBe(generation);
      expect(() => capability.setMacExtensionPlan({ ...ready, reason: "checking" })).toThrow();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("has no Windows-named plan reader left", () => {
    expect(Object.keys(capability)).not.toContain("getWindowsExtensionBackendPlan");
    const source = readFileSync(new URL("../../boot/steps/sandbox-init.ts", import.meta.url), "utf8");
    expect(source).toContain('readiness: "off", reason: "not-requested"');
  });
});
