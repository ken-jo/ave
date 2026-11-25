import * as childProcess from "node:child_process";
import * as filesystem from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../test-helpers.js";
import { setProcessPlatform } from "./process-platform.js";
import { useConfigurationOwner } from "./configuration-owner.js";
import { mxcStagingParentFor, SYNTHETIC_MXC_STAGING_PARENT } from "./mxc-staging-parent.js";
import { nativePluginLaunch } from "./mxc-plugin-launch.js";
import {
  SIMULATED_MXC_CACHE_HOME, simulatedConfigurationFs, simulatedConfigurationHandles, simulatedRuntimeRoot, simulatedSandboxProcessHome, simulatedWindowsPathFacts,
} from "./simulated-win32-drive.js";
import * as runtimeRoot from "../../permissions/mxc-runtime-root.js";
import { assertMxcHolderStaging } from "../../permissions/mxc-filesystem-ownership.js";
import { isWindowsDrivePath } from "../../permissions/mxc-runtime-root-windows.js";
import { isPlainWindowsStampPath } from "../../permissions/windows-stamp-targets.js";
import * as pathFacts from "../../shared/windows-path-facts.js";
import * as configurationHandles from "../../shared/windows-configuration-handles.js";
import type * as SandboxProcessHome from "../../permissions/sandbox-process-home.js";
import { readAveHomeConfigurationFile, tryWithAveHomeConfigurationWrite, withAveHomeConfigurationWrite } from "../../shared/ave-home-configuration-access.js";

vi.mock("node:fs", async original => (await import("./simulated-win32-drive.js")).simulatedConfigurationFs(await original(), "linux"));
vi.mock("../../shared/windows-path-facts.js", async original => (await import("./simulated-win32-drive.js")).simulatedWindowsPathFacts(await original(), "linux"));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("./simulated-win32-drive.js")).simulatedConfigurationHandles(await original(), "linux"));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(() => { throw new Error("Unexpected native helper call"); }) };
});

const host = process.platform;
const temporary = useTempDirs("simulated-configuration-");
useConfigurationOwner();
afterEach(() => { setProcessPlatform(host); });

