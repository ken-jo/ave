import * as childProcess from "node:child_process";
import * as filesystem from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../test-helpers.js";
import { setProcessPlatform } from "./process-platform.js";
import { useConfigurationOwner } from "./configuration-owner.js";
import { simulatedConfigurationFs, simulatedConfigurationHandles, simulatedWindowsPathFacts } from "./simulated-win32-drive.js";
import * as pathFacts from "../../shared/windows-path-facts.js";
import * as configurationHandles from "../../shared/windows-configuration-handles.js";
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
