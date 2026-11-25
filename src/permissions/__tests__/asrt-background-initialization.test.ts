// Faked win32 on any host: no backend state to check here; the state rule has its own tests.
vi.mock("../confinement-state-paths.js", async (original) => ({
  ...await original<typeof import("../confinement-state-paths.js")>(),
  declaredConfinementStatePaths: () => [],
}));
vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
const presentTargets = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const fs = (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDriveFs(actual);
  const { win32: drivePath } = await vi.importActual<typeof import("node:path")>("node:path");
  // Registered deny targets exist, so they reach the stamp instead of being watched.
  const lstatSync = ((path: import("node:fs").PathLike, options?: import("node:fs").StatSyncOptions) => {
    if (presentTargets.has(drivePath.resolve(String(path)).replace(/\\$/u, "").toLowerCase())) return actual.lstatSync(".");
    return actual.lstatSync(path, options);
  }) as typeof actual.lstatSync;
  return { ...fs, lstatSync, default: { ...(fs as { default?: object }).default ?? fs, lstatSync } };
});
vi.mock("node:module", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDriveModule(await original()));
vi.mock("node:path", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDrivePath(await original()));
vi.mock("../../shared/ave-home-test-guard.js", async original => {
  const actual = await original<typeof import("../../shared/ave-home-test-guard.js")>();
  return { ...actual, checkSandboxStampTargets: (paths: readonly string[]) => {
    actual.checkSandboxStampTargets(paths);
    if (ORIGINAL_PLATFORM !== "win32") {
      // Model the host treating Windows drive operands as relative strings under the checkout.
      const drives = paths.filter(path => /^[A-Za-z]:[\\/]/u.test(path));
      withProvidedContext("realAccountHome", checkout, () => actual.checkSandboxStampTargets(drives));
    }
  } };
});
vi.mock("../../shared/policy-home.js", async original => {
  return {
    ...(await original<typeof import("../../shared/policy-home.js")>()),
    policyHomeAnchors: () => {
      const home = process.env.AVE_TEST_RUN_HOME;
      if (home === undefined) throw new Error("Isolated test home is unavailable");
      return [home];
    },
  };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerEachStart } from "../../__tests__/support/approved-extension-start.js";
import {
  __resetExtensionStartsForTest, deferExtensionStart, listPendingExtensionStarts, setExtensionStartAsker, settlePendingExtensionStarts, takeExtensionStartGrant,
} from "../extension-start-consent.js";
import { resolve, win32 } from "node:path";
import { realpathSync } from "node:fs";
import { WindowsSandboxError } from "@anthropic-ai/sandbox-runtime";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
import { withProvidedContext } from "../../__tests__/support/provided-context.js";
import { useTempDirs as trackTempDirs } from "../../__tests__/test-helpers.js";
import { useVerifiedAveHomePrivacy as installVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { t } from "../../i18n/index.js";
import { configureHostResources } from "../../main/host-resources.js";
import { setPluginWorkerConfinementRequestedAtBoot, __resetSandboxRequestedAtBootForTest } from "../sandbox-capability.js";
import * as facts from "../../shared/windows-path-facts.js";
import * as denyAcl from "../windows-deny-acl.js";
import * as stampTargets from "../windows-stamp-targets.js";
import { windowsDenyOperandKey } from "../sandbox-write-policy.js";
import { assertExtensionStartAllowed, grantWindowsWorkerFilesystemAccess, initializeAsrtSandbox, probeExtensionStart, isAsrtSandboxActive, isOfflineProcessConfinementActive, isPluginWorkerConfinementActive, resetAsrtSandbox, wrapToolCommand, wrapWorkerCommand } from "../asrt-sandbox.js";

const manager = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  initializeWindowsIsolation: vi.fn<() => Promise<void>>(),
  reset: vi.fn(async () => undefined),
  setParentProxyRouter: vi.fn(),
  getConfig: vi.fn(() => undefined),
  updateConfig: vi.fn(),
  wrapWithSandboxArgv: vi.fn(async () => ({ argv: ["confined"], env: {} })),
}));
const nativeWorker = vi.hoisted(() => ({
  grantWindowsAcl: vi.fn(),
  revokeWindowsAcl: vi.fn(() => []),
  resolveSrtWin: vi.fn(({ path }: { path: string }) => ({ exe: path, prependArgs: [] })),
  getWindowsSandboxUserStatus: vi.fn(() => ({ provisioned: true, credPresent: true, sid: "S-1-5-21-123" })),
}));
const stampWindowsAclAsync = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@anthropic-ai/sandbox-runtime", async original => ({
  ...(await original<typeof import("@anthropic-ai/sandbox-runtime")>()),
  ...nativeWorker,
  SandboxManager: manager,
}));
vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js", async original => ({
  ...(await original<typeof import("@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js")>()),
  stampWindowsAclAsync,
}));
vi.mock("../srt-win-integrity.js", async original => ({
  ...(await original<typeof import("../srt-win-integrity.js")>()),
  prepareSrtWinExecutable: (path: string) => path,
}));