describe("simulated configuration boundary", () => {
  it("preserves native modules and handle calls on a captured Windows host", async () => {
    const actualFs = await vi.importActual<typeof filesystem>("node:fs");
    expect(simulatedConfigurationFs(actualFs, "win32")).toBe(actualFs);
    expect(await simulatedWindowsPathFacts(pathFacts, "win32")).toBe(pathFacts);
    const result = { handles: undefined, fileOpened: false };
    const open = vi.fn(() => result);
    const native = simulatedConfigurationHandles({ ...configurationHandles, openWindowsConfigurationHandles: open }, "win32");
    expect(native.openWindowsConfigurationHandles([])).toBe(result);
    expect(open).toHaveBeenCalledWith([]);
  });

  it.each(["linux", "darwin"] as const)("uses host fixtures for facts and handles on a captured %s host", async nativeHost => {
    const file = join(temporary(), "restrictions.json");
    filesystem.writeFileSync(file, '{"restricted":true}');
    setProcessPlatform("win32");
    const nativePin = vi.fn(() => { throw new Error("Unexpected native pin"); });
    const nativeDacl = vi.fn(() => { throw new Error("Unexpected native DACL"); });
    const facts = await simulatedWindowsPathFacts({ ...pathFacts, pinWindowsPaths: nativePin, readWindowsDacls: nativeDacl }, nativeHost);
    const [row] = facts.pinWindowsPaths([file]);
    const descriptor = filesystem.openSync(file, "r");
    try {
      const stat = simulatedConfigurationFs(filesystem, nativeHost).fstatSync(descriptor, { bigint: true });
      expect(BigInt(row!.volumeSerialNumber!)).toBe(stat.dev);
      expect(BigInt(row!.fileIndex!)).toBe(stat.ino);
      expect((BigInt(row!.changeTime!) - 116444736000000000n) * 100n).toBe(stat.ctimeNs);
    } finally { filesystem.closeSync(descriptor); }
    expect(facts.readWindowsDacls([file], { content: true })[0]!.contentHex).toBe(Buffer.from('{"restricted":true}').toString("hex"));
    expect(facts.pinWindowsPaths([`${file}.missing`])[0]!.exists).toBe(false);
    const open = vi.fn(() => { throw new Error("Unexpected native handle"); });
    const handles = simulatedConfigurationHandles({ ...configurationHandles, openWindowsConfigurationHandles: open }, nativeHost);
    expect(handles.openWindowsConfigurationHandles([])).toEqual({ handles: undefined, fileOpened: false });
    expect(nativePin).not.toHaveBeenCalled();
    expect(nativeDacl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("runs real configuration reads and both owner paths without a native helper", async () => {
    const file = join(temporary(), "restrictions.json");
    filesystem.writeFileSync(file, '{"restricted":true}');
    setProcessPlatform("win32");
    expect(readAveHomeConfigurationFile(file)?.toString()).toBe('{"restricted":true}');
    expect(tryWithAveHomeConfigurationWrite(file, path => filesystem.writeFileSync(path, '{"restricted":"owner"}'))).toBe(true);
    await withAveHomeConfigurationWrite(file, async path => { filesystem.writeFileSync(path, '{"restricted":"queued"}'); });
    expect(readAveHomeConfigurationFile(file)?.toString()).toBe('{"restricted":"queued"}');
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });
});

describe("simulated sandbox process HOME", () => {
  const moduleWith = (createSandboxProcessHome: (...args: unknown[]) => unknown) =>
    ({ createSandboxProcessHome }) as unknown as typeof SandboxProcessHome;

  it("preserves the real HOME module on a captured Windows host", async () => {
    const actual = moduleWith(vi.fn());
    expect(await simulatedSandboxProcessHome(actual, "win32")).toBe(actual);
  });

  it.each(["linux", "darwin"] as const)("gives a simulated Windows HOME a host directory on a captured %s host", async nativeHost => {
    const real = vi.fn(() => { throw new Error("Unexpected real HOME"); });
    const simulated = await simulatedSandboxProcessHome(moduleWith(real), nativeHost);
    setProcessPlatform("win32");
    const homes = [simulated.createSandboxProcessHome(), simulated.createSandboxProcessHome("win32")];
    for (const home of homes) {
      try {
        expect(isAbsolute(home.path)).toBe(true);
        expect(filesystem.statSync(home.path).isDirectory()).toBe(true);
        expect(home.env).toEqual({ HOME: home.path, USERPROFILE: home.path });
      } finally { home.cleanup(); }
      expect(filesystem.existsSync(home.path)).toBe(false);
    }
    expect(real).not.toHaveBeenCalled();
  });

  it("hands a host-platform HOME to the real module", async () => {
    const fixture = { path: "/fixture-home", env: {}, cleanup: vi.fn() };
    const real = vi.fn(() => fixture);
    const simulated = await simulatedSandboxProcessHome(moduleWith(real), "linux");
    setProcessPlatform("linux");
    expect(simulated.createSandboxProcessHome()).toBe(fixture);
    expect(simulated.createSandboxProcessHome("darwin")).toBe(fixture);
    expect(real.mock.calls).toEqual([[], ["darwin"]]);
  });
});

describe("simulated container runtime root", () => {
  it("keeps the real module on a Windows host", () => {
    expect(simulatedRuntimeRoot(runtimeRoot, "win32")).toBe(runtimeRoot);
  });

  it("denies a drive-path root for a simulated win32 process whatever this kernel spells the run directory", () => {
    const simulated = simulatedRuntimeRoot(runtimeRoot, "linux");
    setProcessPlatform("win32");
    vi.stubEnv("AVE_TEST_SANDBOX_BASE", "/home/alice/.ave/test-tmp/sbx-example");
    try {
      const floor = simulated.mxcRuntimeRootFloorPath();
      expect(floor).toBe(win32.join(SIMULATED_MXC_CACHE_HOME, runtimeRoot.AVE_APP_ID, "mxc-runtime"));
      expect(isWindowsDrivePath(floor) && isPlainWindowsStampPath(floor)).toBe(true);
      expect(simulated.mxcRuntimeRootFloorPath("C:\\example")).toBe(runtimeRoot.mxcRuntimeRootFloorPath("C:\\example", "win32"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Production asks with a positional platform; the installed function must not read it as the host.
  const asProductionAsks = (parent: () => string): string => (parent as (...args: unknown[]) => string)("win32");

  it("hands a foreign host's win32 staging request the synthetic parent its launch passes the holder check on", () => {
    const parent = mxcStagingParentFor("linux", () => "/tmp/mxc-staging-example");
    const stagingParent = asProductionAsks(parent);
    const { home, temp } = nativePluginLaunch({}, parent());
    expect(() => assertMxcHolderStaging({ stagingParent, home, temp })).not.toThrow();
    expect(stagingParent).toBe(SYNTHETIC_MXC_STAGING_PARENT);
  });

  it("hands a Windows host its suite parent with or without a platform argument", () => {
    const parent = mxcStagingParentFor("win32", () => "D:\\example\\mxc-staging-x");
    expect([parent(), asProductionAsks(parent)]).toEqual(["D:\\example\\mxc-staging-x", "D:\\example\\mxc-staging-x"]);
    const { home, temp } = nativePluginLaunch({}, parent());
    expect(() => assertMxcHolderStaging({ stagingParent: asProductionAsks(parent), home, temp })).not.toThrow();
  });
});
