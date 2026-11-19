vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDriveFs(await original()));
vi.mock("node:module", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDriveModule(await original()));
vi.mock("node:path", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDrivePath(await original()));
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
import { resolve, win32 } from "node:path";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
import { useVerifiedAveHomePrivacy as installVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { t } from "../../i18n/index.js";
import { configureHostResources } from "../../main/host-resources.js";
import { setPluginWorkerConfinementRequestedAtBoot, __resetSandboxRequestedAtBootForTest } from "../sandbox-capability.js";
import * as facts from "../../shared/windows-path-facts.js";
import * as denyAcl from "../windows-deny-acl.js";
import * as stampTargets from "../windows-stamp-targets.js";
import { grantWindowsWorkerFilesystemAccess, initializeAsrtSandbox, isAsrtSandboxActive, isOfflineProcessConfinementActive, isPluginWorkerConfinementActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";

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
  stampWindowsAcl: vi.fn(),
  revokeWindowsAcl: vi.fn(() => []),
  resolveSrtWin: vi.fn(({ path }: { path: string }) => ({ exe: path, prependArgs: [] })),
  getWindowsSandboxUserStatus: vi.fn(() => ({ provisioned: true, credPresent: true, sid: "S-1-5-21-123" })),
}));
vi.mock("@anthropic-ai/sandbox-runtime", async original => ({
  ...(await original<typeof import("@anthropic-ai/sandbox-runtime")>()),
  ...nativeWorker,
  SandboxManager: manager,
}));
vi.mock("../srt-win-integrity.js", async original => ({
  ...(await original<typeof import("../srt-win-integrity.js")>()),
  prepareSrtWinExecutable: (path: string) => path,
}));

installVerifiedAveHomePrivacy();
const ORIGINAL_PLATFORM = process.platform;
const FIXTURE_DRIVE = ORIGINAL_PLATFORM === "win32" ? win32.parse(process.cwd()).root : "D:\\";
let succeed: () => void;
let fail: (error: Error) => void;

beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  setProcessPlatform("win32");
  setPluginWorkerConfinementRequestedAtBoot(true);
  manager.initializeWindowsIsolation.mockImplementation(() => new Promise<void>((resolve, reject) => {
    succeed = resolve;
    fail = reject;
  }));
});

afterEach(async () => {
  await resetAsrtSandbox();
  __resetSandboxRequestedAtBootForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe("background session isolation", () => {
  it("verifies and stamps a valid worker policy once per distinct target", async () => {
    const root = win32.join(FIXTURE_DRIVE, "fixture", "worker");
    const paths = Array.from({ length: 510 }, (_, index) => win32.join(root, `denied-${index}`));
    paths.push(win32.join(root, "Case"), win32.join(root, "case"), `${win32.join(root, "absent-dir")}\\`);
    await initializeAsrtSandbox({ denyWrite: paths, windows: { externalConfinement: true } });
    const pin = facts.pinWindowsPaths;
    const pinSpy = vi.spyOn(facts, "pinWindowsPaths").mockImplementation(requests => requests.map(path =>
      path === root ? { exists: true, canonical: root, volumeSerial: "volume", fileId: "worker-root",
        volumeSerialNumber: null, fileIndex: null, changeTime: null, attributes: 16, reparseTag: 0,
        directory: true, reparseTarget: null, ancestors: [] } : pin([path])[0]!));
    const stamp = vi.spyOn(stampTargets, "pinWindowsFilesystemConfig").mockImplementation(config => config);
    const read = vi.spyOn(denyAcl, "readWindowsDenyAcls").mockImplementation(requests => requests.map(() => ({
      denyMask: denyAcl.WINDOWS_WRITE_DENY_MASK, inheritableMask: denyAcl.WINDOWS_WRITE_DENY_MASK, parentMask: 0x40, directory: false,
    })));
    try {
      const grant = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [root] });
      try {
        expect(read.mock.calls.map(([targets]) => targets)).toEqual([paths, paths]);
        expect(nativeWorker.stampWindowsAcl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ denyWrite: paths, denyRead: [] }));
        expect(nativeWorker.grantWindowsAcl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ write: [root] }));
      } finally { grant.release(); }
    } finally {
      read.mockRestore();
      stamp.mockRestore();
      pinSpy.mockRestore();
    }
  });

  it("refuses cumulative retained deny growth without recording the rejected request", async () => {
    const paths = (prefix: string, length = 600) => Array.from({ length }, (_, index) => `D:/retained/${prefix}/${index}`);
    const base = paths("base", 300);
    await initializeAsrtSandbox({ denyWrite: base, windows: { externalConfinement: true } });
    const wrap = (denyWrite: string[]) => wrapToolCommand("echo safe", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [], denyWrite } });
    const first = [...base, ...paths("first")];
    await wrap(first);
    await expect(wrap(paths("second"))).rejects.toThrow(t("sandboxPolicy.configuredDeniesTooLarge"));
    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledOnce();
    await wrap(first);
    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledTimes(2);
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

    succeed();
    await expect(initialization.windowsIsolation).resolves.toEqual({ status: "ready" });
    expect(isPluginWorkerConfinementActive()).toBe(true);
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
