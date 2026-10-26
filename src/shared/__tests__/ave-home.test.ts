import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { tmpdir } from "node:os";
import { ensureAveHomePrivate, aveHome, aveHomeConfigurationDirectory, setAveHomeConfigurationRefusedAtBoot, win32SystemBinary, readWindowsDirectoryDacls, _resetAveHomePrivacyForTest, type WindowsDirectoryDacl, type WindowsAccessRule } from "../ave-home.js";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { WINDOWS_OWNER_CLAIM_SOURCE } from "../windows-owner-claim.js";
import { permissionSettingsPath } from "../../permissions/permission-settings-store.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as windowsPathFacts from "../windows-path-facts.js";
import * as pathKindLauncher from "../../main/windows-path-kind-launcher.js";

beforeAll(() => { configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }); });
beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows"); });

const OWNER_SID = "S-1-5-21-1004336348-11-77-1417";
const OWNER_RULE: WindowsAccessRule = { sid: OWNER_SID, accessControlType: 0, fileSystemRights: 2032127,
  inheritanceFlags: 3, propagationFlags: 0, isInherited: false };
function descriptor(path: string): WindowsDirectoryDacl {
  return { path, currentUserSid: OWNER_SID, ownerSid: OWNER_SID, elevated: false, protected: true, rules: [{ ...OWNER_RULE }] };
}


function nativeDescriptor(path: string, owner = OWNER_SID): windowsPathFacts.WindowsDaclFacts {
  const identity = { volumeSerial: "0x0000000000000001", fileId: "0x00000000000000000000000000000001" };
  return { exists: true, canonical: resolve(path), ...identity, volumeSerialNumber: "0x0000000000000001",
    fileIndex: "0x0000000000000001", changeTime: "0x0000000000000001", attributes: 16, reparseTag: 0, reparseTarget: null, directory: true, ancestors: [],
    currentUserSid: OWNER_SID, elevated: false, principals: {},
    dacl: { identity, owner, group: OWNER_SID, protected: true, nullDacl: false,
      aces: [{ type: 0, flags: 3, mask: 0x1f01ff, sid: OWNER_SID }] } };
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => join(actual.tmpdir(), "example") };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});
afterEach(async () => {
  vi.restoreAllMocks();
  _resetAveHomePrivacyForTest();
  vi.unstubAllEnvs();
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(execFileSync).mockReset().mockImplementation(actual.execFileSync);
});

