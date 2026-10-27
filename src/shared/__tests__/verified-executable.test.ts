import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({ stat: vi.fn(), entries: vi.fn(), realpath: vi.fn(), access: vi.fn() }));
const nativeFacts = vi.hoisted(() => ({ read: vi.fn() }));
const systemHelper = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), execFileSync: systemHelper.exec }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  lstatSync: filesystem.stat, readdirSync: filesystem.entries, realpathSync: filesystem.realpath, accessSync: filesystem.access,
}));
vi.mock("../windows-path-facts.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../windows-path-facts.js")>(), readWindowsDacls: nativeFacts.read,
}));

interface Entry {
  directory: boolean;
  uid: number;
  mode: number;
  link?: boolean;
}
const entries = new Map<string, Entry>();
const INSTALLATION = "/opt/tools/reader";
const EXECUTABLE = `${INSTALLATION}/reader`;
const DEPENDENCIES = "/usr/lib/reader-support";
const ORIGINAL_UID = Object.getOwnPropertyDescriptor(process, "getuid");
const ORIGINAL_EUID = Object.getOwnPropertyDescriptor(process, "geteuid");

function declareEntries({ directories = [], files = [] }: {
  readonly directories?: readonly string[];
  readonly files?: readonly string[];
}): void {
  for (const [directory, paths] of [[true, directories], [false, files]] as const) {
    for (const path of paths) {
      if (entries.has(path)) throw new Error("Duplicate fixture path");
      entries.set(path, { directory, uid: 0, mode: directory ? 0o40755 : 0o100755 });
    }
  }
}

beforeEach(() => {
  vi.resetModules();
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1001 });
  Object.defineProperty(process, "geteuid", { configurable: true, value: () => 1001 });
  entries.clear();
  for (const mock of [...Object.values(filesystem), nativeFacts.read, systemHelper.exec]) mock.mockReset();
  declareEntries({
    directories: ["/", "/opt", "/opt/tools", INSTALLATION, `${INSTALLATION}/lib`, "/usr", "/usr/lib", DEPENDENCIES],
    files: [EXECUTABLE, `${INSTALLATION}/lib/startup`, `${DEPENDENCIES}/startup`],
  });
  filesystem.stat.mockImplementation((path: string) => {
    const entry = entries.get(path);
    if (!entry) throw Object.assign(new Error("Missing fixture entry"), { code: "ENOENT" });
    return { ...entry, isDirectory: () => entry.directory, isFile: () => !entry.directory && !entry.link, isSymbolicLink: () => entry.link === true };
  });
  filesystem.entries.mockImplementation((path: string) => [...entries.keys()].filter(child => child.startsWith(`${path}/`) && !child.slice(path.length + 1).includes("/")).map(child => child.slice(path.length + 1)));
  filesystem.realpath.mockImplementation((path: string) => path);
  filesystem.access.mockImplementation((_path: string, mode: number) => {
    if (mode === 2) throw Object.assign(new Error("Protected fixture entry"), { code: "EACCES" });
  });
});

afterEach(() => {
  if (ORIGINAL_UID) Object.defineProperty(process, "getuid", ORIGINAL_UID);
  else Reflect.deleteProperty(process, "getuid");
  if (ORIGINAL_EUID) Object.defineProperty(process, "geteuid", ORIGINAL_EUID);
  else Reflect.deleteProperty(process, "geteuid");
  vi.unstubAllEnvs();
});

