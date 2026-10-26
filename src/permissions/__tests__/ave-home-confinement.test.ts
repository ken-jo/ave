import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { ensureAveHomePrivate, setAveHomePrivacyAtBoot, _resetAveHomePrivacyForTest, approveExtensionsWithoutIsolation, areExtensionsWithoutIsolationApproved, setAveHomePrivacyRefusalReporter } from "../../shared/ave-home.js";
import { useTempDirs, useTempPaths } from "../../__tests__/test-helpers.js";
import * as policyHome from "../../shared/policy-home.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { assertExtensionStartAllowed, initializeAsrtSandbox, isAsrtSandboxActive, isPluginWorkerConfinementActive, resetAsrtSandbox, wrapWorkerCommand, wrapTerminalCommand, grantWindowsWorkerFilesystemAccess } from "../asrt-sandbox.js";
import { setPluginWorkerConfinementRequestedAtBoot, __resetSandboxRequestedAtBootForTest } from "../sandbox-capability.js";
import { readAsrtWindowsStatus } from "../asrt-windows-support.js";

const runtime = vi.hoisted(() => ({ initialize: vi.fn(), wrap: vi.fn() }));

// A simulated drive path must use drive-path operations even on a POSIX host.
vi.mock("node:path", async original => {
  const actual = await original<typeof import("node:path")>();
  return { ...actual, ...Object.fromEntries(Object.entries(actual.win32)
    .filter(([, value]) => typeof value === "function")
    .map(([key, value]) => [key, (...args: unknown[]) =>
      Reflect.apply(process.platform === "win32" && args.some(arg => typeof arg === "string" && /^[A-Za-z]:[\\/]/.test(arg))
        ? value as (...args: unknown[]) => unknown : actual[key as keyof typeof actual] as (...args: unknown[]) => unknown, undefined, args)])) };
});

// On a POSIX host a simulated drive is empty: only its root resolves, so path resolution still walks up to it.
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  if (process.platform === "win32") return actual;
  const simulated = (real: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
    const [path] = args;
    if (typeof path !== "string" || !/^[A-Za-z]:[\\/]/.test(path)) return real(...args);
    if (/^[A-Za-z]:[\\/]$/.test(path)) return path;
    throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: "ENOENT" });
  };
  const realpathSync = Object.assign(simulated(actual.realpathSync as (...args: unknown[]) => unknown),
    { native: simulated(actual.realpathSync.native as (...args: unknown[]) => unknown) }) as typeof actual.realpathSync;
  return { ...actual, default: { ...actual, realpathSync }, realpathSync };
});

// Lifecycle fixtures on another kernel validate spellings but cannot open native handles.
vi.mock("../windows-stamp-targets.js", async original => {
  const actual = await original<typeof import("../windows-stamp-targets.js")>();
  const host = process.platform;
  return { ...actual, pinWindowsFilesystemConfig: (filesystem: Parameters<typeof actual.pinWindowsFilesystemConfig>[0]) => {
    if (host === "win32") return actual.pinWindowsFilesystemConfig(filesystem);
    for (const entries of [filesystem?.allowRead, filesystem?.allowWrite, filesystem?.denyRead, filesystem?.denyWrite]) {
      for (const entry of entries ?? []) {
        const path = typeof entry === "string" ? entry : entry.path;
        if (/[A-Za-z]:/.test(path) && !actual.isPlainWindowsStampPath(path.replace(/\//g, "\\"))) throw new Error("Invalid simulated drive path");
      }
    }
    return filesystem;
  } };
});
vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: runtime.initialize,
    wrapWithSandboxArgv: runtime.wrap,
    reset: vi.fn(),
    // The macOS runtime probe opens an attributed listener and cleans up after its wrap.
    openInvocationListener: vi.fn(async () => undefined),
    closeInvocationListener: vi.fn(),
    cleanupAfterCommand: vi.fn(),
    setParentProxyRouter: vi.fn(),
    getProxyPort: () => undefined,
    getSocksProxyPort: () => undefined,
  },
}));

const ORIGINAL_PLATFORM = process.platform;
const OWNER_SID = "S-1-5-21-100-200-300-1001";
const home = useTempPaths("ave-home-confinement-", ".ave");
const policyFixture = useTempDirs("confinement-stamp-floor-");

