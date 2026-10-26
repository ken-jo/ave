import { configureHostResources } from "../../main/host-resources.js";
import * as childProcess from "node:child_process";
import { existsSync, lstatSync, mkdirSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";
import { readAveHomeConfigurationFile, withAveHomeConfigurationWrite } from "../ave-home-configuration-access.js";
import { writeUtf8FileAtomicSync } from "../../lib/atomic-file.js";
import { migrateAveHomeConfiguration } from "../ave-home-configuration.js";
import { AveHomeConfigurationUntrustedError, ensureAveHomePrivate, isAveHomeConfigurationRefused, win32SystemBinary, _resetAveHomePrivacyForTest } from "../ave-home.js";
import { windowsPowerShellEnv } from "../windows-powershell-env.js";
import { WINDOWS_HOME_BOUNDARY_SOURCE } from "../windows-home-boundary.js";
import { readJudgeStoredModels, writePermissionSettings } from "../../permissions/permission-settings-store.js";

beforeAll(() => { configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }); });

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: vi.fn(actual.exec), execSync: vi.fn(actual.execSync), execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync), spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync), fork: vi.fn(actual.fork) };
});

useConfigurationOwner();
const paths = useTempPaths("configuration-read-", ".ave");
afterEach(() => { vi.unstubAllEnvs(); _resetAveHomePrivacyForTest(); });

function fixture(): { home: string; path: string } {
  const home = paths();
  setFixtureOwner(dirname(home));
  vi.stubEnv("AVE_HOME", home);
  expect(ensureAveHomePrivate(home).enforcement).toBe("win32-dacl");
  writeFileSync(join(home, "settings.json"), '{"permissions":{}}');
  migrateAveHomeConfiguration(home);
  return { home, path: join(home, "settings.json") };
}

function expectNoSpawns(): void {
  for (const name of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"] as const) {
    expect(childProcess[name], name).not.toHaveBeenCalled();
  }
}

function weaken(path: string): void {
  childProcess.execFileSync(win32SystemBinary("icacls"), [path, "/grant", "*S-1-1-0:(OI)(CI)W", "/q"], { windowsHide: true, stdio: "pipe" });
}

function nativeChangeTime(home: string): bigint {
  const extra = `public static class DirectoryChangeTime {
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct Basic { public long Created, Accessed, Written, Changed; public uint Attributes; }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle h, int c, out Basic b, uint n);
    public static string Read(Microsoft.Win32.SafeHandles.SafeFileHandle h) {
      Basic b; if (!GetFileInformationByHandleEx(h, 0, out b, 40)) throw new System.ComponentModel.Win32Exception();
      return ((b.Changed - 116444736000000000L) * 100L).ToString();
    }
  }`;
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WINDOWS_HOME_BOUNDARY_SOURCE}\n${extra}\n'@\n$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $h=[HomeDirectoryDacl]::OpenHome($env:AVE_DACL_REQUEST,$u,$false,$true); try { [DirectoryChangeTime]::Read($h) } finally { $h.Dispose() }`;
  return BigInt(childProcess.execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$s=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($s))", "utf16le").toString("base64")],
    { input: script, encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ...process.env, AVE_DACL_REQUEST: home }) }).trim());
}

