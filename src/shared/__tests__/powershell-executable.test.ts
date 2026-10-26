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

const INSTALLATION = "/opt/microsoft/powershell/7";
const EXECUTABLE = `${INSTALLATION}/pwsh`;
const ORIGINAL_UID = Object.getOwnPropertyDescriptor(process, "getuid");
const entries = new Map<string, { directory: boolean; uid: number; mode: number; link?: boolean }>();

function add(path: string, directory: boolean, extra: Partial<{ uid: number; mode: number; link: boolean }> = {}): void {
  entries.set(path, { directory, uid: 0, mode: directory ? 0o40755 : 0o100755, ...extra });
}

beforeEach(() => {
  vi.resetModules();
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1001 });
  entries.clear();
  for (const mock of Object.values(filesystem)) mock.mockReset();
  for (const path of ["/", "/opt", "/opt/microsoft", "/opt/microsoft/powershell", INSTALLATION, `${INSTALLATION}/Modules`]) add(path, true);
  add(EXECUTABLE, false);
  add(`${INSTALLATION}/Modules/module.psd1`, false);
  filesystem.stat.mockImplementation((path: string) => {
    const entry = entries.get(path);
    if (!entry) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { ...entry, isDirectory: () => entry.directory, isFile: () => !entry.directory && !entry.link, isSymbolicLink: () => entry.link === true };
  });
  filesystem.entries.mockImplementation((path: string) => [...entries.keys()].filter((child) => child.startsWith(path + "/") && !child.slice(path.length + 1).includes("/")).map((child) => child.slice(path.length + 1)));
  filesystem.realpath.mockImplementation((path: string) => path);
  filesystem.access.mockImplementation((_path: string, mode: number) => {
    if (mode === 2) throw Object.assign(new Error("protected"), { code: "EACCES" });
  });
  nativeFacts.read.mockReset();
  systemHelper.exec.mockReset();
});

afterEach(() => {
  if (ORIGINAL_UID) Object.defineProperty(process, "getuid", ORIGINAL_UID);
  else Reflect.deleteProperty(process, "getuid");
  vi.unstubAllEnvs();
});

describe("trusted shell installation", () => {
  it("selects a fixed protected image and verifies the full installation once", async () => {
    vi.stubEnv("PATH", "/agent-controlled/bin");
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("linux")).toEqual({ executable: EXECUTABLE, kind: "pwsh" });
    const calls = filesystem.stat.mock.calls.length;
    expect(resolveTrustedPowerShellExecutable("linux")).toEqual({ executable: EXECUTABLE, kind: "pwsh" });
    expect(filesystem.stat.mock.calls).toHaveLength(calls);
    expect(filesystem.stat.mock.calls.some(([path]) => path === `${INSTALLATION}/Modules/module.psd1`)).toBe(true);
    expect(filesystem.stat.mock.calls.some(([path]) => path.startsWith("/agent-controlled"))).toBe(false);
  });

  it.each([
    ["agent-owned executable", EXECUTABLE, { uid: 1001 }],
    ["agent-owned module", `${INSTALLATION}/Modules/module.psd1`, { uid: 1001 }],
    ["writable module", `${INSTALLATION}/Modules/module.psd1`, { mode: 0o100666 }],
    ["writable parent", "/opt/microsoft", { mode: 0o40777 }],
    ["symbolic executable", EXECUTABLE, { link: true }],
    ["symbolic module", `${INSTALLATION}/Modules/module.psd1`, { link: true }],
  ] as const)("refuses %s", async (_label, path, change) => {
    Object.assign(entries.get(path)!, change);
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("linux")).toBeNull();
  });

  it("refuses a writable directory before enumerating its contents", async () => {
    Object.assign(entries.get(INSTALLATION + "/Modules")!, { uid: 1001 });
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("linux")).toBeNull();
    expect(filesystem.entries.mock.calls.map(([path]) => path)).not.toContain(INSTALLATION + "/Modules");
  });

  it("refuses write access granted beyond the ordinary mode bits", async () => {
    filesystem.access.mockImplementation((path: string, mode: number) => {
      if (mode === 2 && path !== `${INSTALLATION}/Modules/module.psd1`) throw Object.assign(new Error("protected"), { code: "EACCES" });
    });
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("linux")).toBeNull();
  });

  it("never discovers an executable from PATH when protected installations are absent", async () => {
    entries.clear();
    vi.stubEnv("PATH", "/agent-controlled/bin");
    add("/agent-controlled/bin/pwsh", false, { uid: 1001 });
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("linux")).toBeNull();
    expect(filesystem.stat.mock.calls.some(([path]) => path.startsWith("/agent-controlled"))).toBe(false);
  });

  it("caches a missing installation until restart without repeated filesystem work", async () => {
    const protectedEntries = new Map(entries);
    entries.clear();
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("linux")).toBeNull();
    const inspections = filesystem.stat.mock.calls.length;
    for (const [path, entry] of protectedEntries) entries.set(path, entry);
    expect(resolveTrustedPowerShellExecutable("linux")).toBeNull();
    expect(filesystem.stat.mock.calls).toHaveLength(inspections);
    vi.resetModules();
    const restarted = await import("../powershell-executable.js");
    expect(restarted.resolveTrustedPowerShellExecutable("linux")).toEqual({ executable: EXECUTABLE, kind: "pwsh" });
  });

  it("refuses a process whose identity can modify the installation", async () => {
    Object.defineProperty(process, "getuid", { configurable: true, value: () => 0 });
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("linux")).toBeNull();
  });

  it("does not reinterpret an install-directory symlink as proof", async () => {
    filesystem.realpath.mockReturnValue("/agent-controlled/pwsh");
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("linux")).toBeNull();
  });
});