describe("aveHome", () => {
  it("uses the refused boot location without probing a nonexistent configuration path", () => {
    const dir = join(tmpdir(), "missing-boot-home");
    setAveHomeConfigurationRefusedAtBoot(dir);
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("Unexpected subprocess"); });
    expect(aveHomeConfigurationDirectory(dir)).toBe(dir);
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it("resolves the default home without writing it", () => {
    vi.stubEnv("AVE_HOME", undefined);
    expect(aveHome()).toBe(resolve(tmpdir(), "example", ".ave"));
  });
  it("resolves a relative override", () => {
    vi.stubEnv("AVE_HOME", join("relative-state", "..", "ave-state"));
    expect(aveHome()).toBe(resolve("ave-state"));
  });
  it("normalizes an absolute override", () => {
    vi.stubEnv("AVE_HOME", join(tmpdir(), "ave-parent", "..", "ave-state"));
    expect(aveHome()).toBe(resolve(tmpdir(), "ave-state"));
  });
});
describe("win32SystemBinary", () => {
  it("pins the binary to System32 and refuses missing system roots", () => {
    expect(win32SystemBinary("icacls", { SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\icacls.exe");
    expect(win32SystemBinary("icacls", { windir: "D:\\Win" })).toBe(win32.join("D:\\Win", "System32", "icacls.exe"));
    expect(() => win32SystemBinary("icacls", {})).toThrow(/system root/i);
  });
});
/** A refused result with the DACL it was refused for: owner, entries and inheritance flags. */
function refusal(result: ReturnType<typeof ensureAveHomePrivate>): string {
  if (result.enforcement !== "none" || result.failedPath === undefined) return JSON.stringify(result);
  return JSON.stringify({ result, dacl: readWindowsDirectoryDacls([result.failedPath]) });
}

function requireRestorePrivilege(context: TestContext): void {
  const privileges = execFileSync(win32SystemBinary("whoami"), ["/priv"], { encoding: "utf-8", windowsHide: true });
  if (!/\bSeRestorePrivilege\b/.test(privileges)) context.skip("SeRestorePrivilege is absent; this token cannot create a foreign-owned directory fixture");
}

describe("ensureAveHomePrivate", () => {
  const home = useTempPaths("ave-home-privacy-", ".ave");
  it.runIf(process.platform === "win32")("reuses only a verified identity across path owners and case aliases", () => {
    const dir = home();
    setFixtureOwner(dirname(dir));
    expect(ensureAveHomePrivate(dir).enforcement).toBe("win32-dacl");
    writeFileSync(join(dir, "config", ".ave-config-migrated"), "ave-home-boundary-v1");
    const before = vi.mocked(execFileSync).mock.calls.length;
    expect(aveHomeConfigurationDirectory(dir)).toBe(join(dir, "config"));
    expect(permissionSettingsPath(dir)).toBe(join(dir, "config", "settings.json"));
    expect(aveHomeConfigurationDirectory(dir.toUpperCase())).toBe(join(dir.toUpperCase(), "config"));
    const requests = vi.mocked(execFileSync).mock.calls.slice(before);
    expect(requests.filter(([, args]) => args?.[0] === "--dacl")).toHaveLength(2);
    for (const [executable, args] of requests) {
      expect(String(executable)).toMatch(/ave-path-kind\.exe$/);
      expect(["--pin", "--dacl"]).toContain(args?.[0]);
    }
  });
  function check(change: (entry: WindowsDirectoryDacl, index: number) => WindowsDirectoryDacl = (entry) => entry) {
    const dir = home();
    const readDacls = vi.fn((paths: readonly string[], _protect?: boolean) => paths.map((path, index) => change(descriptor(path), index)));
    return { dir, readDacls, result: ensureAveHomePrivate(dir, { platform: "win32", readDacls }) };
  }
  it("accepts alias-free numeric JSON rules and requests protection in one read-back", () => {
    const { dir, result, readDacls } = check();
    expect(result).toEqual({ enforcement: "win32-dacl", home: dir, sid: OWNER_SID });
    expect(readDacls.mock.calls).toEqual([[[dir, join(dir, "secrets"), join(dir, "subscription-runtimes"), join(dir, "keys"), join(dir, "certs"), join(dir, "config")], true]]);
  });
  it("protects the default home with only mocked profile and filesystem access", () => {
    vi.stubEnv("AVE_HOME", undefined);
    const mkdir = vi.mocked(mkdirSync);
    const original = mkdir.getMockImplementation()!;
    mkdir.mockImplementation(() => undefined);
    try {
      const dir = resolve(tmpdir(), "example", ".ave");
      expect(ensureAveHomePrivate(undefined, { platform: "win32", readDacls: (paths) => paths.map(descriptor) }))
        .toEqual({ enforcement: "win32-dacl", home: dir, sid: OWNER_SID });
    } finally {
      mkdir.mockImplementation(original);
    }
  });
  it("accepts an elevated group owner while granting access only to the token user", () => {
    expect(check((entry) => ({ ...entry, elevated: true, ownerSid: "S-1-5-32-544" })).result.enforcement).toBe("win32-dacl");
  });
  it("refuses a group owner on a non-elevated token", () => {
    expect(check((entry) => ({ ...entry, ownerSid: "S-1-5-32-544" })).result).toMatchObject({ enforcement: "none", category: "invalid-owner-grant" });
  });
  it("refuses a foreign owner on the subscription runtime root", () => {
    const { result, dir } = check((entry, index) => index === 2 ? { ...entry, ownerSid: "S-1-5-18" } : entry);
    expect(result).toMatchObject({ enforcement: "none", category: "invalid-owner-grant", failedPath: join(dir, "subscription-runtimes") });
  });
  it("reports a failed runtime root ownership claim without downgrading protection", () => {
    const dir = home();
    const runtimeRoot = join(dir, "subscription-runtimes");
    const reason = "Directory ownership claim failed";
    vi.spyOn(windowsPathFacts, "readWindowsDacls").mockImplementation(paths => paths.map(path =>
      nativeDescriptor(path, path === runtimeRoot ? "S-1-5-32-544" : OWNER_SID)));
    vi.mocked(execFileSync).mockImplementation((_file, _args, options) => {
      const request = JSON.parse((options as { env: NodeJS.ProcessEnv }).env.AVE_DACL_REQUEST!);
      return JSON.stringify(request.paths.map((path: string) => path === runtimeRoot
        ? { path, category: "owner-claim-failed", error: reason } : { path }));
    });
    expect(ensureAveHomePrivate(dir, { platform: "win32", readDacls: (paths, protect) => readWindowsDirectoryDacls(paths, protect, runtimeRoot) }))
      .toEqual({ enforcement: "none", home: dir, failedPath: runtimeRoot, category: "owner-claim-failed", reason });
  });
  it.each(["S-1-5-18", "S-1-5-32-544", "S-1-1-0"])("rejects an extra well-known principal %s", (sid) => {
    const { result, dir } = check((entry) => ({ ...entry, rules: [OWNER_RULE, { ...OWNER_RULE, sid }] }));
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals", extraPrincipals: [{ sid }] });
  });
  it.each(["example\\guest", undefined])("retains optional account resolution %s", (account) => {
    const sid = "S-1-5-21-100-200-300-9999";
    expect(check((entry) => ({ ...entry, rules: [OWNER_RULE, { ...OWNER_RULE, sid, account }] })).result)
      .toMatchObject({ category: "extra-principals", extraPrincipals: [{ sid, ...(account ? { account } : {}) }] });
  });
  it("refuses an extra principal on the subscription runtime root", () => {
    const sid = "S-1-5-32-545";
    const { result, dir } = check((entry, index) => index === 2
      ? { ...entry, rules: [OWNER_RULE, { ...OWNER_RULE, sid }] }
      : entry);
    expect(result).toMatchObject({ enforcement: "none", category: "extra-principals",
      failedPath: join(dir, "subscription-runtimes"), extraPrincipals: [{ sid }] });
  });
  it.each([
    { protected: false }, { rules: [] }, { rules: [{ ...OWNER_RULE, isInherited: true }] },
    { rules: [{ ...OWNER_RULE, inheritanceFlags: 2 }] }, { rules: [{ ...OWNER_RULE, propagationFlags: 1 }] },
    { rules: [{ ...OWNER_RULE, fileSystemRights: 1179785 }] }, { rules: [{ ...OWNER_RULE, accessControlType: 1 }] },
    { ownerSid: "S-1-5-18" }, { rules: undefined }, { currentUserSid: undefined },
    { rules: [{ ...OWNER_RULE, sid: "SY" }] },
  ])("fails closed for invalid structured evidence %j", (patch) => {
    expect(check((entry) => ({ ...entry, ...patch })).result.enforcement).toBe("none");
  });
  it.each([0, 1])("retains read-back failures for directory %i", (index) => {
    const { result, dir } = check((entry, at) => at === index ? { path: entry.path, error: "read failed" } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: index ? join(dir, "secrets") : dir, category: "read-back-failed" });
  });
  it("warns when a foreign root grant contains read data", () => {
    const { result } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 1 }] } : entry);
    expect(result).toMatchObject({ enforcement: "win32-dacl", diagnostics: [expect.stringContaining("foreign read-only access")] });
    expect(result.enforcement).toBe("win32-dacl");
  });
  it("warns when a foreign root grant contains read extended attributes", () => {
    const { result } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 8 }] } : entry);
    expect(result).toMatchObject({ enforcement: "win32-dacl", diagnostics: [expect.stringContaining("foreign read-only access")] });
    expect(result.enforcement).toBe("win32-dacl");
  });
  it("warns when a foreign root grant contains execute", () => {
    const { result } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 32 }] } : entry);
    expect(result).toMatchObject({ enforcement: "win32-dacl", diagnostics: [expect.stringContaining("foreign read-only access")] });
    expect(result.enforcement).toBe("win32-dacl");
  });
  it("warns when a foreign root grant contains read attributes", () => {
    const { result } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 128 }] } : entry);
    expect(result).toMatchObject({ enforcement: "win32-dacl", diagnostics: [expect.stringContaining("foreign read-only access")] });
    expect(result.enforcement).toBe("win32-dacl");
  });
  it("warns when a foreign root grant contains read control", () => {
    const { result } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 131072 }] } : entry);
    expect(result).toMatchObject({ enforcement: "win32-dacl", diagnostics: [expect.stringContaining("foreign read-only access")] });
    expect(result.enforcement).toBe("win32-dacl");
  });
  it("warns when a foreign root grant contains synchronize", () => {
    const { result } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 1048576 }] } : entry);
    expect(result).toMatchObject({ enforcement: "win32-dacl", diagnostics: [expect.stringContaining("foreign read-only access")] });
    expect(result.enforcement).toBe("win32-dacl");
  });
  it("warns when a foreign root grant contains read and execute", () => {
    const { result } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 1179817 }] } : entry);
    expect(result).toMatchObject({ enforcement: "win32-dacl", diagnostics: [expect.stringContaining("foreign read-only access")] });
    expect(result.enforcement).toBe("win32-dacl");
  });
  it("refuses when a foreign root grant contains write data", () => {
    const { result, dir } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 2 }] } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals" });
  });
  it("refuses when a foreign root grant contains append data", () => {
    const { result, dir } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 4 }] } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals" });
  });
  it("refuses when a foreign root grant contains write extended attributes", () => {
    const { result, dir } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 16 }] } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals" });
  });
  it("refuses when a foreign root grant contains delete child", () => {
    const { result, dir } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 64 }] } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals" });
  });
  it("refuses when a foreign root grant contains write attributes", () => {
    const { result, dir } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 256 }] } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals" });
  });
  it("refuses when a foreign root grant contains delete", () => {
    const { result, dir } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 65536 }] } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals" });
  });
  it("refuses when a foreign root grant contains write DAC", () => {
    const { result, dir } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 262144 }] } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals" });
  });
  it("refuses when a foreign root grant contains write owner", () => {
    const { result, dir } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 524288 }] } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals" });
  });
  it("refuses when a foreign root grant contains generic all", () => {
    const { result, dir } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 268435456 }] } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals" });
  });
  it("warns when a foreign root grant contains generic read", () => {
    expect(check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: -2147483648 }] } : entry).result)
      .toMatchObject({ enforcement: "win32-dacl", diagnostics: [expect.stringContaining("foreign read-only access")] });
  });
  it("refuses when a foreign root grant contains generic write", () => {
    expect(check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 0x40000000 }] } : entry).result)
      .toMatchObject({ enforcement: "none", category: "extra-principals" });
  });
  it("reports a wrong owner before foreign access entries", () => {
    expect(check((entry) => ({ ...entry, ownerSid: "S-1-5-18", rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0" }] })).result)
      .toMatchObject({ enforcement: "none", category: "invalid-owner-grant", reason: "Directory is owned by another account" });
  });
  it("refuses when a foreign root grant contains an unknown right", () => {
    const { result, dir } = check((entry, index) => index === 0 ? { ...entry, rules: [OWNER_RULE,
      { ...OWNER_RULE, sid: "S-1-1-0", fileSystemRights: 512 }] } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals" });
  });
  it("retains the permission command category", () => {
    expect(check((entry) => ({ path: entry.path, category: "icacls-failed", error: "command failed" })).result)
      .toMatchObject({ enforcement: "none", category: "icacls-failed" });
  });
  it("refuses a missing descriptor", () => {
    expect(ensureAveHomePrivate(home(), { platform: "win32", readDacls: () => [] }).enforcement).toBe("none");
  });
  it("refuses a thrown read-back", () => {
    expect(ensureAveHomePrivate(home(), { platform: "win32", readDacls: () => { throw new Error("read failed"); } }))
      .toMatchObject({ enforcement: "none", category: "read-back-failed" });
  });
  it("does not resolve a privacy executable through PATH without the system root", () => {
    vi.stubEnv("SystemRoot", undefined); vi.stubEnv("windir", undefined);
    const before = vi.mocked(execFileSync).mock.calls.length;
    expect(ensureAveHomePrivate(home(), { platform: "win32", readDacls: readWindowsDirectoryDacls }))
      .toMatchObject({ enforcement: "none", category: "system-root-missing" });
    expect(vi.mocked(execFileSync).mock.calls).toHaveLength(before);
  });
  it("uses owner-only POSIX creation without invoking Windows commands", () => {
    const dir = home();
    expect(ensureAveHomePrivate(dir, { platform: "darwin", readDacls: () => { throw new Error("unexpected DACL read"); } }))
      .toEqual({ enforcement: "posix-mode", home: dir });

  });
  it.skipIf(process.platform === "win32")("creates the POSIX home with owner-only mode", () => {
    const dir = home();
    ensureAveHomePrivate(dir, { platform: "darwin", readDacls: () => [] });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
  it("passes untrusted paths only through one JSON environment value", () => {
    const paths = ["odd’; Write-Output x; 'path", "secret"];
    vi.spyOn(windowsPathFacts, "readWindowsDacls").mockImplementation(targets => targets.map(path => nativeDescriptor(path)));
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify(paths.map(path => ({ path }))));
    expect(readWindowsDirectoryDacls(paths, true)).toEqual(paths.map(descriptor));
    const [, args, options] = vi.mocked(execFileSync).mock.calls.at(-1)!;
    expect(args!.join(" ")).not.toContain(paths[0]);
    const env = (options as { env: NodeJS.ProcessEnv }).env;
    expect(JSON.parse(env.AVE_DACL_REQUEST!)).toEqual({ paths, readOnlyRights: 0x1200a9 });
    // The system root reaches the child only inside the request, never as a second variable.
    expect(Object.keys(env).filter((name) => name.startsWith("AVE_DACL_"))).toEqual(["AVE_DACL_REQUEST"]);
  });
  it("lets Windows PowerShell rebuild its own module path", () => {
    vi.stubEnv("PSModulePath", "C:\\Program Files\\PowerShell\\7\\Modules");
    vi.spyOn(windowsPathFacts, "readWindowsDacls").mockImplementation(paths => paths.map(path => nativeDescriptor(path)));
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([{ path: home() }]));
    readWindowsDirectoryDacls([home()], true);
    const env = (vi.mocked(execFileSync).mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }).env;
    expect(Object.keys(env).filter(name => name.toLowerCase() === "psmodulepath")).toEqual([]);
  });
  it("retains a per-path read error without losing another descriptor", () => {
    const dir = home();
    const paths = [dir, join(dir, "secrets")];
    vi.spyOn(windowsPathFacts, "readWindowsDacls").mockImplementation(targets => {
      if (targets[0] === resolve(paths[1]!)) throw new Error("read failed");
      return targets.map(path => nativeDescriptor(path));
    });
    expect(readWindowsDirectoryDacls(paths)).toEqual([descriptor(dir),
      { path: paths[1], category: "read-back-failed", error: "read failed" }]);
  });
  it("reports a directory the protecting step could not create", () => {
    const dir = home();
    const result = ensureAveHomePrivate(dir, { platform: "win32", readDacls: (paths) => [
      { path: paths[0]!, category: "directory-failed", error: "Access is denied" }, ...paths.slice(1).map(descriptor),
    ] });
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "directory-failed", reason: "Access is denied" });
  });
  it("rejects a malformed native read-back result set", () => {
    vi.spyOn(pathKindLauncher, "resolveWindowsPathKindHelper").mockReturnValue(process.execPath);
    vi.mocked(execFileSync).mockReturnValueOnce("{}");
    expect(readWindowsDirectoryDacls([home()])[0]).toMatchObject({ category: "read-back-failed", error: "Invalid Windows path facts response" });
  });
  it.runIf(process.platform === "win32")("blocks later home grants from reaching subscription runtimes and new children", () => {
    const dir = home();
    const runtimeRoot = join(dir, "subscription-runtimes");
    const child = join(runtimeRoot, "runtime");
    const sid = "S-1-5-32-545";
    const first = ensureAveHomePrivate(dir);
    expect(first, refusal(first)).toMatchObject({ enforcement: "win32-dacl" });
    const second = ensureAveHomePrivate(dir);
    expect(second, refusal(second)).toMatchObject({ enforcement: "win32-dacl" });
    execFileSync(win32SystemBinary("icacls"), [dir, "/grant", `*${sid}:(OI)(CI)R`, "/q"], { encoding: "utf-8", windowsHide: true });
    mkdirSync(child, { recursive: true });
    const descriptors = readWindowsDirectoryDacls([dir, join(dir, "secrets"), runtimeRoot, child]);
    expect(descriptors).toMatchObject([
      { path: dir, protected: true, rules: expect.any(Array) },
      { path: join(dir, "secrets"), protected: true, rules: expect.any(Array) },
      { path: runtimeRoot, protected: true, rules: expect.any(Array) },
      { path: child, rules: expect.any(Array) },
    ]);
    expect(descriptors[0].rules).toContainEqual(expect.objectContaining({ sid, inheritanceFlags: 3, isInherited: false }));
    expect(descriptors[2].rules).not.toContainEqual(expect.objectContaining({ sid }));
    expect(descriptors[3].rules).not.toContainEqual(expect.objectContaining({ sid }));
  });
  it("uses a stdin bootstrap and pinned creation without child verification", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.spyOn(windowsPathFacts, "readWindowsDacls").mockImplementation(paths => paths.map(path => nativeDescriptor(path)));
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify([descriptor("C:\\home")]));
    readWindowsDirectoryDacls(["C:\\home"], true);
    const [, args, options] = vi.mocked(execFileSync).mock.calls.at(-1)!;
    expect(args).toContain("-EncodedCommand");
    expect(Buffer.from(args!.at(-1)!, "base64").toString("utf16le")).toContain("[Console]::In.ReadToEnd()");
    const script = (options as { input: string }).input;
    expect(script).toContain("NtCreateFile");
    expect(script).toContain("Attributes = noReparse ? 0x1040u");
    expect(script).not.toContain("Get-ChildItem");
    expect(script).not.toContain("ReadChild");
    expect(script).not.toContain("Reapply");
    expect(script).not.toContain("MAX_CHILD");
    expect(script).not.toContain("WindowsOwnerClaim.Restore");
  });
  it("refuses a link and an unaccepted owner before the permission command writes", () => {
    const dir = home();
    for (const row of [{ ...nativeDescriptor(dir), reparseTag: 0x80000042, attributes: 0x410 }, nativeDescriptor(dir, "S-1-5-18")]) {
      const spy = vi.spyOn(windowsPathFacts, "readWindowsDacls").mockReturnValue([row]);
      const before = vi.mocked(execFileSync).mock.calls.length;
      expect(readWindowsDirectoryDacls([dir, join(dir, "secrets")], true)[0]!.category).toMatch(/reparse-point|invalid-owner-grant/);
      expect(vi.mocked(execFileSync).mock.calls).toHaveLength(before);
      spy.mockRestore();
    }
  });
  it("claims only the requested runtime root before writing its DACL", () => {
    const dir = home();
    const runtimeRoot = join(dir, "subscription-runtimes");
    vi.spyOn(windowsPathFacts, "readWindowsDacls").mockImplementation(paths => paths.map(path =>
      nativeDescriptor(path, path === runtimeRoot ? "S-1-5-32-544" : OWNER_SID)));
    const paths = [dir, join(dir, "secrets"), runtimeRoot];
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify(paths.map(path => ({ path }))));
    readWindowsDirectoryDacls(paths, true, runtimeRoot);
    const [, , options] = vi.mocked(execFileSync).mock.calls.at(-1)!;
    const request = JSON.parse((options as { env: NodeJS.ProcessEnv }).env.AVE_DACL_REQUEST!);
    const script = (options as { input: string }).input;
    expect(request).toEqual({ paths, claimableRuntimeRoot: runtimeRoot, readOnlyRights: 0x1200a9 });
    expect(script).toContain('$path -eq $request.claimableRuntimeRoot');
    expect(script.indexOf("[HomeDirectoryDacl]::ClaimRuntimeRoot")).toBeLessThan(script.indexOf("[HomeDirectoryDacl]::Repair"));
    expect(script).toContain('string owner = Read(handle).GetOwner(typeof(SecurityIdentifier)).Value');
    expect(script.indexOf('owner != "S-1-5-32-544"')).toBeLessThan(script.indexOf("SetSecurityInfo(handle, 1, 0x80000005u"));
  });
  it("reports the first refused path and touches none inside it", () => {
    const dir = home();
    const result = ensureAveHomePrivate(dir, { platform: "win32", readDacls: (paths) => [
      { path: paths[0]!, category: "reparse-point", error: "Directory is a link or junction" },
      ...paths.slice(1).map((path) => ({ path, category: "reparse-point" as const, error: "An enclosing directory was refused" })),
    ] });
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "reparse-point" });
  });

  /** Owner and access entries of a real directory, read on that directory itself. */
  function sddl(path: string, sections = "Owner, Access"): string {
    return execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
      "-NoProfile", "-NonInteractive", "-Command",
      `[System.IO.Directory]::GetAccessControl($env:AVE_TEST_TARGET).GetSecurityDescriptorSddlForm('${sections}')`,
    ], { env: { ...process.env, AVE_TEST_TARGET: path }, encoding: "utf-8", windowsHide: true }).trim();
  }
  function checkJunction(which: "home" | "secrets" | "subscription-runtimes"): void {
    const dir = home();
    const target = join(dirname(dir), "target");
    mkdirSync(target); setFixtureOwner(target);
    const link = which === "home" ? dir : join(dir, which);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl" });
    if (which === "home") rmSync(dir, { recursive: true });
    else rmdirSync(link);
    symlinkSync(target, link, "junction");
    try {
      const before = sddl(target);
      const result = ensureAveHomePrivate(dir);
      expect(result).toMatchObject({ enforcement: "none", failedPath: link, category: "reparse-point" });
      expect(sddl(target)).toBe(before);
      expect(existsSync(join(target, "secrets"))).toBe(false);
    } finally {
      rmdirSync(link);
    }
  }
  it.runIf(process.platform === "win32")("refuses a home junction without changing its target", () => { checkJunction("home"); });
  it.runIf(process.platform === "win32")("refuses a secrets junction without changing its target", () => { checkJunction("secrets"); });
  it.runIf(process.platform === "win32")("refuses a subscription-runtimes junction without changing its target", () => { checkJunction("subscription-runtimes"); });
  it.runIf(process.platform === "win32")("refuses an existing home owned by another account and leaves its DACL unchanged", (context) => {
    requireRestorePrivilege(context);
    const dir = home();
    mkdirSync(dir); setFixtureOwner(dir);
    execFileSync(win32SystemBinary("icacls"), [dir, "/setowner", "*S-1-5-18", "/q"], { encoding: "utf-8", windowsHide: true });
    const before = sddl(dir);
    const result = ensureAveHomePrivate(dir);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "invalid-owner-grant", reason: "Directory is owned by another account" });
    expect(sddl(dir)).toBe(before);
    expect(existsSync(join(dir, "secrets"))).toBe(false);
  });
  it.runIf(process.platform === "win32")("rechecks the handle owner before claiming and leaves a token-owned fixture unchanged", () => {
    const dir = home();
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl" });
    const before = sddl(dir);
    const error = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), ["-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -TypeDefinition @'\n${WINDOWS_OWNER_CLAIM_SOURCE}\n'@\ntry { [WindowsOwnerClaim]::ClaimFromAdministrators($env:AVE_TEST_TARGET, [System.Security.Principal.WindowsIdentity]::GetCurrent().User, $true) } catch { [Console]::Write($_.Exception.InnerException.Message) }`,
    ], { env: { ...process.env, AVE_TEST_TARGET: dir }, encoding: "utf-8", windowsHide: true });
    expect(error).toBe("Owner changed during the claim");
    expect(sddl(dir)).toBe(before);
  });
  it.runIf(process.platform === "win32")("claims an Administrators-owned runtime root with a protected owner-only DACL on an elevated token", (context) => {
    const dir = home();
    execFileSync(win32SystemBinary("icacls"), [dirname(dir), "/grant", "*S-1-5-32-545:(OI)(CI)RX", "/q"], { encoding: "utf-8", windowsHide: true });
    mkdirSync(dir); setFixtureOwner(dir);
    const [token] = readWindowsDirectoryDacls([dir]);
    expect(token.rules).toContainEqual(expect.objectContaining({ sid: "S-1-5-32-545", isInherited: true }));
    if (!token.elevated) context.skip("An elevated token is required to set the fixture owner and exercise the claim directly");
    execFileSync(win32SystemBinary("icacls"), [dir, "/setowner", "*S-1-5-32-544", "/q"], { encoding: "utf-8", windowsHide: true });
    expect(readWindowsDirectoryDacls([dir])[0].ownerSid).toBe("S-1-5-32-544");
    execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), ["-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -TypeDefinition @'\n${WINDOWS_OWNER_CLAIM_SOURCE}\n'@\n[WindowsOwnerClaim]::ClaimFromAdministrators($env:AVE_TEST_TARGET, [System.Security.Principal.WindowsIdentity]::GetCurrent().User, $true)`,
    ], { env: { ...process.env, AVE_TEST_TARGET: dir }, encoding: "utf-8", windowsHide: true });
    const [after] = readWindowsDirectoryDacls([dir]);
    expect(after.ownerSid).toBe(token.currentUserSid);
    expect(after.protected).toBe(true);
    expect(after.rules).toEqual([expect.objectContaining({ ...OWNER_RULE, sid: token.currentUserSid })]);
    expect(after.rules?.some(({ sid }) => sid === "S-1-5-32-545")).toBe(false);
    // SetSecurityInfo marks the DACL auto-inherited (AI); the SID may render as an alias such as LA, so match one OI|CI FullControl allow.
    const access = sddl(dir, "Access");
    expect(access).toMatch(/^D:PAI\(A;OICI;FA;;;[^;)]+\)$/);
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl" });
    expect(sddl(dir, "Access")).toBe(access);
  });
  function checkRelocatedDirectory(name: string): void {
    const dir = join(home(), name);
    const before = vi.mocked(execFileSync).mock.calls.length;
    const result = ensureAveHomePrivate(dir);
    expect(result, refusal(result)).toMatchObject({ enforcement: "win32-dacl" });
    expect(vi.mocked(execFileSync).mock.calls.slice(before).filter(([, , options]) =>
      (options as { env?: NodeJS.ProcessEnv } | undefined)?.env?.AVE_DACL_REQUEST !== undefined)).toHaveLength(1);
    const descriptors = readWindowsDirectoryDacls([dir, join(dir, "secrets"), join(dir, "subscription-runtimes"), join(dir, "keys"), join(dir, "certs")]);
    console.info(`Verified relocated private directory DACL JSON: ${JSON.stringify(descriptors)}`);
    for (const entry of descriptors) {
      expect(entry.path).toContain(dir);
      expect(entry).toMatchObject({ protected: true, rules: [expect.objectContaining({
        ...OWNER_RULE, sid: (result as { sid: string }).sid,
      })] });
      // Creation sets current-user ownership even on an elevated token.
      expect(entry.ownerSid).toBe(entry.currentUserSid);
    }
    writeFileSync(permissionSettingsPath(dir), "{}");
    expect(readFileSync(permissionSettingsPath(dir), "utf-8")).toBe("{}");
  }
  it.runIf(process.platform === "win32")("protects a real directory containing ordinary", () => { checkRelocatedDirectory("ordinary"); });
  it.runIf(process.platform === "win32")("protects a real directory containing curly quote", () => { checkRelocatedDirectory("curly’quote"); });
  it.runIf(process.platform === "win32")("protects a real directory containing script punctuation", () => { checkRelocatedDirectory("' ; Write-Output x; '"); });
});
