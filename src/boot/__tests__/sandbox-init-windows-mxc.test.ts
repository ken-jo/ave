vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

/** Check each Windows substrate combination and the boot outcome reported to Settings. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import {
  createSandboxBootHarness,
  type SandboxBootHarness,
} from "../../__tests__/support/sandbox-boot-context.js";

const h = vi.hoisted(() => ({
  initialize: vi.fn(),
  checkDeps: vi.fn(),
  detectMxc: vi.fn(),
  startProbe: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/ave-sandbox-init-windows-test") },
}));

vi.mock("../../lib/logger.js", () => ({
  createLogger: vi.fn(() => h.logger),
}));

vi.mock("../../permissions/mxc-windows.js", () => ({
  detectHostMxcPrerequisites: h.detectMxc,
  probeHostMxcPowerShellStart: h.startProbe,
}));

vi.mock("../../permissions/asrt-sandbox.js", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const roots = join(tmpdir(), "ave-sandbox-init-windows-mxc-sandbox");
  return {
    appOwnedSandboxTempRoot: () => join(roots, "tmp"),
    appOwnedSandboxHomeRoot: () => join(roots, "home"),
    sandboxTempPrincipalDirsInUse: () => new Set<string>(),
    ensureSandboxPrivateRoot: (root: string) => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      return root;
    },
    useAppOwnedSandboxTempRoot: () => "/tmp/ave-test-sandbox-tmp",
    initializeAsrtSandbox: h.initialize,
    subscribeAsrtViolations: async () => () => {},
    checkAsrtDependencies: h.checkDeps,
    isAsrtLinuxRuntimeProbeError: () => false,
    isAsrtMacRuntimeProbeError: () => false,
    closeAllEgressConnections: () => 0,
  };
});

import { initSandboxGate } from "../steps/sandbox-init.js";
import { assertAveHomePrivacyForConfinement, setAveHomePrivacyAtBoot, _resetAveHomePrivacyForTest } from "../../shared/ave-home.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxBootOutcomeForTest,
  __resetSandboxRequestedAtBootForTest,
  __resetWindowsSandboxSubstrateForTest,
  detectPluginWorkerSandboxCapability,
  detectSandboxCapability,
  detectShellSandboxCapability,
  getHostShellExecutionPlan,
  getSandboxBootOutcome,
  getWindowsSandboxSubstrate,
} from "../../permissions/sandbox-capability.js";

const ORIGINAL_PLATFORM = process.platform;
const SRT_WIN_MISSING = { errors: ["no srt-win path configured"], warnings: [] };
// Boot-path checks precede the shell start probe.
const MXC_OK = { state: "available", windowsBuild: "10.0.26300.9711" };
const MXC_OLD = { state: "unavailable", reason: "tier-unsupported", windowsBuild: "10.0.22631.4317", detail: "tier none" };

let harness: SandboxBootHarness;

beforeEach(() => {
  harness = createSandboxBootHarness();
  setProcessPlatform("win32");
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSandboxBootOutcomeForTest();
  __resetWindowsSandboxSubstrateForTest();
  h.initialize.mockReset();
  h.initialize.mockResolvedValue(undefined);
  h.checkDeps.mockReset();
  h.detectMxc.mockReset();
  h.startProbe.mockReset();
  h.startProbe.mockResolvedValue({ state: "available", windowsBuild: "10.0.26300.9711" });
  vi.stubEnv("AVE_SANDBOX_ENABLED", "");
  vi.stubEnv("AVE_PLUGIN_WORKER_CONFINEMENT", "");
});

afterEach(() => {
  _resetAveHomePrivacyForTest();
  vi.unstubAllEnvs();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSandboxBootOutcomeForTest();
  __resetWindowsSandboxSubstrateForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

it("degrades before initializing the extension backend when private-directory protection fails", async () => {
  const path = "D:/private-state/secrets";
  setAveHomePrivacyAtBoot({ enforcement: "none", home: "D:/private-state", failedPath: path, category: "read-back-failed", reason: "read-back failed" });
  h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
  h.detectMxc.mockResolvedValue(MXC_OK);
  h.initialize.mockImplementation(async (settings) => {
    if (settings.windows?.externalConfinement !== true) assertAveHomePrivacyForConfinement();
  });

  const context = harness.context(true, true);
  const logRefusal = vi.fn();
  context.bootAuditLogger.log = logRefusal;
  await initSandboxGate(context);

  expect(h.initialize).not.toHaveBeenCalled();
  expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade", reason: "degrade-ave-home-privacy-failed", causes: ["ave-home-privacy-failed"] });
  expect(detectPluginWorkerSandboxCapability().kind).toBe("none");
  expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("isolation is OFF"), "read-back-failed", path);
  expect(() => assertAveHomePrivacyForConfinement()).toThrow("Settings > Permissions");
  expect(logRefusal).toHaveBeenCalledWith(expect.objectContaining({ type: "error", output: expect.stringContaining("ave_home_privacy_refused") }));
  await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ extensions: "none" }));
});

describe("initSandboxGate — Windows MXC substrate", () => {
  it("MXC without srt-win: starts ASRT as the proxy only and runs agent shells in containers", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);

    await initSandboxGate(harness.context(true, true));

    expect(h.initialize).toHaveBeenCalledOnce();
    expect(h.initialize.mock.calls[0]?.[0]).toMatchObject({ windows: { externalConfinement: true } });
    expect(getSandboxBootOutcome()).toMatchObject({
      action: "activate",
      reason: "activate-windows-mxc-proxy-only",
      dependencyErrors: SRT_WIN_MISSING.errors,
      causes: ["windows-sandbox-missing"],
    });
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", extensions: "none", shellEgressIdentity: "kernel-channel" }));
    expect(detectSandboxCapability().reason).toContain("agent shell commands run in containers");
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "asrt", substrate: "mxc" });
    // Never claim confinement outside the containers.
    expect(detectShellSandboxCapability().confines).toEqual({ filesystem: false, process: false, network: false });
    expect(detectPluginWorkerSandboxCapability().kind).toBe("none");
  });

  it("MXC with srt-win: shells in containers, extensions under srt-win, ASRT initialized as before", async () => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OK);

    await initSandboxGate(harness.context(true, true));

    expect(h.initialize.mock.calls[0]?.[0]).not.toHaveProperty("windows");
    expect(getSandboxBootOutcome()).toMatchObject({ action: "activate", reason: "deps-present" });
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", extensions: "srt-win" }));
    expect(getHostShellExecutionPlan().substrate).toBe("mxc");
  });

  it("srt-win without MXC: approved-host shells and a shared identity, with the MXC reason recorded and logged", async () => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OLD);

    await initSandboxGate(harness.context(true, false));

    expect(getWindowsSandboxSubstrate()).toMatchObject({
      shells: "approved-host",
      shellEgressIdentity: "shared",
      mxc: { state: "unavailable", reason: "tier-unsupported" },
    });
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "plain", substrate: "none", requiresExplicitUserApproval: true });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Microsoft Execution Containers cannot confine agent shells"),
      "tier-unsupported",
      "10.0.22631.4317",
      "tier none",
    );
  });

  it("neither: degrades and records that nothing is confined", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OLD);

    await initSandboxGate(harness.context(true, false));

    expect(h.initialize).not.toHaveBeenCalled();
    expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade" });
    expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "none", extensions: "none" });
  });

  it("never aborts on Windows: an explicit extension request without srt-win still gets contained shells and a loud warning", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    vi.stubEnv("AVE_PLUGIN_WORKER_CONFINEMENT", "1");

    await initSandboxGate(harness.context(true, false));

    expect(getSandboxBootOutcome()).toMatchObject({ action: "activate", reason: "activate-windows-mxc-proxy-only", onSignal: "explicit-env" });
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", extensions: "none" }));
    expect(detectPluginWorkerSandboxCapability().kind).toBe("none");
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("plugin workers, plugin children, plugin hooks and MCP stdio servers run with NO OS isolation"));
  });

  it("records the withdrawn substrate when ASRT fails to initialize", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    h.initialize.mockRejectedValue(new Error("proxy failed to bind"));

    await initSandboxGate(harness.context(true, false));

    expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade" });
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "none", extensions: "none", mxc: { state: "available" } }));
    expect(getHostShellExecutionPlan().substrate).not.toBe("mxc");
  });

  it("retries as the proxy only when srt-win passes its check but fails to start, so shells still run in containers", async () => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OK);
    h.initialize
      .mockRejectedValueOnce(new Error("srt-win acl stamp timed out after 60000ms"))
      .mockResolvedValueOnce(undefined);

    await initSandboxGate(harness.context(true, true));

    expect(h.initialize).toHaveBeenCalledTimes(2);
    expect(h.initialize.mock.calls[0]?.[0]).not.toHaveProperty("windows");
    expect(h.initialize.mock.calls[1]?.[0]).toMatchObject({ windows: { externalConfinement: true } });
    expect(getSandboxBootOutcome()).toMatchObject({ action: "activate", reason: "activate-windows-mxc-proxy-only" });
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", extensions: "none" }));
    expect(detectShellSandboxCapability().confines).toEqual({ filesystem: false, process: false, network: false });
    expect(detectPluginWorkerSandboxCapability().kind).toBe("none");
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("srt-win acl stamp timed out"));
  });

  it("does not retry a failed srt-win start when MXC is unavailable", async () => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OLD);
    h.initialize.mockRejectedValue(new Error("srt-win acl stamp timed out after 60000ms"));

    await initSandboxGate(harness.context(true, false));

    expect(h.initialize).toHaveBeenCalledOnce();
    expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade" });
    expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "none", extensions: "none" });
  });

  it("does not wait for the PowerShell start probe: shells take the approved route while it is checking", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    let finishProbe!: (value: unknown) => void;
    h.startProbe.mockReturnValue(new Promise((resolve) => { finishProbe = resolve; }));

    await initSandboxGate(harness.context(true, false));

    await vi.waitFor(() => expect(h.startProbe).toHaveBeenCalledOnce());
    expect(getSandboxBootOutcome()).toMatchObject({ action: "activate", reason: "activate-windows-mxc-proxy-only" });
    expect(getWindowsSandboxSubstrate()).toMatchObject({ mxc: { state: "checking" }, shells: "approved-host", shellEgressIdentity: "shared" });
    expect(detectSandboxCapability().reason).toContain("container start check pending");
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "plain", substrate: "none", requiresExplicitUserApproval: true });

    finishProbe({ state: "available", windowsBuild: "10.0.26300.9711" });
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ mxc: { state: "available" }, shells: "mxc" }));
    expect(detectSandboxCapability().reason).toContain("agent shell commands run in containers");
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "asrt", substrate: "mxc", requiresExplicitUserApproval: false });
  });

  it("keeps the approved route and records the reason when PowerShell cannot start in a container", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    let finishProbe!: (value: unknown) => void;
    h.startProbe.mockReturnValue(new Promise((resolve) => { finishProbe = resolve; }));

    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(h.startProbe).toHaveBeenCalledOnce());
    expect(detectSandboxCapability().reason).toContain("container start check pending");

    finishProbe({ state: "unavailable", reason: "unverified-session", windowsBuild: "10.0.26300.9711", detail: "0xC0000142" });

    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({
      mxc: { state: "unavailable", reason: "unverified-session" },
      // Proxy-only boot cannot change mode mid-session; shells require approval.
      shells: "approved-host",
    }));
    expect(getSandboxBootOutcome()).toMatchObject({
      action: "activate",
      reason: "activate-windows-mxc-proxy-only",
      dependencyErrors: SRT_WIN_MISSING.errors,
      causes: ["windows-sandbox-missing"],
    });
    expect(detectSandboxCapability()).toMatchObject({
      kind: "asrt",
      reason: expect.stringContaining("containers unavailable; agent shell commands require host approval"),
      confines: { filesystem: false, process: false, network: false },
    });
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "plain", requiresExplicitUserApproval: true });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Microsoft Execution Containers cannot confine agent shells"),
      "unverified-session",
      "10.0.26300.9711",
      "0xC0000142",
    );
  });

  it("drops a probe result that arrives after the record was replaced", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    let finishProbe!: (value: unknown) => void;
    h.startProbe.mockReturnValue(new Promise((resolve) => { finishProbe = resolve; }));

    await initSandboxGate(harness.context(true, false));
    __resetWindowsSandboxSubstrateForTest();
    finishProbe({ state: "available", windowsBuild: "10.0.26300.9711" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(getWindowsSandboxSubstrate()).toBeNull();
  });
});
