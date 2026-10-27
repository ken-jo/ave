import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import * as pathFacts from "../../shared/windows-path-facts.js";
import * as configurationHandles from "../../shared/windows-configuration-handles.js";
import { installWindowsNativeTripwire } from "./windows-native-tripwire.js";

vi.mock("node:fs", async original => (await import("./simulated-win32-drive.js")).simulatedConfigurationFs(await original(), "linux"));
vi.mock("../../shared/windows-path-facts.js", async original => (await import("./simulated-win32-drive.js")).simulatedWindowsPathFacts(await original(), "linux"));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("./simulated-win32-drive.js")).simulatedConfigurationHandles(await original(), "linux"));
vi.mock("node:os", async original => ({
  ...await original<typeof import("node:os")>(), platform: () => "win32",
}));

describe("native Windows tripwire", () => {
  it.each(["linux", "darwin"] as const)("blocks real native entry points on a captured %s host", async host => {
    const facts = await vi.importActual<typeof pathFacts>("../../shared/windows-path-facts.js");
    const handles = await vi.importActual<typeof configurationHandles>("../../shared/windows-configuration-handles.js");
    let tripwire = await installWindowsNativeTripwire(host, () => expect.getState().testPath);
    const path = join(tmpdir(), "native-tripwire-missing");
    try {
      for (const read of [facts.pinWindowsPaths, facts.readWindowsDacls]) {
        expect(() => read([path])).toThrow(/windows-native-tripwire\.test\.ts.*simulated-win32-drive\.ts/);
        expect(tripwire.takeViolation()?.message).toContain(`host ${host}`);
      }
      expect(() => handles.openWindowsConfigurationHandles([{
        path, facts: { directory: false, volumeSerialNumber: null, fileIndex: null, changeTime: null, fileSystemName: null },
        changeTimeRequired: false,
      }])).toThrow(/windows-native-tripwire\.test\.ts.*simulated-win32-drive\.ts/);
      expect(tripwire.takeViolation()?.message).toMatch(/windows-native-tripwire\.test\.ts.*simulated-win32-drive\.ts/);
      // Configuration owners deliberately catch native read failures. Teardown
      // retains the actionable error even when the immediate caller catches it.
      try { facts.pinWindowsPaths([path]); } catch { /* Exercise a caught read failure. */ }
      expect(tripwire.takeViolation()?.message).toContain("simulated-win32-drive.ts");
      vi.restoreAllMocks();
      vi.resetModules();
      const reloaded = await vi.importActual<typeof pathFacts>("../../shared/windows-path-facts.js");
      tripwire.restore();
      tripwire = await installWindowsNativeTripwire(host, () => expect.getState().testPath);
      expect(() => reloaded.pinWindowsPaths([path])).toThrow(/simulated-win32-drive\.ts/);
      expect(tripwire.takeViolation()?.message).toContain(`host ${host}`);
    } finally { tripwire.restore(); }
  });

  it("passes through unchanged on a captured Windows host", async () => {
    const os = await vi.importActual<typeof import("node:os")>("node:os");
    const platform = os.platform;
    const tripwire = await installWindowsNativeTripwire("win32", () => expect.getState().testPath);
    try {
      expect(os.platform).toBe(platform);
      expect(tripwire.takeViolation()).toBeUndefined();
    } finally { tripwire.restore(); }
  });

  it("lets the per-file simulated factories bypass native access", async () => {
    const tripwire = await installWindowsNativeTripwire("linux", () => expect.getState().testPath);
    try {
      const path = join(tmpdir(), "native-tripwire-missing");
      expect(pathFacts.pinWindowsPaths([path])[0]!.exists).toBe(false);
      expect(pathFacts.readWindowsDacls([path])[0]!.exists).toBe(false);
      const { simulatedConfigurationHandles } = await import("./simulated-win32-drive.js");
      const provider = vi.fn(() => ({ handles: undefined, fileOpened: false }));
      const simulated = simulatedConfigurationHandles({ ...configurationHandles, openWindowsConfigurationHandles: provider }, "win32");
      expect(simulated.openWindowsConfigurationHandles([])).toEqual({ handles: undefined, fileOpened: false });
      expect(provider).toHaveBeenCalledOnce();
      expect(tripwire.takeViolation()).toBeUndefined();
    } finally { tripwire.restore(); }
  });

  it("reports a caught native violation without stack traces", async () => {
    const nativeHost = await import("../../shared/windows-native-host.js");
    const limit = Error.stackTraceLimit;
    const tripwire = await installWindowsNativeTripwire("darwin", () => "example.test.ts");
    try {
      Error.stackTraceLimit = 0;
      try { nativeHost.runWindowsNative(() => undefined); } catch { /* Exercise caught failures. */ }
      expect(tripwire.takeViolation()?.message).toMatch(/example\.test\.ts.*host darwin.*simulated-win32-drive\.ts/);
    } finally { Error.stackTraceLimit = limit; tripwire.restore(); }
  });
});
