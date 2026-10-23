import { execFile, type ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, promises as fs, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import {
  assertCodexExecutableLocation,
  assertCodexLocations,
  assertCodexPrivateRuntimeDirectory,
  CodexExecutableLocationError,
  _resetDesktopPackageCacheForTest,
} from "../codex-executable-location.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn(),
}));

const HOST = process.platform;
const roots: string[] = [];

beforeEach(() => { _resetDesktopPackageCacheForTest(); });

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

  it("admits a sticky root-owned ancestor while rejecting a writable regular file", async () => {
    const fixture = posixFixture();
    fixture.metadata.set(fixture.root, { uid: 0, mode: 0o041777 });
    await expect(assertCodexExecutableLocation(fixture.executable)).resolves.toBeUndefined();
    fixture.metadata.set(fixture.executable, { uid: 0, mode: 0o101777 });
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
const PACKAGE_SID = "S-1-15-2-10-20-30-40-50-60-70";
const PACKAGE_CAPABILITY_SID = "S-1-15-3-10-20-30-40-50-60-70";

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
  sandboxGroup: Record<string, unknown>;
  probe: Record<string, unknown>;
} {
  vi.stubGlobal("process", Object.create(process, {
    platform: { value: "win32" },
    env: { value: { SystemRoot: String.raw`C:\Windows` } },
  }));
  const links = new Map<string, string>();
  vi.spyOn(fs, "lstat").mockImplementation(async (path) => pathStats(links.has(String(path))
    ? "link"
    : String(path).toLowerCase().endsWith(".exe") && !directory ? "file" : "directory"));
  vi.spyOn(fs, "readlink").mockImplementation(async (path) => links.get(String(path))!);
  vi.spyOn(fs, "realpath").mockImplementation(async (path) => links.get(String(path)) ?? String(path));
  let modify = (_paths: PathSecurity[]): void => {};
  const sandboxGroup: Record<string, unknown> = {};
  const probe: Record<string, unknown> = { desktopPackage: { status: "unavailable", reason: "mapping-not-found" } };
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
    callback(null, JSON.stringify({ currentSid: CURRENT_SID, paths, sandboxGroup, ...probe }), "");
    return {} as ChildProcess;
  });
  return { candidate, modify: (callback) => { modify = callback; }, links, sandboxGroup, probe };
}

function desktopPackageFixture(directory = false) {
  const fixture = windowsFixture(directory ? String.raw`C:\Tools\runtime` : undefined, directory);
  fixture.probe.desktopPackage = { status: "resolved", packageSid: PACKAGE_SID, capabilitySid: PACKAGE_CAPABILITY_SID };
  return fixture;
}

function capFixture(directory = false) {
  const fixture = windowsFixture(directory ? String.raw`C:\Tools\runtime` : undefined, directory);
  const capPath = String.raw`C:\Fixture\cap_sid`;
  const lstat = vi.mocked(fs.lstat).getMockImplementation()!;
  vi.mocked(fs.lstat).mockImplementation((async (path) => String(path) === capPath ? pathStats("file") : lstat(path)) as typeof fs.lstat);
  return { ...fixture, capPath };
}

