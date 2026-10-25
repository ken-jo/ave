import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureAveHomePrivate, aveHome, win32SystemBinary, readWindowsDirectoryDacls, setAveHomePrivacyAtBoot, assertAveHomePrivacyForConfinement, _resetAveHomePrivacyForTest, type WindowsDirectoryDacl, type WindowsAccessRule } from "../ave-home.js";
import { useTempPaths } from "../../__tests__/test-helpers.js";

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

describe("ensureAveHomePrivate", () => {
  const home = useTempPaths("ave-home-privacy-", ".ave");
  function check(change: (entry: WindowsDirectoryDacl, index: number) => WindowsDirectoryDacl = (entry) => entry) {
    const dir = home();
    const readDacls = vi.fn((paths: readonly string[], _protect?: boolean) => paths.map((path, index) => change(descriptor(path), index)));
    return { dir, readDacls, result: ensureAveHomePrivate(dir, { platform: "win32", readDacls }) };
  }
  it("accepts alias-free numeric JSON rules and requests protection in one read-back", () => {
    const { dir, result, readDacls } = check();
    expect(result).toEqual({ enforcement: "win32-dacl", home: dir, sid: OWNER_SID });
    expect(readDacls.mock.calls).toEqual([[[dir, join(dir, "secrets")], true]]);
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
  it.each(["S-1-5-18", "S-1-5-32-544", "S-1-1-0"])("rejects an extra well-known principal %s", (sid) => {
    const { result, dir } = check((entry) => ({ ...entry, rules: [OWNER_RULE, { ...OWNER_RULE, sid }] }));
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "extra-principals", extraPrincipals: [{ sid }] });
  });
  it.each(["example\\guest", undefined])("retains optional account resolution %s", (account) => {
    const sid = "S-1-5-21-100-200-300-9999";
    expect(check((entry) => ({ ...entry, rules: [OWNER_RULE, { ...OWNER_RULE, sid, account }] })).result)
      .toMatchObject({ category: "extra-principals", extraPrincipals: [{ sid, ...(account ? { account } : {}) }] });
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
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
  it("passes untrusted paths and the icacls path only through one JSON environment value", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const paths = ["odd’; Write-Output x; 'path", "secret"];
    const results = paths.map(descriptor);
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify(results));
    expect(readWindowsDirectoryDacls(paths)).toEqual(results);
    const [, args, options] = vi.mocked(execFileSync).mock.calls.at(-1)!;
    expect(args!.join(" ")).not.toContain(paths[0]);
    const env = (options as { env: NodeJS.ProcessEnv }).env;
    expect(JSON.parse(env.AVE_DACL_REQUEST!)).toEqual({ paths, protect: false, icacls: join("C:\\Windows", "System32", "icacls.exe") });
    // The system root reaches the child only inside the request, never as a second variable.
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
      { path: paths[0]!, category: "directory-failed", error: "Access is denied" }, descriptor(paths[1]!),
    ] });
    expect(result).toMatchObject({ enforcement: "none", failedPath: dir, category: "directory-failed", reason: "Access is denied" });
  });
  it("rejects a malformed read-back result set", () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.mocked(execFileSync).mockReturnValueOnce("{}");
    expect(() => readWindowsDirectoryDacls([home()])).toThrow("invalid result set");
  });
  it.each([false, true])("checks immediate child explicit grants (extra=%s)", (extra) => {
    const dir = home();
    const child = join(dir, "secrets", "token");
    const result = ensureAveHomePrivate(dir, { platform: "win32", readDacls: (paths) => [
      ...paths.map(descriptor), { ...descriptor(child), child: true, rules: [
        { ...OWNER_RULE, isInherited: true }, { ...OWNER_RULE, sid: "S-1-5-18", isInherited: !extra },
      ] },
    ] });
    expect(result).toMatchObject(extra ? { enforcement: "none", category: "extra-principals", failedPath: child } : { enforcement: "win32-dacl" });
  });
  it.runIf(process.platform === "win32").each(["home", "secrets", "file", "directory"])("reports retained explicit extra entries on the real %s DACL", (target) => {
    const dir = home();
    // The message carries the whole result, so a refusal shows its category and reason.
    const protectedHome = ensureAveHomePrivate(dir);
    expect(protectedHome, refusal(protectedHome)).toMatchObject({ enforcement: "win32-dacl" });
    const path = target === "home" ? dir : target === "secrets" ? join(dir, "secrets") : join(dir, "secrets", target);
    if (target === "file") writeFileSync(path, "private");
    if (target === "directory") mkdirSync(path);
    execFileSync(win32SystemBinary("icacls"), [path, "/grant", "*S-1-1-0:R", "/q"], { encoding: "utf-8", windowsHide: true });
    const result = ensureAveHomePrivate(dir);
    expect(result).toMatchObject({ enforcement: "none", failedPath: path, category: "extra-principals",
      extraPrincipals: [expect.objectContaining({ sid: "S-1-1-0", account: expect.any(String) })] });
    setAveHomePrivacyAtBoot(result);
    expect(() => assertAveHomePrivacyForConfinement()).toThrow(path);
  });
  it.runIf(process.platform === "win32").each(["ordinary", "curly’quote", "'; Write-Output x; '"])("protects and reads back a real directory named %s", (name) => {
    const dir = join(home(), name);
    const before = vi.mocked(execFileSync).mock.calls.length;
    const result = ensureAveHomePrivate(dir);
    expect(result, refusal(result)).toMatchObject({ enforcement: "win32-dacl" });
    expect(vi.mocked(execFileSync).mock.calls.slice(before)).toHaveLength(1);
    const descriptors = readWindowsDirectoryDacls([dir, join(dir, "secrets")]);
    console.info(`Verified relocated private directory DACL JSON: ${JSON.stringify(descriptors)}`);
    for (const entry of descriptors) {
      expect(entry.path).toContain(dir);
      expect(entry).toMatchObject({ protected: true, rules: [expect.objectContaining({
        ...OWNER_RULE, sid: (result as { sid: string }).sid,
      })] });
      // The call created both directories, so the current user owns them even on an elevated token.
      expect(entry.ownerSid).toBe(entry.currentUserSid);
    }
    writeFileSync(join(dir, "settings.json"), "{}");
    expect(readFileSync(join(dir, "settings.json"), "utf-8")).toBe("{}");
  });
});
