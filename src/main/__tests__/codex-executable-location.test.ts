import { execFile, spawn, type ChildProcess } from "node:child_process";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";
import { EventEmitter } from "node:events";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, promises as fs, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { decodeWindowsAclScript, withWindowsAclScript } from "../../__tests__/support/windows-acl-launch.js";
import { WINDOWS_COMMAND_LINE_LIMIT, WINDOWS_COMMAND_LINE_MARGIN, windowsCommandLineLength } from "../../shared/windows-command-line.js";
import {
  assertCodexExecutableLocation,
  assertCodexLocations,
  assertCodexPrivateRuntimeDirectory,
  CodexExecutableLocationError,
  _resetDesktopPackageCacheForTest,
  _resetWindowsAclHostForTest,
} from "../codex-executable-location.js";
import { getManagedChildProcessCount } from "../managed-child-processes.js";
import {
  WINDOWS_ACL_HOST_IDLE_MS,
  WindowsAclHostError,
  _setWindowsAclTransportForTest,
  type WindowsAclHostLaunch,
  type WindowsAclLimits,
  type WindowsAclRequest,
} from "../windows-acl-host.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const HOST = process.platform;
const roots: string[] = [];
// Windows fixtures answer each ACL host request here, at the request level.
const aclRequest = vi.fn(async (_request: WindowsAclRequest, _launch: WindowsAclHostLaunch, _limits: WindowsAclLimits): Promise<string> => {
  throw new Error("No access-rule fixture");
});
const aclDiscard = vi.fn();

beforeEach(() => {
  _resetDesktopPackageCacheForTest();
  _resetWindowsAclHostForTest();
  _setWindowsAclTransportForTest(undefined);
});