installVerifiedAveHomePrivacy();
const ORIGINAL_PLATFORM = process.platform;
const checkout = process.cwd();
const makeScratch = trackTempDirs("sandbox-background-");
const WIN32_WRAPPERS = [["tool", wrapToolCommand], ["worker", wrapWorkerCommand]] as const;
let fixtureRoot: string;
let succeed: () => void;
let fail: (error: Error) => void;

function wrapWriteDenies(wrap: typeof wrapToolCommand, denyWrite: string[]) {
  return wrap("echo safe", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [], denyWrite } });
}

function denyPatterns(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => win32.join(fixtureRoot, prefix, `${index}-*.deny`));
}

function present(paths: readonly string[]): void {
  for (const path of paths) presentTargets.add(win32.resolve(path).replace(/\\$/u, "").toLowerCase());
}

function pinWorkerRoot(root: string): void {
  const pin = facts.pinWindowsPaths;
  vi.spyOn(facts, "pinWindowsPaths").mockImplementation(requests => requests.map(path => {
    if (path === root) return { exists: true, canonical: root, volumeSerial: "volume", fileId: "worker-root",
      volumeSerialNumber: null, fileIndex: null, changeTime: null, attributes: 16, reparseTag: 0,
      directory: true, reparseTarget: null, ancestors: [] };
    const [response] = pin([path]);
    if (response === undefined) throw new Error("Missing path facts for the worker fixture");
    return response;
  }));
  vi.spyOn(stampTargets, "pinWindowsFilesystemConfig").mockImplementation(config => config);
}

beforeEach(() => {
  configureHostResources({ resourcePath: resolve(checkout, "resources"), isPackaged: false });
  const scratch = realpathSync.native(makeScratch());
  // A foreign drive operand resolves against the host's cwd in the real guard.
  process.chdir(scratch);
  fixtureRoot = win32.join(ORIGINAL_PLATFORM === "win32" ? scratch : "D:\\", "fixture");
  setProcessPlatform("win32");
  setPluginWorkerConfinementRequestedAtBoot(true);
  manager.initializeWindowsIsolation.mockImplementation(() => new Promise<void>((resolve, reject) => {
    succeed = resolve;
    fail = reject;
  }));
});

afterEach(async () => {
  try {
    await resetAsrtSandbox();
  } finally {
    presentTargets.clear();
    process.chdir(checkout);
    __resetSandboxRequestedAtBootForTest();
    setProcessPlatform(ORIGINAL_PLATFORM);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  }
});

