/**
 * Windows boot plan (proxy-egress PR 9): which substrate carries agent shells
 * and extensions, for each MXC × srt-win combination, and that every branch
 * records what it chose for Settings.
 */
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
  };
});

import { initSandboxGate } from "../steps/sandbox-init.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxBootOutcomeForTest,
  __resetSandboxRequestedAtBootForTest,
  __resetWindowsSandboxSubstrateForTest,
  detectPluginWorkerSandboxCapability,
  detectShellSandboxCapability,
  getHostShellExecutionPlan,
  getSandboxBootOutcome,
  getWindowsSandboxSubstrate,
} from "../../permissions/sandbox-capability.js";

const ORIGINAL_PLATFORM = process.platform;
const SRT_WIN_MISSING = { errors: ["srt-win is not installed"], warnings: [] };
// Boot-path checks passed; the PowerShell start probe (h.startProbe) decides.
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
  vi.unstubAllEnvs();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSandboxBootOutcomeForTest();
  __resetWindowsSandboxSubstrateForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe("initSandboxGate — Windows MXC substrate", () => {
  it("MXC without srt-win: starts ASRT as the proxy only and runs agent shells in containers", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);

    await initSandboxGate(harness.context(true, true));

    expect(h.initialize).toHaveBeenCalledOnce();
    expect(h.initialize.mock.calls[0]?.[0]).toMatchObject({ windows: { externalConfinement: true } });
    expect(getSandboxBootOutcome()).toMatchObject({ action: "activate", reason: "activate-windows-mxc-proxy-only" });
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", extensions: "none", shellEgressIdentity: "kernel-channel" }));
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "asrt", substrate: "mxc" });
    // Nothing outside the containers is claimed as confined.
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

  it("does not wait for the PowerShell start probe: shells take the approved route while it is checking", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    let finishProbe!: (value: unknown) => void;
    h.startProbe.mockReturnValue(new Promise((resolve) => { finishProbe = resolve; }));

    await initSandboxGate(harness.context(true, false));

    // Boot finished with the probe started and still pending.
    await vi.waitFor(() => expect(h.startProbe).toHaveBeenCalledOnce());
    expect(getSandboxBootOutcome()).toMatchObject({ action: "activate", reason: "activate-windows-mxc-proxy-only" });
    expect(getWindowsSandboxSubstrate()).toMatchObject({ mxc: { state: "checking" }, shells: "approved-host", shellEgressIdentity: "shared" });
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "plain", substrate: "none", requiresExplicitUserApproval: true });

    finishProbe({ state: "available", windowsBuild: "10.0.26300.9711" });
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ mxc: { state: "available" }, shells: "mxc" }));
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "asrt", substrate: "mxc", requiresExplicitUserApproval: false });
  });

  it("keeps the approved route and records the reason when PowerShell cannot start in a container", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    h.startProbe.mockResolvedValue({ state: "unavailable", reason: "unverified-session", windowsBuild: "10.0.26300.9711", detail: "0xC0000142" });

    await initSandboxGate(harness.context(true, false));

    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({
      mxc: { state: "unavailable", reason: "unverified-session" },
      // The proxy-only boot cannot change mode mid-session: shells ask.
      shells: "approved-host",
    }));
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