afterEach(() => {
  _resetWindowsAclHostForTest();
  _setWindowsAclTransportForTest(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The host script up to its native type: preferences, autoloading off and the module imports. Scripts that run a slice of the host run it under the same
// module rules, so they find the same cmdlets without a module-path search.
function hostModulePreamble(script: string): string {
  return script.slice(0, script.indexOf("Add-Type -TypeDefinition @'"));
}

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
    // Only the fixture's external ancestors are normalized. Entries created by the fixture retain the real permissions that each test exercises.
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
const MACHINE_DOMAIN_SID = "S-1-5-21-10-20-30";
const CAP_SID = "S-1-5-21-400-500-600-700";
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
  reply: (request: WindowsAclRequest) => string;
} {
  vi.stubGlobal("process", Object.create(process, {
    platform: { value: "win32" },
    env: { value: { NODE_ENV: "test", TEMP: process.env.TEMP, TMP: process.env.TMP, SystemRoot: String.raw`C:\Windows` } },
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
  const reply = (request: WindowsAclRequest): string => {
    const paths = request.paths.map((path): PathSecurity => ({
      path,
      owner: path === "C:\\" ? "S-1-5-18" : CURRENT_SID,
      daclPresent: true,
      entries: [{ sid: CURRENT_SID, mask: 0x1f01ff, flags: 0, type: 0 }],
    }));
    modify(paths);
    const capSidAccounts = request.capSids.map((sid) => ({ sid, resolvesToAccount: false }));
    return JSON.stringify({ id: request.id, result: { currentSid: CURRENT_SID, machineDomainSid: MACHINE_DOMAIN_SID,
      capSidAccounts, paths, sandboxGroup, ...probe } });
  };
  aclRequest.mockImplementation(async (request) => reply(request));
  _setWindowsAclTransportForTest({ request: aclRequest, discard: aclDiscard });
  return { candidate, modify: (callback) => { modify = callback; }, links, sandboxGroup, probe, reply };
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
    expect(aclRequest).toHaveBeenCalledTimes(1);
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

  it.each(["mapping-not-found", "ambiguous-mapping", "package-not-installed", "publisher-mismatch", "malformed-sid", "sid-mismatch", "resolution-failed"])(
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
    const flags = aclRequest.mock.calls.map(([request]) => request.skipPackage);
    expect(flags).toEqual([false, true, true]);
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
      const pending: (() => void)[] = [];
      aclRequest.mockImplementation((request) => {
        // The reply is read when the request reaches the host; it completes when the test says so.
        const line = fixture.reply(request);
        return new Promise<string>((resolve) => { pending.push(() => resolve(line)); });
      });
      const first = assertCodexExecutableLocation(fixture.candidate);
      await vi.waitFor(() => { expect(pending).toHaveLength(1); });
      if (outcome === "different SID") fixture.probe.desktopPackage = {
        status: "resolved", packageSid: "S-1-15-2-11-21-31-41-51-61-71", capabilitySid: "S-1-15-3-11-21-31-41-51-61-71",
      };
      if (outcome === "different status") fixture.probe.desktopPackage = { status: "unavailable", reason: "mapping-not-found" };
      if (outcome === "different reason") fixture.probe.desktopPackage = { status: "unavailable", reason: "package-not-installed" };
      // Both lookups start before either completes. Requests are serialized, so the second reaches the host only after the first reply is read.
      const second = assertCodexExecutableLocation(fixture.candidate);
      const results = Promise.allSettled([first, second]);
      // The second admission inspects mocked paths in microtasks only, so it has built and queued its request before this macrotask turn.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      pending[0]!();
      await vi.waitFor(() => { expect(pending).toHaveLength(2); });
      expect(aclRequest.mock.calls.map(([request]) => request.skipPackage)).toEqual([false, false]);
      pending[1]!();
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
    for (const [request] of aclRequest.mock.calls) {
      expect(request.skipPackage).toBe(false);
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
    { label: "mapping SID differs from derivation", sid: "S-1-15-2-11-21-31-41-51-61-71", expected: "sid-mismatch" },
    { label: "short well-known SID", sid: "S-1-15-2-1", expected: "malformed-sid" },
    { label: "short package SID", sid: "S-1-15-2-10-20-30-40-50-60", expected: "malformed-sid" },
    { label: "extra sub-authority", sid: "S-1-15-2-10-20-30-40-50-60-70-80", expected: "malformed-sid" },
    { label: "capability mapping", sid: PACKAGE_CAPABILITY_SID, expected: "malformed-sid" },
    { label: "package module unavailable", appxModule: "absent", expected: "resolution-failed" },
  ])("resolves package principals read-only using command mocks: $label", async (testCase) => {
    const fixture = windowsFixture();
    await assertCodexExecutableLocation(fixture.candidate);
    const [, launch] = aclRequest.mock.calls[0]!;
    const { command, args } = launch;
    const script = decodeWindowsAclScript(args);
    const packageSetup = script.slice(script.indexOf("$appxReady ="), script.indexOf("[Console]::Out.WriteLine('READY')"));
    const fullResolver = packageSetup + script.slice(script.indexOf("$desktopPackageIdentity ="), script.lastIndexOf("$result = [PSCustomObject]@{ currentSid ="));
    // An absent Appx module must reach the same deterministic outcome as a failed query.
    const resolver = testCase.appxModule === "absent"
      ? fullResolver.replace(String.raw`Appx\Appx.psd1`, String.raw`Appx\Absent.psd1`) : fullResolver;
    expect(resolver.includes(String.raw`Appx\Absent.psd1`)).toBe(testCase.appxModule === "absent");
    const mapping = { PSPath: "fixture-mapping", PSChildName: testCase.sid ?? PACKAGE_SID,
      Moniker: testCase.moniker ?? "cLaUdE_pzs8sxrjxfjjc" };
    const input = {
      mappings: testCase.mapping === "missing" ? [] : testCase.mapping === "ambiguous" ? [mapping, mapping] : [mapping],
      packages: testCase.installation === "missing" ? [] : [{ PackageFamilyName: testCase.family ?? "cLaUdE_pzs8sxrjxfjjc",
        PublisherId: testCase.publisher ?? "pzs8sxrjxfjjc" }],
      failMapping: testCase.mapping === "failure", failMoniker: testCase.mapping === "moniker-failure",
      failPackage: testCase.installation === "failure",
    };
    // Execute only the resolver from the encoded production probe. All registry and package commands are functions over fixture data; no host query runs.
    const mockedScript = [
      hostModulePreamble(script),
      // The host's Appx module is never loaded: a cold import can take most of the timeout. Only the production path resolves; the absent case still fails.
      "function Import-Module { param($Name, $ErrorAction); if ($Name -notlike '*\\Modules\\Appx\\Appx.psd1') { throw 'Fixture module unavailable' } }",
      "$fixture = ConvertFrom-Json -InputObject $env:AVE_DESKTOP_PACKAGE_FIXTURE",
      // The decoded request line, as the host reads it.
      "$request = ConvertFrom-Json -InputObject $env:AVE_ACL_REQUEST_FIXTURE",
      `Add-Type 'public static class ExecutablePathSecurity { public static string DerivePackageSid(string name) { return "${PACKAGE_SID}"; } }'`,
      "function Get-ChildItem { param($LiteralPath, $ErrorAction); if ($fixture.failMapping) { throw 'Fixture failure' }; $fixture.mappings }",
      "function Get-ItemProperty { param($LiteralPath, $Name, $ErrorAction); if ($fixture.failMoniker) { throw 'Fixture failure' }; $fixture.mappings | Where-Object { $_.PSPath -eq $LiteralPath } | Select-Object -First 1 }",
      "function Get-AppxPackage { param($Name, $ErrorAction); if ($Name -cne 'Claude' -or $fixture.failPackage) { throw 'Fixture failure' }; $fixture.packages }",
      resolver,
      "[PSCustomObject]$desktopPackage | ConvertTo-Json -Compress",
    ].join("\n");
    const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => {
      childProcess.execFile(command, withWindowsAclScript(launch, mockedScript).args, {
        windowsHide: true, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs,
        env: windowsPowerShellEnv({ ...process.env, AVE_DESKTOP_PACKAGE_FIXTURE: JSON.stringify(input),
          AVE_ACL_REQUEST_FIXTURE: JSON.stringify({ skipPackage: testCase.skip === true }) }),
      }, (error, output) => error ? reject(error) : resolve(output));
    });
    fixture.probe.desktopPackage = JSON.parse(stdout);
    _resetDesktopPackageCacheForTest();
    _resetWindowsAclHostForTest();
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
    expect(aclRequest).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it.runIf(HOST === "win32").each(["valid", "malformed", "oversized"])("reads a %s cap file from a real temporary fixture with the bounded reader", async (kind) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-cap-sid-reader-")));
    roots.push(root);
    const capPath = join(root, "cap_sid");
    writeFileSync(capPath, kind === "valid" ? JSON.stringify({ workspace: CAP_SID }) : kind === "malformed" ? "{" : " ".repeat(1024 * 1024 + 1));
    const lstat = fs.lstat.bind(fs);
    const fixture = windowsFixture();
    const fixtureLstat = vi.mocked(fs.lstat).getMockImplementation()!;
    vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => String(args[0]) === capPath
      ? lstat(...args) : fixtureLstat(...args)) as typeof fs.lstat);
    fixture.modify((paths) => { paths.find((path) => path.path === fixture.candidate)!.entries.push({ sid: CAP_SID, mask: 2, flags: 0, type: 0 }); });
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

  it.each(["group", "member"])("refuses the whole managed group with a foreign-domain %s", async (part) => {
    const fixture = windowsFixture();
    const localSid = `${MACHINE_DOMAIN_SID}-101`;
    Object.assign(fixture.sandboxGroup, { name: "CodexSandboxUsers", description: "Codex sandbox internal group (managed)",
      sid: part === "group" ? FOREIGN_SID : `${MACHINE_DOMAIN_SID}-100`,
      members: part === "group" ? [localSid] : [localSid, FOREIGN_SID] });
    for (const sid of [localSid, FOREIGN_SID]) {
      fixture.modify((paths) => { paths[1]!.entries.push({ sid, mask: 2, flags: 0, type: 0 }); });
      await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
    }
  });

  it.each(["S-1-1-0", "S-1-5-11", "S-1-5-32-545"])("refuses every sandbox principal when membership includes %s", async (broadSid) => {
    const fixture = windowsFixture();
    const groupSid = `${MACHINE_DOMAIN_SID}-100`;
    const memberSid = `${MACHINE_DOMAIN_SID}-101`;
    Object.assign(fixture.sandboxGroup, { name: "CodexSandboxUsers", description: "Codex sandbox internal group (managed)",
      sid: groupSid, members: [memberSid, broadSid] });
    for (const sid of [groupSid, memberSid, broadSid]) {
      fixture.modify((paths) => { paths[1]!.entries.push({ sid, mask: 2, flags: 0, type: 0 }); });
      await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
    }
  });

  it.each([null, "", "S-1-5-21-10-20", "S-1-5-32", "not-a-sid"])("refuses the whole managed group when the machine domain is %j", async (machineDomainSid) => {
    const groupSid = `${MACHINE_DOMAIN_SID}-100`;
    const memberSid = `${MACHINE_DOMAIN_SID}-101`;
    const admit = async (domain: unknown) => {
      const fixture = windowsFixture();
      Object.assign(fixture.sandboxGroup, { name: "CodexSandboxUsers", description: "Codex sandbox internal group (managed)",
        sid: groupSid, members: [memberSid] });
      fixture.probe.machineDomainSid = domain;
      fixture.modify((paths) => { paths[1]!.entries.push({ sid: memberSid, mask: 2, flags: 0, type: 0 }); });
      return assertCodexExecutableLocation(fixture.candidate);
    };
    // The same group is trusted under the real machine domain, so the refusal below is the domain's doing.
    await expect(admit(MACHINE_DOMAIN_SID)).resolves.toBeUndefined();
    await expect(admit(machineDomainSid)).rejects.toThrow("writable by another account");
  });

  it.each(["group", "member"])("refuses a %s SID whose domain only starts with the machine domain", async (part) => {
    const groupSid = `${MACHINE_DOMAIN_SID}-100`;
    const memberSid = `${MACHINE_DOMAIN_SID}-101`;
    const longer = `${MACHINE_DOMAIN_SID}-5-100`;
    const fixture = windowsFixture();
    Object.assign(fixture.sandboxGroup, { name: "CodexSandboxUsers", description: "Codex sandbox internal group (managed)",
      sid: part === "group" ? longer : groupSid, members: part === "group" ? [memberSid] : [memberSid, longer] });
    fixture.modify((paths) => { paths[1]!.entries.push({ sid: memberSid, mask: 2, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow("writable by another account");
  });

  it("pins the group lookup locally without a machine-name environment input", async () => {
    const fixture = windowsFixture();
    process.env.COMPUTERNAME = "untrusted-host";
    await assertCodexExecutableLocation(fixture.candidate);
    const [, launch] = aclRequest.mock.calls[0]!;
    const script = decodeWindowsAclScript(launch.args);
    expect(launch.options.env).not.toHaveProperty("COMPUTERNAME");
    expect(script).not.toContain("$env:COMPUTERNAME");
    expect(script).toContain("WinNT://./CodexSandboxUsers,group");
    expect(script).toContain("AccountDomainSid");
  });

  it.each(["current domain", "machine domain", "resolved account"])("refuses cap trust for a SID from %s", async (kind) => {
    const fixture = capFixture();
    const sid = kind === "current domain" ? FOREIGN_SID : kind === "machine domain" ? `${MACHINE_DOMAIN_SID}-102` : CAP_SID;
    fixture.probe.capSidAccounts = [{ sid, resolvesToAccount: kind === "resolved account" }];
    fixture.modify((paths) => { paths.find((path) => path.path === fixture.candidate)!.entries.push({ sid, mask: 2, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate, "native", { capSidPath: fixture.capPath,
      readCapSidFile: async () => JSON.stringify({ workspace: sid }) })).rejects.toThrow("writable by another account");
  });

  it.runIf(HOST === "win32").each(["empty", "single", "multiple"])("probes account translation for %s cap candidates", async (kind) => {
    const fixture = windowsFixture();
    await assertCodexExecutableLocation(fixture.candidate);
    const [, launch] = aclRequest.mock.calls[0]!;
    const { command, args } = launch;
    const script = decodeWindowsAclScript(args);
    const resolver = script.slice(script.indexOf("$capCandidates ="), script.indexOf("$desktopPackageIdentity ="));
    const query = [
      hostModulePreamble(script),
      "$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      `$candidates = @(${kind === "empty" ? "" : kind === "single" ? `'${CAP_SID}'` : `$currentSid, '${CAP_SID}'`})`,
      // The request line, decoded as the host decodes it.
      "$request = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject @{ capSids = $candidates } -Compress)",
      resolver,
      "ConvertTo-Json -InputObject @{ currentSid = $currentSid; accounts = @($capSidAccounts) } -Depth 4 -Compress",
    ].join("\n");
    const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => {
      childProcess.execFile(command, withWindowsAclScript(launch, query).args, {
        windowsHide: true, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs, env: windowsPowerShellEnv(),
      }, (error, output) => error ? reject(error) : resolve(output));
    });
    const result = JSON.parse(stdout) as { currentSid: string; accounts: { sid: string; resolvesToAccount: boolean }[] };
    expect(result.accounts).toEqual(kind === "empty" ? [] : kind === "single" ? [{ sid: CAP_SID, resolvesToAccount: false }]
      : [{ sid: result.currentSid, resolvesToAccount: true }, { sid: CAP_SID, resolvesToAccount: false }]);
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
      leaf.owner = CAP_SID; leaf.entries.push({ sid: CAP_SID, mask: 2, flags: 0, type: 0 }); });
    const contents = JSON.stringify({ [key]: key.endsWith("_cwd") || key.endsWith("_path") ? { "C:\\workspace": CAP_SID } : CAP_SID });
    await expect(assertCodexExecutableLocation(fixture.candidate, "native", { capSidPath: fixture.capPath,
      readCapSidFile: async () => contents })).resolves.toBeUndefined();
    expect(aclRequest).toHaveBeenCalledTimes(1);
    expect(aclRequest.mock.calls[0]![0].capSids).toEqual([CAP_SID]);
  });

  it.each(["bad JSON", "wrong SID", "oversized", "unreadable"])("ignores a cap file with %s", async (failure) => {
    const fixture = capFixture();
    fixture.modify((paths) => { paths[1]!.entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 }); });
    await expect(assertCodexExecutableLocation(fixture.candidate, "native", { capSidPath: fixture.capPath,
      readCapSidFile: async () => failure === "bad JSON" ? "{" : failure === "oversized" ? " ".repeat(1024 * 1024 + 1)
        : failure === "unreadable" ? null : JSON.stringify({ workspace: "S-1-15-3-10-20-30" }),
    })).rejects.toThrow("writable by another account");
  });

  it.each(["file", "parent"])("ignores parsed cap SIDs when the cap %s is foreign-writable", async (component) => {
    const fixture = capFixture();
    const read = vi.fn(async () => JSON.stringify({ workspace: CAP_SID }));
    fixture.modify((paths) => {
      paths.find((path) => path.path === (component === "file" ? fixture.capPath : String.raw`C:\Fixture`))!
        .entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 });
      paths.find((path) => path.path === fixture.candidate)!.entries.push({ sid: CAP_SID, mask: 2, flags: 0, type: 0 });
    });
    await expect(assertCodexExecutableLocation(fixture.candidate, "native", { capSidPath: fixture.capPath, readCapSidFile: read }))
      .rejects.toThrow("writable by another account");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(["group", "member", "cap"])("keeps private directories private from a trusted sandbox %s", async (principal) => {
    const fixture = capFixture(true);
    const sid = principal === "cap" ? CAP_SID : `${MACHINE_DOMAIN_SID}-101`;
    Object.assign(fixture.sandboxGroup, { name: "CodexSandboxUsers", description: "Codex sandbox internal group (managed)",
      sid: principal === "group" ? sid : `${MACHINE_DOMAIN_SID}-100`, members: principal === "member" ? [sid] : [] });
    fixture.modify((paths) => { paths.find((path) => path.path === fixture.candidate)!.entries.push({ sid, mask: 1, flags: 0, type: 0 }); });
    await expect(assertCodexPrivateRuntimeDirectory(fixture.candidate, "native", { capSidPath: fixture.capPath,
      readCapSidFile: async () => JSON.stringify({ workspace: CAP_SID }) })).rejects.toThrow("accessible by another account");
  });

  it("passes decoded paths separately to the access-query command", async () => {
    const fixture = windowsFixture(String.raw`C:\Tools\odd'; \uD55C\uAE00 $(Write-Output injected).exe`);
    await assertCodexExecutableLocation(fixture.candidate);
    const [request, { args }] = aclRequest.mock.calls[0]!;
    const script = decodeWindowsAclScript(args);
    expect(request.paths).toContain(fixture.candidate);
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

  it.each([
    String.raw`C:\Windows`,
    String.raw`C:\System Images` + String.raw`\Managed deployment`.repeat(9) + String.raw`\Windows`,
    // Also cover the system-root validator's accepted ceiling, beyond ordinary installation paths.
    "C:\\" + "Managed images\\".repeat(33) + "Windows".padStart(14, "W"),
  ])("reserves command-line headroom with system root %s", async (systemRoot) => {
    const fixture = windowsFixture();
    process.env.SystemRoot = systemRoot;
    await assertCodexExecutableLocation(fixture.candidate);
    const [, { command, args }] = aclRequest.mock.calls[0]!;
    expect(command).toBe(`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
    expect(systemRoot.length).toBeLessThanOrEqual(512);
    const length = windowsCommandLineLength(command, args);
    process.stdout.write(`ACL command-line evidence ${JSON.stringify({ systemRootLength: systemRoot.length, length, margin: WINDOWS_COMMAND_LINE_MARGIN })}\n`);
    expect(length + WINDOWS_COMMAND_LINE_MARGIN).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
    // The only variable command-line input is the system root. Request paths and principals stay in stdin.
    await assertCodexExecutableLocation("C:\\Tools\\" + "x".repeat(240) + ".exe", "native");
    expect(aclRequest.mock.calls[1]![1].args).toEqual(args);
  });

  it("uses one absolute system command with bounded execution and path data outside its code", async () => {
    const fixture = windowsFixture(String.raw`C:\Tools\odd'; $(Write-Output injected).exe`);
    await assertCodexExecutableLocation(fixture.candidate);
    expect(aclRequest).toHaveBeenCalledTimes(1);
    const [request, { command, args, options }, limits] = aclRequest.mock.calls[0]!;
    expect(command).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(args).toHaveLength(5);
    expect(windowsCommandLineLength(command, args) + WINDOWS_COMMAND_LINE_MARGIN).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
    const script = decodeWindowsAclScript(args);
    // `exit` in the private runspace would not end the host; failures stay terminating errors, which exit 1.
    expect(script).not.toMatch(/\bexit\b/i);
    expect(script).toContain("CreateFile(path, 0x00020000, 7, IntPtr.Zero, 3, 0x02200000");
    expect(script).toContain("GetSecurityInfo");
    expect(script).toContain("HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings");
    expect(script).toContain("Get-AppxPackage -Name 'Claude' -ErrorAction Stop");
    // No module-path search: autoloading is off before any cmdlet runs, and each module comes from the pinned PowerShell's own directory.
    expect(script.split("\n")[1]).toBe("$PSModuleAutoLoadingPreference = 'None'");
    const imports = script.split("\n").filter((line) => line.includes("Import-Module"));
    expect(imports.map((line) => /Import-Module -Name \(\$PSHOME \+ '\\Modules\\([^']+)'\)/.exec(line)?.[1])).toEqual([
      String.raw`Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1`,
      String.raw`Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1`,
      String.raw`Microsoft.PowerShell.LocalAccounts\Microsoft.PowerShell.LocalAccounts.psd1`,
      String.raw`Appx\Appx.psd1`,
    ]);
    const ready = script.indexOf("[Console]::Out.WriteLine('READY')");
    const loop = script.indexOf("while ($null -ne ($line = [Console]::In.ReadLine()))");
    expect(ready).toBeGreaterThan(0);
    expect(loop).toBeGreaterThan(ready);
    for (const line of imports) expect(script.indexOf(line)).toBeLessThan(ready);
    for (const setup of ["Get-LocalUser", "([ADSI]'WinNT://.').Children", "InvokeGet('Name')", "Get-AppxPackage"]) {
      expect(script.slice(0, ready)).toContain(setup);
      expect(script.slice(loop)).toContain(setup);
    }
    expect(script.slice(ready, loop)).toContain("[Console]::Out.Flush()");
    expect(script.slice(loop)).toContain("if (-not $localAccountsReady) { throw");
    expect(script.slice(loop)).toContain("if (-not $appxReady) { throw");
    // With autoloading off, every cmdlet the host calls must come from the engine itself or from a module it imports above.
    const powershell = script.replace(/@'\n[\s\S]*?\n'@/, "");
    const cmdlets = new Set(powershell.match(/\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/g));
    const moduleOf: Record<string, string> = {
      "Import-Module": "Core", "ForEach-Object": "Core", "Where-Object": "Core",
      "ConvertFrom-Json": "Utility", "ConvertTo-Json": "Utility", "Select-Object": "Utility", "Add-Type": "Utility", "Add-Member": "Utility",
      "Get-ChildItem": "Management", "Get-ItemProperty": "Management",
      "Get-LocalUser": "LocalAccounts", "Get-LocalGroup": "LocalAccounts", "Get-LocalGroupMember": "LocalAccounts",
      "Get-AppxPackage": "Appx",
    };
    expect([...cmdlets].sort()).toEqual(Object.keys(moduleOf).sort());
    expect(script).not.toMatch(/Set-Acl|Get-Acl|Set-ItemProperty|New-LocalUser|Start-Process|-AllUsers/);
    expect(script).not.toContain(fixture.candidate);
    // The bounds that were execFile options now bound each host request.
    expect(limits).toEqual({ timeoutMs: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBytes: 256 * 1024 });
    expect(options).toEqual({
      windowsHide: true,
      env: { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`C:\Windows`, PATH: String.raw`C:\Windows\System32;C:\Windows` },
    });
    expect(request.paths).toEqual(["C:\\", String.raw`C:\Tools`, fixture.candidate]);
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
    aclRequest.mockImplementation(async () => { throw error; });
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toBe(error);
    expect(aclDiscard).toHaveBeenCalled();
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
    expect(aclRequest).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reads a batch's deduplicated routes through one access query", async () => {
    windowsFixture();
    await assertCodexLocations([
      { path: String.raw`C:\Tools\one.exe`, kind: "executable" },
      { path: String.raw`C:\Tools\nested\two.exe`, kind: "executable" },
      { path: String.raw`C:\Tools\nested`, kind: "directory" },
    ]);
    expect(aclRequest).toHaveBeenCalledTimes(1);
    expect(aclRequest.mock.calls[0]![0].paths).toEqual([
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
    expect(aclRequest.mock.calls.length).toBe(3);
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

interface FakeAclHost {
  readonly child: EventEmitter & {
    readonly pid: number;
    readonly stdin: PassThrough;
    readonly stdout: PassThrough;
    readonly stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    readonly unref: Mock;
    readonly kill: Mock<() => boolean>;
  };
  readonly lines: string[];
  readonly requests: WindowsAclRequest[];
  answer: (request: WindowsAclRequest) => void;
}

// Host children that read request lines and answer through `answer`. Only the product's own ACL host talks to them; the transport seam stays empty.
function aclHostFixture(fixture: ReturnType<typeof windowsFixture>, configureFirst?: (host: FakeAclHost) => void): FakeAclHost[] {
  _setWindowsAclTransportForTest(undefined);
  const hosts: FakeAclHost[] = [];
  vi.mocked(spawn).mockImplementation((() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 4100 + hosts.length, stdin, stdout, stderr: new PassThrough(),
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      unref: vi.fn(), kill: vi.fn<() => boolean>(),
    });
    child.kill.mockImplementation(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.signalCode = "SIGTERM";
        queueMicrotask(() => { child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); });
      }
      return true;
    });
    const host: FakeAclHost = { child, lines: [], requests: [], answer: (request) => { stdout.write(`${fixture.reply(request)}\nEND ${request.id}\n`); } };
    let buffered = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      buffered += chunk;
      for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const request = JSON.parse(line) as WindowsAclRequest;
        host.lines.push(line);
        host.requests.push(request);
        host.answer(request);
      }
    });
    if (hosts.length === 0) configureFirst?.(host);
    hosts.push(host);
    queueMicrotask(() => { stdout.write("READY\n"); });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn);
  return hosts;
}

function corruptReply(fixture: ReturnType<typeof windowsFixture>, request: WindowsAclRequest,
  change: (reply: { id?: number; result: Record<string, unknown> }) => void): string {
  const reply = JSON.parse(fixture.reply(request)) as { id?: number; result: Record<string, unknown> };
  change(reply);
  return `${JSON.stringify(reply)}\nEND ${request.id}\n`;
}

describe("Windows ACL host", () => {
  it("launches the host with the per-probe binary, argument shape and environment", async () => {
    vi.stubEnv("PSModulePath", String.raw`C:\module-fixture`);
    vi.stubEnv("PSMODULEPATH", String.raw`C:\other-module-fixture`);
    const fixture = windowsFixture(String.raw`C:\Tools\한글 $(Write-Output injected).exe`);
    const hosts = aclHostFixture(fixture);
    await expect(assertCodexExecutableLocation(fixture.candidate)).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
    // The timeout and output bound apply to each request instead of the process.
    expect(command).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", expect.any(String)]);
    expect(options).toEqual({
      windowsHide: true,
      env: { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`C:\Windows`, PATH: String.raw`C:\Windows\System32;C:\Windows` },
    });
    expect(Object.keys(options!.env!)).not.toContain("PSModulePath");
    const script = decodeWindowsAclScript(args as string[]);
    expect(script).toContain("[Console]::In.ReadLine()");
    for (const stream of ["Progress", "Warning", "Verbose", "Information"]) {
      expect(script).toContain(`$${stream}Preference = 'SilentlyContinue'`);
    }
    expect(script).not.toContain(fixture.candidate);
    // Path data travels only in the request line, ASCII-escaped against the host's input code page.
    const [line] = hosts[0]!.lines;
    expect(line).not.toMatch(/[^\x00-\x7e]/);
    expect(Object.keys(JSON.parse(line!))).toEqual(["id", "paths", "capSids", "skipPackage", "setOwner"]);
    expect(hosts[0]!.requests[0]!.paths).toEqual(["C:\\", String.raw`C:\Tools`, fixture.candidate]);
    expect(hosts[0]!.child.unref).toHaveBeenCalled();
    expect(hosts[0]!.child.kill).not.toHaveBeenCalled();
  });

  it.each<[string, string | RegExp, (host: FakeAclHost, fixture: ReturnType<typeof windowsFixture>) => void]>([
    ["host exit", "Windows ACL host exited (1)", (host) => { host.answer = () => { host.child.exitCode = 1; host.child.emit("exit", 1, null); }; }],
    ["garbage reply", "access rules could not be read", (host) => { host.answer = (request) => { host.child.stdout.write(`not json\nEND ${request.id}\n`); }; }],
    ["id mismatch", "access rules are invalid", (host, fixture) => {
      host.answer = (request) => { host.child.stdout.write(corruptReply(fixture, request, (reply) => { reply.id = request.id + 1; })); };
    }],
    ["missing id", "access rules are invalid", (host, fixture) => {
      host.answer = (request) => { host.child.stdout.write(corruptReply(fixture, request, (reply) => { delete reply.id; })); };
    }],
    ["oversize reply", "Windows ACL host reply exceeds its limit", (host) => {
      host.answer = () => { host.child.stdout.write("x".repeat(256 * 1024 + 1)); };
    }],
    ["unknown result key", "access rules are invalid", (host, fixture) => {
      host.answer = (request) => { host.child.stdout.write(corruptReply(fixture, request, (reply) => { reply.result.extra = true; })); };
    }],
    ["wrong value type", "access rules are invalid", (host, fixture) => {
      host.answer = (request) => { host.child.stdout.write(corruptReply(fixture, request, (reply) => {
        (reply.result.paths as Record<string, unknown>[])[0]!.daclPresent = "yes";
      })); };
    }],
    ["extra reply line", "Windows ACL host wrote more than one reply", (host, fixture) => {
      host.answer = (request) => { host.child.stdout.write(`${fixture.reply(request)}\n${fixture.reply(request)}\n`); };
    }],
    ["error output", "Windows ACL host failed: failure", (host) => { host.answer = () => { host.child.stderr.write("failure"); }; }],
    ["stdin write failure", /destroyed/, (host) => { host.child.stdin.destroy(); }],
  ])("fails closed on %s, then answers the next request from a fresh host", async (_case, message, configure) => {
    const fixture = windowsFixture();
    const hosts = aclHostFixture(fixture, (host) => configure(host, fixture));
    await expect(assertCodexExecutableLocation(fixture.candidate)).rejects.toThrow(message);
    expect(hosts[0]!.child.kill).toHaveBeenCalled();
    // No retry inside the failed request.
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(assertCodexExecutableLocation(fixture.candidate)).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(hosts[1]!.requests).toHaveLength(1);
    expect(hosts[1]!.child.kill).not.toHaveBeenCalled();
  });

  it("fails closed on a request timeout, then answers the next request from a fresh host", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fixture = windowsFixture();
    const hosts = aclHostFixture(fixture, (host) => { host.answer = () => {}; });
    const admission = assertCodexExecutableLocation(fixture.candidate);
    const settled = expect(admission).rejects.toThrow("Windows ACL host request timed out");
    void settled.catch(() => {});
    const queued = assertCodexExecutableLocation(fixture.candidate);
    void queued.catch(() => {});
    // vi.waitFor would advance the fake clock; real turns let the request arrive first.
    while (hosts[0]?.requests.length !== 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(TOOL_TIMEOUT_POLICY.windowsAclRequestMs).toBeLessThan(TOOL_TIMEOUT_POLICY.globalCeilingMs);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsAclRequestMs - 1);
    expect(hosts[0]!.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hosts[0]!.child.kill).toHaveBeenCalled();
    await settled;
    await expect(admission).rejects.toBeInstanceOf(WindowsAclHostError);
    await expect(queued).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent admissions so each reads its own reply", async () => {
    const fixture = windowsFixture();
    fixture.modify((paths) => {
      paths.find((path) => path.path === String.raw`C:\Tools\b.exe`)?.entries.push({ sid: FOREIGN_SID, mask: 2, flags: 0, type: 0 });
    });
    let inFlight = 0;
    let most = 0;
    const hosts = aclHostFixture(fixture, (host) => {
      host.answer = (request) => {
        most = Math.max(most, ++inFlight);
        // Mocked admissions run in microtasks, so all three are queued before any reply.
        setImmediate(() => { inFlight -= 1; host.child.stdout.write(`${fixture.reply(request)}\nEND ${request.id}\n`); });
      };
    });
    const results = await Promise.allSettled(["a", "b", "c"].map((name) => assertCodexLocations([
      { path: `C:\\Tools\\${name}.exe`, kind: "executable" },
    ])));
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    if (results[1]!.status === "rejected") expect(results[1]!.reason.message).toContain("writable by another account");
    expect(most).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    const requests = hosts[0]!.requests;
    expect(requests.map((request) => request.paths.at(-1))).toEqual(["a", "b", "c"].map((name) => `C:\\Tools\\${name}.exe`));
    expect(new Set(requests.map((request) => request.id)).size).toBe(3);
  });

  it("stops the host after the idle period and starts a new one for the next request", async () => {
    expect(WINDOWS_ACL_HOST_IDLE_MS).toBe(30_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fixture = windowsFixture();
    const hosts = aclHostFixture(fixture);
    await assertCodexExecutableLocation(fixture.candidate);
    await assertCodexExecutableLocation(fixture.candidate);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(hosts[0]!.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(WINDOWS_ACL_HOST_IDLE_MS - 1);
    expect(hosts[0]!.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hosts[0]!.child.kill).toHaveBeenCalled();
    await assertCodexExecutableLocation(fixture.candidate);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(hosts[1]!.requests).toHaveLength(1);
  });

  it("registers the host with the managed-child tracker that app quit force-kills, and stops it on reset", async () => {
    const fixture = windowsFixture();
    const hosts = aclHostFixture(fixture);
    const tracked = getManagedChildProcessCount();
    await assertCodexExecutableLocation(fixture.candidate);
    expect(getManagedChildProcessCount()).toBe(tracked + 1);
    _resetWindowsAclHostForTest();
    expect(hosts[0]!.child.kill).toHaveBeenCalled();
    await vi.waitFor(() => { expect(getManagedChildProcessCount()).toBe(tracked); });
  });
});