describe("background session isolation", () => {
  it("keeps UNC names and directory hints exact after removing the extended prefix", () => {
    const share = String.raw`\\server\Share\Case`;
    const extended = String.raw`\\?\unc\server\Share\Case`;
    expect(windowsDenyOperandKey(`${extended}\\`)).toBe(`${share}\\`);
    expect(windowsDenyOperandKey(extended)).toBe(share);
    expect(windowsDenyOperandKey(share.toLowerCase())).not.toBe(share);
  });

  it.each(["absolute", "drive-relative"] as const)("admits a read-deny stamp with equivalent drive spellings (%s)", async (kind) => {
    const drive = win32.parse(fixtureRoot).root.slice(0, 2).toUpperCase();
    const denyRoot = kind === "absolute" ? win32.join(fixtureRoot, "worker") : `${drive}fixture\\worker`;
    const root = win32.resolve(denyRoot);
    const directory = win32.join(denyRoot, "absent-dir");
    const paths = Array.from({ length: 253 }, (_, index) => win32.join(denyRoot, `denied-${index}`));
    paths.push(win32.join(denyRoot, "Case"), win32.join(denyRoot, "case"), directory, `${directory}\\`);
    const denies = paths.flatMap((path, index) => {
      const alias = path.slice(0, 1).toLowerCase() + path.slice(1);
      if (kind === "drive-relative") return [path, alias];
      return [path, index % 2 === 0 ? alias.replaceAll("\\", "/") : `\\\\?\\${alias}`];
    });
    expect(denies.every(path => win32.isAbsolute(path) === (kind === "absolute"))).toBe(true);
    present(paths);
    await initializeAsrtSandbox({ denyRead: denies });
    pinWorkerRoot(root);
    const read = vi.spyOn(denyAcl, "readWindowsDenyAcls").mockImplementation(requests => requests.map(() => ({
      denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: denyAcl.WINDOWS_READ_DENY_MASK, parentMask: 0x40, directory: false,
    })));
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [root] });
    try {
      expect(read.mock.calls.map(([targets]) => targets)).toEqual([paths, paths]);
      expect(stampWindowsAclAsync).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ denyRead: paths, denyWrite: paths }));
      expect(nativeWorker.grantWindowsAcl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ write: [root] }));
    } finally { grant.release(); }
  });

  it("verifies and stamps a valid worker policy once per distinct target", async () => {
    const root = win32.join(fixtureRoot, "worker");
    const paths = Array.from({ length: 510 }, (_, index) => win32.join(root, `denied-${index}`));
    paths.push(win32.join(root, "Case"), win32.join(root, "case"), `${win32.join(root, "absent-dir")}\\`);
    present(paths);
    await initializeAsrtSandbox({ denyWrite: paths });
    pinWorkerRoot(root);
    const read = vi.spyOn(denyAcl, "readWindowsDenyAcls").mockImplementation(requests => requests.map(() => ({
      denyMask: denyAcl.WINDOWS_WRITE_DENY_MASK, inheritableMask: denyAcl.WINDOWS_WRITE_DENY_MASK, parentMask: 0x40, directory: false,
    })));
    const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [root] });
    try {
      expect(read.mock.calls.map(([targets]) => targets)).toEqual([paths, paths]);
      expect(stampWindowsAclAsync).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ denyWrite: paths, denyRead: [] }));
      expect(nativeWorker.grantWindowsAcl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ write: [root] }));
    } finally { grant.release(); }
  });

  it("refuses cumulative retained deny growth without recording the rejected request", async () => {
    const paths = (prefix: string, length = 600) => Array.from({ length }, (_, index) => win32.join(fixtureRoot, "retained", prefix, String(index)));
    const base = paths("base", 300);
    await initializeAsrtSandbox({ denyWrite: base });
    const wrap = (denyWrite: string[]) => wrapToolCommand("echo safe", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [], denyWrite } });
    const first = [...base, ...paths("first")];
    await wrap(first);
    await expect(wrap(paths("second"))).rejects.toThrow(t("sandboxPolicy.configuredDeniesTooLarge"));
    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledOnce();
    await wrap(first);
    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledTimes(2);
  });

  it.each(WIN32_WRAPPERS)("keeps the next %s wrap admissible after mandatory rows exceed the budget", async (_name, wrap) => {
    await initializeAsrtSandbox({});
    await expect(wrapWriteDenies(wrap, denyPatterns("oversized", 1024)))
      .rejects.toThrow(t("sandboxPolicy.configuredDeniesTooLarge"));
    expect(manager.wrapWithSandboxArgv).not.toHaveBeenCalled();
    await expect(wrapWriteDenies(wrap, denyPatterns("ordinary", 1))).resolves.toMatchObject({ argv: ["confined"] });
    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledOnce();
  });

  it.each(WIN32_WRAPPERS)("keeps the next %s wrap admissible after the runtime rejects its expanded policy", async (_name, wrap) => {
    await initializeAsrtSandbox({});
    const cause = new WindowsSandboxError("acl_policy_too_large", "Expanded policy exceeds the ACL budget");
    manager.wrapWithSandboxArgv.mockRejectedValueOnce(cause);
    await expect(wrapWriteDenies(wrap, denyPatterns("expanded", 900)))
      .rejects.toMatchObject({ cause, message: t("sandboxPolicy.configuredDeniesTooLarge") });
    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledOnce();
    await expect(wrapWriteDenies(wrap, denyPatterns("ordinary", 125))).resolves.toMatchObject({ argv: ["confined"] });
    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledTimes(2);
  });

  it("keeps an in-progress worker verification on the same deny revision when a wrap is refused", async () => {
    const root = win32.join(fixtureRoot, "worker");
    const protectedPath = win32.join(root, "protected");
    present([protectedPath]);
    await initializeAsrtSandbox({ denyWrite: [protectedPath] });
    pinWorkerRoot(root);
    let refused: Promise<void> | undefined;
    const read = vi.spyOn(denyAcl, "readWindowsDenyAcls").mockImplementation(requests => {
      refused ??= expect(wrapWriteDenies(wrapToolCommand, denyPatterns("oversized", 1023)))
        .rejects.toThrow(t("sandboxPolicy.configuredDeniesTooLarge"));
      return requests.map(() => ({
        denyMask: denyAcl.WINDOWS_WRITE_DENY_MASK, inheritableMask: denyAcl.WINDOWS_WRITE_DENY_MASK, parentMask: 0x40, directory: false,
      }));
    });
    let grant: Awaited<ReturnType<typeof grantWindowsWorkerFilesystemAccess>> | undefined;
    try {
      grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [root] });
      expect(read.mock.calls.map(([targets]) => targets)).toEqual([[protectedPath], [protectedPath]]);
      expect(nativeWorker.grantWindowsAcl).toHaveBeenCalledOnce();
    } finally {
      await refused;
      grant?.release();
    }
  });

  it.each(WIN32_WRAPPERS.flatMap(([entryPoint, wrap]) => [
    { entryPoint, wrap, readback: 1, kind: "literal" },
    { entryPoint, wrap, readback: 2, kind: "glob" },
  ]))("refuses a worker grant when a $entryPoint wrap adds a $kind deny during readback $readback", async ({ wrap, readback, kind }) => {
    const root = win32.join(fixtureRoot, "worker");
    const initial = win32.join(root, "initial");
    const late = win32.join(root, kind === "glob" ? "*.secret" : "late-secret");
    present([initial, late]);
    await initializeAsrtSandbox({ denyRead: [initial] });
    pinWorkerRoot(root);
    let reads = 0;
    let wrapping: Promise<void> | undefined;
    const read = vi.spyOn(denyAcl, "readWindowsDenyAcls").mockImplementation(requests => {
      if (++reads === readback) {
        wrapping = expect(wrap("echo late", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [late] } }))
          .resolves.toMatchObject({ argv: ["confined"] });
      }
      return requests.map(() => ({
        denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: denyAcl.WINDOWS_READ_DENY_MASK, parentMask: 0x40, directory: false,
      }));
    });
    try {
      const grant = grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [root] })
        .then(held => { held.release(); return held; });
      await expect(grant).rejects.toThrow(/obligation|glob|changed/i);
      expect(read.mock.calls.map(([targets]) => targets)).toEqual(Array.from({ length: readback }, () => [initial]));
      expect(nativeWorker.grantWindowsAcl).not.toHaveBeenCalled();
      expect(wrapping).toBeDefined();
    } finally {
      await wrapping;
    }
  });

  it.each(WIN32_WRAPPERS)("refuses a worker grant when a %s wrap adds a glob deny while every reached row is watched", async (_name, wrap) => {
    const root = win32.join(fixtureRoot, "worker");
    const initial = win32.join(root, "initial");
    await initializeAsrtSandbox({ denyRead: [initial] });
    pinWorkerRoot(root);
    let wrapping: Promise<void> | undefined;
    const read = vi.spyOn(denyAcl, "readWindowsDenyAcls").mockImplementation(requests => {
      wrapping ??= expect(wrap("echo late", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [win32.join(root, "*.secret")] } }))
        .resolves.toMatchObject({ argv: ["confined"] });
      return requests.map(() => ({
        denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: denyAcl.WINDOWS_READ_DENY_MASK, parentMask: 0x40, directory: false,
      }));
    });
    try {
      const grant = grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [root] })
        .then(held => { held.release(); return held; });
      await expect(grant).rejects.toThrow(/obligation|glob|changed/i);
      expect(read.mock.calls.map(([targets]) => targets)).toEqual([[]]);
      expect(nativeWorker.grantWindowsAcl).not.toHaveBeenCalled();
      expect(stampWindowsAclAsync).not.toHaveBeenCalled();
    } finally {
      await wrapping;
    }
  });

  it("keeps both full-isolation gates closed until a late success", async () => {
    const initialization = await initializeAsrtSandbox({ windows: { backgroundInitialization: true } });
    expect(initialization.isCurrent()).toBe(true);
    expect(manager.initialize).toHaveBeenCalledWith(expect.objectContaining({
      windows: expect.objectContaining({ externalConfinement: "embedder" }),
    }), undefined, false);
    expect(manager.initializeWindowsIsolation).toHaveBeenCalledOnce();
    expect(isAsrtSandboxActive()).toBe(true);
    expect(isPluginWorkerConfinementActive()).toBe(false);
    expect(isOfflineProcessConfinementActive()).toBe(false);
    expect(() => assertExtensionStartAllowed()).toThrow("extension-start-consent-required");
    // A start refused in this window waits; once the backend is ready it runs confined, with no card and no consent.
    const ask = vi.fn(answerEachStart(() => "yes"));
    const taken: unknown[] = [];
    setExtensionStartAsker({ ask, notify: vi.fn() });
    deferExtensionStart({ key: "plugin-child:early", identity: "fixture", kind: "plugin-child", label: "early", cause: "no-backend", recheck: () => probeExtensionStart(),
      retry: async () => { taken.push(takeExtensionStartGrant("plugin-child:early"), probeExtensionStart()); } });

    succeed();
    await expect(initialization.windowsIsolation).resolves.toEqual({ status: "ready" });
    expect(isPluginWorkerConfinementActive()).toBe(true);
    // A ready backend confines the start: nobody is asked and no consent is needed.
    expect(() => assertExtensionStartAllowed()).not.toThrow();
    await settlePendingExtensionStarts({ sessionId: "s1", attended: true });
    expect(ask).not.toHaveBeenCalled();
    expect(taken).toEqual([undefined, "confined"]);
    expect(listPendingExtensionStarts()).toEqual([]);
    __resetExtensionStartsForTest();
    expect(isOfflineProcessConfinementActive()).toBe(true);
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("keeps both full-isolation gates closed after failure", async () => {
    const initialization = await initializeAsrtSandbox({ windows: { backgroundInitialization: true } });
    const error = new Error("session stamp failed");
    fail(error);
    await expect(initialization.windowsIsolation).resolves.toEqual({ status: "failed", error });
    expect(isAsrtSandboxActive()).toBe(true);
    expect(isPluginWorkerConfinementActive()).toBe(false);
    expect(isOfflineProcessConfinementActive()).toBe(false);
    expect(manager.reset).not.toHaveBeenCalled();
  });

  it("cannot reactivate either gate when a stamp settles after reset", async () => {
    const initialization = await initializeAsrtSandbox({ windows: { backgroundInitialization: true } });
    await resetAsrtSandbox();
    expect(initialization.isCurrent()).toBe(false);
    succeed();
    await expect(initialization.windowsIsolation).resolves.toEqual({ status: "cancelled" });
    expect(isAsrtSandboxActive()).toBe(false);
    expect(isPluginWorkerConfinementActive()).toBe(false);
    expect(isOfflineProcessConfinementActive()).toBe(false);
  });
});
