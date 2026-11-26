vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

/** Check each Windows substrate combination and the boot outcome reported to Settings. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import {
  createSandboxBootHarness,
  type SandboxBootHarness,
} from "../../__tests__/support/sandbox-boot-context.js";

// This file's private sandbox root, unique per process so concurrent vitest runs never remove each other's.
const SANDBOX_ROOT_NAME = vi.hoisted(() => `ave-sandbox-init-windows-mxc-sandbox-${process.pid}-${Math.random().toString(16).slice(2)}`);
const h = vi.hoisted(() => ({
  initialize: vi.fn(),
  checkDeps: vi.fn(),
  detectMxc: vi.fn(),
  startProbe: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  homesCalls: [] as string[],
  establishHomesError: undefined as Error | undefined,
}));

vi.mock("../../permissions/mxc-runtime-root.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../permissions/mxc-runtime-root.js")>();
  return {
    ...actual,
    // This file's simulated drive holds no provable root; the boot gate's own handling of either outcome is what is checked.
    establishMxcSandboxHomesParent: () => {
      h.homesCalls.push("establish");
      if (h.establishHomesError !== undefined) throw h.establishHomesError;
      return "C:/example/ave-runtime/homes";
    },
    mxcSandboxHomesParent: (...args: Parameters<typeof actual.mxcSandboxHomesParent>) => {
      h.homesCalls.push("parent");
      return actual.mxcSandboxHomesParent(...args);
    },
  };
});

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/ave-sandbox-init-windows-test") },
  ipcMain: { handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { h.handlers.set(channel, fn); }) },
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
  const roots = join(tmpdir(), SANDBOX_ROOT_NAME);
  return {
    appOwnedSandboxTempRoot: () => join(roots, "tmp"),
    isOfflineProcessConfinementActive: () => false,
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
    getWindowsProfileReadDenyWarnings: () => [],
  };
});

import { initSandboxGate } from "../steps/sandbox-init.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { createMemoryMapRuntime } from "../../ipc/domains/memory-map-runtime.js";
import { rendererSettingsSnapshot } from "../../ipc/domains/settings.js";
import type { IpcDeps } from "../../ipc/types.js";
import { assertLocalEmbeddingRuntime } from "../../main/memory-map/local-runtime.js";
import { registerMxcReleaseGateEvidence } from "../../permissions/mxc-extension-admission.js";
import { areWindowsBackgroundSwitchesAvailable } from "../../permissions/windows-background-features.js";
import { decidePermission } from "../../permissions/decision-pipeline.js";
import { requiresUnsandboxedShellAsk } from "../../permissions/host-shell-execution-plan.js";
import { ObligationRefusedError, setWindowsDenyUnenforceableAtBoot, windowsDenyUnenforceableAtBoot } from "../../permissions/admitted-obligation.js";
import { assertAveHomePrivacyForConfinement, getAveHomePrivacyFailure, setAveHomePrivacyAtBoot, _resetAveHomePrivacyForTest } from "../../shared/ave-home.js";
import { windowsPathKindHelperUnavailable } from "../../main/windows-path-kind-launcher.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxBootOutcomeForTest,
  __resetSandboxRequestedAtBootForTest,
  __resetWindowsSandboxSubstrateForTest,
  __resetSandboxHomesUnavailableForTest,
  getSandboxHomesUnavailable,
  detectPluginWorkerSandboxCapability,
  detectSandboxCapability,
  detectShellSandboxCapability,
  getHostShellExecutionPlan,
  getSandboxBootOutcome,
  getWindowsSandboxSubstrate,
  setSandboxStatusChangeListener,
} from "../../permissions/sandbox-capability.js";

const ORIGINAL_PLATFORM = process.platform;
const SRT_WIN_MISSING = { errors: ["no srt-win path configured"], warnings: [] };
// Boot-path checks precede the shell start probe.
const MXC_OK = { state: "available", windowsBuild: "10.0.26300.9711" };
const MXC_OLD = { state: "unavailable", reason: "container-unavailable", windowsBuild: "10.0.22631.4317", detail: "no container API" };
const NO_CONTAINER = { ...MXC_OLD, baseContainerApiPresent: false, containerBackendAbsent: true };
const NO_ACCOUNT_BACKEND = { errors: [], warnings: [], accountBackendAbsent: true };
const RELEASE_EVIDENCE = {
  ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true,
  forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true,
};

let harness: SandboxBootHarness;

beforeEach(() => {
  harness = createSandboxBootHarness();
  setProcessPlatform("win32");
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSandboxBootOutcomeForTest();
  __resetWindowsSandboxSubstrateForTest();
  __resetSandboxHomesUnavailableForTest();
  h.initialize.mockReset();
  h.initialize.mockResolvedValue(undefined);
  h.checkDeps.mockReset();
  h.detectMxc.mockReset();
  h.startProbe.mockReset();
  h.startProbe.mockResolvedValue({ state: "available", windowsBuild: "10.0.26300.9711" });
  h.homesCalls.length = 0;
  h.establishHomesError = undefined;
  vi.stubEnv("AVE_SANDBOX_ENABLED", "");
  vi.stubEnv("AVE_PLUGIN_WORKER_CONFINEMENT", "");
});

// The mocked asrt-sandbox above makes this file's private sandbox roots here; the file owns removing them.
afterAll(() => rmSync(join(tmpdir(), SANDBOX_ROOT_NAME), { recursive: true, force: true }));

afterEach(() => {
  setSandboxStatusChangeListener(undefined);
  _resetAveHomePrivacyForTest();
  vi.unstubAllEnvs();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSandboxBootOutcomeForTest();
  __resetWindowsSandboxSubstrateForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

it.each([
  { category: "read-back-failed", remedy: "Each extension start asks for approval until the folder is fixed.", refusal: "Fix the folder permissions and restart Ave." },
  { category: "helper-unavailable", remedy: "Extensions stay blocked until a restart; if it persists, reinstall Ave.", refusal: "Restart Ave; if it persists, reinstall Ave." },
] as const)("degrades before initializing the extension backend when private-directory protection fails ($category)", async ({ category, remedy, refusal }) => {
  const path = "D:/private-state/secrets";
  setAveHomePrivacyAtBoot({ enforcement: "none", home: "D:/private-state", failedPath: path, category, reason: "read-back failed" });
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
  expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("isolation is OFF"), category, path, remedy);
  expect(() => assertAveHomePrivacyForConfinement()).toThrow(refusal);
  expect(logRefusal).toHaveBeenCalledWith(expect.objectContaining({ type: "error", output: expect.stringContaining("ave_home_privacy_refused") }));
  await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ extensions: "none" }));
});

describe("initSandboxGate — Windows sandbox HOME parent", () => {
  it("establishes the HOME parent first, before the sweep or the backend checks ask for it", async () => {
    h.checkDeps.mockImplementation(async () => {
      h.homesCalls.push("backend");
      return SRT_WIN_MISSING;
    });
    h.detectMxc.mockResolvedValue(MXC_OK);
    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(h.homesCalls).toContain("parent"));
    expect(h.homesCalls[0]).toBe("establish");
    expect(h.homesCalls.indexOf("establish")).toBeLessThan(h.homesCalls.indexOf("parent"));
    expect(h.homesCalls.indexOf("establish")).toBeLessThan(h.homesCalls.indexOf("backend"));
  });

  it("logs a HOME parent that cannot be established and still finishes boot", async () => {
    h.establishHomesError = new Error("root not private");
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    await expect(initSandboxGate(harness.context(true, false))).resolves.toBeUndefined();
    expect(h.homesCalls[0]).toBe("establish");
    expect(h.logger.warn).toHaveBeenCalledWith("boot: Windows sandbox HOME root unavailable: %s", "root not private");
    expect(h.checkDeps).toHaveBeenCalled();
    expect(getSandboxBootOutcome()).not.toBeNull();
  });

  it.each([["passing", MXC_OK], ["failing", MXC_OLD]] as const)(
    "reports the unproved root to Settings, starting no probe, whatever the container prerequisites (%s)", async (_case, prerequisites) => {
      h.establishHomesError = new Error("root not private");
      h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
      h.detectMxc.mockResolvedValue(prerequisites);
      await initSandboxGate(harness.context(true, false));
      await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ mxc: { state: "unavailable", reason: "runtime-root-unproved" } }));
      expect(h.startProbe).not.toHaveBeenCalled();
    });

  it("reports the unproved root to Settings with the sandbox setting off, where no substrate is recorded", async () => {
    h.establishHomesError = new Error("root not private");
    await initSandboxGate(harness.context(false, false));
    expect(getWindowsSandboxSubstrate()).toBeNull();
    expect(getSandboxHomesUnavailable()).toBe(true);
  });

  it("reports nothing of the kind when the root is proved", async () => {
    await initSandboxGate(harness.context(false, false));
    expect(getSandboxHomesUnavailable()).toBe(false);
  });

  it("reports the container prerequisites again once a later boot proves the root", async () => {
    h.establishHomesError = new Error("root not private");
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OLD);
    await initSandboxGate(harness.context(true, false));
    __resetWindowsSandboxSubstrateForTest();
    h.establishHomesError = undefined;
    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ mxc: { state: "unavailable", reason: "container-unavailable" } }));
  });
});

it.each([false, true])("checks background feature availability with both tool scopes off only after release readiness (%s)", async released => {
  const unregister = released ? registerMxcReleaseGateEvidence(RELEASE_EVIDENCE) : undefined;
  try {
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
    h.checkDeps.mockResolvedValue(NO_ACCOUNT_BACKEND);
    h.detectMxc.mockResolvedValue(NO_CONTAINER);
    await initSandboxGate(harness.context(false, false));
    expect(h.detectMxc).toHaveBeenCalledTimes(released ? 1 : 0);
    expect(areWindowsBackgroundSwitchesAvailable()).toBe(released);
    expect(h.startProbe).not.toHaveBeenCalled();
    expect(h.initialize).not.toHaveBeenCalled();
    expect(getSandboxBootOutcome()).toMatchObject({ action: "skip", reason: "gate-off" });
  } finally {
    unregister?.();
  }
});

it.each([
  { label: "both backends absent", mxc: NO_CONTAINER, deps: NO_ACCOUNT_BACKEND, available: true },
  { label: "container API present", mxc: { ...MXC_OLD, baseContainerApiPresent: true }, deps: NO_ACCOUNT_BACKEND },
  { label: "container API fact missing", mxc: MXC_OLD, deps: NO_ACCOUNT_BACKEND },
  { label: "contradictory container facts", mxc: { ...NO_CONTAINER, baseContainerApiPresent: true }, deps: NO_ACCOUNT_BACKEND },
  { label: "launcher missing", mxc: { ...MXC_OLD, reason: "binary-missing" }, deps: NO_ACCOUNT_BACKEND },
  { label: "launcher mismatched", mxc: { ...MXC_OLD, reason: "launcher-mismatch" }, deps: NO_ACCOUNT_BACKEND },
  { label: "probe failed", mxc: { ...MXC_OLD, reason: "probe-failed" }, deps: NO_ACCOUNT_BACKEND },
  { label: "runtime root unproved", mxc: NO_CONTAINER, deps: NO_ACCOUNT_BACKEND, rootFailed: true },
  { label: "account dependency missing", mxc: NO_CONTAINER, deps: SRT_WIN_MISSING },
  { label: "account dependency integrity failed", mxc: NO_CONTAINER, deps: {
    errors: ["helper integrity check failed"], warnings: [], dependencyFailure: { code: "srt-win-integrity-mismatch" },
  } },
  { label: "account setup failed", mxc: NO_CONTAINER, deps: { errors: ["setup failed"], warnings: [] } },
  { label: "contradictory account result", mxc: NO_CONTAINER, deps: { ...NO_ACCOUNT_BACKEND, errors: ["setup failed"] } },
  { label: "backend ready", mxc: NO_CONTAINER, deps: { errors: [], warnings: [] } },
])("projects settings and admits unconfined inference only with boot evidence: $label", async ({ mxc, deps, available, rootFailed }) => {
  const unregister = registerMxcReleaseGateEvidence(RELEASE_EVIDENCE);
  try {
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
    if (rootFailed) h.establishHomesError = new Error("root not private");
    h.checkDeps.mockResolvedValue(deps);
    h.detectMxc.mockResolvedValue(mxc);
    await initSandboxGate(harness.context(false, false));

    const settingsService = {
      getAll: () => DEFAULT_SETTINGS,
      get: (key: keyof typeof DEFAULT_SETTINGS) => DEFAULT_SETTINGS[key],
      hasStoredSecret: async () => false,
    };
    const resolveScope = vi.fn(() => { throw new Error("unexpected local build"); });
    const memoryMap = createMemoryMapRuntime({ settingsService, singleHopNetworkFetch: vi.fn() } as unknown as IpcDeps, resolveScope);
    const generalSettings = await rendererSettingsSnapshot(settingsService as unknown as IpcDeps["settingsService"]);
    const embeddingSettings = await memoryMap.settingsGet();
    expect.soft(Object.hasOwn(generalSettings.features ?? {}, "sessionIndexingWithoutContainment")).toBe(Boolean(available));
    expect.soft(Object.hasOwn(embeddingSettings, "localInferenceWithoutSandbox")).toBe(Boolean(available));
    if (available) expect(assertLocalEmbeddingRuntime()).toBe("unconfined");
    else await expect((async () => memoryMap.build(undefined, {} as Parameters<typeof memoryMap.build>[1]))())
      .rejects.toMatchObject({ code: "local-runtime-unavailable" });
    expect(resolveScope).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});

describe("initSandboxGate — Windows MXC substrate", () => {
  it("starts the real container probe at boot with nothing saved and carries shells in containers once it passes", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    let settle!: (value: typeof MXC_OK) => void;
    h.startProbe.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(h.startProbe).toHaveBeenCalledOnce());
    expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "approved-host", mxc: { state: "checking" } });
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "plain", sandboxed: false });
    settle(MXC_OK);
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", mxc: { state: "available" } }));
    expect(getWindowsSandboxSubstrate()).not.toHaveProperty("shellLocalNetworkAccess");
    expect(getHostShellExecutionPlan()).toMatchObject({ substrate: "mxc", sandboxed: true });
    expect(h.startProbe).toHaveBeenCalledOnce();
  });

  it("skips the container start probe when only extensions asked for confinement", async () => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OK);
    await initSandboxGate(harness.context(false, true));
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "none", extensions: "srt-win" }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.startProbe).not.toHaveBeenCalled();
  });

  it.each([["slow", MXC_OK, "mxc"], ["hung", MXC_OLD, "approved-host"]] as const)("reaches ready while a %s ACL stamp remains pending", async (_delay, mxc, shells) => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(mxc);
    let finishStamp!: () => void;
    const stamp = new Promise<void>(resolve => { finishStamp = resolve; });
    h.initialize.mockImplementation(async settings => {
      if (!settings.windows?.backgroundInitialization) await stamp;
      return { windowsIsolation: stamp.then(() => ({ status: "ready" })), isCurrent: () => true };
    });
    let ready = false;
    const boot = initSandboxGate(harness.context(true, true)).then(() => { ready = true; });
    try {
      await vi.waitFor(() => expect(ready).toBe(true));
      await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells, extensions: "none" }));
      const plan = getHostShellExecutionPlan();
      expect(plan).toMatchObject(shells === "mxc"
        ? { mode: "asrt", substrate: "mxc", sandboxed: true }
        : { mode: "plain", substrate: "none", sandboxed: false, requiresExplicitUserApproval: true });
      if (shells !== "mxc") {
        expect(decidePermission({
          tool: { name: "powershell", source: "builtin", kind: "shell" }, mode: "strict", headless: false,
          shell: { sandboxed: plan.sandboxed, readOnlyProven: true, unproven: false, destructive: false },
        })).toMatchObject({ outcome: "ask" });
      }
      expect(detectSandboxCapability().confines).toEqual({ filesystem: false, process: false, network: false });
      expect(detectPluginWorkerSandboxCapability().kind).toBe("none");
      expect(getSandboxBootOutcome()).toMatchObject({ action: "activate", reason: "activate-windows-mxc-proxy-only" });
    } finally {
      finishStamp();
      await boot;
    }
  });

  it("upgrades subsequent extension plans after a late stamp succeeds", async () => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OK);
    let finishStamp!: (result: { status: "ready" }) => void;
    h.initialize.mockResolvedValue({ windowsIsolation: new Promise(resolve => { finishStamp = resolve; }), isCurrent: () => true });

    await initSandboxGate(harness.context(true, true));
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", extensions: "none" }));
    const pendingPlan = getHostShellExecutionPlan();
    finishStamp({ status: "ready" });

    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", extensions: "srt-win" }));
    expect(detectSandboxCapability().confines).toEqual({ filesystem: true, process: false, network: true });
    expect(detectPluginWorkerSandboxCapability().kind).toBe("asrt");
    expect(pendingPlan).toMatchObject({ substrate: "mxc", sandboxed: true });
    expect(h.initialize).toHaveBeenCalledOnce();
  });

  it.each(["failed", "timed out after 60000ms"])("keeps the degraded route and diagnostic after a late stamp %s", async failure => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OK);
    let finishStamp!: (result: { status: "failed"; error: Error }) => void;
    h.initialize.mockResolvedValue({ windowsIsolation: new Promise(resolve => { finishStamp = resolve; }), isCurrent: () => true });

    await initSandboxGate(harness.context(true, true));
    finishStamp({ status: "failed", error: new Error(`srt-win acl stamp ${failure}`) });

    await vi.waitFor(() => expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining(`srt-win acl stamp ${failure}`)));
    expect(getWindowsSandboxSubstrate()).toMatchObject({ extensions: "none" });
    expect(detectPluginWorkerSandboxCapability().kind).toBe("none");
    expect(detectSandboxCapability().confines).toEqual({ filesystem: false, process: false, network: false });
    expect(getSandboxBootOutcome()).toMatchObject({ reason: "activate-windows-mxc-proxy-only", causes: ["init-failed"] });
    expect(h.initialize).toHaveBeenCalledOnce();
  });

  it("publishes the unavailable startup diagnostic after late failure without containers", async () => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OLD);
    let finishStamp!: (result: { status: "failed"; error: Error }) => void;
    h.initialize.mockResolvedValue({ windowsIsolation: new Promise(resolve => { finishStamp = resolve; }), isCurrent: () => true });

    await initSandboxGate(harness.context(true, true));
    finishStamp({ status: "failed", error: new Error("srt-win acl stamp failed") });

    await vi.waitFor(() => expect(getSandboxBootOutcome()).toMatchObject({
      action: "degrade", reason: "degrade-windows-init-failed", causes: ["init-failed"],
    }));
    expect(getHostShellExecutionPlan()).toMatchObject({ sandboxed: false, requiresExplicitUserApproval: true });
    expect(getWindowsSandboxSubstrate()).toMatchObject({ extensions: "none", shells: "approved-host" });
  });

  it.each(["ready", "failed"] as const)("ignores a stale %s stamp result after its session ends", async status => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OK);
    let finishStamp!: (result: { status: "ready" } | { status: "failed"; error: Error }) => void;
    let current = true;
    h.initialize.mockResolvedValue({ windowsIsolation: new Promise(resolve => { finishStamp = resolve; }), isCurrent: () => current });
    await initSandboxGate(harness.context(true, true));
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", extensions: "none" }));
    const outcome = getSandboxBootOutcome();
    finishStamp(status === "ready" ? { status } : { status, error: new Error("retired stamp") });
    current = false;
    await Promise.resolve();
    expect(getSandboxBootOutcome()).toBe(outcome);
    expect(getWindowsSandboxSubstrate()).toMatchObject({ extensions: "none" });
    expect(detectSandboxCapability().confines).toEqual({ filesystem: false, process: false, network: false });
  });

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

    expect(h.initialize.mock.calls[0]?.[0]).toHaveProperty("windows.backgroundInitialization", true);
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
      mxc: { state: "unavailable", reason: "container-unavailable" },
    });
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "plain", substrate: "none", requiresExplicitUserApproval: true });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Microsoft Execution Containers cannot confine agent shells"),
      "container-unavailable",
      "10.0.22631.4317",
      "no container API",
    );
  });

  it("neither: degrades and records that nothing is confined", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OLD);

    await initSandboxGate(harness.context(true, false));

    expect(h.initialize).not.toHaveBeenCalled();
    expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade" });
    expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "none", extensions: "none" });
    const plan = getHostShellExecutionPlan();
    expect(plan).toMatchObject({ mode: "plain", sandboxed: false, fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: true });
    expect(requiresUnsandboxedShellAsk(plan)).toBe(true);
    expect(plan.capability.confines).toEqual({ filesystem: false, process: false, network: false });
    expect(decidePermission({
      tool: { name: "powershell", source: "builtin", kind: "shell" }, mode: "strict", headless: false,
      shell: { sandboxed: plan.sandboxed, readOnlyProven: true, unproven: false, destructive: false },
    })).toMatchObject({ outcome: "ask" });
    expect(getSandboxBootOutcome()).toMatchObject({ onSignal: "default-settings", causes: ["windows-sandbox-missing"] });
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("NO OS isolation"));
  });

  it("never aborts on Windows: an explicit extension request without srt-win still gets contained shells and a loud warning", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    vi.stubEnv("AVE_PLUGIN_WORKER_CONFINEMENT", "1");

    await initSandboxGate(harness.context(true, false));

    expect(getSandboxBootOutcome()).toMatchObject({ action: "activate", reason: "activate-windows-mxc-proxy-only", onSignal: "explicit-env" });
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", extensions: "none" }));
    expect(detectPluginWorkerSandboxCapability().kind).toBe("none");
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("plugin workers, plugin children, plugin hooks and MCP stdio servers each wait for a per-start approval and then run with NO OS isolation"));
  });

  it.each([["link", "boundary-link"], ["unlisted", "boundary-unlisted"]] as const)(
    "publishes an unverifiable Ave home read boundary (%s) as the privacy refusal, not the generic degrade", async (reason, category) => {
      const home = "C:\\Users\\alice\\.ave";
      h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
      h.detectMxc.mockResolvedValue(MXC_OK);
      h.initialize.mockRejectedValue(Object.assign(new Error(`sandbox: refusing confinement: ${home}\\logs is a link or reparse point`),
        { code: "ave-home-boundary-unverified", reason, home }));
      const context = harness.context(true, true);
      const logRefusal = vi.fn();
      context.bootAuditLogger.log = logRefusal;

      await initSandboxGate(context);

      // No proxy-only retry: every confined start would refuse the same boundary.
      expect(h.initialize).toHaveBeenCalledOnce();
      expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade", reason: "degrade-ave-home-boundary-unverified",
        causes: ["ave-home-privacy-failed"], dependencyErrors: ["ave-home-boundary-unverified"] });
      expect(getAveHomePrivacyFailure()).toMatchObject({ enforcement: "none", home, category });
      expect(() => assertAveHomePrivacyForConfinement()).toThrow("Fix the folder permissions and restart Ave.");
      expect(detectPluginWorkerSandboxCapability().kind).toBe("none");
      expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("read boundary could not be verified"), "ave-home-boundary-unverified", category,
        "Each extension start asks for approval until the folder is fixed.");
      // Logs carry codes only: the error's paths never reach the boot log.
      for (const call of [...h.logger.warn.mock.calls, ...h.logger.error.mock.calls, ...h.logger.info.mock.calls]) {
        expect(JSON.stringify(call)).not.toContain("alice");
      }
      await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "none", extensions: "none" }));
    });

  it.each([["link", "boundary-link"], ["unlisted", "boundary-unlisted"]] as const)(
    "asks for every default shell after a worker-only boot publishes an unverifiable boundary (%s)", async (reason, category) => {
      h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
      h.detectMxc.mockResolvedValue(MXC_OK);
      h.initialize.mockRejectedValue(Object.assign(new Error("sandbox: refusing confinement"),
        { code: "ave-home-boundary-unverified", reason, home: "C:\\Users\\alice\\.ave" }));

      // Worker confinement on, shell scope off: the shell intent stays false.
      await initSandboxGate(harness.context(false, true));

      expect(h.initialize).toHaveBeenCalledOnce();
      expect(getAveHomePrivacyFailure()).toMatchObject({ enforcement: "none", category });
      const plan = getHostShellExecutionPlan();
      expect(plan).toMatchObject({ requestedSandbox: false, mode: "plain", fallbackReason: "disabled-by-setting", requiresExplicitUserApproval: true });
      expect(requiresUnsandboxedShellAsk(plan)).toBe(true);
      expect(requiresUnsandboxedShellAsk(getHostShellExecutionPlan("host"))).toBe(true);
    });

  // The boundary pin wraps a helper failure as an unlisted boundary with the marked error as its cause (asrt-sandbox.ts pinBoundaryFacts).
  it.each([
    ["timeout", windowsPathKindHelperUnavailable("Windows path facts helper did not answer within 15000 ms", "ETIMEDOUT")],
    ["launch failure", windowsPathKindHelperUnavailable("Windows path facts helper could not start (ENOENT)", "ENOENT")],
  ] as const)("publishes a path-facts helper %s during the boundary pin as helper-unavailable: no waiver, shells are denied", async (_label, cause) => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OK);
    h.initialize.mockRejectedValue(Object.assign(new Error("sandbox: refusing confinement, the Ave home read boundary cannot be projected", { cause }),
      { code: "ave-home-boundary-unverified", reason: "unlisted", home: "C:\\Users\\alice\\.ave" }));

    const context = harness.context(false, true);
    context.bootAuditLogger.log = vi.fn();
    await initSandboxGate(context);

    expect(getAveHomePrivacyFailure()).toMatchObject({ enforcement: "none", category: "helper-unavailable" });
    expect(() => assertAveHomePrivacyForConfinement()).toThrow("Restart Ave; if it persists, reinstall Ave.");
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("read boundary could not be verified"), "ave-home-boundary-unverified", "helper-unavailable",
      "Extensions stay blocked until a restart; if it persists, reinstall Ave.");
    for (const plan of [getHostShellExecutionPlan(), getHostShellExecutionPlan("host")]) {
      expect(plan).toMatchObject({ mode: "blocked", fallbackReason: "home-privacy-helper-unavailable", requiresExplicitUserApproval: false });
      expect(requiresUnsandboxedShellAsk(plan)).toBe(false);
    }
  });

  // A profile-child home's container deny rows are pinned through the same helper, so a proxy-only start cannot isolate it.
  it("refuses contained shells on a proxy-only start when the home privacy helper gave no answer", async () => {
    setAveHomePrivacyAtBoot({ enforcement: "none", home: "C:\\Users\\alice\\.ave", category: "helper-unavailable", reason: "no answer" });
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    const context = harness.context(true, true);
    context.bootAuditLogger.log = vi.fn();

    await initSandboxGate(context);

    expect(h.initialize).not.toHaveBeenCalled();
    expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade", reason: "degrade-ave-home-privacy-failed" });
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "none" }));
    for (const plan of [getHostShellExecutionPlan(), getHostShellExecutionPlan("host")]) {
      expect(plan).toMatchObject({ mode: "blocked", sandboxed: false, substrate: "none", fallbackReason: "home-privacy-helper-unavailable" });
    }
  });

  it("keeps the proxy-only container route for an approvable home privacy failure", async () => {
    setAveHomePrivacyAtBoot({ enforcement: "none", home: "C:\\Users\\alice\\.ave", category: "read-back-failed", reason: "read-back failed" });
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);

    await initSandboxGate(harness.context(true, true));

    expect(getSandboxBootOutcome()).toMatchObject({ action: "activate", reason: "activate-windows-mxc-proxy-only" });
    await vi.waitFor(() => expect(getHostShellExecutionPlan()).toMatchObject({ mode: "asrt", substrate: "mxc" }));
  });

  it("keeps the ordinary sandbox-off plan when a worker-only boot fails for another reason", async () => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OK);
    h.initialize.mockRejectedValue(Object.assign(new Error("proxy failed to bind"), { code: "EADDRINUSE" }));

    await initSandboxGate(harness.context(false, true));

    const plan = getHostShellExecutionPlan();
    expect(plan).toMatchObject({ requestedSandbox: false, fallbackReason: "disabled-by-setting", requiresExplicitUserApproval: false });
    expect(plan.identity.endsWith(":ask")).toBe(false);
    expect(requiresUnsandboxedShellAsk(plan)).toBe(false);
  });

  it("puts shells on the forced ask when the proxy-only start itself fails", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    h.initialize.mockRejectedValue(Object.assign(new Error("proxy failed to bind"), { code: "EADDRINUSE" }));

    await initSandboxGate(harness.context(true, false));

    expect(h.initialize).toHaveBeenCalledOnce();
    expect(h.initialize.mock.calls[0]?.[0]).toHaveProperty("windows.externalConfinement", true);
    expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade", reason: "degrade-windows-init-failed", causes: ["init-failed"] });
    expect(detectShellSandboxCapability().kind).toBe("none");
    const plan = getHostShellExecutionPlan();
    expect(plan).toMatchObject({ platform: "win32", mode: "plain", sandboxed: false, fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: true });
    expect(requiresUnsandboxedShellAsk(plan)).toBe(true);
    expect(plan).not.toHaveProperty("installHints");
  });

  it("keeps the generic Windows degrade for any other initialization failure", async () => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OLD);
    h.initialize.mockRejectedValue(Object.assign(new Error("proxy failed to bind"), { code: "EADDRINUSE" }));

    await initSandboxGate(harness.context(true, true));

    expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade", reason: "degrade-windows-init-failed", causes: ["init-failed"] });
    expect(getAveHomePrivacyFailure()).toBeUndefined();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("isolation=none"));
  });

  it.each([
    { label: "a mapped drive", rows: [{ row: "M:\\alice\\.ssh", reason: "mapped-drive" as const }], cause: "windows-deny-unenforceable", kind: "network" },
    { label: "a local helper failure", rows: [{ row: "C:\\alice\\.ssh", reason: "helper-unavailable" as const }], cause: "windows-deny-path-unenforceable", kind: "path" },
    { label: "a share next to a device row", rows: [{ row: "\\\\srv\\s\\x", reason: "share" as const }, { row: "\\\\.\\pipe\\x", reason: "device" as const }], cause: "windows-deny-path-unenforceable", kind: "path" },
  ])("routes an unenforceable Windows deny on $label to the forced sandbox-unavailable question with its own cause, never a proxy-only retry", async ({ rows, cause, kind }) => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OK);
    h.initialize.mockRejectedValue(new ObligationRefusedError(rows));
    try {
      await initSandboxGate(harness.context(true, true));

      expect(h.initialize).toHaveBeenCalledTimes(1);
      expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade", reason: "degrade-windows-init-failed", causes: [cause] });
      expect(windowsDenyUnenforceableAtBoot()).toBe(kind);
      const plan = getHostShellExecutionPlan();
      expect(plan).toMatchObject({ mode: "plain", fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: true });
      expect(requiresUnsandboxedShellAsk(plan)).toBe(true);
    } finally {
      setWindowsDenyUnenforceableAtBoot(undefined);
    }
  });

  it("clears an earlier deny refusal after Windows sandbox initialization succeeds", async () => {
    h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
    h.detectMxc.mockResolvedValue(MXC_OK);
    setWindowsDenyUnenforceableAtBoot("path");
    try {
      await initSandboxGate(harness.context(true, true));
      expect(getSandboxBootOutcome()).toMatchObject({ action: "activate" });
      expect(windowsDenyUnenforceableAtBoot()).toBeUndefined();
    } finally {
      setWindowsDenyUnenforceableAtBoot(undefined);
    }
  });

  it("records the withdrawn substrate when ASRT fails to initialize", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    h.initialize.mockRejectedValue(new Error("proxy failed to bind"));

    await initSandboxGate(harness.context(true, false));

    expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade" });
    expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "none", extensions: "none", mxc: { state: "checking" } });
    expect(h.startProbe).not.toHaveBeenCalled();
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
    expect(h.initialize.mock.calls[0]?.[0]).toHaveProperty("windows.backgroundInitialization", true);
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

  it("reports a status change once the start probe settles, with the settled plan already readable", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    let finishProbe!: (value: unknown) => void;
    h.startProbe.mockReturnValue(new Promise((resolve) => { finishProbe = resolve; }));

    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(h.startProbe).toHaveBeenCalledOnce());
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "plain", requiresExplicitUserApproval: true });

    // A renderer that read the checking-phase plan learns of the settle only through this notification.
    const observed: { mxc: string | undefined; mode: string }[] = [];
    setSandboxStatusChangeListener(() => {
      observed.push({ mxc: getWindowsSandboxSubstrate()?.mxc.state, mode: getHostShellExecutionPlan().mode });
    });
    finishProbe({ state: "available", windowsBuild: "10.0.26300.9711" });

    await vi.waitFor(() => expect(observed).toContainEqual({ mxc: "available", mode: "asrt" }));
    expect(observed.every((entry) => entry.mxc === "available")).toBe(true);
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
