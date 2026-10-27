import { getBuiltinModule } from "node:process";
import { execFileSync } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFileSync: vi.fn() }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
vi.mock("../ave-home.js", async original => ({
  ...await original<typeof import("../ave-home.js")>(),
  verifyAveHomeConfiguration: () => true,
  aveHomeConfigurationDirectory: (home: string) => join(home, "config"),
}));

const HOST = process.platform;
const nativeOs = getBuiltinModule("node:os");
const MESSAGE = "Native Windows access requires a Windows host";

afterEach(() => {
  setProcessPlatform(HOST);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("native host capture", () => {
  it.runIf(process.platform !== "win32")("refuses a forced win32 platform on the real foreign host", async () => {
    vi.resetModules();
    setProcessPlatform("win32");
    const native = await import("../windows-native-host.js");
    expect(() => native.assertWindowsNativeHost()).toThrow(MESSAGE);
  });

  it.each(["Darwin", "Linux"])("captures %s once independently of later platform queries", async type => {
    vi.resetModules();
    const readType = vi.spyOn(nativeOs, "type").mockReturnValue(type);
    const native = await import("../windows-native-host.js");
    expect(readType).toHaveBeenCalledOnce();
    readType.mockReturnValue("Windows_NT");
    setProcessPlatform("win32");
    const limit = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 0;
      expect(() => native.assertWindowsNativeHost()).toThrow(MESSAGE);
      expect(readType).toHaveBeenCalledOnce();
    } finally { Error.stackTraceLimit = limit; }
  });

  it("guards every native entry before process creation or handle access", async () => {
    vi.resetModules();
    vi.spyOn(nativeOs, "type").mockReturnValue("Darwin");
    setProcessPlatform("win32");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const home = join(process.env.AVE_HOME!, "example");
    const owner = await vi.importActual<typeof import("../ave-home.js")>("../ave-home.js");
    const facts = await import("../windows-path-facts.js");
    const handles = await import("../windows-configuration-handles.js");
    const configuration = await import("../ave-home-configuration.js");
    const readDacls = facts.readWindowsDacls;
    vi.spyOn(facts, "readWindowsDacls").mockReturnValue([{
      exists: false, canonical: null, volumeSerial: null, fileId: null, volumeSerialNumber: null, fileIndex: null,
      changeTime: null, attributes: 0, reparseTag: 0, reparseTarget: null, directory: false, ancestors: [],
      currentUserSid: "S-1-5-21-100-200-300-1001", elevated: false, principals: {}, dacl: null,
    }]);
    for (const entry of [
      () => facts.pinWindowsPaths([home]),
      () => readDacls([home]),
      () => owner.verifyAveHomeConfiguration(home, true),
      () => owner.readWindowsDirectoryDacls([home], true),
      () => owner.acknowledgeHomeBoundaryRepair(home, join(home, "secrets")),
      () => handles.openWindowsConfigurationHandles([]),
    ]) {
      expect(entry).toThrow(MESSAGE);
      expect(execFileSync).not.toHaveBeenCalled();
      expect(openSync).not.toHaveBeenCalled();
    }
    const access = await import("../ave-home-configuration-access.js");
    access.setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
    try {
      expect(configuration.migrateAveHomeConfiguration(home)).toEqual([expect.stringContaining(MESSAGE)]);
    } finally { access.setAveHomeConfigurationOwner(undefined); }
    expect(execFileSync).not.toHaveBeenCalled();
    expect(openSync).not.toHaveBeenCalled();
  });
});