beforeEach(() => {
  const profile = ORIGINAL_PLATFORM === "win32" ? join(policyFixture(), "alice") : "C:\\Users\\alice";
  if (ORIGINAL_PLATFORM === "win32") mkdirSync(profile);
  vi.stubEnv("HOME", profile);
  vi.stubEnv("USERPROFILE", profile);
  vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([profile]);
});

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  _resetAveHomePrivacyForTest();
  __resetSandboxRequestedAtBootForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("private-directory confinement gate", () => {
  it("refuses initialization, wraps and ACL grants before boot publishes protection", async () => {
    setProcessPlatform("win32");
    const reason = "home privacy not established (boot did not publish AVE_HOME protection)";
    await expect(initializeAsrtSandbox({ allowedDomains: [] })).rejects.toThrow(reason);
    await expect(wrapWorkerCommand("echo denied", { commandId: "before-boot" })).rejects.toThrow(reason);
    await expect(wrapTerminalCommand("echo denied", { commandId: "before-boot-terminal", ownTty: "/dev/ttys0" })).rejects.toThrow(reason);
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid })).rejects.toThrow(reason);
    expect(runtime.initialize).not.toHaveBeenCalled();
    await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } });
    expect(isAsrtSandboxActive()).toBe(true);
    await expect(wrapWorkerCommand("echo denied", { commandId: "proxy-only" })).rejects.toThrow(reason);
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid })).rejects.toThrow(reason);
    expect(runtime.wrap).not.toHaveBeenCalled();
  });

  it("does not accept POSIX mode evidence as Windows protection", async () => {
    setProcessPlatform("win32");
    setAveHomePrivacyAtBoot({ enforcement: "posix-mode", home: home() });
    await expect(initializeAsrtSandbox({ allowedDomains: [] })).rejects.toThrow("home privacy not established");
    expect(runtime.initialize).not.toHaveBeenCalled();
  });

  it.each(["home-command", "home-read", "secrets-command", "secrets-read"])("refuses %s failure and publishes the failed path to the UI", async (failure) => {
    setProcessPlatform("win32");
    const dir = home();
    const path = failure.startsWith("secrets") ? join(dir, "secrets") : dir;
    const privacy = ensureAveHomePrivate(dir, {
      platform: "win32",
      readDacls: (paths) => paths.map((target) => target === path
        ? { path: target, error: "failed", category: failure.endsWith("command") ? "icacls-failed" as const : "read-back-failed" as const }
        : { path: target, currentUserSid: OWNER_SID, ownerSid: OWNER_SID, protected: true,
          rules: [{ sid: OWNER_SID, accessControlType: 0, fileSystemRights: 2032127, inheritanceFlags: 3, propagationFlags: 0, isInherited: false }] }),
    });
    expect(privacy.enforcement).toBe("none");
    setAveHomePrivacyAtBoot(privacy);
    await expect(initializeAsrtSandbox({ allowedDomains: [] })).rejects.toThrow(path);
    expect(isAsrtSandboxActive()).toBe(false);
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(await readAsrtWindowsStatus()).toMatchObject({ ready: false, homePrivacyError: { path } });
  });

  it("allows proxy-only initialization but refuses extension wraps and ACL grants after protection fails", async () => {
    setProcessPlatform("win32");
    const path = home();
    setAveHomePrivacyAtBoot({ enforcement: "none", home: path, category: "invalid-owner-grant", reason: "DACL mismatch" });
    await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } });
    expect(isAsrtSandboxActive()).toBe(true);
    await expect(wrapWorkerCommand("echo denied", { commandId: "private-directory-test" })).rejects.toThrow(path);
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowRead: [path] })).rejects.toThrow(path);
    expect(runtime.wrap).not.toHaveBeenCalled();
  });

  it("does not impose the Windows privacy gate on POSIX confinement", async () => {
    setProcessPlatform("darwin");
    setAveHomePrivacyAtBoot({ enforcement: "none", home: home(), category: "read-back-failed", reason: "fixture" });
    // The post-initialize runtime probe runs the wrapped no-op; this one exits 0.
    runtime.wrap.mockResolvedValueOnce({ argv: [process.execPath, "-e", ""], env: { ELECTRON_RUN_AS_NODE: "1" } });
    await initializeAsrtSandbox({ allowedDomains: [] });
    expect(isAsrtSandboxActive()).toBe(true);
    expect(await readAsrtWindowsStatus()).toMatchObject({ applicable: false });
  });

  it("keeps headless starts refused, reports each refusal, and grants nothing automatically", () => {
    setProcessPlatform("win32");
    setPluginWorkerConfinementRequestedAtBoot(true);
    setAveHomePrivacyAtBoot({ enforcement: "none", home: home(), category: "read-back-failed", reason: "fixture" });
    const report = vi.fn();
    setAveHomePrivacyRefusalReporter(report);
    for (let attempt = 0; attempt < 3; attempt++) expect(() => assertExtensionStartAllowed()).toThrow("Settings > Permissions");
    expect(report).toHaveBeenCalledTimes(3);
    expect(areExtensionsWithoutIsolationApproved()).toBe(false);
  });

  it("keeps approval only until a new boot or a changed privacy observation", async () => {
    setProcessPlatform("win32");
    setPluginWorkerConfinementRequestedAtBoot(true);
    const dir = home();
    const privacy = { enforcement: "none" as const, home: dir, category: "read-back-failed" as const, reason: "fixture" };
    setAveHomePrivacyAtBoot(privacy);
    expect(() => assertExtensionStartAllowed()).toThrow(dir);
    approveExtensionsWithoutIsolation();
    expect(isPluginWorkerConfinementActive()).toBe(false);
    expect(await readAsrtWindowsStatus()).toMatchObject({ ready: false, homePrivacyError: { approvedForSession: true } });
    setAveHomePrivacyAtBoot(privacy);
    expect(areExtensionsWithoutIsolationApproved()).toBe(true);
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: dir, sid: OWNER_SID });
    expect(areExtensionsWithoutIsolationApproved()).toBe(false);
    setAveHomePrivacyAtBoot(privacy);
    expect(() => assertExtensionStartAllowed()).toThrow(dir);
    approveExtensionsWithoutIsolation();
    _resetAveHomePrivacyForTest();
    setAveHomePrivacyAtBoot(privacy);
    expect(() => assertExtensionStartAllowed()).toThrow(dir);
  });

  it("reports inactive confinement without throwing or auditing a refused status query", async () => {
    setProcessPlatform("win32");
    setPluginWorkerConfinementRequestedAtBoot(true);
    setAveHomePrivacyAtBoot({ enforcement: "none", home: home(), category: "read-back-failed", reason: "fixture" });
    const report = vi.fn();
    setAveHomePrivacyRefusalReporter(report);
    expect(isPluginWorkerConfinementActive()).toBe(false);
    await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } });
    expect(isPluginWorkerConfinementActive()).toBe(false);
    approveExtensionsWithoutIsolation();
    expect(isPluginWorkerConfinementActive()).toBe(false);
    expect(() => assertExtensionStartAllowed()).not.toThrow();
    expect(report).not.toHaveBeenCalled();
  });
});
