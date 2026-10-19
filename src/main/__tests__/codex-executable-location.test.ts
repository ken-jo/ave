import { execFile, type ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, promises as fs, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import {
  assertCodexExecutableLocation,
  assertCodexPrivateRuntimeDirectory,
  CodexExecutableLocationError,
} from "../codex-executable-location.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn(),
}));

const HOST = process.platform;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function withMetadata(stat: Stats, metadata: Partial<Stats>): Stats {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, metadata) as Stats;
}

function posixFixture(): {
  root: string;
  executable: string;
  metadata: Map<string, Partial<Stats>>;
  errors: Map<string, Error>;
  accessRules: Map<string, string[]>;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-executable-location-")));
  roots.push(root);
  chmodSync(root, 0o700);
  const executable = join(root, "executable");
  writeFileSync(executable, "fixture", { mode: 0o700 });
  const metadata = new Map<string, Partial<Stats>>();
  const errors = new Map<string, Error>();
  const accessRules = new Map<string, string[]>();
  const externalAncestors = new Set<string>();
  for (let path = dirname(root);;) {
    externalAncestors.add(path);
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  const originalLstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (path) => {
    const key = String(path);
    if (errors.has(key)) throw errors.get(key);
    const stat = await originalLstat(path);
    // Only the fixture's external ancestors are normalized. Entries created
    // by the fixture retain the real permissions that each test exercises.
    const normalized = externalAncestors.has(key)
      ? withMetadata(stat, { uid: 0, mode: (stat.mode & ~0o7777) | 0o755 })
      : stat;
    return withMetadata(normalized, metadata.get(key) ?? {});
  });
  vi.mocked(execFile).mockImplementation((...args) => {
    const paths = (args[1] as string[]).slice(4);
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    const lines = paths.flatMap((path) => {
      const stat = lstatSync(path);
      const type = stat.isSymbolicLink() ? "l" : stat.isDirectory() ? "d" : "-";
      const suffix = stat.isSymbolicLink() ? ` -> ${readlinkSync(path)}` : "";
      return [`${type}rwx------ 1 0 0 0 0 ${path}${suffix}`, ...accessRules.get(path) ?? []];
    });
    callback(null, `${lines.join("\n")}\n`, "");
    return {} as ChildProcess;
  });
  return { root, executable, metadata, errors, accessRules };
}

