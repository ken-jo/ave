import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureAveHomePrivate, aveHome, win32SystemBinary, readWindowsDirectoryDacls, setAveHomePrivacyAtBoot, assertAveHomePrivacyForConfinement, _resetAveHomePrivacyForTest, type WindowsDirectoryDacl, type WindowsAccessRule } from "../ave-home.js";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { windowsPowerShellEnv } from "../windows-powershell-env.js";

const OWNER_SID = "S-1-5-21-1004336348-11-77-1417";
const OWNER_RULE: WindowsAccessRule = { sid: OWNER_SID, accessControlType: 0, fileSystemRights: 2032127,
  inheritanceFlags: 3, propagationFlags: 0, isInherited: false };
function descriptor(path: string): WindowsDirectoryDacl {
  return { path, currentUserSid: OWNER_SID, ownerSid: OWNER_SID, elevated: false, protected: true, rules: [{ ...OWNER_RULE }] };
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => join(actual.tmpdir(), "synthetic-profile") };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});
afterEach(() => { _resetAveHomePrivacyForTest(); vi.unstubAllEnvs(); });

describe("aveHome", () => {
  it("resolves the default home without writing it", () => {
    vi.stubEnv("AVE_HOME", undefined);
    expect(aveHome()).toBe(resolve(tmpdir(), "synthetic-profile", ".ave"));
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
  it("pins the binary to System32 without changing other callers' fallback", () => {
    expect(win32SystemBinary("icacls", { SystemRoot: "C:\\Windows" })).toBe(join("C:\\Windows", "System32", "icacls.exe"));
    expect(win32SystemBinary("icacls", { windir: "D:\\Win" })).toBe(join("D:\\Win", "System32", "icacls.exe"));
    expect(win32SystemBinary("icacls", {})).toBe("icacls");
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
  function check(change: (entry: WindowsDirectoryDacl, index: number) => WindowsDirectoryDacl = (entry) => entry) {
    const dir = home();
    const readDacls = vi.fn((paths: readonly string[], _protect?: boolean, _claimableRuntimeRoot?: string) => paths.map((path, index) => change(descriptor(path), index)));
    return { dir, readDacls, result: ensureAveHomePrivate(dir, { platform: "win32", readDacls }) };
  }
  it("accepts alias-free numeric JSON rules and requests protection in one read-back", () => {
    const { dir, result, readDacls } = check();
    expect(result).toEqual({ enforcement: "win32-dacl", home: dir, sid: OWNER_SID });
    expect(readDacls.mock.calls).toEqual([[[dir, join(dir, "secrets"), join(dir, "subscription-runtimes")], true, join(dir, "subscription-runtimes")]]);
  });
  it("protects the default home with only mocked profile and filesystem access", () => {
    vi.stubEnv("AVE_HOME", undefined);
    const mkdir = vi.mocked(mkdirSync);
    const original = mkdir.getMockImplementation()!;
    mkdir.mockImplementation(() => undefined);
    try {
      const dir = resolve(tmpdir(), "synthetic-profile", ".ave");
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
    const reason = `Directory "${runtimeRoot}" is owned by Administrators and could not be claimed. Run Ave once elevated or fix the directory owner.`;
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify([
      descriptor(dir), descriptor(join(dir, "secrets")), { path: runtimeRoot, category: "owner-claim-failed", error: reason },
    ]));
    expect(ensureAveHomePrivate(dir, { platform: "win32", readDacls: readWindowsDirectoryDacls }))
      .toEqual({ enforcement: "none", home: dir, failedPath: runtimeRoot, category: "owner-claim-failed", reason });
  });
  it("fails closed when home read-back still contains a foreign principal", () => {
    const sid = "S-1-5-18";
    const { result, dir } = check((entry) => ({ ...entry, rules: [OWNER_RULE, { ...OWNER_RULE, sid }] }));
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals", extraPrincipals: [{ sid }] });
  });
  it("fails closed when home read-back still contains an Administrators grant", () => {
    const sid = "S-1-5-32-544";
    const { result, dir } = check((entry) => ({ ...entry, rules: [OWNER_RULE, { ...OWNER_RULE, sid }] }));
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals", extraPrincipals: [{ sid }] });
  });
  it("fails closed when home read-back still contains an Everyone grant", () => {
    const sid = "S-1-1-0";
    const { result, dir } = check((entry) => ({ ...entry, rules: [OWNER_RULE, { ...OWNER_RULE, sid }] }));
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals", extraPrincipals: [{ sid }] });
  });
  it("fails closed when secrets read-back still contains a foreign deny", () => {
    const sid = "S-1-5-32-545";
    const { result, dir } = check((entry, index) => index === 1
      ? { ...entry, rules: [{ ...OWNER_RULE, sid, accessControlType: 1 }, OWNER_RULE] } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: join(dir, "secrets"), category: "extra-principals", extraPrincipals: [{ sid }] });
  });
  it("reports removed principals after successful protection of all three directories", () => {
    const sid = "S-1-5-32-545";
    const { result, dir } = check((entry) => ({ ...entry, removedPrincipals: [sid] }));
    expect(result).toEqual({ enforcement: "win32-dacl", home: dir, sid: OWNER_SID,
      repairs: [dir, join(dir, "secrets"), join(dir, "subscription-runtimes")].map((path) => ({ path, removedPrincipals: [sid] })) });
  });
  it("retains a resolved foreign account name", () => {
    const sid = "S-1-5-21-100-200-300-9999";
    const account = "example\\guest";
    expect(check((entry) => ({ ...entry, rules: [OWNER_RULE, { ...OWNER_RULE, sid, account }] })).result)
      .toMatchObject({ category: "extra-principals", extraPrincipals: [{ sid, account }] });
  });
  it("retains a foreign SID without an account name", () => {
    const sid = "S-1-5-21-100-200-300-9999";
    expect(check((entry) => ({ ...entry, rules: [OWNER_RULE, { ...OWNER_RULE, sid }] })).result)
      .toMatchObject({ category: "extra-principals", extraPrincipals: [{ sid }] });
  });
  it("fails closed when subscription runtime read-back still contains a foreign principal", () => {
    const sid = "S-1-5-32-545";
    const { result, dir } = check((entry, index) => index === 2
      ? { ...entry, rules: [OWNER_RULE, { ...OWNER_RULE, sid }] }
      : entry);
    expect(result).toMatchObject({ enforcement: "none", category: "extra-principals",
      failedPath: join(dir, "subscription-runtimes"), extraPrincipals: [{ sid }] });
  });
  it("fails closed for an unprotected DACL", () => {
    expect(check((entry) => ({ ...entry, protected: false })).result.enforcement).toBe("none");
  });
  it("fails closed for an empty DACL", () => {
    expect(check((entry) => ({ ...entry, rules: [] })).result.enforcement).toBe("none");
  });
  it("fails closed for an inherited owner rule", () => {
    expect(check((entry) => ({ ...entry, rules: [{ ...OWNER_RULE, isInherited: true }] })).result.enforcement).toBe("none");
  });
  it("fails closed for incomplete inheritance flags", () => {
    expect(check((entry) => ({ ...entry, rules: [{ ...OWNER_RULE, inheritanceFlags: 2 }] })).result.enforcement).toBe("none");
  });
  it("fails closed for restricted propagation", () => {
    expect(check((entry) => ({ ...entry, rules: [{ ...OWNER_RULE, propagationFlags: 1 }] })).result.enforcement).toBe("none");
  });
  it("fails closed for incomplete owner rights", () => {
    expect(check((entry) => ({ ...entry, rules: [{ ...OWNER_RULE, fileSystemRights: 1179785 }] })).result.enforcement).toBe("none");
  });
  it("fails closed for an owner deny rule", () => {
    expect(check((entry) => ({ ...entry, rules: [{ ...OWNER_RULE, accessControlType: 1 }] })).result.enforcement).toBe("none");
  });
  it("fails closed for an unaccepted owner SID", () => {
    expect(check((entry) => ({ ...entry, ownerSid: "S-1-5-18" })).result.enforcement).toBe("none");
  });
  it("fails closed for missing rules", () => {
    expect(check((entry) => ({ ...entry, rules: undefined })).result.enforcement).toBe("none");
  });
  it("fails closed for a missing current user SID", () => {
    expect(check((entry) => ({ ...entry, currentUserSid: undefined })).result.enforcement).toBe("none");
  });
  it("fails closed for a nonnumeric rule SID", () => {
    expect(check((entry) => ({ ...entry, rules: [{ ...OWNER_RULE, sid: "SY" }] })).result.enforcement).toBe("none");
  });
  it("retains a home read-back failure", () => {
    const { result, dir } = check((entry, index) => index === 0 ? { path: entry.path, error: "read failed" } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "read-back-failed" });
  });
  it("retains a secrets read-back failure", () => {
    const { result, dir } = check((entry, index) => index === 1 ? { path: entry.path, error: "read failed" } : entry);
    expect(result).toMatchObject({ enforcement: "none", failedPath: join(dir, "secrets"), category: "read-back-failed" });
  });
  it("retains the permission replacement failure category", () => {
    expect(check((entry) => ({ path: entry.path, category: "icacls-failed", error: "Directory permissions could not be replaced" })).result)
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
  it.runIf(process.platform !== "win32")("creates POSIX directories with owner-only mode", () => {
    const dir = home();
    ensureAveHomePrivate(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
  it("passes untrusted paths only through one JSON environment value", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const paths = ["odd’; Write-Output x; 'path", "secret"];
    const results = paths.map(descriptor);
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify(results));
    expect(readWindowsDirectoryDacls(paths)).toEqual(results);
    const [, args, options] = vi.mocked(execFileSync).mock.calls.at(-1)!;
    expect(args!.join(" ")).not.toContain(paths[0]);
    const env = (options as { env: NodeJS.ProcessEnv }).env;
    expect(JSON.parse(env.AVE_DACL_REQUEST!)).toEqual({ paths, protect: false });
    expect(Object.keys(env).filter((name) => name.startsWith("AVE_DACL_"))).toEqual(["AVE_DACL_REQUEST"]);
  });
  it("lets Windows PowerShell rebuild its own module path", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    // A module path inherited from PowerShell 7 names that edition's modules, not 5.1's.
    vi.stubEnv("PSModulePath", "C:\\Program Files\\PowerShell\\7\\Modules");
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify([descriptor("C:\\home")]));
    readWindowsDirectoryDacls(["C:\\home"]);
    const env = (vi.mocked(execFileSync).mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }).env;
    expect(Object.keys(env).filter((name) => name.toLowerCase() === "psmodulepath")).toEqual([]);
  });
  it("retains a per-path read error in one process", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const dir = home();
    const paths = [dir, join(dir, "secrets")];
    const results = [descriptor(dir), { path: paths[1], error: "read failed" }];
    const before = vi.mocked(execFileSync).mock.calls.length;
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify(results));
    expect(readWindowsDirectoryDacls(paths)).toEqual(results);
    expect(vi.mocked(execFileSync).mock.calls.slice(before)).toHaveLength(1);
  });
  it("reports a directory the protecting step could not create", () => {
    const dir = home();
    const result = ensureAveHomePrivate(dir, { platform: "win32", readDacls: (paths) => [
      { path: paths[0]!, category: "directory-failed", error: "Access is denied" }, ...paths.slice(1).map(descriptor),
    ] });
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "directory-failed", reason: "Access is denied" });
  });
  it("rejects a malformed read-back result set", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.mocked(execFileSync).mockReturnValueOnce("{}");
    expect(() => readWindowsDirectoryDacls([home()])).toThrow("invalid result set");
  });
  it("accepts inherited foreign grants on immediate children", () => {
    const dir = home();
    const child = join(dir, "secrets", "token");
    const result = ensureAveHomePrivate(dir, { platform: "win32", readDacls: (paths) => [
      ...paths.map(descriptor), { ...descriptor(child), child: true, rules: [
        { ...OWNER_RULE, isInherited: true }, { ...OWNER_RULE, sid: "S-1-5-18", isInherited: true },
      ] },
    ] });
    expect(result).toMatchObject({ enforcement: "win32-dacl" });
  });
  it("refuses explicit foreign grants on immediate children", () => {
    const dir = home();
    const child = join(dir, "secrets", "token");
    const result = ensureAveHomePrivate(dir, { platform: "win32", readDacls: (paths) => [
      ...paths.map(descriptor), { ...descriptor(child), child: true, rules: [
        { ...OWNER_RULE, isInherited: true }, { ...OWNER_RULE, sid: "S-1-5-18", isInherited: false },
      ] },
    ] });
    expect(result).toMatchObject({ enforcement: "none", category: "extra-principals", failedPath: child });
  });
  it.runIf(process.platform === "win32")("reapplies owner-only DACLs after foreign inheritable grants on all three protected directories", () => {
    const dir = home();
    const paths = [dir, join(dir, "secrets"), join(dir, "subscription-runtimes")];
    const sid = "S-1-5-32-545";
    const first = ensureAveHomePrivate(dir);
    expect(first, refusal(first)).toMatchObject({ enforcement: "win32-dacl" });
    for (const path of paths) {
      execFileSync(win32SystemBinary("icacls"), [path, "/grant", `*${sid}:(OI)(CI)RX`, "/L", "/q"], { encoding: "utf-8", windowsHide: true });
    }
    const result = ensureAveHomePrivate(dir);
    expect(result, refusal(result)).toMatchObject({ enforcement: "win32-dacl",
      repairs: paths.map((path) => ({ path, removedPrincipals: [sid] })) });
    const descriptors = readWindowsDirectoryDacls(paths);
    expect(descriptors).toHaveLength(3);
    for (const entry of descriptors) {
      expect(entry).toMatchObject({ protected: true, rules: [{ ...OWNER_RULE, sid: entry.currentUserSid, account: expect.any(String) }] });
    }
  });
  it.runIf(process.platform === "win32")("removes a foreign explicit deny from the home DACL", () => {
    const dir = home();
    const sid = "S-1-5-32-545";
    const first = ensureAveHomePrivate(dir);
    expect(first, refusal(first)).toMatchObject({ enforcement: "win32-dacl" });
    execFileSync(win32SystemBinary("icacls"), [dir, "/deny", `*${sid}:(OI)(CI)RX`, "/L", "/q"], { encoding: "utf-8", windowsHide: true });
    try {
      const result = ensureAveHomePrivate(dir);
      expect(result, refusal(result)).toMatchObject({ enforcement: "win32-dacl", repairs: [{ path: dir, removedPrincipals: [sid] }] });
      const [entry] = readWindowsDirectoryDacls([dir]);
      expect(entry).toMatchObject({ protected: true, rules: [{ ...OWNER_RULE, sid: entry.currentUserSid, account: expect.any(String) }] });
    } finally {
      execFileSync(win32SystemBinary("icacls"), [dir, "/remove:d", `*${sid}`, "/L", "/q"], { encoding: "utf-8", windowsHide: true });
    }
  });
  function checkChildRefusal(name: string, createChild: (path: string) => void): void {
    const dir = home();
    const protectedHome = ensureAveHomePrivate(dir);
    expect(protectedHome, refusal(protectedHome)).toMatchObject({ enforcement: "win32-dacl" });
    const path = join(dir, "secrets", name);
    createChild(path);
    execFileSync(win32SystemBinary("icacls"), [path, "/grant", "*S-1-1-0:R", "/q"], { encoding: "utf-8", windowsHide: true });
    const before = sddl(path);
    const result = ensureAveHomePrivate(dir);
    expect(result).toMatchObject({ enforcement: "none", failedPath: path, category: "extra-principals",
      extraPrincipals: [expect.objectContaining({ sid: "S-1-1-0", account: expect.any(String) })] });
    expect(sddl(path)).toBe(before);
    setAveHomePrivacyAtBoot(result);
    expect(() => assertAveHomePrivacyForConfinement()).toThrow(path);
  }
  it.runIf(process.platform === "win32")("reports a foreign explicit grant on a secrets child file without rewriting it", () => {
    checkChildRefusal("file", (path) => writeFileSync(path, "private"));
  });
  it.runIf(process.platform === "win32")("reports a foreign explicit grant on a secrets child directory without rewriting it", () => {
    checkChildRefusal("directory", (path) => mkdirSync(path));
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
  it("refuses a link and an unaccepted owner before the permission command writes", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify([descriptor("C:\\home")]));
    readWindowsDirectoryDacls(["C:\\home"], true);
    const args = vi.mocked(execFileSync).mock.calls.at(-1)![1] as readonly string[];
    const command = args.at(-1)!;
    const write = command.indexOf("[HomeDirectoryDacl]::Reapply($path, $identity.User, $elevated)");
    expect(write).toBeGreaterThan(-1);
    expect(command.indexOf("[System.IO.FileAttributes]::ReparsePoint")).toBeLessThan(write);
    expect(command.indexOf("'Directory is owned by another account'")).toBeLessThan(write);
    expect(command).toContain("$owner -ne $sid -and -not ($elevated -and $owner -eq 'S-1-5-32-544')");
    expect(command).toContain("NtOpenFile(out handle, 0x00040000 | 0x00020000, ref attributes, out io, 3, 0x00004000)");
    expect(command).toContain("CreateFile(parentPath, 0x00100001, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)");
    expect(command).toContain("Root = parent.DangerousGetHandle(), Name = memory");
    expect(command).toContain("Marshal.StringToHGlobalUni(leaf)");
    expect(command).toContain("Attributes = 0x1040");
    expect(command.indexOf('if (status == unchecked((int)0xC000050B)) throw new InvalidOperationException("Directory is a link or junction")')).toBeLessThan(command.indexOf("result = SetSecurityInfo(handle, 1, 0x80000004"));
    expect(command.indexOf('if (!information.Directory) throw new InvalidOperationException("Path is not a directory")')).toBeLessThan(command.indexOf("result = SetSecurityInfo(handle, 1, 0x80000004"));
    expect(command.indexOf('if (ownerSid != user.Value && !(elevated && ownerSid == "S-1-5-32-544"))')).toBeLessThan(command.indexOf("result = SetSecurityInfo(handle, 1, 0x80000004"));
    expect(command).toContain('new RawSecurityDescriptor("D:P(A;OICI;FA;;;" + user.Value + ")")');
    expect(command.lastIndexOf("$readBack = Read-Dacl $path $false")).toBeGreaterThan(write);
  });
  it("claims only the requested runtime root before writing its DACL", () => {
    const dir = home();
    const runtimeRoot = join(dir, "subscription-runtimes");
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify([dir, join(dir, "secrets"), runtimeRoot].map(descriptor)));
    ensureAveHomePrivate(dir, { platform: "win32", readDacls: readWindowsDirectoryDacls });
    const [, args, options] = vi.mocked(execFileSync).mock.calls.at(-1)!;
    const request = JSON.parse((options as { env: NodeJS.ProcessEnv }).env.AVE_DACL_REQUEST!);
    expect(request).toEqual({ paths: [dir, join(dir, "secrets"), runtimeRoot], protect: true, claimableRuntimeRoot: runtimeRoot });
    const command = (args as readonly string[]).at(-1)!;
    const guard = command.indexOf("if ($path -eq $request.claimableRuntimeRoot -and -not $elevated -and $owner -eq 'S-1-5-32-544')");
    const claim = command.indexOf("[RuntimeRootOwnership]::ClaimFromAdministrators($path, $identity.User)");
    expect(guard).toBeGreaterThan(command.indexOf("if ($request.protect)"));
    expect(guard).toBeGreaterThan(command.indexOf("[System.IO.FileAttributes]::ReparsePoint"));
    expect(claim).toBeGreaterThan(guard);
    expect(claim).toBeLessThan(command.indexOf("[HomeDirectoryDacl]::Reapply($path, $identity.User, $elevated)"));
    expect(command).toContain("CreateFile(path, 0x00080000 | 0x00020000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)");
    expect(command).toContain('new SecurityIdentifier(owner).Value != "S-1-5-32-544"');
    expect(command.indexOf("GetSecurityInfo(handle, 1, 1")).toBeLessThan(command.indexOf("SetSecurityInfo(handle, 1, 1"));
    expect(command).toContain("$refused = 'owner-claim-failed'");
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
  function sddl(path: string): string {
    return execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-Acl -LiteralPath $env:AVE_TEST_TARGET).GetSecurityDescriptorSddlForm('Owner, Access')",
    ], { env: windowsPowerShellEnv({ ...process.env, AVE_TEST_TARGET: path }), encoding: "utf-8", windowsHide: true }).trim();
  }
  function protectWithoutCompilation(dir: string): ReturnType<typeof ensureAveHomePrivate> {
    return ensureAveHomePrivate(dir, { platform: "win32", readDacls: (paths, protect, claimableRuntimeRoot) => {
      vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify(paths.map(descriptor)));
      readWindowsDirectoryDacls(paths, protect, claimableRuntimeRoot);
      const [, args, options] = vi.mocked(execFileSync).mock.calls.at(-1)!;
      const command = (args as readonly string[]).at(-1)!.replaceAll("Add-Type -TypeDefinition", "throw 'Unexpected permission writer compilation'; Add-Type -TypeDefinition");
      const output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
        ...(args as readonly string[]).slice(0, -1), command,
      ], options as { env: NodeJS.ProcessEnv; encoding: "utf-8"; windowsHide: boolean });
      return JSON.parse(output);
    } });
  }
  it.runIf(process.platform === "win32")("skips writer compilation for newly created owner-only directories", () => {
    const dir = home();
    const result = protectWithoutCompilation(dir);
    expect(result, refusal(result)).toMatchObject({ enforcement: "win32-dacl", home: dir });
    expect(result).not.toHaveProperty("repairs");
  });
  it.runIf(process.platform === "win32")("skips writer compilation for already protected owner-only directories", () => {
    const dir = home();
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl" });
    const result = protectWithoutCompilation(dir);
    expect(result, refusal(result)).toMatchObject({ enforcement: "win32-dacl", home: dir });
    expect(result).not.toHaveProperty("repairs");
  });
  it.runIf(process.platform === "win32")("protects and repairs a home reached through a parent junction", () => {
    const fixture = home();
    const target = join(dirname(fixture), "parent-target");
    const parent = join(dirname(fixture), "parent-junction");
    mkdirSync(target);
    symlinkSync(target, parent, "junction");
    const dir = join(parent, "home");
    vi.stubEnv("AVE_HOME", dir);
    try {
      const before = sddl(target);
      expect(ensureAveHomePrivate()).toMatchObject({ enforcement: "win32-dacl", home: dir });
      execFileSync(win32SystemBinary("icacls"), [dir, "/grant", "*S-1-5-32-545:(OI)(CI)RX", "/L", "/q"], { encoding: "utf-8", windowsHide: true });
      const result = ensureAveHomePrivate();
      expect(result, refusal(result)).toMatchObject({ enforcement: "win32-dacl", home: dir,
        repairs: [{ path: dir, removedPrincipals: ["S-1-5-32-545"] }] });
      const entries = readWindowsDirectoryDacls([dir, join(dir, "secrets"), join(dir, "subscription-runtimes")]);
      expect(entries).toHaveLength(3);
      for (const entry of entries) {
        expect(entry).toMatchObject({ protected: true, rules: [{ ...OWNER_RULE, sid: entry.currentUserSid, account: expect.any(String) }] });
      }
      expect(sddl(target)).toBe(before);
    } finally {
      rmdirSync(parent);
    }
  });
  function checkJunctionRefusal(dir: string, link: string): void {
    const target = join(dirname(dir), "target");
    mkdirSync(target);
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
  it.runIf(process.platform === "win32")("refuses a home junction and leaves its target DACL unchanged", () => {
    const dir = home();
    checkJunctionRefusal(dir, dir);
  });
  it.runIf(process.platform === "win32")("refuses a secrets junction and leaves its target DACL unchanged", () => {
    const dir = home();
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl" });
    const link = join(dir, "secrets");
    rmdirSync(link);
    checkJunctionRefusal(dir, link);
  });
  it.runIf(process.platform === "win32")("refuses an existing home owned by another account and leaves its DACL unchanged", (context) => {
    requireRestorePrivilege(context);
    const dir = home();
    mkdirSync(dir);
    execFileSync(win32SystemBinary("icacls"), [dir, "/setowner", "*S-1-5-18", "/q"], { encoding: "utf-8", windowsHide: true });
    const before = sddl(dir);
    const result = ensureAveHomePrivate(dir);
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "invalid-owner-grant", reason: "Directory is owned by another account" });
    expect(sddl(dir)).toBe(before);
    expect(existsSync(join(dir, "secrets"))).toBe(false);
  });
  it.runIf(process.platform === "win32")("claims an Administrators-owned runtime root on a non-elevated token", (context) => {
    requireRestorePrivilege(context);
    const dir = home();
    const first = ensureAveHomePrivate(dir);
    const runtimeRoot = join(dir, "subscription-runtimes");
    const [before] = readWindowsDirectoryDacls([runtimeRoot]);
    if (before.elevated) context.skip("A non-elevated token with SeRestorePrivilege is required to exercise the boot ownership claim");
    expect(first, refusal(first)).toMatchObject({ enforcement: "win32-dacl" });
    execFileSync(win32SystemBinary("icacls"), [runtimeRoot, "/setowner", "*S-1-5-32-544", "/q"], { encoding: "utf-8", windowsHide: true });
    expect(readWindowsDirectoryDacls([runtimeRoot])[0].ownerSid).toBe("S-1-5-32-544");
    const result = ensureAveHomePrivate(dir);
    expect(result, refusal(result)).toMatchObject({ enforcement: "win32-dacl" });
    const [after] = readWindowsDirectoryDacls([runtimeRoot]);
    expect(after.ownerSid).toBe(after.currentUserSid);
    expect(after).toMatchObject({ protected: true, rules: [expect.objectContaining({ ...OWNER_RULE, sid: after.currentUserSid })] });
  });
  it.runIf(process.platform === "win32")("rechecks the handle owner before claiming and leaves a token-owned fixture unchanged", () => {
    const dir = home();
    expect(ensureAveHomePrivate(dir)).toMatchObject({ enforcement: "win32-dacl" });
    const before = sddl(dir);
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify([descriptor(dir)]));
    readWindowsDirectoryDacls([dir], true, dir);
    const args = vi.mocked(execFileSync).mock.calls.at(-1)![1] as readonly string[];
    const source = args.at(-1)!.split("Add-Type -TypeDefinition @'\n")[1].split("\n'@;")[0];
    const error = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), ["-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -TypeDefinition @'\n${source}\n'@\ntry { [RuntimeRootOwnership]::ClaimFromAdministrators($env:AVE_TEST_TARGET, [System.Security.Principal.WindowsIdentity]::GetCurrent().User) } catch { [Console]::Write($_.Exception.InnerException.Message) }`,
    ], { env: { ...process.env, AVE_TEST_TARGET: dir }, encoding: "utf-8", windowsHide: true });
    expect(error).toBe("Owner changed during the claim");
    expect(sddl(dir)).toBe(before);
  });
  it.runIf(process.platform === "win32")("refuses a swapped junction on the write handle and leaves its target DACL unchanged", () => {
    const dir = home();
    const target = join(dirname(dir), "target");
    mkdirSync(target);
    symlinkSync(target, dir, "junction");
    try {
      const before = sddl(target);
      vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify([descriptor(dir)]));
      readWindowsDirectoryDacls([dir], true);
      const args = vi.mocked(execFileSync).mock.calls.at(-1)![1] as readonly string[];
      const source = args.at(-1)!.split("Add-Type -TypeDefinition @'\n").at(-1)!.split("\n'@;")[0];
      const error = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), ["-NoProfile", "-NonInteractive", "-Command",
        `Add-Type -TypeDefinition @'\n${source}\n'@\ntry { [HomeDirectoryDacl]::Reapply($env:AVE_TEST_TARGET, [System.Security.Principal.WindowsIdentity]::GetCurrent().User, $false) } catch { [Console]::Write($_.Exception.GetBaseException().Message) }`,
      ], { env: { ...process.env, AVE_TEST_TARGET: dir }, encoding: "utf-8", windowsHide: true });
      expect(error).toBe("Directory is a link or junction");
      expect(sddl(target)).toBe(before);
    } finally {
      rmdirSync(dir);
    }
  });
  function checkRealDirectory(name: string): void {
    const dir = join(home(), name);
    const before = vi.mocked(execFileSync).mock.calls.length;
    const result = ensureAveHomePrivate(dir);
    expect(result, refusal(result)).toMatchObject({ enforcement: "win32-dacl" });
    expect(vi.mocked(execFileSync).mock.calls.slice(before)).toHaveLength(1);
    const descriptors = readWindowsDirectoryDacls([dir, join(dir, "secrets"), join(dir, "subscription-runtimes")]);
    console.info(`Verified relocated private directory DACL JSON: ${JSON.stringify(descriptors)}`);
    for (const entry of descriptors) {
      expect(entry.path).toContain(dir);
      expect(entry).toMatchObject({ protected: true, rules: [expect.objectContaining({
        ...OWNER_RULE, sid: (result as { sid: string }).sid,
      })] });
      // Creation sets current-user ownership even on an elevated token.
      expect(entry.ownerSid).toBe(entry.currentUserSid);
    }
    writeFileSync(join(dir, "settings.json"), "{}");
    expect(readFileSync(join(dir, "settings.json"), "utf-8")).toBe("{}");
  }
  it.runIf(process.platform === "win32")("protects and reads back a directory with an ordinary name", () => {
    checkRealDirectory("ordinary");
  });
  it.runIf(process.platform === "win32")("protects and reads back a directory with a curly quote", () => {
    checkRealDirectory("curly’quote");
  });
  it.runIf(process.platform === "win32")("protects and reads back a directory with shell punctuation", () => {
    checkRealDirectory("'; Write-Output x; '");
  });
});