describe("verified executable installations", () => {
  it("uses the executable directory by default and returns an immutable descriptor", async () => {
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    const verified = resolveVerifiedExecutable([{ executable: EXECUTABLE }], "linux");
    expect(verified).toEqual({ executable: EXECUTABLE });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(filesystem.stat.mock.calls.map(([path]) => path)).toContain(`${INSTALLATION}/lib/startup`);
    expect(filesystem.stat.mock.calls.map(([path]) => path)).not.toContain(DEPENDENCIES);
  });

  it("tries fixed candidates in order and caches both unsuccessful and successful evidence", async () => {
    const candidates = [{ executable: "/opt/missing/reader" }, { executable: EXECUTABLE }];
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    const verified = resolveVerifiedExecutable(candidates, "linux");
    expect(verified).toEqual({ executable: EXECUTABLE });
    const inspections = filesystem.stat.mock.calls.length;
    expect(resolveVerifiedExecutable(candidates, "linux")).toBe(verified);
    expect(filesystem.stat.mock.calls).toHaveLength(inspections);
    expect(filesystem.realpath.mock.calls.map(([path]) => path)).toEqual(["/opt/missing/reader", EXECUTABLE]);
  });

  it("proves an explicit image file and its ancestors without enumerating siblings", async () => {
    entries.get(`${INSTALLATION}/lib/startup`)!.uid = 1001;
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    const verified = resolveVerifiedExecutable([{ executable: EXECUTABLE, installationRoots: [EXECUTABLE] }], "linux");
    expect(verified).toEqual({ executable: EXECUTABLE });
    expect(filesystem.stat.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining([EXECUTABLE, INSTALLATION, "/opt/tools", "/opt", "/"]));
    expect(filesystem.entries).not.toHaveBeenCalled();
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE }], "linux")).toBeNull();
  });

  it.each([
    ["image owner", EXECUTABLE, { uid: 1001 }],
    ["image write", EXECUTABLE, { mode: 0o100775 }],
    ["image link", EXECUTABLE, { link: true }],
    ["ancestor owner", "/opt/tools", { uid: 1001 }],
    ["dependency write", `${DEPENDENCIES}/startup`, { mode: 0o100775 }],
  ] as const)("refuses unsafe explicit file-root evidence: %s", async (_label, path, change) => {
    Object.assign(entries.get(path)!, change);
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE, installationRoots: [EXECUTABLE, `${DEPENDENCIES}/startup`] }], "linux")).toBeNull();
  });

  it("proves mixed file and directory roots", async () => {
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE, installationRoots: [EXECUTABLE, DEPENDENCIES] }], "linux")).toEqual({ executable: EXECUTABLE });
    expect(filesystem.entries.mock.calls.map(([path]) => path)).toEqual([DEPENDENCIES]);
  });

  it("requires positive plain access records for explicit image files", async () => {
    declareEntries({ directories: ["/bin"], files: ["/bin/ls"] });
    systemHelper.exec.mockImplementation((_image: string, args: readonly string[]) => args.slice(1).map(path =>
      `${entries.get(path)?.directory ? "d" : "-"}rwxr-xr-x 1 root wheel ${path}\n`).join(""));
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE, installationRoots: [EXECUTABLE] }], "darwin")).toEqual({ executable: EXECUTABLE });
    expect(systemHelper.exec).toHaveBeenCalledWith("/bin/ls", ["-lde", EXECUTABLE], expect.anything());
    expect(filesystem.entries).not.toHaveBeenCalled();
  });

  it("proves every explicit dependency tree and its ancestors", async () => {
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE, installationRoots: [INSTALLATION, DEPENDENCIES] }], "linux")).toEqual({ executable: EXECUTABLE });
    expect(filesystem.stat.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(["/usr", "/usr/lib", DEPENDENCIES, `${DEPENDENCIES}/startup`]));
  });

  it.each([
    ["dependency owner", `${DEPENDENCIES}/startup`, { uid: 1001 }],
    ["dependency mode", `${DEPENDENCIES}/startup`, { mode: 0o100775 }],
    ["dependency link", `${DEPENDENCIES}/startup`, { link: true }],
    ["dependency parent", "/usr/lib", { mode: 0o40777 }],
  ] as const)("refuses an unprotected %s", async (_label, path, change) => {
    Object.assign(entries.get(path)!, change);
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE, installationRoots: [INSTALLATION, DEPENDENCIES] }], "linux")).toBeNull();
  });

  it("does not reuse a positive proof when a candidate adds an unprotected root", async () => {
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE }], "linux")).not.toBeNull();
    Object.assign(entries.get(`${DEPENDENCIES}/startup`)!, { uid: 1001 });
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE, installationRoots: [INSTALLATION, DEPENDENCIES] }], "linux")).toBeNull();
  });

  it("keeps a refusal scoped to its exact installation roots", async () => {
    Object.assign(entries.get(`${DEPENDENCIES}/startup`)!, { uid: 1001 });
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE, installationRoots: [INSTALLATION, DEPENDENCIES] }], "linux")).toBeNull();
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE }], "linux")).toEqual({ executable: EXECUTABLE });
  });

  it("caches a repaired dependency refusal until module restart", async () => {
    const candidates = [{ executable: EXECUTABLE, installationRoots: [INSTALLATION, DEPENDENCIES] }];
    const dependency = entries.get(`${DEPENDENCIES}/startup`)!;
    dependency.uid = 1001;
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable(candidates, "linux")).toBeNull();
    const inspections = filesystem.stat.mock.calls.length;
    dependency.uid = 0;
    expect(resolveVerifiedExecutable(candidates, "linux")).toBeNull();
    expect(filesystem.stat.mock.calls).toHaveLength(inspections);
    vi.resetModules();
    const restarted = await import("../verified-executable.js");
    expect(restarted.resolveVerifiedExecutable(candidates, "linux")).toEqual({ executable: EXECUTABLE });
  });

  it("never transfers a platform proof to another platform", async () => {
    declareEntries({ directories: ["/bin"], files: ["/bin/ls"] });
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE }], "linux")).not.toBeNull();
    systemHelper.exec.mockReturnValue("");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE }], "darwin")).toBeNull();
    expect(systemHelper.exec).toHaveBeenCalled();
  });

  it.each([
    { executable: EXECUTABLE, installationRoots: [] },
    { executable: EXECUTABLE, installationRoots: [DEPENDENCIES] },
    { executable: EXECUTABLE, installationRoots: ["/opt/tools/read"] },
    { executable: EXECUTABLE, installationRoots: [INSTALLATION, "relative"] },
    { executable: "reader" },
    { executable: `${INSTALLATION}/lib/../reader` },
  ])("refuses missing executable coverage or ambiguous paths: %j", async candidate => {
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([candidate], "linux")).toBeNull();
    expect(filesystem.stat).not.toHaveBeenCalled();
  });

  it("does not enumerate an additional writable installation root", async () => {
    entries.get(DEPENDENCIES)!.uid = 1001;
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE, installationRoots: [INSTALLATION, DEPENDENCIES] }], "linux")).toBeNull();
    expect(filesystem.entries.mock.calls.map(([path]) => path)).not.toContain(DEPENDENCIES);
  });

  it.each([64, 65])("keeps the installation depth boundary at %i", async depth => {
    declareEntries({ directories: Array.from({ length: depth }, (_, index) => INSTALLATION + "/nested".repeat(index + 1)) });
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE }], "linux") !== null).toBe(depth === 64);
  });

  it("shares the entry-count ceiling across all installation roots", async () => {
    const normalStat = filesystem.stat.getMockImplementation()!;
    const normalEntries = filesystem.entries.getMockImplementation()!;
    filesystem.stat.mockImplementation((path: string) => /\/entry[0-9]+$/.test(path)
      ? { uid: 0, mode: 0o100755, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }
      : normalStat(path));
    filesystem.entries.mockImplementation((path: string) => path === INSTALLATION || path === DEPENDENCIES
      ? [...normalEntries(path), ...Array.from({ length: 32_768 }, (_, index) => `entry${index}`)]
      : normalEntries(path));
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE, installationRoots: [INSTALLATION, DEPENDENCIES] }], "linux")).toBeNull();
  });

  it("refuses effective administrative identity", async () => {
    Object.defineProperty(process, "geteuid", { configurable: true, value: () => 0 });
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: EXECUTABLE }], "linux")).toBeNull();
  });
});

