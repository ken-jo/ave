import { describe, expect, it } from "vitest";
import {
  HOST_SHELL_EXECUTION_PLAN_VERSION,
  buildHostShellExecutionPlan,
  exactRulePassesUnsandboxedShellAsk,
  getHostShellExecutionPlanAuditProjection,
  getHostShellExecutionPlanCacheIdentity,
  isIssuedHostShellExecutionPlanAuditProjection,
  requiresExplicitHostShellApproval,
  isHomePrivacyHelperUnavailablePlan,
  requiresUnsandboxedShellAsk,
} from "../host-shell-execution-plan.js";

const FULL_ASRT = {
  kind: "asrt" as const,
  confidence: "verified" as const,
  platform: "darwin" as const,
  reason: "full ASRT",
  confines: { filesystem: true, process: true, network: true },
};

const WINDOWS_PARTIAL_ASRT = {
  kind: "asrt" as const,
  confidence: "verified" as const,
  platform: "win32" as const,
  reason: "srt-win partial",
  confines: { filesystem: true, process: false, network: true },
};

const NONE = {
  kind: "none" as const,
  confidence: "verified" as const,
  platform: "win32" as const,
  reason: "inactive",
  confines: { filesystem: false, process: false, network: false },
};

describe("host shell execution plan", () => {
  it("reports the protocol limits of the selected MXC route", () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: { ...FULL_ASRT, platform: "win32" },
      shellSubstrate: "mxc",
    });
    expect(plan).toMatchObject({
      mode: "asrt", substrate: "mxc", requiresExplicitUserApproval: false,
      egressProtocolCoverage: { dns: "host-resolver", rawIp: "unknown" },
    });
  });

  it.each(["darwin", "linux"] as const)("reports the actual %s route in the existing plan and projection", (platform) => {
    for (const requestedSandbox of [false, true]) {
      for (const executionMode of ["default", "host"] as const) {
        const plan = buildHostShellExecutionPlan({ platform, requestedSandbox, executionMode, activeCapability: { ...FULL_ASRT, platform } });
        const sandboxed = requestedSandbox && executionMode === "default";
        expect(plan.sandboxed).toBe(sandboxed);
        expect(plan.mode === "asrt").toBe(sandboxed);
        expect(plan.egressProtocolCoverage).toEqual({ dns: "unknown", rawIp: "unknown" });
        expect(getHostShellExecutionPlanAuditProjection(plan).sandboxed).toBe(sandboxed);
      }
    }
  });

  it.each(["assumed", "policy-best-effort"] as const)("never reports %s capability as a sandboxed command", (confidence) => {
    const plan = buildHostShellExecutionPlan({ platform: "linux", requestedSandbox: true, activeCapability: { ...FULL_ASRT, platform: "linux", confidence } });
    expect(plan.sandboxed).toBe(false);
    expect(plan.fallbackReason).toBe("active-sandbox-not-shell-contained");
  });

  it("distinguishes unsupported platforms from a disabled setting", () => {
    const plan = buildHostShellExecutionPlan({ platform: "freebsd", requestedSandbox: false, activeCapability: { ...NONE, platform: "freebsd" } });
    expect(plan.sandboxed).toBe(false);
    expect(plan.fallbackReason).toBe("platform-unsupported");
  });

  it("requires evidence for every confinement dimension", () => {
    for (const confines of [undefined,
      { filesystem: false, process: true, network: true },
      { filesystem: true, process: false, network: true },
      { filesystem: true, process: true, network: false }]) {
      const plan = buildHostShellExecutionPlan({ platform: "linux", requestedSandbox: true,
        activeCapability: { ...FULL_ASRT, platform: "linux", confines } });
      expect(plan.sandboxed).toBe(false);
      expect(plan.mode).toBe("plain");
      expect(requiresUnsandboxedShellAsk(plan)).toBe(true);
    }
  });

  it("reports the unconfined route for incomplete Windows shell containment", () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: WINDOWS_PARTIAL_ASRT,
    });

    expect(plan).toMatchObject({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      requestedSandbox: true,
      mode: "plain",
      fallbackReason: "active-sandbox-not-shell-contained",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    expect(plan.identity).toContain("active-sandbox-not-shell-contained");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.capability)).toBe(true);
  });

  it("puts both Windows host routes under the floor, with the exact-rule pass based on boot home privacy", () => {
    const plan = buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: WINDOWS_PARTIAL_ASRT,
      unavailableCauses: ["missing-bwrap"] });
    expect(plan).toEqual({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      platform: "win32",
      requestedSandbox: true,
      executionRequest: "default",
      mode: "plain",
      sandboxed: false,
      substrate: "none",
      egressProtocolCoverage: { dns: "unknown", rawIp: "unknown" },
      capability: {
        kind: "none", confidence: "verified", platform: "win32",
        reason: "The active OS sandbox does not prove containment for this shell.",
        confines: { filesystem: false, process: false, network: false },
      },
      fallbackReason: "active-sandbox-not-shell-contained",
      requiresExplicitUserApproval: true,
      identity: "host-shell-execution-plan/v4:win32:active-sandbox-not-shell-contained:ask",
    });
    expect(requiresUnsandboxedShellAsk(plan)).toBe(true);
    const host = buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: WINDOWS_PARTIAL_ASRT, executionMode: "host" });
    expect(host.identity).toBe("host-shell-execution-plan/v4:win32:explicit-host:ask");
    for (const homePrivacyVerified of [true, false]) {
      for (const executionMode of ["default", "host"] as const) {
        const built = buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: WINDOWS_PARTIAL_ASRT, executionMode, homePrivacyVerified });
        expect(requiresUnsandboxedShellAsk(built)).toBe(true);
        expect(exactRulePassesUnsandboxedShellAsk(built)).toBe(homePrivacyVerified);
      }
    }
    // A contained shell route is not floored when its explicit host request is: the request leaves a ready backend.
    const ready = buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: { ...WINDOWS_PARTIAL_ASRT, confines: { filesystem: true, process: true, network: true } }, shellSubstrate: "mxc", executionMode: "host" });
    expect(requiresUnsandboxedShellAsk(ready)).toBe(false);
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "puts requested-on but unavailable %s under the forced ask, distinct from explicit sandbox-off",
    (platform) => {
      const requested = buildHostShellExecutionPlan({
        platform,
        requestedSandbox: true,
        activeCapability: { ...NONE, platform },
      });
      const off = buildHostShellExecutionPlan({
        platform,
        requestedSandbox: false,
        activeCapability: { ...NONE, platform },
      });

      expect(requested).toMatchObject({
        requestedSandbox: true,
        mode: "plain",
        sandboxed: false,
        fallbackReason: "requested-sandbox-unavailable",
        requiresExplicitUserApproval: true,
        identity: `host-shell-execution-plan/v4:${platform}:requested-sandbox-unavailable:ask`,
        capability: {
          kind: "none",
          confines: { filesystem: false, process: false, network: false },
        },
      });
      // No boundary failure is needed: the unavailable route itself is the floor.
      expect(requiresUnsandboxedShellAsk(requested)).toBe(true);
      expect(requiresExplicitHostShellApproval(requested)).toBe(true);
      expect(requested).not.toHaveProperty("installHints");
      expect(requested).toEqual(buildHostShellExecutionPlan({ platform, requestedSandbox: true, activeCapability: { ...NONE, platform },
        unavailableSandboxRequiresAsk: true }));
      expect(requested.identity).not.toBe(off.identity);
      expect(off).toMatchObject({
        requestedSandbox: false,
        mode: "plain",
        fallbackReason: "disabled-by-setting",
        requiresExplicitUserApproval: false,
      });
      expect(requiresUnsandboxedShellAsk(off)).toBe(false);
      expect(requiresExplicitHostShellApproval(off)).toBe(false);
    },
  );

  it("distinguishes a missing backend from sandbox-off and ready backends for host requests", () => {
    const host = (requestedSandbox: boolean, activeCapability: Parameters<typeof buildHostShellExecutionPlan>[0]["activeCapability"]) =>
      buildHostShellExecutionPlan({ platform: "linux", requestedSandbox, executionMode: "host", activeCapability });
    const unavailable = host(true, { ...NONE, platform: "linux" });
    expect(unavailable.identity).toBe("host-shell-execution-plan/v4:linux:explicit-host:ask");
    expect(requiresUnsandboxedShellAsk(unavailable)).toBe(true);
    // Sandbox off by the person's choice, or a ready backend: the explicit request keeps its ordinary handling.
    for (const plan of [host(false, { ...NONE, platform: "linux" }), host(true, { ...FULL_ASRT, platform: "linux" })]) {
      expect(plan.identity).toBe("host-shell-execution-plan/v4:linux:explicit-host");
      expect(requiresUnsandboxedShellAsk(plan)).toBe(false);
    }
  });

  it.each([
    ["linux", "asrt"],
    ["win32", "partial"],
  ] as const)("puts an explicit host request under the floor with an uncontained %s %s backend", (platform, kind) => {
    const plan = buildHostShellExecutionPlan({
      platform,
      requestedSandbox: true,
      executionMode: "host",
      activeCapability: { ...WINDOWS_PARTIAL_ASRT, platform, kind },
      homePrivacyVerified: true,
    });
    expect(plan.mode).toBe("plain");
    expect(requiresUnsandboxedShellAsk(plan)).toBe(true);
    expect(exactRulePassesUnsandboxedShellAsk(plan)).toBe(true);
  });
  it.each(["default", "host"] as const)("marks the %s no-backend plan for the exact-rule pass only with verified boot home privacy", (executionMode) => {
    const build = (extra: Partial<Parameters<typeof buildHostShellExecutionPlan>[0]>) => buildHostShellExecutionPlan({
      platform: "linux", requestedSandbox: true, activeCapability: { ...NONE, platform: "linux" }, executionMode, ...extra });
    const route = executionMode === "host" ? "explicit-host" : "requested-sandbox-unavailable";
    const verified = build({ homePrivacyVerified: true });
    expect(verified.identity).toBe(`host-shell-execution-plan/v4:linux:${route}:home-verified:ask`);
    expect(requiresUnsandboxedShellAsk(verified)).toBe(true);
    expect(exactRulePassesUnsandboxedShellAsk(verified)).toBe(true);
    // No published result, a failed one, and a failed one that also claims verification all leave the boot floor governing.
    for (const plan of [build({}), build({ unavailableSandboxRequiresAsk: true }), build({ unavailableSandboxRequiresAsk: true, homePrivacyVerified: true })]) {
      expect(plan.identity).toBe(`host-shell-execution-plan/v4:linux:${route}:ask`);
      expect(requiresUnsandboxedShellAsk(plan)).toBe(true);
      expect(exactRulePassesUnsandboxedShellAsk(plan)).toBe(false);
    }
    // A ready backend, the sandbox turned off, the helper-unavailable block and a boot-floor plan with the shell scope off are never marked.
    for (const plan of [
      build({ activeCapability: { ...FULL_ASRT, platform: "linux" }, homePrivacyVerified: true }),
      build({ requestedSandbox: false, homePrivacyVerified: true }),
      build({ requestedSandbox: false, unavailableSandboxRequiresAsk: true, homePrivacyVerified: true }),
      build({ unconfinedShellDenied: true, homePrivacyVerified: true }),
    ]) {
      expect(plan.identity).not.toContain(":home-verified");
      expect(exactRulePassesUnsandboxedShellAsk(plan)).toBe(false);
    }
    expect(exactRulePassesUnsandboxedShellAsk(undefined)).toBe(false);
  });

  it("names what to install only on the unavailable plan, and only for causes an install fixes", () => {
    const unavailable = (unavailableCauses: Parameters<typeof buildHostShellExecutionPlan>[0]["unavailableCauses"]) =>
      buildHostShellExecutionPlan({ platform: "linux", requestedSandbox: true, activeCapability: { ...NONE, platform: "linux" }, unavailableCauses });
    const hinted = unavailable(["missing-bwrap", "dependency-check-failed", "missing-socat", "missing-bwrap", "missing-ripgrep"]);
    expect(hinted.installHints).toEqual(["bubblewrap", "socat", "ripgrep"]);
    expect(Object.isFrozen(hinted.installHints)).toBe(true);
    expect(getHostShellExecutionPlanAuditProjection(hinted).installHints).toEqual(["bubblewrap", "socat", "ripgrep"]);
    expect(requiresUnsandboxedShellAsk(hinted)).toBe(true);
    for (const causes of [undefined, [], ["linux-runtime-probe-failed"], ["init-failed"], ["windows-setup-incomplete"]] as const) {
      expect(unavailable(causes)).not.toHaveProperty("installHints");
      expect(getHostShellExecutionPlanAuditProjection(unavailable(causes))).not.toHaveProperty("installHints");
    }
    // The hint is display only: it partitions the cache but never the route identity the floor reads.
    expect(hinted.identity).toBe(unavailable([]).identity);
    expect(getHostShellExecutionPlanCacheIdentity(getHostShellExecutionPlanAuditProjection(hinted)))
      .not.toBe(getHostShellExecutionPlanCacheIdentity(getHostShellExecutionPlanAuditProjection(unavailable([]))));
    for (const other of [
      buildHostShellExecutionPlan({ platform: "linux", requestedSandbox: false, activeCapability: { ...NONE, platform: "linux" }, unavailableCauses: ["missing-bwrap"] }),
      buildHostShellExecutionPlan({ platform: "linux", requestedSandbox: true, executionMode: "host", activeCapability: { ...NONE, platform: "linux" }, unavailableCauses: ["missing-bwrap"] }),
      buildHostShellExecutionPlan({ platform: "linux", requestedSandbox: true, activeCapability: { ...FULL_ASRT, platform: "linux" }, unavailableCauses: ["missing-bwrap"] }),
    ]) expect(other).not.toHaveProperty("installHints");
  });
  it.each(["darwin", "linux", "win32"] as const)(
    "keeps full %s ASRT on the wrapped route",
    (platform) => {
      const plan = buildHostShellExecutionPlan({
        platform,
        requestedSandbox: true,
        activeCapability: { ...FULL_ASRT, platform },
      });

      expect(plan.mode).toBe("asrt");
      expect(plan.fallbackReason).toBe("none");
      expect(plan.requiresExplicitUserApproval).toBe(false);
      expect(plan.capability).toMatchObject({
        kind: "asrt",
        confines: { filesystem: true, process: true, network: true },
      });
    },
  );

  it.each(["default", "host"] as const)("uses the same floor on the %s route for missing and incomplete Linux containment", (executionMode) => {
    const missing = { ...NONE, platform: "linux" as const };
    const incomplete = { ...FULL_ASRT, platform: "linux" as const,
      confines: { filesystem: true, process: false, network: false } };
    for (const activeCapability of [missing, incomplete]) {
      for (const homePrivacyVerified of [false, true]) {
        const plan = buildHostShellExecutionPlan({
          platform: "linux", requestedSandbox: true, executionMode, activeCapability, homePrivacyVerified,
        });
        expect(plan).toMatchObject({ mode: "plain", sandboxed: false, requiresExplicitUserApproval: true,
          capability: { kind: "none", confines: { filesystem: false, process: false, network: false } } });
        expect(requiresUnsandboxedShellAsk(plan)).toBe(true);
        expect(exactRulePassesUnsandboxedShellAsk(plan)).toBe(homePrivacyVerified);
      }
    }
  });
  it("partitions cache identity by the entire safe plan projection", () => {
    const requested = buildHostShellExecutionPlan({
      platform: "darwin",
      requestedSandbox: true,
      activeCapability: { ...NONE, platform: "darwin" },
    });
    const explicitOff = buildHostShellExecutionPlan({
      platform: "darwin",
      requestedSandbox: false,
      activeCapability: { ...NONE, platform: "darwin" },
    });

    // The sealed requested-unavailable plan gets a distinct route identity, and its cache identity must remain distinct from explicit sandbox-off.
    expect(requested.identity).not.toBe(explicitOff.identity);
    const requestedProjection = getHostShellExecutionPlanAuditProjection(requested);
    const offProjection = getHostShellExecutionPlanAuditProjection(explicitOff);
    expect(getHostShellExecutionPlanCacheIdentity(requestedProjection))
      .not.toBe(getHostShellExecutionPlanCacheIdentity(offProjection));
    expect(getHostShellExecutionPlanCacheIdentity(requestedProjection))
      .toBe(getHostShellExecutionPlanCacheIdentity(requestedProjection));
  });
  it.each(["darwin", "linux", "win32"] as const)(
    "requires the no-confinement floor for incomplete substrates on %s",
    (platform) => {
      for (const kind of ["partial", "fs-only"] as const) {
        const plan = buildHostShellExecutionPlan({
          platform,
          requestedSandbox: true,
          activeCapability: {
            kind,
            confidence: "policy-best-effort",
            platform,
            reason: "future partial substrate",
            confines: {
              filesystem: kind === "fs-only",
              process: false,
              network: false,
            },
          },
        });

        expect(plan).toMatchObject({
          requestedSandbox: true,
          mode: "plain",
          fallbackReason: "active-sandbox-not-shell-contained",
          requiresExplicitUserApproval: true,
          capability: {
            kind: "none",
            confines: { filesystem: false, process: false, network: false },
          },
        });
      }
    },
  );
  it("returns one immutable allowlist-only audit projection per execution plan", () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: {
        ...WINDOWS_PARTIAL_ASRT,
        reason: "internal capability detail that must not be audited",
      },
    });

    const projection = getHostShellExecutionPlanAuditProjection(plan);
    expect(getHostShellExecutionPlanAuditProjection(plan)).toBe(projection);
    expect(projection).toMatchObject({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      identity: plan.identity,
      platform: "win32",
      requestedSandbox: true,
      mode: "plain",
      fallbackReason: "active-sandbox-not-shell-contained",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confidence: "verified",
        platform: "win32",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.capability)).toBe(true);
    expect(Object.isFrozen(projection.capability.confines)).toBe(true);
    expect(isIssuedHostShellExecutionPlanAuditProjection(projection)).toBe(true);
    expect(isIssuedHostShellExecutionPlanAuditProjection({ ...projection })).toBe(false);

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("internal capability detail that must not be audited");
    for (const forbidden of [
      "command",
      "requestedCwd",
      "executionCwd",
      "resolvedCwd",
      "allowedDirectories",
      "permit",
      "binding",
      "nonce",
      "hmac",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("host shell execution plan — Windows MXC substrate", () => {
  const MXC = {
    kind: "asrt" as const,
    confidence: "verified" as const,
    platform: "win32" as const,
    reason: "MXC BaseContainer",
    confines: { filesystem: true, process: true, network: true },
  };

  it("routes a sandbox-requested Windows shell into MXC without an approval, under its own identity", () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: MXC,
      shellSubstrate: "mxc",
    });
    expect(plan).toMatchObject({ mode: "asrt", substrate: "mxc", requiresExplicitUserApproval: false });
    expect(plan.identity).toBe(`${HOST_SHELL_EXECUTION_PLAN_VERSION}:win32:mxc`);
    expect(getHostShellExecutionPlanAuditProjection(plan).substrate).toBe("mxc");
  });

  it("keys the cache by substrate, so an MXC verdict never serves an ASRT-wrapped command", () => {
    const base = { platform: "win32" as const, requestedSandbox: true, activeCapability: MXC };
    const mxc = buildHostShellExecutionPlan({ ...base, shellSubstrate: "mxc" });
    const asrt = buildHostShellExecutionPlan({ ...base, shellSubstrate: "asrt" });
    expect(asrt.substrate).toBe("asrt");
    expect(getHostShellExecutionPlanCacheIdentity(mxc)).not.toBe(getHostShellExecutionPlanCacheIdentity(asrt));
  });

  it("refuses the MXC substrate off Windows", () => {
    expect(() =>
      buildHostShellExecutionPlan({ platform: "darwin", requestedSandbox: true, activeCapability: FULL_ASRT, shellSubstrate: "mxc" }),
    ).toThrow(/only on Windows/);
  });

  it("keeps an explicit host request on the plain, approved route even when MXC is live", () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: MXC,
      shellSubstrate: "mxc",
      executionMode: "host",
    });
    expect(plan).toMatchObject({ mode: "plain", substrate: "none", requiresExplicitUserApproval: true });
  });

  it("reports substrate none for every non-sandboxed route", () => {
    for (const activeCapability of [WINDOWS_PARTIAL_ASRT, NONE]) {
      const plan = buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability });
      expect(plan.mode).not.toBe("asrt");
      expect(plan.substrate).toBe("none");
    }
  });
});

