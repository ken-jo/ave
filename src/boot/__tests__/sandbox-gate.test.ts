/** Explicit sandbox activation fails closed; settings-based activation may degrade. */
import { describe, expect, it } from "vitest";
import {
  decideSandboxGate,
  shouldWarnHostClassifyInterlock,
} from "../steps/sandbox-gate.js";

describe("decideSandboxGate", () => {
  it("skips when neither the setting nor the env opt-in is on", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(
        decideSandboxGate({ settingOn: false, explicitEnv: false, platform, depsOk: true }),
      ).toEqual({ action: "skip", reason: "gate-off" });
    }
  });

  it("activates when opted in (default OR explicit) and deps are present", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(
        decideSandboxGate({ settingOn: true, explicitEnv: false, platform, depsOk: true }),
      ).toEqual({ action: "activate", reason: "deps-present" });
      expect(
        decideSandboxGate({ settingOn: false, explicitEnv: true, platform, depsOk: true }),
      ).toEqual({ action: "activate", reason: "deps-present" });
    }
  });

  it("DEGRADES (non-bricking) on the DEFAULT/settings-on path when mac/linux deps are missing", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const decision = decideSandboxGate({
        settingOn: true,
        explicitEnv: false,
        platform,
        depsOk: false,
      });
      expect(decision).toEqual({
        action: "degrade",
        reason: "degrade-default-cannot-activate",
      });
    }
  });

  it("ABORTS (fail-closed) on the EXPLICIT env opt-in when mac/linux deps are missing", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const decision = decideSandboxGate({
        settingOn: false,
        explicitEnv: true,
        platform,
        depsOk: false,
      });
      expect(decision).toEqual({
        action: "abort",
        reason: "abort-explicit-cannot-activate",
      });
    }
  });

  it("EXPLICIT wins over the default: env opt-in still aborts even when the setting is also on", () => {
    expect(
      decideSandboxGate({ settingOn: true, explicitEnv: true, platform: "linux", depsOk: false }),
    ).toEqual({ action: "abort", reason: "abort-explicit-cannot-activate" });
  });

  it("Windows deps-missing always DEGRADES (non-bricking) — even for the explicit env opt-in", () => {
    // Windows must reach the consent UI before sandbox setup; aborting would block first run.
    expect(
      decideSandboxGate({ settingOn: true, explicitEnv: false, platform: "win32", depsOk: false }),
    ).toEqual({ action: "degrade", reason: "degrade-windows-not-installed" });
    expect(
      decideSandboxGate({ settingOn: false, explicitEnv: true, platform: "win32", depsOk: false }),
    ).toEqual({ action: "degrade", reason: "degrade-windows-not-installed" });
  });
});

describe("shouldWarnHostClassifyInterlock", () => {
  it("fires only when hostClassifiesRisk is ON and the sandbox is NOT active", () => {
    expect(
      shouldWarnHostClassifyInterlock({ hostClassifiesRisk: true, sandboxActive: false }),
    ).toBe(true);
    expect(
      shouldWarnHostClassifyInterlock({ hostClassifiesRisk: true, sandboxActive: true }),
    ).toBe(false);
    expect(
      shouldWarnHostClassifyInterlock({ hostClassifiesRisk: false, sandboxActive: false }),
    ).toBe(false);
    expect(
      shouldWarnHostClassifyInterlock({ hostClassifiesRisk: false, sandboxActive: true }),
    ).toBe(false);
  });

  it("fires in the DEGRADED state (gate ON by default + sandbox could not activate)", () => {
    // A degraded sandbox must still trigger the host-classification warning.
    const decision = decideSandboxGate({
      settingOn: true,
      explicitEnv: false,
      platform: "linux",
      depsOk: false,
    });
    expect(decision.action).toBe("degrade");
    const sandboxActive = decision.action === "activate";
    expect(
      shouldWarnHostClassifyInterlock({ hostClassifiesRisk: true, sandboxActive }),
    ).toBe(true);
  });
});
