vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

/** Check each Windows substrate combination and the boot outcome reported to Settings. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { afterQueuedCallbacks, deferred } from "../../__tests__/support/deferred.js";
import { readMxcRawIpProbeScript } from "../../__tests__/support/mxc-raw-ip-probe.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  createSandboxBootHarness,
  type SandboxBootHarness,
} from "../../__tests__/support/sandbox-boot-context.js";

// This file's private sandbox root, unique per process so concurrent vitest runs never remove each other's.
const SANDBOX_ROOT_NAME = vi.hoisted(() => `ave-sandbox-init-windows-mxc-sandbox-${process.pid}-${Math.random().toString(16).slice(2)}`);
const h = vi.hoisted(() => ({
  initialize: vi.fn(),
  checkDeps: vi.fn(),
  accountInventory: vi.fn(),
  accountDependencies: vi.fn(),
  offlineConfinement: vi.fn(),
  accountOperational: vi.fn(),
  requireLauncher: vi.fn(),
  verifyLauncher: vi.fn(),
  runtimeActive: vi.fn(),
  detectMxc: vi.fn(),
  startProbe: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  homesCalls: [] as string[],
  establishHomesError: undefined as Error | undefined,
  homesParentError: undefined as Error | undefined,
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
    mxcSandboxHomesParent: () => {
      h.homesCalls.push("parent");
      if (h.homesParentError !== undefined) throw h.homesParentError;
      return "C:/example/ave-runtime/homes";
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

vi.mock("../dev-flags.js", async (original) => ({
  ...await original<typeof import("../dev-flags.js")>(),
  isPackagedElectronProcess: () => true,
}));

vi.mock("../../permissions/mxc-windows.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permissions/mxc-windows.js")>(),
  detectHostMxcPrerequisites: h.detectMxc,
  probeHostMxcPowerShellStart: h.startProbe,
  getHostWxcExecIdentity: h.requireLauncher,
  resolveHostWxcExecPath: h.verifyLauncher,
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  resolveSrtWin: ({ path }: { path: string }) => ({ exe: path, prependArgs: [] }),
  checkWindowsDependenciesAsync: h.accountDependencies,
  checkWindowsSandboxStatusAsync: h.accountInventory,
  windowsInstallInstructions: () => "Complete Windows sandbox setup.",
}));
vi.mock("../../permissions/srt-win-integrity.js", async original => ({
  ...await original<typeof import("../../permissions/srt-win-integrity.js")>(),
  getVerifiedSrtWinExePath: () => "C:/example/resources/srt-win.exe",
}));

vi.mock("../../permissions/asrt-sandbox.js", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const roots = join(tmpdir(), SANDBOX_ROOT_NAME);
  return {
    appOwnedSandboxTempRoot: () => join(roots, "tmp"),
    isAsrtSandboxActive: h.runtimeActive,
    isWindowsBackgroundConfinementRuntimeActive: h.runtimeActive,
    isOfflineProcessConfinementActive: h.offlineConfinement,
    isWindowsAccountConfinementOperational: async () => h.accountOperational(),
    getWindowsConfinementRoute: () => [h.runtimeActive(), h.offlineConfinement()],
    getWindowsAccountConfinementHelperIdentity: () => undefined,
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
import { HOST_CONTAINER_ABSENCE_PROBE } from "../../__tests__/support/mxc-probe-report.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { createMemoryMapRuntime } from "../../ipc/domains/memory-map-runtime-win32.js";
import { rendererSettingsSnapshot } from "../../ipc/domains/settings.js";
import type { IpcDeps } from "../../ipc/types.js";
import { assertLocalEmbeddingRuntime } from "../../main/memory-map/local-runtime-win32.js";
import { SessionRepository } from "../../memory/session-repository.js";
import { WindowsSessionRepository } from "../../memory/session-repository-win32.js";
import { SessionSearchIndex } from "../../memory/session-search-index.js";
import { registerMxcReleaseGateEvidence } from "../../permissions/mxc-extension-admission.js";
import { detectMxcPrerequisites, pinnedWxcExecSha256 } from "../../permissions/mxc-windows.js";
import { refreshWindowsBackgroundAdmission, sessionSearchIndexPolicySource } from "../../permissions/windows-background-features.js";
import { invalidateWindowsBackendEvidence } from "../../permissions/windows-confinement-evidence.js";
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
  getWindowsMxcShellEgressMeasurement,
  getWindowsSandboxSubstrate,
  markSandboxGatePendingAtBoot,
  markSandboxHomesUnavailable,
  setShellSandboxRequestedAtBoot,
  setSandboxStatusChangeListener,
} from "../../permissions/sandbox-capability.js";

const ORIGINAL_PLATFORM = process.platform;
const SRT_WIN_MISSING = { errors: ["no srt-win path configured"], warnings: [] };
// Boot-path checks precede the shell start probe.
const MXC_OK = { state: "available", windowsBuild: "10.0.26300.9711" };
const MXC_OLD = { state: "unavailable", reason: "container-unavailable", windowsBuild: "10.0.22631.4317", detail: "no container API" };
const NO_CONTAINER = { ...MXC_OLD, baseContainerApiPresent: false, containerBackendAbsent: true };
const EMPTY_ACCOUNT_INVENTORY = {
  user: { provisioned: false, groupExists: false, credPresent: false, inBuiltinUsers: false,
    inSandboxGroup: false, hiddenFromLogon: false, realUserSid: "S-1-5-21-1000" },
  wfp: { state: "absent", filters: 0 },
};
const NO_ACCOUNT_BACKEND = { errors: [], warnings: [], accountBackendAbsent: true };
const RELEASE_EVIDENCE = {
  ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true,
  forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true,
};

let harness: SandboxBootHarness;

beforeAll(() => {
  // Cache the host's native binding before the boot cases impersonate win32.
  const Database = createRequire(import.meta.url)("better-sqlite3") as typeof BetterSqlite3;
  new Database(":memory:").close();
});

beforeEach(() => {
  harness = createSandboxBootHarness();
  setProcessPlatform("win32");
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSandboxBootOutcomeForTest();
  __resetWindowsSandboxSubstrateForTest();
  __resetSandboxHomesUnavailableForTest();
  h.initialize.mockReset();
  h.initialize.mockImplementation(async () => { h.runtimeActive.mockReturnValue(true); });
  h.offlineConfinement.mockReset().mockReturnValue(false);
  h.accountOperational.mockReset().mockImplementation(() => h.offlineConfinement());
  h.requireLauncher.mockReset().mockReturnValue("C:/example/resources/wxc-exec.exe");
  h.verifyLauncher.mockReset().mockImplementation(async () => h.requireLauncher());
  h.runtimeActive.mockReset().mockReturnValue(false);
  h.checkDeps.mockReset();
  h.detectMxc.mockReset();
  h.startProbe.mockReset();
  h.startProbe.mockResolvedValue({ state: "available", windowsBuild: "10.0.26300.9711" });
  h.homesCalls.length = 0;
  h.establishHomesError = undefined;
  h.homesParentError = undefined;
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

const ACCOUNT_DEPS_READY = { errors: [], warnings: [] };

it.each([
  { label: "operational account runtime", mxc: MXC_OLD, deps: ACCOUNT_DEPS_READY, accountStarted: true },
  { label: "verified container shell", mxc: MXC_OK, deps: SRT_WIN_MISSING, containerStarted: true },
  { label: "inconclusive container with dependencies only", mxc: MXC_OLD, deps: ACCOUNT_DEPS_READY, inactive: true },
  { label: "inconclusive container without dependencies", mxc: MXC_OLD, deps: SRT_WIN_MISSING, inactive: true },
  { label: "degraded after account initialization fails", mxc: MXC_OLD, deps: ACCOUNT_DEPS_READY, initFailure: "startup", inactive: true },
  { label: "degraded after deferred account isolation fails", mxc: MXC_OLD, deps: ACCOUNT_DEPS_READY, initFailure: "background", inactive: true },
  { label: "still checking", mxc: MXC_OK, deps: NO_ACCOUNT_BACKEND, inactive: true },
  { label: "confirmed absent", mxc: NO_CONTAINER, deps: NO_ACCOUNT_BACKEND, absent: true },
])("defers boot and reconciliation indexing with stored false until the backend is $label", async ({ mxc, deps, absent, inactive, accountStarted, containerStarted, initFailure }) => {
  const unregister = registerMxcReleaseGateEvidence(RELEASE_EVIDENCE);
  const dir = mkdtempSync(join(tmpdir(), "ave-boot-session-index-"));
  const mainDir = join(dir, "main");
  const isolatedDir = join(dir, "isolated");
  const mainIndex = join(mainDir, "search", "index.db");
  const isolatedIndex = join(isolatedDir, "search", "index.db");
  const searchIndexPolicy = sessionSearchIndexPolicySource(() => false);
  const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
  const root = "C:/example/workspace";
  try {
    await new SessionRepository({ aveDir: mainDir }).saveSession(sessionId, [{ role: "user", content: "boot evidence" }]);
    const isolatedSeed = new SessionRepository({ aveDir: isolatedDir });
    await isolatedSeed.saveSession(sessionId, [{ role: "user", content: "detachment evidence" }]);
    await isolatedSeed.saveSessionMetadata(sessionId, { sessionKind: "main", projectRoot: root, title: "Session" });
    const main = new WindowsSessionRepository({ aveDir: mainDir, ...searchIndexPolicy });
    const isolated = new WindowsSessionRepository({ aveDir: isolatedDir, ...searchIndexPolicy });
    const originalMainIndex = readFileSync(mainIndex);
    const originalIsolatedIndex = readFileSync(isolatedIndex);
    const openIndex = vi.spyOn(SessionSearchIndex.prototype, "open");
    const rebuildIndex = vi.spyOn(SessionSearchIndex.prototype, "writeRebuiltSessions");
    const updateIndex = vi.spyOn(SessionSearchIndex.prototype, "upsertSession");
    const discardIndex = vi.spyOn(SessionSearchIndex.prototype, "discard");
    try {
      markSandboxGatePendingAtBoot();
      await main.verifyOrRebuildSearchIndex();
      await expect(isolated.detachSessionsFromProject(root)).resolves.toBe(1);
      await isolated.searchIndexIdle();
      expect.soft(existsSync(mainIndex)).toBe(true);
      expect.soft(existsSync(isolatedIndex)).toBe(true);
      expect.soft(openIndex).not.toHaveBeenCalled();

      setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
      h.checkDeps.mockResolvedValue(deps);
      h.detectMxc.mockResolvedValue(mxc);
      if (initFailure === "startup") h.initialize.mockRejectedValueOnce(new Error("account isolation startup failed"));
      if (initFailure === "background") {
        h.initialize.mockResolvedValueOnce({
          windowsIsolation: Promise.resolve({ status: "failed", error: new Error("account isolation setup failed") }),
          isCurrent: () => true,
        });
      }
      if (accountStarted) {
      h.initialize.mockImplementationOnce(async () => {
        h.runtimeActive.mockReturnValue(true);
        h.offlineConfinement.mockReturnValue(true);
      });
      }
      await initSandboxGate(harness.context(Boolean(accountStarted || containerStarted || initFailure), false));
      if (containerStarted) await vi.waitFor(() => expect(getWindowsSandboxSubstrate()?.shells).toBe("mxc"));
      if (initFailure) {
        expect(h.initialize).toHaveBeenCalledOnce();
        expect(getSandboxBootOutcome()).toMatchObject({ action: "degrade", reason: "degrade-windows-init-failed" });
        expect(getWindowsSandboxSubstrate()).toMatchObject({
          srtWinReady: true, shells: initFailure === "startup" ? "none" : "approved-host", extensions: "none",
        });
      }
      await main.verifyOrRebuildSearchIndex();
      await isolated.verifyOrRebuildSearchIndex();
      expect(existsSync(mainIndex)).toBe(!absent);
      expect(existsSync(isolatedIndex)).toBe(!absent);
      if (inactive) {
        await main.saveSession(sessionId, [{ role: "user", content: "deferred indexing update" }]);
        await main.searchIndexIdle();
        expect.soft((await refreshWindowsBackgroundAdmission()).searchIndexPolicy(false)).toBe("inactive");
        expect.soft(readFileSync(mainIndex).equals(originalMainIndex)).toBe(true);
        expect.soft(readFileSync(isolatedIndex).equals(originalIsolatedIndex)).toBe(true);
        expect.soft(rebuildIndex).not.toHaveBeenCalled();
        expect.soft(updateIndex).not.toHaveBeenCalled();
        expect.soft(discardIndex).not.toHaveBeenCalled();
      }
      if (absent || inactive) {
        expect.soft(await main.searchSessionsWithCurrentPolicy("boot evidence")).toHaveLength(0);
        expect.soft(await isolated.searchSessionsWithCurrentPolicy("detachment evidence")).toHaveLength(0);
        expect(openIndex).not.toHaveBeenCalled();
      } else {
        expect(await main.searchSessionsWithCurrentPolicy("boot evidence")).toHaveLength(1);
        expect(await isolated.searchSessionsWithCurrentPolicy("detachment evidence", { projectRoot: root })).toHaveLength(0);
        expect(await isolated.searchSessionsWithCurrentPolicy("detachment evidence")).toHaveLength(1);
      }
      expect(isolated.loadSessionMetadata(sessionId)?.projectRoot).toBeUndefined();
    } finally {
      openIndex.mockRestore();
      rebuildIndex.mockRestore();
      updateIndex.mockRestore();
      discardIndex.mockRestore();
      main.closeSearchIndex();
      isolated.closeSearchIndex();
    }
  } finally {
    unregister();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  { label: "published HOME refusal", revoke: () => markSandboxHomesUnavailable() },
  { label: "HOME parent identity loss", revoke: () => { h.homesParentError = new Error("HOME parent changed identity"); } },
  { label: "withdrawn shell route", revoke: () => setShellSandboxRequestedAtBoot(false) },
  { label: "stopped proxy runtime", revoke: () => h.runtimeActive.mockReturnValue(false) },
  { label: "container launcher loss", preservesRoute: true, revoke: () => h.requireLauncher.mockImplementation(() => { throw new Error("launcher missing"); }) },
  { label: "account readiness loss", preservesRoute: true, account: true, revoke: () => h.accountOperational.mockReturnValue(false) },
  { label: "account egress or identity proof that cannot be gathered", preservesRoute: true, account: true,
    revoke: () => h.accountOperational.mockImplementation(() => { throw new Error("egress proof failed"); }) },
  { label: "container native startup loss", preservesRoute: true,
    revoke: () => h.startProbe.mockResolvedValue({ state: "unavailable", reason: "powershell-start-failed", windowsBuild: "10.0.26300.9711" }) },
  { label: "container start that cannot be attempted", preservesRoute: true, revoke: () => h.startProbe.mockRejectedValue(new Error("start failed")) },
  { label: "loss signal before final admission", preservesRoute: true,
    revoke: () => h.startProbe.mockImplementation(async () => { invalidateWindowsBackendEvidence(); return MXC_OK; }) },
])("preserves the host index after live confinement loses health: $label", async ({ revoke, account, preservesRoute }) => {
  const unregister = registerMxcReleaseGateEvidence(RELEASE_EVIDENCE);
  const dir = mkdtempSync(join(tmpdir(), "ave-boot-session-index-"));
  const indexPath = join(dir, "search", "index.db");
  const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
  const projectRoot = "C:/example/workspace";
  const repository = new WindowsSessionRepository({ aveDir: dir, ...sessionSearchIndexPolicySource(() => false) });
  try {
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
    h.checkDeps.mockResolvedValue(account ? ACCOUNT_DEPS_READY : SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(account ? MXC_OLD : MXC_OK);
    if (account) h.initialize.mockImplementationOnce(async () => {
      h.runtimeActive.mockReturnValue(true);
      h.offlineConfinement.mockReturnValue(true);
    });
    await initSandboxGate(harness.context(true, false));
    if (!account) {
      await vi.waitFor(() => expect(getWindowsSandboxSubstrate()?.shells).toBe("mxc"));
      expect(getHostShellExecutionPlan()).toMatchObject({ substrate: "mxc", sandboxed: true });
    }
    const publishedSubstrate = getWindowsSandboxSubstrate();
    await repository.saveSession(sessionId, [{ role: "user", content: "indexed before refusal" }]);
    await repository.saveSessionMetadata(sessionId, { projectRoot });
    expect(await repository.searchSessionsWithCurrentPolicy("indexed before refusal", { projectRoot })).toHaveLength(1);
    const originalIndex = readFileSync(indexPath);

    revoke();
    const openIndex = vi.spyOn(SessionSearchIndex.prototype, "open");
    const rebuildIndex = vi.spyOn(SessionSearchIndex.prototype, "writeRebuiltSessions");
    const updateIndex = vi.spyOn(SessionSearchIndex.prototype, "upsertSession");
    const deleteRow = vi.spyOn(SessionSearchIndex.prototype, "deleteSession");
    const discardIndex = vi.spyOn(SessionSearchIndex.prototype, "discard");
    try {
      await repository.verifyOrRebuildSearchIndex();
      expect.soft(await repository.searchSessionsWithCurrentPolicy("indexed before refusal")).toEqual([]);
      await repository.saveSession(sessionId, [{ role: "user", content: "changed after refusal" }]);
      await repository.saveSessionMetadata(sessionId, { projectRoot, title: "Changed title" });
      await expect(repository.detachSessionsFromProject(projectRoot)).resolves.toBe(1);
      await repository.deleteSession(sessionId);
      await repository.searchIndexIdle();
      expect.soft((await refreshWindowsBackgroundAdmission()).searchIndexPolicy(false)).toBe("inactive");
      expect.soft(openIndex).toHaveBeenCalledTimes(0);
      expect.soft(rebuildIndex).toHaveBeenCalledTimes(0);
      expect.soft(updateIndex).toHaveBeenCalledTimes(0);
      expect.soft(deleteRow).toHaveBeenCalledTimes(0);
      expect.soft(discardIndex).toHaveBeenCalledTimes(0);
      if (preservesRoute) {
        expect.soft(getWindowsSandboxSubstrate()).toBe(publishedSubstrate);
        expect.soft(getSandboxHomesUnavailable()).toBe(false);
        expect.soft(h.runtimeActive()).toBe(true);
        if (account) expect.soft(h.offlineConfinement()).toBe(true);
        else expect.soft(getHostShellExecutionPlan()).toMatchObject({ substrate: "mxc", sandboxed: true });
      }
      expect(readFileSync(indexPath).equals(originalIndex)).toBe(true);
    } finally {
      openIndex.mockRestore();
      rebuildIndex.mockRestore();
      updateIndex.mockRestore();
      deleteRow.mockRestore();
      discardIndex.mockRestore();
    }
  } finally {
    repository.closeSearchIndex();
    unregister();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(["route withdrawal", "launcher identity replacement", "launcher verification failure"] as const)(
  "refuses a container receipt after %s with the same boot record", async loss => {
    const unregister = registerMxcReleaseGateEvidence(RELEASE_EVIDENCE);
    try {
      setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
      h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
      h.detectMxc.mockResolvedValue(MXC_OK);
      await initSandboxGate(harness.context(true, false));
      await vi.waitFor(() => expect(getWindowsSandboxSubstrate()?.shells).toBe("mxc"));
      const published = getWindowsSandboxSubstrate();
      const answer = deferred<object>();
      h.startProbe.mockClear().mockReturnValue(answer.promise);
      if (loss === "launcher verification failure") h.verifyLauncher.mockRejectedValueOnce(new Error("launcher failed verification"));
      const pending = refreshWindowsBackgroundAdmission();
      if (loss !== "launcher verification failure") await vi.waitFor(() => expect(h.startProbe).toHaveBeenCalledOnce());
      if (loss === "route withdrawal") {
        setShellSandboxRequestedAtBoot(false);
        setShellSandboxRequestedAtBoot(true);
      }
      answer.resolve(MXC_OK);
      const admission = await pending;
      if (loss === "launcher identity replacement") h.requireLauncher.mockReturnValue("replaced launcher identity");
      expect(getWindowsSandboxSubstrate()).toBe(published);
      expect(admission.searchIndexPolicy(true)).toBe("inactive");
    } finally {
      unregister();
    }
  },
);

it.each([false, true])("does no SQLite work for a superseded refresh (first inventory clean: %s)", async firstClean => {
  const unregister = registerMxcReleaseGateEvidence(RELEASE_EVIDENCE);
  const dir = mkdtempSync(join(tmpdir(), "ave-boot-session-index-"));
  const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
  const seed = new SessionRepository({ aveDir: dir });
  await seed.saveSession(sessionId, [{ role: "user", content: "indexed before overlap" }]);
  seed.closeSearchIndex();
  const repository = new WindowsSessionRepository({ aveDir: dir, ...sessionSearchIndexPolicySource(() => false) });
  try {
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
    h.checkDeps.mockResolvedValue(NO_ACCOUNT_BACKEND);
    h.detectMxc.mockResolvedValue(NO_CONTAINER);
    await initSandboxGate(harness.context(false, false));
    h.checkDeps.mockClear();
    const rejected = { ...NO_ACCOUNT_BACKEND, warnings: ["inventory incomplete"] };
    h.checkDeps.mockResolvedValue(rejected).mockResolvedValueOnce(firstClean ? NO_ACCOUNT_BACKEND : rejected)
      .mockResolvedValueOnce(firstClean ? rejected : NO_ACCOUNT_BACKEND);
    const slow = deferred<object>();
    const late = deferred<object>();
    const lateProbeStarted = deferred<void>();
    h.detectMxc.mockClear().mockReturnValueOnce(slow.promise).mockImplementationOnce(() => {
      lateProbeStarted.resolve();
      return late.promise;
    });
    const methods = ["open", "writeRebuiltSessions", "upsertSession", "deleteSession", "discard"] as const;
    const sqlite = methods.map(method => vi.spyOn(SessionSearchIndex.prototype, method));
    try {
      const search = repository.searchSessionsWithCurrentPolicy("indexed before overlap");
      await repository.saveSession(sessionId, [{ role: "user", content: "saved during overlap" }]);
      const second = refreshWindowsBackgroundAdmission();
      await afterQueuedCallbacks();
      slow.resolve(NO_CONTAINER);
      expect((await second).areSwitchesAvailable()).toBe(!firstClean);
      expect(await search).toEqual([]);
      await lateProbeStarted.promise;
      for (const call of sqlite) expect.soft(call).not.toHaveBeenCalled();
      late.resolve(NO_CONTAINER);
      await repository.searchIndexIdle();
      expect(h.detectMxc).toHaveBeenCalledTimes(2);
      expect(h.checkDeps).toHaveBeenCalledTimes(3);
      for (const call of sqlite) expect.soft(call).not.toHaveBeenCalled();
    } finally {
      slow.resolve(NO_CONTAINER);
      late.resolve(NO_CONTAINER);
      await repository.searchIndexIdle();
      for (const call of sqlite) call.mockRestore();
    }
  } finally {
    repository.closeSearchIndex();
    unregister();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(["failed", "refused"] as const)("keeps progress and other reads responsive while a native answer is delayed, and indexes nothing once it has %s", async (outcome) => {
  const unregister = registerMxcReleaseGateEvidence(RELEASE_EVIDENCE);
  const dir = mkdtempSync(join(tmpdir(), "ave-boot-session-index-"));
  const indexPath = join(dir, "search", "index.db");
  const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
  const repository = new WindowsSessionRepository({ aveDir: dir, ...sessionSearchIndexPolicySource(() => undefined) });
  try {
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()?.shells).toBe("mxc"));
    await repository.saveSession(sessionId, [{ role: "user", content: "indexed before the delay" }]);
    expect(await repository.searchSessionsWithCurrentPolicy("indexed before the delay")).toHaveLength(1);
    const originalIndex = readFileSync(indexPath);

    const answer = deferred<object>();
    h.startProbe.mockClear().mockReturnValue(answer.promise);
    const openIndex = vi.spyOn(SessionSearchIndex.prototype, "open");
    const updateIndex = vi.spyOn(SessionSearchIndex.prototype, "upsertSession");
    const discardIndex = vi.spyOn(SessionSearchIndex.prototype, "discard");
    try {
      const verify = repository.verifyOrRebuildSearchIndex();
      await repository.saveSession(sessionId, [{ role: "user", content: "changed during the delay" }]);
      await repository.saveSessionMetadata(sessionId, { title: "Saved during the delay" });
      const search = repository.searchSessionsWithCurrentPolicy("indexed before the delay");
      await expect(repository.appendSessionProgress(sessionId, [
        { role: "user", content: "changed during the delay" }, { role: "assistant", content: "progress during the delay" },
      ])).resolves.toEqual(expect.any(String));
      await afterQueuedCallbacks();
      expect(repository.loadSession(sessionId)).toHaveLength(2);
      expect(repository.listSessions()).toHaveLength(1);
      expect(repository.searchSessions("indexed before the delay")).toEqual([]);
      // Both settings channels answer from the boot record of a present backend: no native query, no wait.
      const settingsService = {
        getAll: () => DEFAULT_SETTINGS,
        get: (key: keyof typeof DEFAULT_SETTINGS) => DEFAULT_SETTINGS[key],
        hasStoredSecret: async () => false,
      };
      const memoryMap = createMemoryMapRuntime({ settingsService, singleHopNetworkFetch: vi.fn() } as unknown as IpcDeps, vi.fn());
      const inventories = h.detectMxc.mock.calls.length + h.checkDeps.mock.calls.length;
      expect((await rendererSettingsSnapshot(settingsService as unknown as IpcDeps["settingsService"])).features ?? {})
        .not.toHaveProperty("sessionIndexingWithoutContainment");
      expect(await memoryMap.settingsGet()).not.toHaveProperty("localInferenceWithoutSandbox");
      expect(h.detectMxc.mock.calls.length + h.checkDeps.mock.calls.length).toBe(inventories);
      expect(h.startProbe).toHaveBeenCalledOnce();
      expect(openIndex).toHaveBeenCalledTimes(0);

      answer.resolve(outcome === "failed" ? Promise.reject(new Error("native answer failed"))
        : { state: "unavailable", reason: "powershell-start-failed", windowsBuild: "10.0.26300.9711" });
      await verify;
      expect(await search).toEqual([]);
      expect(openIndex).toHaveBeenCalledTimes(0);
      expect(updateIndex).toHaveBeenCalledTimes(0);
      expect(discardIndex).toHaveBeenCalledTimes(0);
      expect(readFileSync(indexPath).equals(originalIndex)).toBe(true);
    } finally {
      openIndex.mockRestore();
      updateIndex.mockRestore();
      discardIndex.mockRestore();
    }
  } finally {
    repository.closeSearchIndex();
    unregister();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses index work still waiting for a native answer when the store closes, and leaves it for repair", async () => {
  const unregister = registerMxcReleaseGateEvidence(RELEASE_EVIDENCE);
  const dir = mkdtempSync(join(tmpdir(), "ave-boot-session-index-"));
  const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
  const repository = new WindowsSessionRepository({ aveDir: dir, ...sessionSearchIndexPolicySource(() => undefined) });
  try {
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()?.shells).toBe("mxc"));
    const answer = deferred<object>();
    h.startProbe.mockReturnValue(answer.promise);
    const openIndex = vi.spyOn(SessionSearchIndex.prototype, "open");
    try {
      await repository.saveSession(sessionId, [{ role: "user", content: "saved before closing" }]);
      const search = repository.searchSessionsWithCurrentPolicy("saved before closing");
      repository.closeSearchIndex();
      expect(await search).toEqual([]);
      expect(existsSync(join(dir, "sessions", ".search-repair.json"))).toBe(true);
      answer.resolve(MXC_OK);
      await repository.searchIndexIdle();
      expect(openIndex).toHaveBeenCalledTimes(0);
    } finally {
      openIndex.mockRestore();
    }
  } finally {
    repository.closeSearchIndex();
    unregister();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  ["a present account backend", () => h.checkDeps.mockResolvedValue(ACCOUNT_DEPS_READY)],
  ["an account backend that cannot be queried", () => h.checkDeps.mockRejectedValue(new Error("inventory failed"))],
  ["a present container backend", () => h.detectMxc.mockResolvedValue(MXC_OK)],
  ["a container backend that cannot be queried", () => h.detectMxc.mockRejectedValue(new Error("probe failed"))],
] as const)("stops unconfined indexing and both switches once published absence meets %s", async (_label, change) => {
  const unregister = registerMxcReleaseGateEvidence(RELEASE_EVIDENCE);
  const dir = mkdtempSync(join(tmpdir(), "ave-boot-session-index-"));
  const indexPath = join(dir, "search", "index.db");
  const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
  const repository = new WindowsSessionRepository({ aveDir: dir, ...sessionSearchIndexPolicySource(() => true) });
  try {
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
    h.checkDeps.mockResolvedValue(NO_ACCOUNT_BACKEND);
    h.detectMxc.mockResolvedValue(NO_CONTAINER);
    await initSandboxGate(harness.context(false, false));
    const publishedSubstrate = getWindowsSandboxSubstrate();
    expect((await refreshWindowsBackgroundAdmission("switches")).areSwitchesAvailable()).toBe(true);
    expect(assertLocalEmbeddingRuntime(true, await refreshWindowsBackgroundAdmission())).toBe("unconfined");
    const settingsService = {
      getAll: () => DEFAULT_SETTINGS,
      get: (key: keyof typeof DEFAULT_SETTINGS) => DEFAULT_SETTINGS[key],
      set: vi.fn(),
      hasStoredSecret: async () => false,
    };
    const memoryMap = createMemoryMapRuntime({ settingsService, singleHopNetworkFetch: vi.fn() } as unknown as IpcDeps, vi.fn());
    const generalSettings = async () => (await rendererSettingsSnapshot(settingsService as unknown as IpcDeps["settingsService"])).features ?? {};
    expect(await generalSettings()).toHaveProperty("sessionIndexingWithoutContainment");
    expect(await memoryMap.settingsGet()).toHaveProperty("localInferenceWithoutSandbox");
    await repository.saveSession(sessionId, [{ role: "user", content: "indexed without a backend" }]);
    expect(await repository.searchSessionsWithCurrentPolicy("indexed without a backend")).toHaveLength(1);
    const originalIndex = readFileSync(indexPath);

    change();
    const openIndex = vi.spyOn(SessionSearchIndex.prototype, "open");
    const updateIndex = vi.spyOn(SessionSearchIndex.prototype, "upsertSession");
    const discardIndex = vi.spyOn(SessionSearchIndex.prototype, "discard");
    try {
      await repository.verifyOrRebuildSearchIndex();
      await repository.saveSession(sessionId, [{ role: "user", content: "changed after the backend appeared" }]);
      await repository.searchIndexIdle();
      expect.soft(await repository.searchSessionsWithCurrentPolicy("indexed without a backend")).toEqual([]);
      expect.soft((await refreshWindowsBackgroundAdmission("switches")).areSwitchesAvailable()).toBe(false);
      expect.soft(await generalSettings()).not.toHaveProperty("sessionIndexingWithoutContainment");
      expect.soft(await memoryMap.settingsGet()).not.toHaveProperty("localInferenceWithoutSandbox");
      await expect.soft(memoryMap.settingsSet({ localInferenceWithoutSandbox: false })).rejects.toMatchObject({ code: "local-runtime-unavailable" });
      expect.soft(settingsService.set).not.toHaveBeenCalled();
      const admission = await refreshWindowsBackgroundAdmission();
      expect.soft(() => assertLocalEmbeddingRuntime(true, admission)).toThrow(expect.objectContaining({ code: "local-runtime-unavailable" }));
      expect.soft(openIndex).toHaveBeenCalledTimes(0);
      expect.soft(updateIndex).toHaveBeenCalledTimes(0);
      expect.soft(discardIndex).toHaveBeenCalledTimes(0);
      expect.soft(getWindowsSandboxSubstrate()).toBe(publishedSubstrate);
      expect(readFileSync(indexPath).equals(originalIndex)).toBe(true);
    } finally {
      openIndex.mockRestore();
      updateIndex.mockRestore();
      discardIndex.mockRestore();
    }
  } finally {
    repository.closeSearchIndex();
    unregister();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([undefined, false])("retains indexes and recovers skipped writes across boots with preference %s", async (preference) => {
  const unregister = registerMxcReleaseGateEvidence(RELEASE_EVIDENCE);
  const dir = mkdtempSync(join(tmpdir(), "ave-boot-session-index-"));
  const emptyDir = join(dir, "empty");
  const index = join(dir, "search", "index.db");
  const emptyIndex = join(emptyDir, "search", "index.db");
  const searchIndexPolicy = sessionSearchIndexPolicySource(() => preference);
  const beforeId = "aaaaaaaa-1111-2222-3333-444444444444";
  const duringId = "bbbbbbbb-1111-2222-3333-444444444444";
  try {
    await new SessionRepository({ aveDir: dir }).saveSession(beforeId, [{ role: "user", content: "retained evidence" }]);
    const originalIndex = readFileSync(index);
    const main = new WindowsSessionRepository({ aveDir: dir, ...searchIndexPolicy });
    const empty = new WindowsSessionRepository({ aveDir: emptyDir, ...searchIndexPolicy });
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
    h.checkDeps.mockResolvedValue(NO_ACCOUNT_BACKEND);
    h.detectMxc.mockResolvedValue(MXC_OLD);
    await initSandboxGate(harness.context(false, false));
    const openIndex = vi.spyOn(SessionSearchIndex.prototype, "open");
    try {
      await main.verifyOrRebuildSearchIndex();
      await empty.verifyOrRebuildSearchIndex();
      await main.saveSession(duringId, [{ role: "user", content: "new transcript evidence" }]);
      await empty.saveSession(duringId, [{ role: "user", content: "new transcript evidence" }]);
      await Promise.all([main.searchIndexIdle(), empty.searchIndexIdle()]);
      expect.soft(await main.searchSessionsWithCurrentPolicy("retained evidence")).toEqual([]);
      expect.soft(readFileSync(index).equals(originalIndex)).toBe(true);
      expect.soft(existsSync(emptyIndex)).toBe(false);
      expect.soft(openIndex).not.toHaveBeenCalled();
    } finally {
      openIndex.mockRestore();
    }

    markSandboxGatePendingAtBoot();
    h.checkDeps.mockResolvedValue(ACCOUNT_DEPS_READY);
    h.initialize.mockImplementationOnce(async () => {
      h.runtimeActive.mockReturnValue(true);
      h.offlineConfinement.mockReturnValue(true);
    });
    await initSandboxGate(harness.context(true, false));
    const restarted = new WindowsSessionRepository({ aveDir: dir, ...searchIndexPolicy });
    const restartedEmpty = new WindowsSessionRepository({ aveDir: emptyDir, ...searchIndexPolicy });
    await restarted.verifyOrRebuildSearchIndex();
    await restartedEmpty.verifyOrRebuildSearchIndex();
    expect(await restarted.searchSessionsWithCurrentPolicy("retained evidence")).toHaveLength(1);
    expect(await restarted.searchSessionsWithCurrentPolicy("new transcript evidence")).toHaveLength(1);
    expect(await restartedEmpty.searchSessionsWithCurrentPolicy("new transcript evidence")).toHaveLength(1);
  } finally {
    unregister();
    rmSync(dir, { recursive: true, force: true });
  }
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
    expect(h.logger.info).toHaveBeenCalledWith({ mxcRuntimeRootState: "available" }, "boot: MXC runtime root proved");
  });

  it("logs a HOME parent that cannot be established and still finishes boot", async () => {
    h.establishHomesError = new Error("root not private");
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    await expect(initSandboxGate(harness.context(true, false))).resolves.toBeUndefined();
    expect(h.homesCalls[0]).toBe("establish");
    expect(h.logger.warn).toHaveBeenCalledWith(
      { mxcRuntimeRootState: "unavailable", mxcRuntimeRootReason: "runtime-root-unproved" },
      "boot: Windows sandbox HOME root unavailable: %s", "root not private",
    );
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
    expect(h.logger.warn).toHaveBeenCalledWith(
      { mxcRuntimeRootState: "unavailable", mxcRuntimeRootReason: "runtime-root-unproved" },
      "boot: Windows sandbox HOME root unavailable: %s", "root not private",
    );
    expect(h.detectMxc).not.toHaveBeenCalled();
  });

  it("reports the proved root with the sandbox setting off", async () => {
    await initSandboxGate(harness.context(false, false));
    expect(getSandboxHomesUnavailable()).toBe(false);
    expect(h.logger.info).toHaveBeenCalledWith({ mxcRuntimeRootState: "available" }, "boot: MXC runtime root proved");
    expect(h.detectMxc).not.toHaveBeenCalled();
  });

  it("reports the proved root before a host prerequisites refusal", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockImplementation(async () => {
      expect(h.logger.info).toHaveBeenCalledWith({ mxcRuntimeRootState: "available" }, "boot: MXC runtime root proved");
      return MXC_OLD;
    });
    await initSandboxGate(harness.context(true, false));
    expect(h.logger.warn).toHaveBeenCalledWith(
      { mxcHostState: "unavailable", mxcHostReason: "container-unavailable" },
      expect.any(String), MXC_OLD.windowsBuild, MXC_OLD.detail,
    );
    expect(h.startProbe).not.toHaveBeenCalled();
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
    expect((await refreshWindowsBackgroundAdmission()).areSwitchesAvailable()).toBe(released);
    expect(h.startProbe).not.toHaveBeenCalled();
    expect(h.initialize).not.toHaveBeenCalled();
    expect(getSandboxBootOutcome()).toMatchObject({ action: "skip", reason: "gate-off" });
  } finally {
    unregister?.();
  }
});

const ABSENCE_FACTS = HOST_CONTAINER_ABSENCE_PROBE.probes;

it.each([
  ["container", true],
  ["container", false],
  ["account", true],
  ["account", false],
] as const)("preserves the host index when backend absence carries a warning (%s, preference %s)", async (backend, preference) => {
  const unregister = registerMxcReleaseGateEvidence(RELEASE_EVIDENCE);
  const dir = mkdtempSync(join(tmpdir(), "ave-boot-session-index-"));
  const indexPath = join(dir, "search", "index.db");
  const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
  const searchIndexPolicy = sessionSearchIndexPolicySource(() => preference);
  const repository = new WindowsSessionRepository({ aveDir: dir, ...searchIndexPolicy });
  const warning = "host capability query could not complete";
  try {
    await new SessionRepository({ aveDir: dir }).saveSession(sessionId, [{ role: "user", content: "retained evidence" }]);
    const originalIndex = readFileSync(indexPath);
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
    h.checkDeps.mockResolvedValue(backend === "account" ? { ...NO_ACCOUNT_BACKEND, warnings: [warning] } : NO_ACCOUNT_BACKEND);
    const run = vi.fn(async () => ({
      code: 0, stderr: "",
      stdout: JSON.stringify(backend === "container"
        ? { ...HOST_CONTAINER_ABSENCE_PROBE, warnings: [warning] } : HOST_CONTAINER_ABSENCE_PROBE),
    }));
    h.detectMxc.mockImplementation(() => detectMxcPrerequisites({
      platform: "win32", arch: "x64", resourcePath: "C:\\example\\resources", windowsBuild: null,
      systemRoot: "C:\\Windows", probeDirectory: "C:\\example\\probe", exists: () => true,
      sha256: async () => pinnedWxcExecSha256("x64") ?? "", run,
    }));
    await initSandboxGate(harness.context(false, false));
    expect(run).toHaveBeenCalledOnce();

    const openIndex = vi.spyOn(SessionSearchIndex.prototype, "open");
    const discardIndex = vi.spyOn(SessionSearchIndex.prototype, "discard");
    try {
      await repository.verifyOrRebuildSearchIndex();
      await repository.saveSession(sessionId, [{ role: "user", content: "changed evidence" }]);
      await repository.searchIndexIdle();
      expect.soft((await refreshWindowsBackgroundAdmission()).searchIndexPolicy(preference)).toBe("inactive");
      expect.soft((await refreshWindowsBackgroundAdmission()).areSwitchesAvailable()).toBe(false);
      expect.soft(openIndex).toHaveBeenCalledTimes(0);
      expect.soft(discardIndex).toHaveBeenCalledTimes(0);
      expect(existsSync(indexPath) && readFileSync(indexPath).equals(originalIndex)).toBe(true);
    } finally {
      openIndex.mockRestore();
      discardIndex.mockRestore();
    }
  } finally {
    repository.closeSearchIndex();
    unregister();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  { label: "partial probe", response: { error: HOST_CONTAINER_ABSENCE_PROBE.error, probes: { baseContainerApiPresent: false } } },
  { label: "missing host fact", response: { ...HOST_CONTAINER_ABSENCE_PROBE,
    probes: { ...ABSENCE_FACTS, baseContainerSupportsEnumeratePaths: undefined } } },
  { label: "contradictory enumeration", response: { ...HOST_CONTAINER_ABSENCE_PROBE,
    probes: { ...ABSENCE_FACTS, baseContainerSupportsEnumeratePaths: true } } },
  { label: "contradictory proxy support", response: { ...HOST_CONTAINER_ABSENCE_PROBE,
    probes: { ...ABSENCE_FACTS, baseContainerSupportsIdentitylessLoopbackProxy: true } } },
  { label: "generic detector error", response: { ...HOST_CONTAINER_ABSENCE_PROBE, error: "host capability query failed" } },
  { label: "duplicate raw API fact", response: JSON.stringify(HOST_CONTAINER_ABSENCE_PROBE).replace(
    '"baseContainerApiPresent":false', '"baseContainerApiPresent":true,"baseContainerApiPresent":false',
  ) },
  { label: "definitive host absence", response: HOST_CONTAINER_ABSENCE_PROBE, available: true, inventory: EMPTY_ACCOUNT_INVENTORY },
  { label: "account group remains", mxc: NO_CONTAINER, inventory: { ...EMPTY_ACCOUNT_INVENTORY, user: { ...EMPTY_ACCOUNT_INVENTORY.user, groupExists: true } } },
  { label: "account setup marker remains", mxc: NO_CONTAINER, inventory: { ...EMPTY_ACCOUNT_INVENTORY, user: { ...EMPTY_ACCOUNT_INVENTORY.user, markerVersion: 1 } } },
  { label: "network filters remain", mxc: NO_CONTAINER, inventory: { ...EMPTY_ACCOUNT_INVENTORY, wfp: { state: "absent", filters: 1 } } },
  { label: "network inventory unreadable", mxc: NO_CONTAINER, inventory: { ...EMPTY_ACCOUNT_INVENTORY, wfp: { state: "cannot-read", filters: 0 } } },
  { label: "account inventory probe failed", mxc: NO_CONTAINER, inventory: new Error("inventory unavailable") },
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
])("projects settings and admits unconfined inference only with boot evidence: $label", async ({ mxc, deps, response, available, rootFailed, inventory }) => {
  const unregister = registerMxcReleaseGateEvidence(RELEASE_EVIDENCE);
  try {
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: tmpdir(), sid: "S-1-5-21-1000" });
    if (rootFailed) h.establishHomesError = new Error("root not private");
    h.checkDeps.mockResolvedValue(deps ?? NO_ACCOUNT_BACKEND);
    if (inventory !== undefined) {
      h.accountDependencies.mockReset().mockResolvedValue({ errors: ["Sandbox account is not provisioned"], warnings: [] });
      h.accountInventory.mockReset().mockImplementation(async () => {
        if (inventory instanceof Error) throw inventory;
        return inventory;
      });
      h.checkDeps.mockImplementation((await vi.importActual<typeof import("../../permissions/asrt-sandbox.js")>(
        "../../permissions/asrt-sandbox.js",
      )).checkAsrtDependencies);
    }
    const run = vi.fn(async () => ({
      code: 0, stdout: typeof response === "string" ? response : JSON.stringify(response), stderr: "",
    }));
    if (response) {
      h.detectMxc.mockImplementation(() => detectMxcPrerequisites({
        platform: "win32", arch: "x64", resourcePath: "C:\\example\\resources", windowsBuild: null,
        systemRoot: "C:\\Windows", probeDirectory: "C:\\example\\probe", exists: () => true,
        sha256: async () => pinnedWxcExecSha256("x64") ?? "", run,
      }));
    } else {
      h.detectMxc.mockResolvedValue(mxc);
    }
    await initSandboxGate(harness.context(false, false));
    if (response) expect(run).toHaveBeenCalledOnce();
    if (inventory !== undefined) {
      expect(getWindowsSandboxSubstrate()?.accountBackendAbsent).toBe(available ? true : undefined);
    }

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
    if (available) {
      expect(assertLocalEmbeddingRuntime(undefined, await refreshWindowsBackgroundAdmission())).toBe("unconfined");
      expect(h.accountInventory.mock.calls.length).toBeGreaterThan(1);
      h.accountInventory.mockResolvedValue({ ...EMPTY_ACCOUNT_INVENTORY, wfp: { state: "cannot-read", filters: 0 } });
      expect((await refreshWindowsBackgroundAdmission()).areSwitchesAvailable()).toBe(false);
    }
    else await expect((async () => memoryMap.build(undefined, "11111111-1111-4111-8111-111111111111",
      {} as Parameters<typeof memoryMap.build>[2], () => {}))())
      .rejects.toMatchObject({ code: "local-runtime-unavailable" });
    expect(resolveScope).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});

describe("initSandboxGate — Windows MXC substrate", () => {
  it("withholds boot shell evidence when the measured launcher changes before publication", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    const measured = { ...MXC_OK, rawIpProbe: { rawIp: "blocked", reason: "blocked", evidenceKind: "measured", reachableTargets: [], udpArrival: "absent" } };
    const result = deferred<typeof measured>();
    h.startProbe.mockReturnValue(result.promise);
    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(h.startProbe).toHaveBeenCalledOnce());
    h.requireLauncher.mockReturnValue("replacement launcher");
    result.resolve(measured);
    await afterQueuedCallbacks();
    expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "approved-host", mxc: { state: "unavailable", reason: "launcher-mismatch" } });
    expect(getWindowsSandboxSubstrate()?.shellEgressProtocolCoverage).toBeUndefined();
    expect(getWindowsMxcShellEgressMeasurement()).toBeUndefined();
  });

  it("starts the real container probe at boot with nothing saved and carries shells in containers once it passes", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    let settle!: (value: typeof MXC_OK) => void;
    h.startProbe.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(h.startProbe).toHaveBeenCalledOnce());
    expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "approved-host", mxc: { state: "checking" } });
    expect(h.logger.info).toHaveBeenCalledWith({ mxcRuntimeRootState: "available" }, "boot: MXC runtime root proved");
    expect(h.logger.info).toHaveBeenCalledWith({ mxcHostState: "available" }, "boot: MXC host prerequisites satisfied");
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "plain", sandboxed: false });
    settle(MXC_OK);
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", mxc: { state: "available" } }));
    expect(getWindowsSandboxSubstrate()).not.toHaveProperty("shellLocalNetworkAccess");
    expect(getHostShellExecutionPlan()).toMatchObject({ substrate: "mxc", sandboxed: true });
    expect(h.logger.info).toHaveBeenCalledWith(
      { mxcShellState: "available" }, "boot: MXC shell start probe succeeded in %d ms", expect.any(Number),
    );
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
      { mxcHostState: "unavailable", mxcHostReason: "container-unavailable" },
      "boot: MXC host prerequisites unavailable (build %s): %s",
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

  it.each([
    { rawIp: "blocked", reason: "blocked", evidenceKind: "measured", reachableTargets: [], udpArrival: "absent" },
    { rawIp: "blocked", reason: "blocked", evidenceKind: "structural", reachableTargets: [], udpArrival: "absent" },
    { rawIp: "unknown", reason: "raw-ip-reachable", reachableTargets: ["udp"], udpArrival: "arrived" },
    { rawIp: "unknown", reason: "ipv6-unmeasured", reachableTargets: [], udpArrival: "absent" },
  ])("publishes the start measurement with the available shell route ($reason, $evidenceKind)", async (rawIpProbe) => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    h.startProbe.mockResolvedValue({ ...MXC_OK, rawIpProbe });
    const published = new Set<NonNullable<ReturnType<typeof getWindowsSandboxSubstrate>>>();
    setSandboxStatusChangeListener(() => {
      const snapshot = getWindowsSandboxSubstrate();
      if (snapshot?.shells === "mxc") published.add(snapshot);
    });

    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()?.shells).toBe("mxc"));
    expect(h.startProbe).toHaveBeenCalledOnce();
    expect(published.size).toBe(1);
    const coverage = { dns: "host-resolver", rawIp: rawIpProbe.rawIp };
    expect(getWindowsMxcShellEgressMeasurement()).toEqual(rawIpProbe.evidenceKind === undefined
      ? undefined : { coverage, evidenceKind: rawIpProbe.evidenceKind });
    expect(getWindowsSandboxSubstrate()).not.toHaveProperty("evidenceKind");
    expect(getWindowsSandboxSubstrate()?.shellEgressProtocolCoverage).toEqual(coverage);
    expect(getHostShellExecutionPlan().egressProtocolCoverage).toEqual(coverage);
  });

  it("publishes available MXC with unknown coverage after a late successful start", async () => {
    const { probeMxcPowerShellStart } = await vi.importActual<typeof import("../../permissions/mxc-windows.js")>(
      "../../permissions/mxc-windows.js",
    );
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    const epoch = 1_800_000_000_000;
    const run = vi.fn<import("../../permissions/mxc-windows.js").DetectMxcSupportDeps["run"]>();
    h.startProbe.mockImplementation(async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(epoch);
      try {
        run.mockImplementation(async (_file, args, timeout) => {
          if (args[0] !== "--config-base64") {
            expect(timeout).toBe(6_000);
            clock.mockReturnValue(epoch + 5_000);
            return { code: 0, stdout: "", stderr: "" };
          }
          const request: import("../../permissions/mxc-windows.js").MxcContainerRequest =
            JSON.parse(Buffer.from(args[1] ?? "", "base64").toString("utf8"));
          const wrapper = Buffer.from(request.process.commandLine.split(" ").at(-1) ?? "", "base64").toString("utf16le");
          if (wrapper.endsWith("exit 0")) return { code: 0, stdout: "", stderr: "" };
          const script = readMxcRawIpProbeScript(request.process.commandLine);
          const deadline = Number(/(\d{13}) - \[DateTimeOffset\]::UtcNow/.exec(script)?.[1]);
          const ready = epoch + 5_000 + request.process.timeout - 100;
          const exits = script.includes("if ($probeBudget -le 0) { exit 0 }") && ready >= deadline;
          return { code: exits ? 0 : 1, stdout: "", stderr: exits ? "" : "launcher timeout" };
        });
        return await probeMxcPowerShellStart({
          platform: "win32", arch: "x64", resourcePath: "C:/example/resources", windowsBuild: MXC_OK.windowsBuild,
          probeDirectory: "C:/example/scratch", systemRoot: "C:/Windows", exists: () => true, sha256: async () => "", run,
        }, async () => ({ port: 49153, url: "http://127.0.0.1:49153", close: async () => {} }));
      } finally {
        clock.mockRestore();
      }
    });

    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(getWindowsSandboxSubstrate()).toMatchObject({
      mxc: { state: "available" }, shells: "mxc", shellEgressProtocolCoverage: { rawIp: "unknown" },
    }));
    expect(getHostShellExecutionPlan().egressProtocolCoverage).toEqual({ dns: "host-resolver", rawIp: "unknown" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[2]).toBe(60_000);
  });

  it("keeps the approved route and records the reason when PowerShell cannot start in a container", async () => {
    h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
    h.detectMxc.mockResolvedValue(MXC_OK);
    let finishProbe!: (value: unknown) => void;
    h.startProbe.mockReturnValue(new Promise((resolve) => { finishProbe = resolve; }));

    await initSandboxGate(harness.context(true, false));
    await vi.waitFor(() => expect(h.startProbe).toHaveBeenCalledOnce());
    expect(detectSandboxCapability().reason).toContain("container start check pending");

    finishProbe({ state: "unavailable", reason: "unverified-session", windowsBuild: "10.0.26300.9711", detail: "STATUS_DLL_INIT_FAILED" });

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
      { mxcShellState: "unavailable", mxcShellReason: "unverified-session" },
      "boot: MXC shell start probe failed in %d ms (build %s): %s",
      expect.any(Number),
      "10.0.26300.9711",
      "STATUS_DLL_INIT_FAILED",
    );
  });

  it.each([
    { path: "measured start", listenerAvailable: true, rejects: false },
    { path: "measured start", listenerAvailable: true, rejects: true },
    { path: "plain start", listenerAvailable: false, rejects: false },
    { path: "plain start", listenerAvailable: false, rejects: true },
  ])("keeps launch diagnostics out of the file log for $path (rejects=$rejects)", async ({ listenerAvailable, rejects }) => {
    const { probeMxcPowerShellStart } = await vi.importActual<typeof import("../../permissions/mxc-windows.js")>("../../permissions/mxc-windows.js");
    const { closeFileLogSink, createLogger, initFileLogSink } = await vi.importActual<typeof import("../../lib/logger.js")>("../../lib/logger.js");
    const dir = await mkdtemp(join(tmpdir(), "mxc-start-log-"));
    try {
      const sink = initFileLogSink({ dir });
      if (!sink) throw new Error("Missing file log sink");
      const fileLogger = createLogger("sandbox-init");
      h.logger.warn.mockImplementation((...args) => Reflect.apply(fileLogger.warn, fileLogger, args));
      h.checkDeps.mockResolvedValue(SRT_WIN_MISSING);
      h.detectMxc.mockResolvedValue(MXC_OK);
      const address = "192.168.111.29";
      const sid = "S-1-15-3-7";
      h.startProbe.mockImplementation(() => probeMxcPowerShellStart({
        platform: "win32", arch: "x64", resourcePath: "C:/example/resources", windowsBuild: MXC_OK.windowsBuild,
        probeDirectory: "C:/example/scratch", systemRoot: "C:/Windows", exists: () => true, sha256: async () => "",
        run: async (_file, args) => {
          if (args[0] !== "--config-base64") return { code: 0, stdout: "", stderr: "" };
          if (rejects) throw new Error(`Launch rejected at ${address} for ${sid}`);
          return { code: 1, stdout: `Profile ${sid}`, stderr: `STATUS_DLL_INIT_FAILED at ${address}` };
        },
      }, async () => {
        if (!listenerAvailable) throw new Error("Listener unavailable");
        return { port: 49153, url: "http://127.0.0.1:49153", close: async () => {} };
      }));

      await initSandboxGate(harness.context(true, false));
      await vi.waitFor(async () => {
        const log = await readFile(sink.currentFile, "utf8");
        expect(log).toContain("boot: MXC shell start probe failed");
        expect(log).not.toContain(address);
        expect(log).not.toContain(sid);
        expect(log).toContain(rejects ? "launch-rejected" : "STATUS_DLL_INIT_FAILED");
      });
      expect(getWindowsSandboxSubstrate()).toMatchObject({
        mxc: { state: "unavailable", reason: rejects ? "powershell-start-failed" : "unverified-session" },
        shells: "approved-host",
      });
    } finally {
      h.logger.warn.mockReset();
      closeFileLogSink();
      await cleanupTmpDir(dir);
    }
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
