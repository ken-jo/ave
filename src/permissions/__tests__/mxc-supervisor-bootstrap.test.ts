import { win32 as winPath } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as Ffi from "koffi";
import { _bootstrapMxcSupervisorForTest } from "../mxc-supervisor-bootstrap.js";
import { MxcProcessContractError } from "../mxc-extension-errors.js";

function bootstrapFixture() {
  const modules = String.raw`C:\Ave\resources\app.asar.unpacked\node_modules`;
  const sdkRoot = winPath.join(modules, "@microsoft/mxc-sdk");
  const addonPath = winPath.join(modules, "@koromix/koffi-win32-x64/win32_x64/koffi.node");
  const directories = [winPath.join(sdkRoot, "bin/x64"), winPath.dirname(addonPath)];
  const events: string[] = [];
  const loaded = [String.raw`C:\Ave\ave.exe`, addonPath];
  const calls = vi.fn((signature: string, ...args: unknown[]): unknown => {
    if (signature.includes("SetDefaultDllDirectories")) { events.push("restrict"); expect(args[0]).toBe(0xc00); return true; }
    if (signature.includes("AddDllDirectory")) { events.push(`directory:${args[0]}`); return 1n; }
    if (signature.includes("GetStdHandle")) return 4n;
    if (signature.includes("GetCurrentProcess(")) return 1n;
    if (signature.includes("GetSystemDirectoryW")) {
      const directory = String.raw`C:\Windows\System32`;
      (args[0] as Buffer).write(directory, "utf16le"); return directory.length;
    }
    if (signature.includes("K32EnumProcessModules")) {
      for (let i = 0; i < loaded.length; i++) (args[1] as Buffer).writeBigUInt64LE(BigInt(i + 1), i * 8);
      (args[3] as number[])[0] = loaded.length * 8; return true;
    }
    if (signature.includes("GetModuleFileNameW")) {
      const file = loaded[Number(args[0]) - 1]; (args[1] as Buffer).write(file, "utf16le"); return file.length;
    }
    if (signature.includes("CreateJobObjectW")) { events.push("job-create"); expect(args).toEqual([null, null]); return 2n; }
    if (signature.includes("SetInformationJobObject")) { events.push("job-limit"); expect(args[1]).toBe(9); return true; }
    if (signature.includes("SetHandleInformation")) { events.push(args[0] === 2n ? "job-private" : "stdio-private"); expect(args.slice(1)).toEqual([1, 0]); return true; }
    if (signature.includes("AssignProcessToJobObject")) { events.push("job-assign"); return true; }
    if (signature.includes("CloseHandle")) { events.push("job-close"); return true; }
    throw new Error(`Unexpected native unit call: ${signature}`);
  });
  const encode = vi.fn();
  const ffi = { load: vi.fn(() => { events.push("kernel-load"); return { func: (signature: string) => (...args: unknown[]) => calls(signature, ...args) }; }),
    struct: vi.fn(() => ({})), sizeof: () => 144, encode } as unknown as typeof Ffi;
  const verify = vi.fn(() => { events.push("verified"); return { sdkRoot, addonPath, nativeDirectories: directories }; });
  const loadAddon = vi.fn((file: string) => { events.push("addon-load"); expect(file).toBe(addonPath); return ffi; });
  const importSdk = vi.fn(async () => { events.push("sdk-import"); return { probe: vi.fn(), spawn: vi.fn() }; });
  const deps = { verify, verifyRuntime: vi.fn(() => { events.push("runtime-verified"); return [String.raw`C:\Ave\ave.exe`]; }), loadAddon, importSdk, resolvePath: (file: string) => file };
  return { modules, sdkRoot, addonPath, directories, events, loaded, calls, encode, deps };
}

describe("supervisor bootstrap ordering with injected native calls", () => {
  it("verifies all payloads before the sole addon load, then restricts search before SDK import", async () => {
    const f = bootstrapFixture();
    await _bootstrapMxcSupervisorForTest(f.modules, "x64", {}, f.deps);
    expect(f.events).toEqual(["verified", "runtime-verified", "addon-load", "kernel-load", "restrict", ...f.directories.map((dir) => `directory:${dir}`), "stdio-private", "stdio-private", "stdio-private", "job-create", "job-limit", "job-private", "job-assign", "sdk-import"]);
    expect(f.deps.verify.mock.calls[0].slice(-2)).toEqual([{}, true]);
    expect(f.encode.mock.calls[0][2].basicLimitInformation.limitFlags).toBe(0x2000);
    expect(f.events).not.toContain("job-close");
  });

  it("performs zero native requires after verification rejects tamper or override", async () => {
    const f = bootstrapFixture();
    f.deps.verify.mockImplementation(() => { throw new Error("pin mismatch"); });
    await expect(_bootstrapMxcSupervisorForTest(f.modules, "x64", { MXC_FFI_DIR: "planted" }, f.deps)).rejects.toThrow("pin mismatch");
    expect(f.deps.loadAddon).not.toHaveBeenCalled();
    expect(f.deps.importSdk).not.toHaveBeenCalled();
  });

  it("refuses search restriction and job assignment failure before SDK import", async () => {
    for (const failing of ["SetDefaultDllDirectories", "AddDllDirectory", "AssignProcessToJobObject"]) {
      const f = bootstrapFixture(), original = f.calls.getMockImplementation()!;
      f.calls.mockImplementation((signature, ...args) => signature.includes(failing) ? false : original(signature, ...args));
      await expect(_bootstrapMxcSupervisorForTest(f.modules, "x64", {}, f.deps)).rejects.toBeInstanceOf(MxcProcessContractError);
      expect(f.deps.importSdk).not.toHaveBeenCalled();
    }
  });

  it("rejects a selected DLL resolving to cwd, PATH or temp", async () => {
    for (const directory of [String.raw`C:\workspace`, String.raw`C:\bin`, String.raw`C:\temp`]) {
      const f = bootstrapFixture();
      f.deps.importSdk.mockImplementation(async () => {
        f.loaded.push(winPath.join(directory, "mxc_ffi.dll"));
        return { probe: vi.fn(), spawn: vi.fn() };
      });
      await expect(_bootstrapMxcSupervisorForTest(f.modules, "x64", {}, f.deps)).rejects.toThrow("Unexpected supervisor native module");
    }
  });

  it("rejects an unpinned module already present immediately after the bootstrap load", async () => {
    const f = bootstrapFixture(); f.loaded.push(String.raw`C:\temp\initial.dll`);
    await expect(_bootstrapMxcSupervisorForTest(f.modules, "x64", {}, f.deps)).rejects.toThrow("Unexpected supervisor native module");
    expect(f.deps.importSdk).not.toHaveBeenCalled();
  });

  it("audits newly loaded dependencies after the native probe", async () => {
    const f = bootstrapFixture();
    const runtime = await _bootstrapMxcSupervisorForTest(f.modules, "x64", {}, f.deps);
    f.loaded.push(winPath.join(f.sdkRoot, "bin/x64/mxc_ffi.dll"));
    expect(runtime.auditModules()).toContain(winPath.join(f.sdkRoot, "bin/x64/mxc_ffi.dll"));
    f.loaded.push(String.raw`C:\temp\other.dll`);
    expect(() => runtime.auditModules()).toThrow(MxcProcessContractError);
  });
});