describe.skipIf(HOST === "win32")("executable location admission", () => {
  it.each(["current account", "system account"])("admits a protected file owned by the %s", async (owner) => {
    const fixture = posixFixture();
    if (owner === "system account") fixture.metadata.set(fixture.executable, { uid: 0 });
    await expect(assertCodexExecutableLocation(fixture.executable)).resolves.toBeUndefined();
    expect(vi.mocked(execFile).mock.calls.some(([command]) => command === fixture.executable)).toBe(false);
  });

  it("rejects a foreign-owned file", async () => {
    const fixture = posixFixture();
    fixture.metadata.set(fixture.executable, { uid: (process.getuid?.() ?? 0) + 1 });
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toThrow("untrusted owner");
  });

  it.each([0o720, 0o702, 0o777])("rejects file permissions %o", async (mode) => {
    const fixture = posixFixture();
    chmodSync(fixture.executable, mode);
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toThrow("writable by another account");
  });

  it.each([0o770, 0o707, 0o1777])("rejects ancestor permissions %o", async (mode) => {
    const fixture = posixFixture();
    chmodSync(fixture.root, mode);
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toThrow("writable by another account");
  });

  it("rejects a foreign-owned ancestor", async () => {
    const fixture = posixFixture();
    fixture.metadata.set(fixture.root, { uid: (process.getuid?.() ?? 0) + 1 });
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toThrow("untrusted owner");
  });

  it("admits a protected launcher link without interpreting its permission bits", async () => {
    const fixture = posixFixture();
    const launcher = join(fixture.root, "launcher");
    symlinkSync("executable", launcher);
    await expect(assertCodexExecutableLocation(launcher)).resolves.toBeUndefined();
  });

  it("rejects a foreign-owned launcher link", async () => {
    const fixture = posixFixture();
    const launcher = join(fixture.root, "launcher");
    symlinkSync(fixture.executable, launcher);
    fixture.metadata.set(launcher, { uid: (process.getuid?.() ?? 0) + 1 });
    await expect(assertCodexExecutableLocation(launcher)).rejects.toThrow("untrusted owner");
  });

  it("checks the original launcher's parent before following the target", async () => {
    const fixture = posixFixture();
    const unsafe = join(fixture.root, "unsafe");
    mkdirSync(unsafe, { mode: 0o777 });
    chmodSync(unsafe, 0o777);
    const launcher = join(unsafe, "launcher");
    symlinkSync(fixture.executable, launcher);
    await expect(assertCodexExecutableLocation(launcher)).rejects.toThrow("writable by another account");
  });

  it("checks a symlinked ancestor's own ownership", async () => {
    const fixture = posixFixture();
    const alias = join(fixture.root, "alias");
    symlinkSync(fixture.root, alias);
    fixture.metadata.set(alias, { uid: (process.getuid?.() ?? 0) + 1 });
    await expect(assertCodexExecutableLocation(join(alias, "executable"))).rejects.toThrow("untrusted owner");
  });

  it("checks intermediate link targets even when the final canonical route is protected", async () => {
    const fixture = posixFixture();
    const unsafe = join(fixture.root, "unsafe");
    mkdirSync(unsafe, { mode: 0o700 });
    const relay = join(unsafe, "relay");
    symlinkSync(fixture.executable, relay);
    const launcher = join(fixture.root, "launcher");
    symlinkSync(relay, launcher);
    chmodSync(unsafe, 0o777);
    await expect(assertCodexExecutableLocation(launcher)).rejects.toThrow("writable by another account");
  });

  it("checks parent components after resolving the symlink target", async () => {
    const fixture = posixFixture();
    const nested = join(fixture.root, "nested");
    const deeper = join(nested, "deeper");
    mkdirSync(deeper, { recursive: true, mode: 0o700 });
    writeFileSync(join(nested, "executable"), "fixture", { mode: 0o777 });
    chmodSync(join(nested, "executable"), 0o777);
    const alias = join(fixture.root, "alias");
    symlinkSync(deeper, alias);
    await expect(assertCodexExecutableLocation(`${alias}/../executable`)).rejects.toThrow("writable by another account");
  });

  it.each(["EACCES", "EIO", "ENOENT"])("propagates %s from lstat unchanged", async (code) => {
    const fixture = posixFixture();
    const error = Object.assign(new Error("Filesystem failure"), { code });
    fixture.errors.set(fixture.executable, error);
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toBe(error);
  });

  it("propagates canonical-path lookup failures unchanged", async () => {
    const fixture = posixFixture();
    const error = Object.assign(new Error("Filesystem failure"), { code: "EIO" });
    vi.spyOn(fs, "realpath").mockRejectedValue(error);
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toBe(error);
  });

  it("rejects an existing directory as an executable", async () => {
    const fixture = posixFixture();
    await expect(assertCodexExecutableLocation(fixture.root)).rejects.toThrow("not a regular file");
  });

  it("rejects a symbolic link loop without executing it", async () => {
    const fixture = posixFixture();
    const loop = join(fixture.root, "loop");
    symlinkSync(loop, loop);
    await expect(assertCodexExecutableLocation(loop)).rejects.toThrow("too many symbolic links");
  });

  it("admits an owner-only runtime directory", async () => {
    const fixture = posixFixture();
    await expect(assertCodexPrivateRuntimeDirectory(fixture.root)).resolves.toBeUndefined();
  });

  it.each([0o755, 0o750, 0o1700])("rejects runtime permissions %o", async (mode) => {
    const fixture = posixFixture();
    chmodSync(fixture.root, mode);
    await expect(assertCodexPrivateRuntimeDirectory(fixture.root)).rejects.toThrow("private to the current account");
  });

  it("requires the current account to own the private leaf", async () => {
    const fixture = posixFixture();
    fixture.metadata.set(fixture.root, { uid: 0 });
    vi.spyOn(process, "getuid").mockReturnValue(4242);
    await expect(assertCodexPrivateRuntimeDirectory(fixture.root)).rejects.toThrow("private to the current account");
  });

  it("refuses a symbolic link as the runtime directory leaf", async () => {
    const fixture = posixFixture();
    const alias = join(fixture.root, "alias");
    symlinkSync(fixture.root, alias);
    await expect(assertCodexPrivateRuntimeDirectory(alias)).rejects.toThrow("must not be a symbolic link");
  });

  it.each(["/", "/.", "/./"])("refuses a symbolic runtime leaf with suffix %s", async (suffix) => {
    const fixture = posixFixture();
    const alias = join(fixture.root, "alias");
    symlinkSync(fixture.root, alias);
    await expect(assertCodexPrivateRuntimeDirectory(`${alias}${suffix}`)).rejects.toThrow("must not be a symbolic link");
  });

  it("checks the private directory's ancestors too", async () => {
    const fixture = posixFixture();
    const directory = join(fixture.root, "runtime");
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(fixture.root, 0o1777);
    await expect(assertCodexPrivateRuntimeDirectory(directory)).rejects.toThrow("writable by another account");
  });
});