const WINDOWS_ROOT = String.raw`C:\Tools\Reader`;
const WINDOWS_EXECUTABLE = `${WINDOWS_ROOT}\\reader.exe`;
const WINDOWS_DEPENDENCIES = String.raw`C:\Libraries\Reader`;
const SYSTEM = "S-1-5-18";
const USER = "S-1-5-21-100-200-300-1001";

function windowsFixture(): void {
  entries.clear();
  declareEntries({
    directories: ["C:\\", "C:\\Tools", WINDOWS_ROOT, "C:\\Libraries", WINDOWS_DEPENDENCIES],
    files: [WINDOWS_EXECUTABLE, `${WINDOWS_DEPENDENCIES}\\startup.dll`],
  });
  filesystem.entries.mockImplementation((path: string) => [...entries.keys()].filter(child => child.startsWith(`${path}\\`) && !child.slice(path.length + 1).includes("\\")).map(child => child.slice(path.length + 1)));
  nativeFacts.read.mockImplementation((paths: readonly string[]) => paths.map(path => ({
    exists: true, canonical: path, directory: entries.get(path)!.directory, ancestors: [], reparseTag: 0, attributes: 0,
    elevated: false, currentUserSid: USER,
    dacl: { owner: SYSTEM, nullDacl: false, aces: [{ type: 0, flags: 0, mask: 0x1f01ff, sid: SYSTEM }, { type: 0, flags: 0, mask: 0x1200a9, sid: USER }] },
  })));
}

