vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

/** Boot outcome distinguishes never-enabled isolation from failed activation even when both publish no runtime capability. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import {
  createSandboxBootHarness,
  type SandboxBootHarness,
} from "../../__tests__/support/sandbox-boot-context.js";

const h = vi.hoisted(() => ({
  initialize: vi.fn(),
  subscribe: vi.fn(),
  checkDeps: vi.fn(),
  isProbeError: vi.fn(),
  isMacProbeError: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/ave-sandbox-outcome-test") },
}));

vi.mock("../../lib/logger.js", () => ({
  createLogger: vi.fn(() => h.logger),
}));

// Use a Windows host with neither supported confinement substrate available.
vi.mock("../../permissions/mxc-windows.js", () => ({
  detectHostMxcPrerequisites: async () => ({ state: "unavailable", reason: "tier-unsupported", windowsBuild: null, detail: "test host" }),
}));

vi.mock("../../permissions/asrt-sandbox.js", async () => {
  // Boot sweeps private roots; use an owned temporary home.
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const roots = join(tmpdir(), "ave-sandbox-boot-outcome-sandbox");
  return {
    appOwnedSandboxTempRoot: () => join(roots, "tmp"),
    appOwnedSandboxHomeRoot: () => join(roots, "home"),
    sandboxTempPrincipalDirsInUse: () => new Set<string>(),
    ensureSandboxPrivateRoot: (root: string) => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      return root;
    },
    initializeAsrtSandbox: h.initialize,
    subscribeAsrtViolations: h.subscribe,
    useAppOwnedSandboxTempRoot: () => "/tmp/ave-test-sandbox-tmp",
    checkAsrtDependencies: h.checkDeps,
    isAsrtLinuxRuntimeProbeError: h.isProbeError,
    isAsrtMacRuntimeProbeError: h.isMacProbeError,
    closeAllEgressConnections: () => 0,
  };
});

import { initSandboxGate } from "../steps/sandbox-init.js";
import { SrtWinIntegrityError } from "../../permissions/srt-win-integrity.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxBootOutcomeForTest,
  __resetSandboxRequestedAtBootForTest,
  detectSandboxCapability,
  getSandboxBootOutcome,
} from "../../permissions/sandbox-capability.js";

const ORIGINAL_PLATFORM = process.platform;

let harness: SandboxBootHarness;

beforeEach(() => {
  harness = createSandboxBootHarness();
  setProcessPlatform("linux");
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSandboxBootOutcomeForTest();
  h.initialize.mockReset();
  h.subscribe.mockReset();
  h.subscribe.mockResolvedValue(() => {});
  h.checkDeps.mockReset();
  h.isProbeError.mockReset();
  h.isMacProbeError.mockReset();
  h.isMacProbeError.mockReturnValue(false);
  h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
  h.isProbeError.mockReturnValue(false);
  vi.stubEnv("AVE_SANDBOX_ENABLED", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSandboxBootOutcomeForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe("boot sandbox outcome", () => {
  it.each([
    ["srt-win-not-found", "windows-sandbox-missing"],
    ["srt-win-integrity-mismatch", "windows-sandbox-integrity-failed"],
  ] as const)("preserves %s through the dependency check and a wrapped cause at boot", async (code, cause) => {
    setProcessPlatform("win32");
    const dependencyFailure = new Error("Dependency preparation failed", { cause: new SrtWinIntegrityError(code) });
    h.checkDeps.mockResolvedValue({ errors: [dependencyFailure.message], warnings: [], dependencyFailure });
    await initSandboxGate(harness.context(true));
    expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade", causes: [cause] });
    expect(h.initialize).not.toHaveBeenCalled();
  });
  it("is null before the gate has run, which is not the same as off", () => {
    expect(getSandboxBootOutcome()).toBeNull();
  });

  it("records the Windows degrade with the dependency errors that name the fix", async () => {
    setProcessPlatform("win32");
    const depError =
      "Sandbox user is not provisioned (user=true, cred=false). Windows sandbox needs a one-time install";
    h.checkDeps.mockResolvedValue({ errors: [depError], warnings: [] });

    await expect(initSandboxGate(harness.context(true))).resolves.toBeUndefined();

    expect(detectSandboxCapability()).toMatchObject({ kind: "none" });

    expect(getSandboxBootOutcome()).toEqual({
      action: "degrade",
      reason: "degrade-windows-not-installed",
      onSignal: "default-settings",
      dependencyErrors: [depError],
      causes: ["windows-setup-incomplete"],
    });
  });

  it("records the gate-off skip distinctly from a failed activation", async () => {
    await expect(initSandboxGate(harness.context(false))).resolves.toBeUndefined();

    expect(getSandboxBootOutcome()).toEqual({
      action: "skip",
      reason: "gate-off",
      onSignal: "off",
      dependencyErrors: [],
      causes: [],
    });
  });

  it("classifies each missing Linux dependency so the permission card can name it", async () => {
    h.checkDeps.mockResolvedValue({
      errors: ["bubblewrap (bwrap) not installed", "socat not executable at /opt/bin/socat"],
      warnings: [],
    });

    await expect(initSandboxGate(harness.context(true))).resolves.toBeUndefined();

    expect(getSandboxBootOutcome()).toMatchObject({
      action: "degrade",
      reason: "degrade-default-cannot-activate",
      causes: ["missing-bwrap", "missing-socat"],
    });
  });

  it("names a Linux runtime-probe failure apart from a generic start failure", async () => {
    h.initialize.mockRejectedValue(new Error("probe exited 1"));
    h.isProbeError.mockReturnValue(true);

    await expect(initSandboxGate(harness.context(true))).resolves.toBeUndefined();

    expect(getSandboxBootOutcome()).toMatchObject({
      action: "degrade",
      reason: "degrade-linux-runtime-probe-failed",
      causes: ["linux-runtime-probe-failed"],
    });
  });

  it("records the explicit-env abort before boot rejects", async () => {
    h.checkDeps.mockResolvedValue({ errors: ["missing bwrap"], warnings: [] });
    vi.stubEnv("AVE_SANDBOX_ENABLED", "1");

    await expect(initSandboxGate(harness.context(false))).rejects.toThrow(/dependencies are missing/);

    expect(getSandboxBootOutcome()).toMatchObject({
      action: "abort",
      onSignal: "explicit-env",
      dependencyErrors: ["missing bwrap"],
      causes: ["dependency-check-failed"],
    });
  });

  it("carries the init-failure cause through the degrade so the surface can show it", async () => {
    h.initialize.mockRejectedValue(new Error("wrapper refused to start"));

    await expect(initSandboxGate(harness.context(true))).resolves.toBeUndefined();

    expect(getSandboxBootOutcome()).toMatchObject({
      action: "degrade",
      dependencyErrors: ["wrapper refused to start"],
      causes: ["init-failed"],
    });
  });

  it("reports the same action and reason to the audit log and to the surface", async () => {
    setProcessPlatform("win32");
    h.checkDeps.mockResolvedValue({ errors: ["not installed"], warnings: [] });

    await initSandboxGate(harness.context(true));

    // Audit and renderer must receive the same terminal outcome.
    const calls = harness.logSandboxGate.mock.calls;
    const audited = calls[calls.length - 1]?.[0] as {
      outcome: string;
      reason: string;
      onSignal: string;
    };
    const surfaced = getSandboxBootOutcome();
    expect(surfaced).not.toBeNull();
    expect(audited.outcome).toBe(surfaced?.action);
    expect(audited.reason).toBe(surfaced?.reason);
    expect(audited.onSignal).toBe(surfaced?.onSignal);
  });

  it("subscribes the proxy-deny monitor before the sandbox proxy starts, and only when it activates", async () => {
    const order: string[] = [];
    h.subscribe.mockImplementation(async () => { order.push("subscribe"); return () => {}; });
    h.initialize.mockImplementation(async () => { order.push("initialize"); });

    await initSandboxGate(harness.context(true));

    expect(getSandboxBootOutcome()?.action).toBe("activate");
    expect(order).toEqual(["subscribe", "initialize"]);
    // Every connection needs an invocation-specific decision; never share extension allow-lists across identities.
    expect(h.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDomains: [], strictAllowlist: false }),
      expect.any(Function),
    );
    expect(h.initialize.mock.calls[0]).toHaveLength(2);

    order.length = 0;
    __resetSandboxBootOutcomeForTest();
    __resetSandboxRequestedAtBootForTest();
    await initSandboxGate(harness.context(false));
    expect(order).toEqual([]);
  });

  it("does not let a caller mutate the sealed outcome", async () => {
    await initSandboxGate(harness.context(false));

    const outcome = getSandboxBootOutcome();
    expect(outcome).not.toBeNull();
    expect(() => {
      (outcome as unknown as { action: string }).action = "activate";
    }).toThrow();
    expect(getSandboxBootOutcome()?.action).toBe("skip");
  });
});