describe("native access-rule admission", () => {
  it.each([PACKAGE_SID, PACKAGE_CAPABILITY_SID])("admits identified package SID %s on ancestors and non-private leaves", async (sid) => {
    const fixture = desktopPackageFixture();
    fixture.modify((paths) => { for (const path of paths) path.entries.push({ sid, mask: 0x1f01ff, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    "S-1-15-2-1", "S-1-15-2-2", "S-1-15-2-11-21-31-41-51-61-71", "S-1-15-3-11-21-31-41-51-61-71",
    "S-1-15-3-10-20-30-40-50-60-71",
  ])("keeps other package or capability SID %s foreign", async (sid) => {
    const fixture = desktopPackageFixture();
    for (const index of [1, 2]) {
      fixture.modify((paths) => { paths[index]!.entries.push({ sid, mask: 0x1f01ff, flags: 0, type: 0 }); });
      await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
    }
  });

  it.each(["mapping-not-found", "ambiguous-mapping", "package-not-installed", "publisher-mismatch", "malformed-sid", "resolution-failed"])(
    "keeps admission operational without an exemption after %s", async (reason) => {
      const fixture = desktopPackageFixture();
      fixture.probe.desktopPackage = { status: "unavailable", reason };
      await expect(assertCodexExecutableLocation(fixture.candidate)).resolves.toBeUndefined();
      for (const sid of [PACKAGE_SID, PACKAGE_CAPABILITY_SID]) {
        fixture.modify((paths) => { paths[1]!.entries.push({ sid, mask: 0x1f01ff, flags: 0, type: 0 }); });
        await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
      }
    },
  );

  it.each([PACKAGE_SID, PACKAGE_CAPABILITY_SID])("keeps private directories and their children strict for package SID %s", async (sid) => {
    const fixture = desktopPackageFixture(true);
    fixture.modify((paths) => { paths[2]!.entries.push({ sid, mask: 1, flags: 8, type: 0 }); });
    await expect(assertCodexPrivateRuntimeDirectory(fixture.candidate)).rejects.toThrow("accessible by another account");
    fixture.modify((paths) => { paths.at(-1)!.entries.push({ sid, mask: 2, flags: 0, type: 0 }); });
    // A directory leaf inside the private root also retains the private rule.
    await expect(assertCodexLocations([
      { path: fixture.candidate, kind: "private-directory" },
      { path: `${fixture.candidate}\\child`, kind: "directory" },
    ])).rejects.toThrow("accessible by another account");
  });

  it.each([PACKAGE_SID, PACKAGE_CAPABILITY_SID])("does not exempt package SID %s from ownership checks", async (sid) => {
    const fixture = desktopPackageFixture();
    fixture.modify((paths) => { paths[1]!.owner = sid; });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("untrusted owner");
  });

  it.each([
    undefined, null, [], {}, { status: "resolved", packageSid: PACKAGE_SID },
    { status: "resolved", packageSid: "S-1-15-2-1", capabilitySid: "S-1-15-3-1" },
    { status: "resolved", packageSid: 123, capabilitySid: PACKAGE_CAPABILITY_SID },
    { status: "resolved", packageSid: "S-1-15-2-10-20-30-40-50-60", capabilitySid: PACKAGE_CAPABILITY_SID },
    { status: "resolved", packageSid: PACKAGE_SID, capabilitySid: "S-1-15-3-10-20-30-40-50-60-71" },
    { status: "resolved", packageSid: PACKAGE_SID, capabilitySid: null },
    { status: "resolved", packageSid: PACKAGE_SID, capabilitySid: PACKAGE_CAPABILITY_SID, reason: "resolution-failed" },
    { status: "unavailable" }, { status: "unavailable", reason: 123 }, { status: "unavailable", reason: "unknown" },
    { status: "unavailable", reason: "resolution-failed", packageSid: PACKAGE_SID },
    { status: "other", packageSid: PACKAGE_SID, capabilitySid: PACKAGE_CAPABILITY_SID },
    { status: "skipped" },
  ])("refuses malformed package principal output %#", async (output) => {
    const fixture = windowsFixture();
    fixture.probe.desktopPackage = output;
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("access rules are invalid");
  });

  it.each(["resolved", "unavailable"])("caches a %s package outcome across admissions and probe batches", async (status) => {
    const fixture = desktopPackageFixture();
    if (status === "unavailable") fixture.probe.desktopPackage = { status, reason: "package-not-installed" };
    let batch = 0;
    fixture.modify((paths) => {
      if (batch++ > 0) fixture.probe.desktopPackage = { status: "skipped" };
      if (status === "resolved") paths[0]!.entries.push({ sid: PACKAGE_SID, mask: 2, flags: 0, type: 0 });
    });
    await expect(assertCodexLocations(Array.from({ length: 130 }, (_, index) => ({
      path: String.raw`C:\Tools\file-${index}.exe`, kind: "executable" as const,
    })))).resolves.toBeUndefined();
    await expect(assertCodexExecutableLocation(fixture.candidate)).resolves.toBeUndefined();
    const flags = vi.mocked(execFile).mock.calls.map((call) =>
      (call[2] as { env: NodeJS.ProcessEnv }).env.AVE_ACL_DESKTOP_PACKAGE);
    expect(flags).toEqual([undefined, "skip", "skip"]);
    if (status === "unavailable") {
      fixture.modify((paths) => { paths[1]!.entries.push({ sid: PACKAGE_SID, mask: 2, flags: 0, type: 0 }); });
      await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
    }
  });

  it("rejects malformed skipped output even when the lookup was skipped", async () => {
    const fixture = windowsFixture();
    await assertCodexExecutableLocation(fixture.candidate);
    fixture.probe.desktopPackage = { status: "skipped", packageSid: PACKAGE_SID };
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("access rules are invalid");
  });

  it.each(["same resolved", "same unavailable", "different SID", "different status", "different reason"])(
    "checks concurrent first lookup agreement: %s", async (outcome) => {
      const fixture = desktopPackageFixture();
      if (outcome.endsWith("unavailable") || outcome === "different reason") {
        fixture.probe.desktopPackage = { status: "unavailable", reason: "mapping-not-found" };
      }
      const respond = vi.mocked(execFile).getMockImplementation()!;
      const pending: (() => void)[] = [];
      vi.mocked(execFile).mockImplementation((...args) => {
        const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
        return respond(args[0], args[1], args[2], (error, stdout, stderr) => {
          pending.push(() => callback(error, String(stdout), String(stderr)));
        });
      });
      const first = assertCodexExecutableLocation(fixture.candidate);
      await vi.waitFor(() => { expect(pending).toHaveLength(1); });
      if (outcome === "different SID") fixture.probe.desktopPackage = {
        status: "resolved", packageSid: "S-1-15-2-11-21-31-41-51-61-71", capabilitySid: "S-1-15-3-11-21-31-41-51-61-71",
      };
      if (outcome === "different status") fixture.probe.desktopPackage = { status: "unavailable", reason: "mapping-not-found" };
      if (outcome === "different reason") fixture.probe.desktopPackage = { status: "unavailable", reason: "package-not-installed" };
      const second = assertCodexExecutableLocation(fixture.candidate);
      const results = Promise.allSettled([first, second]);
      await vi.waitFor(() => { expect(pending).toHaveLength(2); });
      expect(vi.mocked(execFile).mock.calls.map((call) =>
        (call[2] as { env: NodeJS.ProcessEnv }).env.AVE_ACL_DESKTOP_PACKAGE)).toEqual([undefined, undefined]);
      for (const complete of pending) complete();
      const [firstResult, secondResult] = await results;
      expect(firstResult.status).toBe("fulfilled");
      if (outcome.startsWith("same")) expect(secondResult.status).toBe("fulfilled");
      else {
        expect(secondResult.status).toBe("rejected");
        if (secondResult.status === "rejected") expect(secondResult.reason.message).toContain("access rules are invalid");
      }
    },
  );

  it("does not cache malformed lookup results", async () => {
    const fixture = windowsFixture();
    fixture.probe.desktopPackage = { status: "skipped" };
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("access rules are invalid");
    fixture.probe.desktopPackage = { status: "unavailable", reason: "mapping-not-found" };
    await expect(assertCodexExecutableLocation(fixture.candidate)).resolves.toBeUndefined();
    for (const call of vi.mocked(execFile).mock.calls) {
      expect((call[2] as { env: NodeJS.ProcessEnv }).env.AVE_ACL_DESKTOP_PACKAGE).toBeUndefined();
    }
  });

  it("warns once per process about an unavailable package exemption across repeated probes", async () => {
    const fixture = windowsFixture();
    fixture.probe.desktopPackage = { status: "unavailable", reason: "publisher-mismatch" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await assertCodexExecutableLocation(fixture.candidate);
    fixture.probe.desktopPackage = { status: "skipped" };
    await assertCodexExecutableLocation(fixture.candidate);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[codex-executable-location] Desktop package exemption unavailable", { reason: "publisher-mismatch" });
  });

  it.runIf(HOST === "win32").each([
    { label: "skipped lookup", skip: true, mapping: "failure", installation: "failure", expected: "skipped" },
    { label: "case-insensitive identity", expected: "resolved" },
    { label: "missing mapping", mapping: "missing", expected: "mapping-not-found" },
    { label: "ambiguous mapping", mapping: "ambiguous", expected: "ambiguous-mapping" },
    { label: "mapping query failure", mapping: "failure", expected: "resolution-failed" },
    { label: "moniker query failure", mapping: "moniker-failure", expected: "resolution-failed" },
    { label: "lookalike moniker", moniker: "claude_otherpublisher", expected: "mapping-not-found" },
    { label: "missing installation", installation: "missing", expected: "package-not-installed" },
    { label: "package query failure", installation: "failure", expected: "resolution-failed" },
    { label: "lookalike family", family: "Claude_otherpublisher", expected: "package-not-installed" },
    { label: "publisher mismatch", publisher: "otherpublisher", expected: "publisher-mismatch" },
    { label: "short well-known SID", sid: "S-1-15-2-1", expected: "malformed-sid" },
    { label: "short package SID", sid: "S-1-15-2-10-20-30-40-50-60", expected: "malformed-sid" },
    { label: "extra sub-authority", sid: "S-1-15-2-10-20-30-40-50-60-70-80", expected: "malformed-sid" },
    { label: "capability mapping", sid: PACKAGE_CAPABILITY_SID, expected: "malformed-sid" },
  ])("resolves package principals read-only using command mocks: $label", async (testCase) => {
    const fixture = windowsFixture();
    await assertCodexExecutableLocation(fixture.candidate);
    const [command, args] = vi.mocked(execFile).mock.calls[0]!;
    const script = Buffer.from(args![4]!, "base64").toString("utf16le");
    const resolver = script.slice(script.indexOf("$desktopPackageIdentity ="), script.lastIndexOf("[PSCustomObject]@{ currentSid ="));
    const mapping = { PSPath: "fixture-mapping", PSChildName: testCase.sid ?? PACKAGE_SID,
      Moniker: testCase.moniker ?? "cLaUdE_pzs8sxrjxfjjc" };
    const input = {
      mappings: testCase.mapping === "missing" ? [] : testCase.mapping === "ambiguous" ? [mapping, mapping] : [mapping],
      packages: testCase.installation === "missing" ? [] : [{ PackageFamilyName: testCase.family ?? "cLaUdE_pzs8sxrjxfjjc",
        PublisherId: testCase.publisher ?? "pzs8sxrjxfjjc" }],
      failMapping: testCase.mapping === "failure", failMoniker: testCase.mapping === "moniker-failure",
      failPackage: testCase.installation === "failure",
    };
    // Execute only the resolver from the encoded production probe. All registry
    // and package commands are functions over fixture data; no host query runs.
    const mockedScript = [
      "$ErrorActionPreference = 'Stop'",
      "$fixture = ConvertFrom-Json -InputObject $env:AVE_DESKTOP_PACKAGE_FIXTURE",
      "function Get-ChildItem { param($LiteralPath, $ErrorAction); if ($fixture.failMapping) { throw 'Fixture failure' }; $fixture.mappings }",
      "function Get-ItemProperty { param($LiteralPath, $Name, $ErrorAction); if ($fixture.failMoniker) { throw 'Fixture failure' }; $fixture.mappings | Where-Object { $_.PSPath -eq $LiteralPath } | Select-Object -First 1 }",
      "function Get-AppxPackage { param($Name, $ErrorAction); if ($Name -cne 'Claude' -or $fixture.failPackage) { throw 'Fixture failure' }; $fixture.packages }",
      resolver,
      "[PSCustomObject]$desktopPackage | ConvertTo-Json -Compress",
    ].join("\n");
    const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => {
      childProcess.execFile(command, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(mockedScript, "utf16le").toString("base64")], {
        windowsHide: true, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs,
        env: { ...process.env, AVE_DESKTOP_PACKAGE_FIXTURE: JSON.stringify(input),
          AVE_ACL_DESKTOP_PACKAGE: testCase.skip ? "skip" : undefined },
      }, (error, output) => error ? reject(error) : resolve(output));
    });
    fixture.probe.desktopPackage = JSON.parse(stdout);
    _resetDesktopPackageCacheForTest();
    if (testCase.skip) {
      expect(fixture.probe.desktopPackage).toEqual({ status: "skipped" });
      return;
    }
    expect(fixture.probe.desktopPackage).toEqual(testCase.expected === "resolved"
      ? { status: "resolved", packageSid: PACKAGE_SID, capabilitySid: PACKAGE_CAPABILITY_SID }
      : { status: "unavailable", reason: testCase.expected });
    fixture.modify((paths) => { paths[1]!.entries.push({ sid: PACKAGE_CAPABILITY_SID, mask: 0x1f01ff, flags: 0, type: 0 }); });
    const admission = assertCodexExecutableLocation(fixture.candidate);
    if (testCase.expected === "resolved") await expect(admission).resolves.toBeUndefined();
    else await expect(admission).rejects.toThrow("writable by another account");
  });

  it("never adds a probe for optional cap trust when the admission batch is full", async () => {
    const fixture = capFixture();
    const read = vi.fn(async () => JSON.stringify({ workspace: FOREIGN_SID }));
    const requests = Array.from({ length: 126 }, (_, index) => ({ path: String.raw`C:\Tools\file-${index}.exe`, kind: "executable" as const, routeKind: "native" as const }));
    await expect(assertCodexLocations(requests, { capSidPath: fixture.capPath, readCapSidFile: read })).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it.runIf(HOST === "win32").each(["valid", "malformed", "oversized"])("reads a %s cap file from a real temporary fixture with the bounded reader", async (kind) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-cap-sid-reader-")));
    roots.push(root);
    const capPath = join(root, "cap_sid");
    writeFileSync(capPath, kind === "valid" ? JSON.stringify({ workspace: FOREIGN_SID }) : kind === "malformed" ? "{" : " ".repeat(1024 * 1024 + 1));
    const lstat = fs.lstat.bind(fs);
    const fixture = windowsFixture();
    const fixtureLstat = vi.mocked(fs.lstat).getMockImplementation()!;
    vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => String(args[0]) === capPath
      ? lstat(...args) : fixtureLstat(...args)) as typeof fs.lstat);
    fixture.modify((paths) => { paths.find((path) => path.path === fixture.candidate)!.entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 }); });
    const admission = assertCodexExecutableLocation(fixture.candidate, "native", { capSidPath: capPath });
    if (kind === "valid") await expect(admission).resolves.toBeUndefined();
    else await expect(admission).rejects.toThrow("writable by another account");
  });

  it.each(["group", "member"] as const)("trusts a managed sandbox %s for mutation and ownership", async (principal) => {
    const fixture = windowsFixture();
    const groupSid = "S-1-5-21-10-20-30-100";
    const memberSid = "S-1-5-21-10-20-30-101";
    Object.assign(fixture.sandboxGroup, { name: "CodexSandboxUsers", description: "Codex sandbox internal group (managed)", sid: groupSid, members: [memberSid] });
    fixture.modify((paths) => { paths[1]!.owner = principal === "group" ? groupSid : memberSid;
      paths[1]!.entries.push({ sid: paths[1]!.owner, mask: 0x1f01ff, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).resolves.toBeUndefined();
  });

  it.each(["different description", "different name", "invalid SID"])("does not trust a sandbox group with %s", async (mismatch) => {
    const fixture = windowsFixture();
    Object.assign(fixture.sandboxGroup, { name: mismatch === "different name" ? "OtherGroup" : "CodexSandboxUsers",
      description: mismatch === "different description" ? "Unmanaged group" : "Codex sandbox internal group (managed)",
      sid: FOREIGN_SID, members: mismatch === "invalid SID" ? ["invalid"] : [] });
    fixture.modify((paths) => { paths[1]!.entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
  });

  it.each(["S-1-5-21-10-20-30-999", "S-1-15-3-10-20-30"])("keeps unknown SID %s foreign", async (sid) => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths[1]!.entries.push({ sid, mask: 2, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
  });

  it.each(["workspace", "readonly", "workspace_by_cwd", "writable_root_by_path"])("trusts an admitted cap SID from %s without adding a probe", async (key) => {
    const fixture = capFixture();
    fixture.modify((paths) => { const leaf = paths.find((path) => path.path === fixture.candidate)!;
      leaf.owner = FOREIGN_SID; leaf.entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 }); });
    const contents = JSON.stringify({ [key]: key.endsWith("_cwd") || key.endsWith("_path") ? { "C:\\workspace": FOREIGN_SID } : FOREIGN_SID });
    await expect(assertCodexExecutableLocation(fixture.candidate, "native", { capSidPath: fixture.capPath,
      readCapSidFile: async () => contents })).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it.each(["bad JSON", "wrong SID", "oversized", "unreadable"])("ignores a cap file with %s", async (failure) => {
    const fixture = capFixture();
    fixture.modify((paths) => { paths[1]!.entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate, "native", { capSidPath: fixture.capPath,
      readCapSidFile: async () => failure === "bad JSON" ? "{" : failure === "oversized" ? " ".repeat(1024 * 1024 + 1)
        : failure === "unreadable" ? null : JSON.stringify({ workspace: "S-1-15-3-10-20-30" }),
    })).rejects.toThrow("writable by another account");
  });

  it.each(["file", "parent"])("ignores cap SIDs when the cap %s is foreign-writable without reading it", async (component) => {
    const fixture = capFixture();
    const read = vi.fn(async () => JSON.stringify({ workspace: FOREIGN_SID }));
    fixture.modify((paths) => {
      paths.find((path) => path.path === (component === "file" ? fixture.capPath : String.raw`C:\Fixture`))!
        .entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 });
      paths.find((path) => path.path === fixture.candidate)!.entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 });
    });
    await expect(assertCodexExecutableLocation(fixture.candidate, "native", { capSidPath: fixture.capPath, readCapSidFile: read }))
      .rejects.toThrow("writable by another account");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["group", "member", "cap"])("keeps private directories private from a trusted sandbox %s", async (principal) => {
    const fixture = capFixture(true);
    Object.assign(fixture.sandboxGroup, { name: "CodexSandboxUsers", description: "Codex sandbox internal group (managed)",
      sid: principal === "group" ? FOREIGN_SID : "S-1-5-21-10-20-30-100", members: principal === "member" ? [FOREIGN_SID] : [] });
    fixture.modify((paths) => { paths.find((path) => path.path === fixture.candidate)!.entries.push({ sid: FOREIGN_SID, mask: 1, flags: 0, type: 0 }); });
    await expect(assertCodexPrivateRuntimeDirectory(fixture.candidate, "native", { capSidPath: fixture.capPath,
      readCapSidFile: async () => JSON.stringify({ workspace: FOREIGN_SID }) })).rejects.toThrow("accessible by another account");
  });

  it("passes decoded paths separately to the access-query command", async () => {
    const fixture = windowsFixture(String.raw`C:\Tools\odd'; \uD55C\uAE00 $(Write-Output injected).exe`);
    await assertCodexExecutableLocation(fixture.candidate);
    const args = vi.mocked(execFile).mock.calls[0]![1]!;
    const script = Buffer.from(args[4]!, "base64").toString("utf16le");
    expect(script).toContain("ConvertFrom-Json");
    expect(script).toContain("[ExecutablePathSecurity]::Read($target)");
    expect(script).not.toContain(fixture.candidate);
  });

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
    expect(script).toContain("HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings");
    expect(script).toContain("Get-AppxPackage -Name 'Claude' -ErrorAction Stop");
    expect(script).not.toMatch(/Set-Acl|Set-ItemProperty|New-LocalUser|Start-Process|-AllUsers/);
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

  it.each(["native", "guarded-script"] as const)("admits ancestor subdirectory creation only for %s", async (kind) => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { for (const path of paths.slice(0, -1)) path.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate, kind)).resolves.toBeUndefined();
  });

  it("rejects foreign subdirectory creation on a script route's ancestors", async () => {
    const fixture = windowsFixture();
    const script = String.raw`C:\Tools\cli.js`;
    vi.mocked(fs.lstat).mockImplementation(async (path) => pathStats(String(path) === script ? "file" : "directory"));
    fixture.modify((paths) => { paths[0]!.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 }); });
    await expect(assertCodexLocations([{ path: script, kind: "executable", routeKind: "script" }]))
      .rejects.toThrow("writable by another account");
  });

  it.each(["native", "guarded-script", "script"] as const)("rejects leaf subdirectory creation for %s", async (kind) => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths[2]!.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate, kind)).rejects.toThrow("writable by another account");
  });

  it("keeps foreign subdirectory creation rejected on a private directory", async () => {
    const fixture = windowsFixture(String.raw`C:\Tools\runtime`, true);
    fixture.modify((paths) => { paths[2]!.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 }); });
    await expect(assertCodexPrivateRuntimeDirectory(fixture.candidate, "native")).rejects.toThrow("accessible by another account");
  });

  it("allows ancestor subdirectory creation for a private native runtime", async () => {
    const fixture = windowsFixture(String.raw`C:\Tools\runtime`, true);
    fixture.modify((paths) => { paths[0]!.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 }); });
    await expect(assertCodexPrivateRuntimeDirectory(fixture.candidate, "native")).resolves.toBeUndefined();
    await expect(assertCodexPrivateRuntimeDirectory(fixture.candidate)).rejects.toThrow("writable by another account");
  });

  it("allows ancestor subdirectory creation for a private guarded package", async () => {
    const fixture = windowsFixture(String.raw`C:\Tools\runtime`, true);
    fixture.modify((paths) => { paths[0]!.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 }); });
    await expect(assertCodexPrivateRuntimeDirectory(fixture.candidate, "guarded-script")).resolves.toBeUndefined();
  });

  it("keeps a private subtree strict even when a child is also admitted as native", async () => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths.find((path) => path.path === fixture.candidate)!.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 }); });
    await expect(assertCodexLocations([
      { path: String.raw`C:\Tools`, kind: "private-directory", routeKind: "native" },
      { path: fixture.candidate, kind: "executable", routeKind: "native" },
    ])).rejects.toThrow("accessible by another account");
  });

  it.each([0x2, 0x4 | 0x40, 0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000, 0x40000000, 0x10000000])(
    "rejects foreign ancestor mutation mask %i on a native route", async (mask) => {
      const fixture = windowsFixture();
      fixture.modify((paths) => { paths[0]!.entries.push({ sid: FOREIGN_SID, mask, flags: 0, type: 0 }); });
      await expect(assertCodexExecutableLocation(fixture.candidate, "native")).rejects.toThrow("writable by another account");
    },
  );

  it("reports the rejected path, SID and mask in one warning", async () => {
    const fixture = desktopPackageFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.modify((paths) => { paths[0]!.entries.push({ sid: FOREIGN_SID, mask: 0x44, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate, "native")).rejects.toThrow(
      `"C:\\\\" (SID ${FOREIGN_SID}, mask 0x44)`,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("keeps the strictest shared ancestor rule regardless of request order %s", async (reverse) => {
    const fixture = windowsFixture();
    fixture.modify((paths) => { paths[0]!.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 }); });
    const requests = [
      { path: fixture.candidate, kind: "executable", routeKind: "native" },
      { path: String.raw`C:\Tools\other.exe`, kind: "executable", routeKind: "script" },
    ] as const;
    await expect(assertCodexLocations(reverse ? [...requests].reverse() : requests)).rejects.toThrow("writable by another account");
  });

  it.each([false, true])("keeps a requested directory leaf strict regardless of request order %s", async (reverse) => {
    const fixture = windowsFixture();
    fixture.modify((paths) => {
      paths.find((path) => path.path === String.raw`C:\Tools`)!.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 });
    });
    const requests = [
      { path: fixture.candidate, kind: "executable", routeKind: "native" },
      { path: String.raw`C:\Tools`, kind: "directory", routeKind: "native" },
    ] as const;
    await expect(assertCodexLocations(reverse ? [...requests].reverse() : requests)).rejects.toThrow("writable by another account");
  });

  it("checks the native link route and its resolved leaf with their own rules", async () => {
    const fixture = windowsFixture();
    fixture.links.set(fixture.candidate, String.raw`C:\Native\runtime.exe`);
    fixture.modify((paths) => {
      for (const path of paths.filter((path) => path.path === String.raw`C:\Tools` || path.path === String.raw`C:\Native`)) {
        path.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 });
      }
    });
    await expect(assertCodexExecutableLocation(fixture.candidate, "native")).resolves.toBeUndefined();
    fixture.modify((paths) => {
      paths.find((path) => path.path === String.raw`C:\Native\runtime.exe`)!.entries.push({ sid: FOREIGN_SID, mask: 0x4, flags: 0, type: 0 });
    });
    await expect(assertCodexExecutableLocation(fixture.candidate, "native")).rejects.toThrow("writable by another account");
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

  it("reads a batch's deduplicated routes through one access query", async () => {
    windowsFixture();
    await assertCodexLocations([
      { path: String.raw`C:\Tools\one.exe`, kind: "executable" },
      { path: String.raw`C:\Tools\nested\two.exe`, kind: "executable" },
      { path: String.raw`C:\Tools\nested`, kind: "directory" },
    ]);
    expect(execFile).toHaveBeenCalledTimes(1);
    const options = vi.mocked(execFile).mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(JSON.parse(options.env.AVE_EXECUTABLE_ACL_PATHS!)).toEqual([
      "C:\\", String.raw`C:\Tools`, String.raw`C:\Tools\one.exe`, String.raw`C:\Tools\nested`, String.raw`C:\Tools\nested\two.exe`,
    ]);
  });

  it("refuses a batch when any one of its paths is writable by another account", async () => {
    const fixture = windowsFixture();
    fixture.modify((paths) => {
      paths.find((entry) => entry.path === String.raw`C:\Tools\three.exe`)!.entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 });
    });
    await expect(assertCodexLocations(["one", "two", "three", "four"].map((name) => ({
      path: `C:\\Tools\\${name}.exe`, kind: "executable" as const,
    })))).rejects.toThrow("writable by another account");
  });

  it("splits a large batch into bounded queries that each cover their own paths", async () => {
    const fixture = windowsFixture();
    const candidates = Array.from({ length: 300 }, (_, index) => String.raw`C:\Tools\file-${index}.exe`);
    const queried: string[] = [];
    fixture.modify((paths) => { queried.push(...paths.map((entry) => entry.path)); });
    await assertCodexLocations(candidates.map((path) => ({ path, kind: "executable" as const })));
    expect(vi.mocked(execFile).mock.calls.length).toBe(3);
    expect(queried).toEqual(["C:\\", String.raw`C:\Tools`, ...candidates]);
  });

  it("applies the private rule to a runtime leaf that is also another path's ancestor", async () => {
    const fixture = windowsFixture();
    fixture.modify((paths) => {
      paths.find((entry) => entry.path === String.raw`C:\Tools\runtime`)!.entries.push({ sid: FOREIGN_SID, mask: 1, flags: 8, type: 0 });
    });
    const executable = { path: String.raw`C:\Tools\runtime\codex.exe`, kind: "executable" as const };
    await expect(assertCodexLocations([executable])).resolves.toBeUndefined();
    await expect(assertCodexLocations([executable, { path: String.raw`C:\Tools\runtime`, kind: "private-directory" }]))
      .rejects.toThrow("accessible by another account");
  });
});