const WINDOWS_ROOT = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0`;
const WINDOWS_EXECUTABLE = `${WINDOWS_ROOT}\\powershell.exe`;
const STANDARD_USER = "S-1-5-21-100-200-300-1001";
const SYSTEM = "S-1-5-18";

function windowsFixture(): void {
  entries.clear();
  for (const path of ["C:\\", "C:\\Windows", "C:\\Windows\\System32", "C:\\Windows\\System32\\WindowsPowerShell", WINDOWS_ROOT, `${WINDOWS_ROOT}\\Modules`]) add(path, true);
  add(WINDOWS_EXECUTABLE, false);
  add(`${WINDOWS_ROOT}\\Modules\\module.psd1`, false);
  filesystem.entries.mockImplementation((path: string) => [...entries.keys()].filter((child) => child.startsWith(path + "\\") && !child.slice(path.length + 1).includes("\\")).map((child) => child.slice(path.length + 1)));
  vi.stubEnv("SystemRoot", "C:\\Windows");
  nativeFacts.read.mockImplementation((paths: readonly string[]) => paths.map((path) => ({
    exists: true, canonical: path, directory: entries.get(path)!.directory,
    ancestors: [], reparseTag: 0, attributes: 0, currentUserSid: STANDARD_USER, elevated: false,
    dacl: { owner: SYSTEM, nullDacl: false, aces: [{ type: 0, flags: 0, mask: 0x1f01ff, sid: SYSTEM }, { type: 0, flags: 0, mask: 0x1200a9, sid: STANDARD_USER }] },
  })));
}

describe("protected system shell image", () => {
  it("admits a verified system installation independently of PATH and optional installations", async () => {
    windowsFixture();
    vi.stubEnv("PATH", "C:\\agent-controlled");
    vi.stubEnv("ProgramFiles", "C:\\agent-controlled");
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("win32")).toEqual({ executable: WINDOWS_EXECUTABLE, kind: "windows-powershell" });
    expect(nativeFacts.read.mock.calls.length).toBeGreaterThan(1);
    expect(nativeFacts.read.mock.calls.flatMap(([paths]) => paths)).toContain(`${WINDOWS_ROOT}\\Modules\\module.psd1`);
  });

  it.each(["write", "owner", "reparse", "elevated", "incomplete"] as const)("refuses an unproven installation descriptor: %s", async (failure) => {
    windowsFixture();
    const normal = nativeFacts.read.getMockImplementation()!;
    nativeFacts.read.mockImplementation((paths: readonly string[]) => {
      const rows = normal(paths) as { elevated: boolean; reparseTag: number; dacl: { owner: string; aces: { type: number; flags: number; mask: number; sid: string }[] } }[];
      const target = rows.at(-1)!;
      if (failure === "write") target.dacl.aces.push({ type: 0, flags: 0, mask: 2, sid: STANDARD_USER });
      if (failure === "owner") target.dacl.owner = STANDARD_USER;
      if (failure === "reparse") target.reparseTag = 0xa000000c;
      if (failure === "elevated") target.elevated = true;
      if (failure === "incomplete") rows.pop();
      return rows;
    });
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("win32")).toBeNull();
  });

  it("proves each directory before traversing a writable native subtree", async () => {
    windowsFixture();
    const normal = nativeFacts.read.getMockImplementation()!;
    nativeFacts.read.mockImplementation((paths: readonly string[]) => {
      const rows = normal(paths);
      for (let index = 0; index < paths.length; index += 1) {
        if (paths[index] === WINDOWS_ROOT + "\\Modules") rows[index].dacl.aces.push({ type: 0, flags: 0, mask: 2, sid: STANDARD_USER });
      }
      return rows;
    });
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("win32")).toBeNull();
    expect(filesystem.entries.mock.calls.map(([path]) => path)).not.toContain(WINDOWS_ROOT + "\\Modules");
  });

  it("bounds native query argument counts across a wide protected directory", async () => {
    windowsFixture();
    for (let index = 0; index < 100; index += 1) add(WINDOWS_ROOT + "\\module" + index + ".dll", false);
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("win32")).toEqual({ executable: WINDOWS_EXECUTABLE, kind: "windows-powershell" });
    expect(nativeFacts.read.mock.calls.length).toBeGreaterThan(6);
    expect(nativeFacts.read.mock.calls.every(([paths]) => paths.length <= 16)).toBe(true);
  });

  it("caches unavailable native evidence until restart without re-running the helper", async () => {
    windowsFixture();
    const normal = nativeFacts.read.getMockImplementation()!;
    nativeFacts.read.mockImplementation(() => { throw new Error("native evidence unavailable"); });
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("win32")).toBeNull();
    const inspections = nativeFacts.read.mock.calls.length;
    nativeFacts.read.mockImplementation(normal);
    expect(resolveTrustedPowerShellExecutable("win32")).toBeNull();
    expect(nativeFacts.read.mock.calls).toHaveLength(inspections);
    vi.resetModules();
    const restarted = await import("../powershell-executable.js");
    expect(restarted.resolveTrustedPowerShellExecutable("win32")).toEqual({ executable: WINDOWS_EXECUTABLE, kind: "windows-powershell" });
  });

  it("refuses inaccessible native evidence without launching an alternative shell", async () => {
    windowsFixture();
    nativeFacts.read.mockImplementation(() => { throw new Error("native evidence unavailable"); });
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("win32")).toBeNull();
  });
});

describe("installation extended access", () => {
  function darwinFixture(): string {
    const executable = "/usr/local/microsoft/powershell/7/pwsh";
    entries.clear();
    for (const path of ["/", "/usr", "/usr/local", "/usr/local/microsoft", "/usr/local/microsoft/powershell", "/usr/local/microsoft/powershell/7", "/bin"]) add(path, true);
    add(executable, false);
    add("/bin/ls", false);
    systemHelper.exec.mockReturnValue("-rwxr-xr-x 1 root wheel pwsh\n");
    return executable;
  }

  it("queries extended access through a fixed system image without inherited loader settings", async () => {
    const executable = darwinFixture();
    vi.stubEnv("DYLD_LIBRARY_PATH", "/agent-controlled");
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("darwin")).toEqual({ executable, kind: "pwsh" });
    expect(systemHelper.exec).toHaveBeenCalledWith("/bin/ls", expect.arrayContaining(["-lde", executable]), expect.objectContaining({ env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } }));
  });

  it("refuses extended ACLs including security-change grants not reflected in write access", async () => {
    darwinFixture();
    systemHelper.exec.mockReturnValue("-rwxr-xr-x+ 1 root wheel pwsh\n 0: user:agent allow writesecurity\n");
    const { resolveTrustedPowerShellExecutable } = await import("../powershell-executable.js");
    expect(resolveTrustedPowerShellExecutable("darwin")).toBeNull();
  });
});