function extendedRulesFixture(): ReturnType<typeof posixFixture> {
  const fixture = posixFixture();
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  return fixture;
}

describe.skipIf(HOST === "win32")("extended access-rule admission", () => {
  it("admits deny-only rules with an unresolved principal", async () => {
    const fixture = extendedRulesFixture();
    fixture.accessRules.set(fixture.root, [" 0: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C deny delete"]);
    await expect(assertCodexExecutableLocation(fixture.executable)).resolves.toBeUndefined();
  });

  it.each(["write", "append", "add_file", "add_subdirectory", "delete", "delete_child", "writeattr", "writeextattr", "writesecurity", "chown"])("rejects an extended allow grant for %s", async (permission) => {
    const fixture = extendedRulesFixture();
    fixture.accessRules.set(fixture.executable, [` 0: group:other allow ${permission}`]);
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toThrow("writable by another account");
  });

  it("checks extended mutation grants on ancestors", async () => {
    const fixture = extendedRulesFixture();
    fixture.accessRules.set(fixture.root, [" 0: group:other allow add_file"]);
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toThrow("writable by another account");
  });

  it("checks the link object's access rules too", async () => {
    const fixture = extendedRulesFixture();
    const alias = join(fixture.root, "alias");
    symlinkSync(fixture.executable, alias);
    fixture.accessRules.set(alias, [" 0: group:other allow write"]);
    await expect(assertCodexExecutableLocation(alias)).rejects.toThrow("writable by another account");
  });

  it.each(["user:0", `user:${process.getuid?.() ?? 0}`])("admits a numeric trusted user grant for %s", async (principal) => {
    const fixture = extendedRulesFixture();
    fixture.accessRules.set(fixture.executable, [` 0: ${principal} allow write,delete`]);
    await expect(assertCodexExecutableLocation(fixture.executable)).resolves.toBeUndefined();
  });

  it("admits foreign read-only access to an installed file", async () => {
    const fixture = extendedRulesFixture();
    fixture.accessRules.set(fixture.executable, [" 0: group:other allow read,readattr,readextattr,readsecurity,execute"]);
    await expect(assertCodexExecutableLocation(fixture.executable)).resolves.toBeUndefined();
  });

  it("rejects unresolved principal mutation grants", async () => {
    const fixture = extendedRulesFixture();
    fixture.accessRules.set(fixture.executable, [" 0: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C allow write"]);
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toThrow("writable by another account");
  });

  it("fails closed for unknown allow permissions", async () => {
    const fixture = extendedRulesFixture();
    fixture.accessRules.set(fixture.executable, [" 0: user:0 allow future_permission"]);
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toThrow("unsupported");
  });

  it("ignores ancestor inherit-only grants while checking reached inherited grants", async () => {
    const fixture = extendedRulesFixture();
    fixture.accessRules.set(fixture.root, [" 0: group:other allow write,file_inherit,only_inherit"]);
    await expect(assertCodexExecutableLocation(fixture.executable)).resolves.toBeUndefined();
    fixture.accessRules.set(fixture.executable, [" 0: group:other inherited allow write"]);
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toThrow("writable by another account");
  });

  it.each(["read", "read,file_inherit,only_inherit"])("rejects foreign private-directory access for %s", async (permissions) => {
    const fixture = extendedRulesFixture();
    fixture.accessRules.set(fixture.root, [` 0: group:other allow ${permissions}`]);
    await expect(assertCodexPrivateRuntimeDirectory(fixture.root)).rejects.toThrow("accessible by another account");
  });

  it("uses an absolute metadata utility with bounded execution and stable formatting", async () => {
    const fixture = extendedRulesFixture();
    await assertCodexExecutableLocation(fixture.executable);
    const [command, args, options] = vi.mocked(execFile).mock.calls[0]!;
    expect(command).toBe("/bin/ls");
    expect(args!.slice(0, 4)).toEqual(["-ldne", "-D", "%s", "--"]);
    expect(options).toMatchObject({
      timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs,
      maxBuffer: 256 * 1024,
      env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" },
    });
  });

  it("propagates metadata process errors unchanged", async () => {
    const fixture = extendedRulesFixture();
    const error = Object.assign(new Error("Metadata read failed"), { code: "EIO" });
    vi.mocked(execFile).mockImplementation((...args) => {
      const callback = args[3] as (error: Error, stdout: string, stderr: string) => void;
      callback(error, "", "");
      return {} as ChildProcess;
    });
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toBe(error);
  });

  it("refuses partial metadata results", async () => {
    const fixture = extendedRulesFixture();
    vi.mocked(execFile).mockImplementation((...args) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, "", "");
      return {} as ChildProcess;
    });
    await expect(assertCodexExecutableLocation(fixture.executable)).rejects.toThrow("incomplete");
  });
});