describe.runIf(process.platform === "win32")("configuration handle reads", () => {
  it("refuses a recognized non-refused unprotected home for document and stored judge reads", () => {
    const home = paths();
    mkdirSync(home);
    vi.stubEnv("AVE_HOME", home);
    const path = join(home, "settings.json");
    const raw = '{"permissions":{"judge":{"model":"openai/reviewer"}}}';
    writeFileSync(path, raw);
    expect(isAveHomeConfigurationRefused(home)).toBe(false);
    expect(() => readAveHomeConfigurationFile(path)).toThrowError(AveHomeConfigurationUntrustedError);
    expect(() => readJudgeStoredModels(path)).toThrowError(AveHomeConfigurationUntrustedError);
    expect(existsSync(join(home, "config"))).toBe(false);
  });

  it("surfaces an untrusted admitted boundary when reading stored judge models", () => {
    const { home, path } = fixture();
    readAveHomeConfigurationFile(path);
    weaken(join(home, "config"));
    expect(() => readJudgeStoredModels(path)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });

  it("refuses an inherited deletion deny applied during cold verification", () => {
    const home = paths();
    mkdirSync(home);
    setFixtureOwner(dirname(home));
    const path = join(home, "settings.json");
    writeFileSync(path, "{}");
    const before = lstatSync(home, { bigint: true });
    const execute = vi.mocked(childProcess.execFileSync).getMockImplementation()!;
    const principal = "*S-1-1-0";
    let denyApplied = false;
    vi.mocked(childProcess.execFileSync).mockImplementationOnce((...args) => {
      const result = Reflect.apply(execute, undefined, args);
      Reflect.apply(execute, undefined, [win32SystemBinary("icacls"),
        [dirname(home), "/deny", `${principal}:(OI)(CI)(DC)`, "/q"], { windowsHide: true, stdio: "pipe" }]);
      denyApplied = true;
      return result;
    });
    try {
      let failure: unknown;
      try { readAveHomeConfigurationFile(path); } catch (error) { failure = error; }
      expect(failure).toMatchObject({
        name: "AveHomeConfigurationUntrustedError", reason: "Configuration boundary changed during verification",
      });
      const after = lstatSync(home, { bigint: true });
      expect(after.dev).toBe(before.dev);
      expect(after.ino).toBe(before.ino);
      expect(after.ctimeNs).toBeGreaterThan(before.ctimeNs);
      const acl = childProcess.execFileSync(win32SystemBinary("icacls"), [home], { windowsHide: true, encoding: "utf8" });
      expect(acl).toContain("(I)(OI)(CI)(DENY)(DC)");
    } finally {
      if (denyApplied) childProcess.execFileSync(win32SystemBinary("icacls"), [dirname(home), "/remove:d", principal, "/q"], { windowsHide: true, stdio: "pipe" });
    }
  });

  it("does not spawn a child process during steady state reads", () => {
    const { path } = fixture();
    expect(readAveHomeConfigurationFile(path)?.toString()).toBe('{"permissions":{}}');
    vi.clearAllMocks();
    for (let i = 0; i < 20; i++) expect(readAveHomeConfigurationFile(path)?.toString()).toBe('{"permissions":{}}');
    expectNoSpawns();
  });

  it.each(["config", "home"])("invalidates a warm boundary after an in place %s DACL weakening", (target) => {
    const { home, path } = fixture();
    readAveHomeConfigurationFile(path);
    vi.clearAllMocks();
    readAveHomeConfigurationFile(path);
    expectNoSpawns();
    weaken(target === "home" ? home : join(home, "config"));
    expect(() => readAveHomeConfigurationFile(path)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });

  it.each(["junction", "directory"])("refuses an intermediate ancestor substituted with a %s", (kind) => {
    const { home, path } = fixture();
    readAveHomeConfigurationFile(path);
    const ancestor = dirname(home), moved = `${ancestor}-moved`;
    renameSync(ancestor, moved);
    if (kind === "junction") symlinkSync(moved, ancestor, "junction");
    else {
      mkdirSync(ancestor);
      renameSync(join(moved, ".ave"), home);
    }
    try {
      expect(() => readAveHomeConfigurationFile(path)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
    } finally {
      if (kind === "directory") renameSync(home, join(moved, ".ave"));
      rmdirSync(ancestor);
      renameSync(moved, ancestor);
    }
  });

  it("keeps cold verification and unrelated ancestor entry changes warm", () => {
    const { home, path } = fixture();
    expect(readAveHomeConfigurationFile(path)).toBeDefined();
    writeFileSync(join(dirname(home), "unrelated.log"), "entry");
    vi.clearAllMocks();
    expect(readAveHomeConfigurationFile(path)).toBeDefined();
    expectNoSpawns();
  });

  it("keeps reads immediately after owner settings writes warm and measures the sequence", async () => {
    const bootStart = performance.now();
    const { path } = fixture();
    const bootMs = performance.now() - bootStart;
    vi.clearAllMocks();
    const coldStart = performance.now();
    readAveHomeConfigurationFile(path);
    const coldMs = performance.now() - coldStart;
    const coldSpawns = vi.mocked(childProcess.execFileSync).mock.calls.length;
    vi.clearAllMocks();
    for (let i = 0; i < 20; i++) readAveHomeConfigurationFile(path);
    expectNoSpawns();
    for (let i = 0; i < 3; i++) {
      await writePermissionSettings({ additionalDirectories: [] }, path);
      readAveHomeConfigurationFile(path);
    }
    const samples = Array.from({ length: 20 }, () => {
      const start = performance.now(); readAveHomeConfigurationFile(path); return performance.now() - start;
    }).sort((a, b) => a - b);
    console.log(JSON.stringify({ bootMs, coldMs, coldSpawns, ownerWrites: 3, warmReads: 43,
      warmSpawns: vi.mocked(childProcess.execFileSync).mock.calls.length, warmMedianMs: (samples[9]! + samples[10]!) / 2 }));
    expectNoSpawns();
  });

  it.each(["config", "home"])("refuses foreign %s DACL weakening immediately after an owner write", async (target) => {
    const { home, path } = fixture();
    readAveHomeConfigurationFile(path);
    await writePermissionSettings({ additionalDirectories: [] }, path);
    weaken(target === "home" ? home : join(home, "config"));
    expect(() => readAveHomeConfigurationFile(path)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });

  it("never rekeys a foreign DACL change across an awaited owner callback", async () => {
    const { home, path } = fixture();
    readAveHomeConfigurationFile(path);
    await expect(withAveHomeConfigurationWrite(path, async (target) => {
      await Promise.resolve();
      weaken(join(home, "config"));
      writeUtf8FileAtomicSync(target, "{}");
    })).rejects.toMatchObject({ name: "AveHomeConfigurationUntrustedError" });
    expect(() => readAveHomeConfigurationFile(path)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });

  it("maps directory ctime to native ChangeTime and advances it after a security descriptor change", () => {
    const { home } = fixture();
    const directory = join(home, "config");
    const before = lstatSync(directory, { bigint: true });
    expect(before.ctimeNs).toBe(nativeChangeTime(directory));
    weaken(directory);
    const after = lstatSync(directory, { bigint: true });
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.ctimeNs).toBe(nativeChangeTime(directory));
    expect(after.ctimeNs).toBeGreaterThan(before.ctimeNs);
    console.log(`directory ChangeTime: ${before.ctimeNs} -> ${after.ctimeNs}; volume=${after.dev}; file=${after.ino}`);
  });

  it("refuses a file replaced by a junction between reads", () => {
    const { home, path } = fixture();
    readAveHomeConfigurationFile(path);
    const target = join(dirname(home), "replacement");
    mkdirSync(target);
    const file = join(home, "config", "settings.json");
    renameSync(file, join(home, "config", "original.json"));
    symlinkSync(target, file, "junction");
    expect(() => readAveHomeConfigurationFile(path)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });

  it("reports cold and median warm fixture read latency", () => {
    const { path } = fixture();
    const coldStart = performance.now();
    readAveHomeConfigurationFile(path);
    const cold = performance.now() - coldStart;
    const samples = Array.from({ length: 20 }, () => {
      const start = performance.now(); readAveHomeConfigurationFile(path); return performance.now() - start;
    }).sort((a, b) => a - b);
    console.log(`configuration read latency ms: cold=${cold.toFixed(3)} warm-median-20=${((samples[9]! + samples[10]!) / 2).toFixed(3)}`);
  });
});