describe("verified native installations", () => {
  it("proves every root with bounded native batches and caches its descriptor", async () => {
    windowsFixture();
    const candidates = [{ executable: WINDOWS_EXECUTABLE, installationRoots: [WINDOWS_ROOT, WINDOWS_DEPENDENCIES] }];
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    const verified = resolveVerifiedExecutable(candidates, "win32");
    expect(verified).toEqual({ executable: WINDOWS_EXECUTABLE });
    expect(nativeFacts.read.mock.calls.flatMap(([paths]) => paths)).toContain(`${WINDOWS_DEPENDENCIES}\\startup.dll`);
    expect(nativeFacts.read.mock.calls.every(([paths]) => paths.length <= 16)).toBe(true);
    const inspections = nativeFacts.read.mock.calls.length;
    expect(resolveVerifiedExecutable(candidates, "win32")).toBe(verified);
    expect(nativeFacts.read.mock.calls).toHaveLength(inspections);
  });

  it.each(["write", "reparse", "owner"])("refuses unsafe additional native root evidence: %s", async failure => {
    windowsFixture();
    const normal = nativeFacts.read.getMockImplementation()!;
    nativeFacts.read.mockImplementation((paths: readonly string[]) => {
      const rows = normal(paths);
      paths.forEach((path, index) => {
        if (path !== WINDOWS_DEPENDENCIES) return;
        if (failure === "write") rows[index].dacl.aces.push({ type: 0, flags: 0, mask: 2, sid: USER });
        if (failure === "reparse") rows[index].reparseTag = 0xa000000c;
        if (failure === "owner") rows[index].dacl.owner = USER;
      });
      return rows;
    });
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: WINDOWS_EXECUTABLE, installationRoots: [WINDOWS_ROOT, WINDOWS_DEPENDENCIES] }], "win32")).toBeNull();
    expect(filesystem.entries.mock.calls.map(([path]) => path)).not.toContain(WINDOWS_DEPENDENCIES);
  });

  it.each([1024, 1025])("keeps the native entry-path boundary at %i characters", async length => {
    windowsFixture();
    const entry = `${WINDOWS_ROOT}\\${"x".repeat(length - WINDOWS_ROOT.length - 1)}`;
    declareEntries({ files: [entry] });
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: WINDOWS_EXECUTABLE }], "win32") !== null).toBe(length === 1024);
  });

  it("proves explicit native image and dependency file roots without enumerating siblings", async () => {
    windowsFixture();
    const dependency = `${WINDOWS_DEPENDENCIES}\\startup.dll`;
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: WINDOWS_EXECUTABLE, installationRoots: [WINDOWS_EXECUTABLE, dependency] }], "win32")).toEqual({ executable: WINDOWS_EXECUTABLE });
    expect(nativeFacts.read.mock.calls.flatMap(([paths]) => paths)).toEqual(expect.arrayContaining([WINDOWS_EXECUTABLE, WINDOWS_ROOT, dependency, WINDOWS_DEPENDENCIES]));
    expect(filesystem.entries).not.toHaveBeenCalled();
  });

  it.each(["write", "owner", "reparse"])("refuses unsafe explicit native image evidence: %s", async failure => {
    windowsFixture();
    const normal = nativeFacts.read.getMockImplementation()!;
    nativeFacts.read.mockImplementation((paths: readonly string[]) => {
      const rows = normal(paths);
      paths.forEach((path, index) => {
        if (path !== WINDOWS_EXECUTABLE) return;
        if (failure === "write") rows[index].dacl.aces.push({ type: 0, flags: 0, mask: 2, sid: USER });
        if (failure === "owner") rows[index].dacl.owner = USER;
        if (failure === "reparse") rows[index].reparseTag = 0xa000000c;
      });
      return rows;
    });
    const { resolveVerifiedExecutable } = await import("../verified-executable.js");
    expect(resolveVerifiedExecutable([{ executable: WINDOWS_EXECUTABLE, installationRoots: [WINDOWS_EXECUTABLE] }], "win32")).toBeNull();
    expect(filesystem.entries).not.toHaveBeenCalled();
  });
});