const CURRENT_SID = "S-1-5-21-100-200-300-1001";
const FOREIGN_SID = "S-1-5-21-100-200-300-1002";

interface AccessEntry {
  sid: string;
  mask: number;
  flags: number;
  type: number;
}

interface PathSecurity {
  path: string;
  owner: string;
  daclPresent: boolean;
  entries: AccessEntry[];
}

function pathStats(kind: "file" | "directory" | "link"): Stats {
  return {
    uid: 9999,
    mode: 0o777,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "link",
  } as Stats;
}

function windowsFixture(candidate = String.raw`C:\Tools\executable.exe`, directory = false): {
  candidate: string;
  modify: (callback: (paths: PathSecurity[]) => void) => void;
  links: Map<string, string>;
} {
  vi.stubGlobal("process", { ...process, platform: "win32", env: { SystemRoot: String.raw`C:\Windows` } });
  const links = new Map<string, string>();
  vi.spyOn(fs, "lstat").mockImplementation(async (path) => pathStats(links.has(String(path))
    ? "link"
    : String(path).toLowerCase().endsWith(".exe") && !directory ? "file" : "directory"));
  vi.spyOn(fs, "readlink").mockImplementation(async (path) => links.get(String(path))!);
  vi.spyOn(fs, "realpath").mockImplementation(async (path) => links.get(String(path)) ?? String(path));
  let modify = (_paths: PathSecurity[]): void => {};
  vi.mocked(execFile).mockImplementation((...args) => {
    const options = args[2] as { env: NodeJS.ProcessEnv };
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    const targets = JSON.parse(options.env.AVE_EXECUTABLE_ACL_PATHS!) as string[];
    const paths = targets.map((path): PathSecurity => ({
      path,
      owner: path === "C:\\" ? "S-1-5-18" : CURRENT_SID,
      daclPresent: true,
      entries: [{ sid: CURRENT_SID, mask: 0x1f01ff, flags: 0, type: 0 }],
    }));
    modify(paths);
    callback(null, JSON.stringify({ currentSid: CURRENT_SID, paths }), "");
    return {} as ChildProcess;
  });
  return { candidate, modify: (callback) => { modify = callback; }, links };
}