// A boot home-privacy failure sets the ask flag; on Windows every plan branch then confines, refuses, or asks a human for each command.
describe("host shell execution plan — Windows under a boot home-privacy failure", () => {
  const MXC = { ...WINDOWS_PARTIAL_ASRT, reason: "MXC BaseContainer", confines: { filesystem: true, process: true, network: true } };
  const branches = [
    { label: "explicit host", requestedSandbox: true, activeCapability: MXC, executionMode: "host", expected: "ask" },
    { label: "shell scope off", requestedSandbox: false, activeCapability: NONE, expected: "ask" },
    { label: "requested sandbox unavailable", requestedSandbox: true, activeCapability: NONE, expected: "ask" },
    { label: "partial ASRT", requestedSandbox: true, activeCapability: WINDOWS_PARTIAL_ASRT, expected: "ask" },
    { label: "MXC", requestedSandbox: true, activeCapability: MXC, shellSubstrate: "mxc", expected: "confined" },
    { label: "full ASRT", requestedSandbox: true, activeCapability: MXC, expected: "confined" },
    { label: "uncontained capability", requestedSandbox: true, activeCapability: { ...NONE, kind: "asrt" as const, platform: "linux" as const }, platform: "linux", expected: "ask" },
  ] as const;

  it.each(branches)("$label: $expected", (branch) => {
    const plan = buildHostShellExecutionPlan({
      platform: "platform" in branch ? branch.platform : "win32",
      requestedSandbox: branch.requestedSandbox,
      activeCapability: branch.activeCapability,
      ...("shellSubstrate" in branch ? { shellSubstrate: branch.shellSubstrate } : {}),
      ...("executionMode" in branch ? { executionMode: branch.executionMode } : {}),
      unavailableSandboxRequiresAsk: true,
    });
    const outcome = plan.sandboxed ? "confined" : plan.mode === "blocked" ? "refused"
      : requiresUnsandboxedShellAsk(plan) && requiresExplicitHostShellApproval(plan) ? "ask" : "unconfined-without-ask";
    expect(outcome).toBe(branch.expected);
  });

  // Helper-unavailable (owner 2026-11-24): every unconfined branch is refused with the restart notice; confined routes are unchanged.
  it.each(branches)("helper-unavailable, $label: refused unless confined", (branch) => {
    const plan = buildHostShellExecutionPlan({
      platform: "platform" in branch ? branch.platform : "win32",
      requestedSandbox: branch.requestedSandbox,
      activeCapability: branch.activeCapability,
      ...("shellSubstrate" in branch ? { shellSubstrate: branch.shellSubstrate } : {}),
      ...("executionMode" in branch ? { executionMode: branch.executionMode } : {}),
      unavailableSandboxRequiresAsk: true,
      unconfinedShellDenied: true,
    });
    if (branch.expected === "confined") {
      expect(plan).toMatchObject({ mode: "asrt", sandboxed: true });
      return;
    }
    expect(plan).toMatchObject({ mode: "blocked", sandboxed: false, fallbackReason: "home-privacy-helper-unavailable", requiresExplicitUserApproval: false,
      executionRequest: "executionMode" in branch ? branch.executionMode : "default" });
    expect(isHomePrivacyHelperUnavailablePlan(plan)).toBe(true);
    expect(requiresExplicitHostShellApproval(plan)).toBe(false);
    expect(plan.capability.reason).toContain("Restart Ave; if it persists, reinstall Ave.");
  });
});