describe("native access-rule admission", () => {
  it("checks access rules instead of synthetic uid and permission values", async () => {
    const fixture = windowsFixture();
    fixture.modify((paths) => {
      for (const path of paths) path.entries.push({ sid: FOREIGN_SID, mask: 0x1200a9, flags: 0, type: 0 });
    });
    await expect(assertCodexExecutableLocation(fixture.candidate)).resolves.toBeUndefined();
  });

  it("uses one absolute system command with bounded execution and path data outside its code", async () => {
    const fixture = windowsFixture(String.raw`C:\Tools\odd'; $(Write-Output injected).exe`);
    await assertCodexExecutableLocation(fixture.candidate);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = vi.mocked(execFile).mock.calls[0]!;
    expect(command).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(args!.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(args![4]!, "base64").toString("utf16le");
    expect(script).toContain("CreateFile(path, 0x00020000, 7, IntPtr.Zero, 3, 0x02200000");
    expect(script).toContain("GetSecurityInfo");
    expect(script).not.toContain(fixture.candidate);
    expect(options).toMatchObject({
      timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: { SystemRoot: String.raw`C:\Windows`, PATH: String.raw`C:\Windows\System32;C:\Windows` },
    });
    expect(JSON.parse((options as { env: NodeJS.ProcessEnv }).env.AVE_EXECUTABLE_ACL_PATHS!)).toEqual([
      "C:\\", String.raw`C:\Tools`, fixture.candidate,
    ]);
  });

  it("rejects an untrusted owner even with a restrictive access list", async () => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths[2]!.owner = FOREIGN_SID; });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("untrusted owner");
  });

  it.each([0x2, 0x4, 0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000, 0x40000000, 0x10000000])("rejects foreign mutation mask %i", async (mask) => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths[2]!.entries.push({ sid: FOREIGN_SID, mask, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
  });

  it("rejects create-only access at the drive root", async () => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths[0]!.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
  });

  it.each([0, 1, 2, 4, 16])("checks an applicable ACE with propagation flags %i", async (flags) => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths[1]!.entries.push({ sid: FOREIGN_SID, mask: 2, flags, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
  });

  it.each([8, 9, 10, 12, 24, 31])("ignores an ancestor inherit-only ACE with flags %i", async (flags) => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths[1]!.entries.push({ sid: FOREIGN_SID, mask: 2, flags, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).resolves.toBeUndefined();
  });

  it("does not use deny entries to excuse an untrusted write grant", async () => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths[2]!.entries.push(
      { sid: FOREIGN_SID, mask: 2, flags: 0, type: 1 },
      { sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 },
    ); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
  });

  it("refuses a null access list", async () => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths[2]!.daclPresent = false; });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("unrestricted access");
  });

  it("refuses unsupported conditional access entries", async () => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths[2]!.entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 9 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("unsupported");
  });

  it("requires access-rule results for every inspected path", async () => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths.pop(); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("incomplete");
  });

  it("checks both the original link object and the target's ancestors", async () => {
    const fixture = windowsFixture();
    fixture.links.set(fixture.candidate, String.raw`C:\Native\runtime.exe`);
    fixture.modify((paths) => {
      expect(paths.map((entry) => entry.path)).toEqual([
        "C:\\", String.raw`C:\Tools`, fixture.candidate, String.raw`C:\Native`, String.raw`C:\Native\runtime.exe`,
      ]);
      paths.find((entry) => entry.path === fixture.candidate)!.entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 });
    });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
  });

  it("preserves case-distinct path objects across the original and canonical routes", async () => {
    const fixture = windowsFixture();
    vi.mocked(fs.realpath).mockResolvedValue(String.raw`C:\tools\executable.exe`);
    fixture.modify((paths) => {
      expect(paths.some((entry) => entry.path === String.raw`C:\Tools`)).toBe(true);
      expect(paths.some((entry) => entry.path === String.raw`C:\tools`)).toBe(true);
      paths.find((entry) => entry.path === String.raw`C:\Tools`)!.entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 });
    });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
  });

  it("deduplicates separator aliases while preserving path case", async () => {
    const fixture = windowsFixture("C:/Tools/executable.exe");
    vi.mocked(fs.realpath).mockResolvedValue(String.raw`C:\Tools\executable.exe`);
    await expect(assertCodexExecutableLocation(fixture.candidate)).resolves.toBeUndefined();
  });

  it("propagates access-query process failures", async () => {
    const fixture = windowsFixture();
    const error = Object.assign(new Error("Access query failed"), { code: "EACCES" });
    vi.mocked(execFile).mockImplementation((...args) => {
      const callback = args[3] as (error: Error, stdout: string, stderr: string) => void;
      callback(error, "", "");
      return {} as ChildProcess;
    });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toBe(error);
  });

  it("admits a current-account runtime leaf with a private inheritable access list", async () => {
    const fixture = windowsFixture(String.raw`C:\Tools\runtime`, true);
    await expect(assertCodexPrivateRuntimeDirectory(fixture.candidate)).resolves.toBeUndefined();
  });

  it("requires current-account ownership for the runtime leaf", async () => {
    const fixture = windowsFixture(String.raw`C:\Tools\runtime`, true);
    fixture.modify((paths) => { paths[2]!.owner = "S-1-5-18"; });
    await expect(assertCodexPrivateRuntimeDirectory(fixture.candidate)).rejects.toThrow("not owned by the current account");
  });

  it.each([0, 9])("rejects foreign read access on a private leaf with propagation flags %i", async (flags) => {
    const fixture = windowsFixture(String.raw`C:\Tools\runtime`, true);
    fixture.modify((paths) => { paths[2]!.entries.push({ sid: FOREIGN_SID, mask: 1, flags, type: 0 }); });
    await expect(assertCodexPrivateRuntimeDirectory(fixture.candidate)).rejects.toThrow("accessible by another account");
  });

  it.each([String.raw`\Tools\runtime.exe`, String.raw`C:Tools\runtime.exe`, String.raw`\\?\C:\Tools\runtime.exe`, "relative"])("refuses an unqualified or device path %s", async (candidate) => {
    windowsFixture(candidate);
    await expect(assertCodexExecutableLocation(candidate)).rejects.toBeInstanceOf(CodexExecutableLocationError);
    expect(execFile).not.toHaveBeenCalled();
  });
});
