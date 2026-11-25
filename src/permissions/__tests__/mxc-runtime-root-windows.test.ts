/**
 * On Windows everything a container needs lives under one per-account runtime root in the account's local application
 * data, outside the Ave home. These cases hold the root to a real NTFS directory that only this account can open,
 * established once at start-up, and its staging parent to that root.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 as winPath } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getLocale, setLocale } from "../../i18n/runtime.js";
import { configureHostResources } from "../../main/host-resources.js";
import { windowsGrantingRules, windowsOwnerRules, type WindowsDaclFacts } from "../../shared/windows-path-facts.js";
import {
  AVE_APP_ID, currentMxcRuntimeHost, establishMxcRuntimeRoot, establishMxcSandboxHomesParent, _forgetMxcRuntimeRootForTest, MxcRuntimeRootError,
  mxcRuntimeRootFloorPath, mxcSandboxHomesParent, mxcStagingParent, requireMxcRuntimeRoot, type MxcRuntimeHost,
} from "../mxc-runtime-root.js";
import {
  isWindowsDrivePath, WINDOWS_RUNTIME_HOST, windowsLocalAppData, windowsRuntimeRootFailure, type MxcWindowsRuntimeHost,
} from "../mxc-runtime-root-windows.js";

const windows = process.platform === "win32";
const ACCOUNT = "S-1-5-21-1-2-3-1001";
const FULL_CONTROL = 0x1f01ff;

/** What the OS reports for a root this account created private, on an NTFS volume, under no link. */
function privateFacts(path: string, overrides: Partial<WindowsDaclFacts> = {}): WindowsDaclFacts {
  const identity = { volumeSerial: "0x0000000000000001", fileId: `0x${"0".repeat(31)}2` };
  return {
    exists: true, canonical: `\\\\?\\${path}`, ...identity, volumeSerialNumber: "0x0000000000000001", fileIndex: "0x0000000000000002",
    fileSystemName: "NTFS", changeTime: "0x0000000000000003", attributes: 16, reparseTag: 0, directory: true, reparseTarget: null,
    ancestors: [], currentUserSid: ACCOUNT, elevated: false, principals: {},
    dacl: { identity, owner: ACCOUNT, protected: true, nullDacl: false, aces: [{ type: 0, flags: 3, mask: FULL_CONTROL, sid: ACCOUNT }] },
    ...overrides,
  };
}

function daclOf(facts: WindowsDaclFacts): NonNullable<WindowsDaclFacts["dacl"]> {
  if (facts.dacl === null) throw new Error("no descriptor");
  return facts.dacl;
}

const PRIVATE_DACL = daclOf(privateFacts("C:\\x"));

function markIn(root: string): string {
  const mark = readdirSync(root).find((name) => name.startsWith(".established-"));
  if (mark === undefined) throw new Error("no mark");
  return mark;
}

describe("the account's local application data directory", () => {
  it("is LOCALAPPDATA when that is a drive path, and the profile's own otherwise", () => {
    expect(windowsLocalAppData({ LOCALAPPDATA: "D:\\Profiles\\example\\Local" }, "C:\\Users\\example")).toBe("D:\\Profiles\\example\\Local");
    expect(windowsLocalAppData({ LOCALAPPDATA: "D:\\Local\\" }, "C:\\Users\\example")).toBe("D:\\Local");
    for (const ignored of [undefined, "", "Local", "\\\\server\\share\\Local", "\\\\?\\C:\\Local", "C:/Users/example/Local", "C:\\a\\..\\Local"]) {
      expect(windowsLocalAppData({ LOCALAPPDATA: ignored }, "C:\\Users\\example")).toBe("C:\\Users\\example\\AppData\\Local");
    }
  });

  it("counts only a normalized drive-letter path as a local one", () => {
    expect(isWindowsDrivePath("C:\\Users\\example")).toBe(true);
    for (const path of ["C:", "C:relative", "\\\\server\\share", "\\\\.\\pipe\\x", "/home/example", "C:\\a\\.\\b", "C:\\a*"]) {
      expect(isWindowsDrivePath(path), path).toBe(false);
    }
  });
});

describe("what makes a directory the runtime root", () => {
  const ROOT = "C:\\Users\\example\\AppData\\Local\\ai.agent-connector.ave\\mxc-runtime";
  const dacl = PRIVATE_DACL;

  it("accepts a private NTFS directory, whatever case its path is reported in", () => {
    expect(windowsRuntimeRootFailure(privateFacts(ROOT), ROOT)).toBeUndefined();
    expect(windowsRuntimeRootFailure(privateFacts(ROOT, { canonical: `\\\\?\\${ROOT.toUpperCase()}` }), ROOT)).toBeUndefined();
  });

  it("accepts the sandbox account's deny on it: a deny opens nothing", () => {
    const stamped = { ...dacl, aces: [{ type: 1, flags: 3, mask: FULL_CONTROL, sid: "S-1-5-21-1-2-3-2002" }, ...dacl.aces] };
    expect(windowsRuntimeRootFailure(privateFacts(ROOT, { dacl: stamped }), ROOT)).toBeUndefined();
  });

  it("accepts an elevated process's root owned by the administrators group", () => {
    expect(windowsRuntimeRootFailure(privateFacts(ROOT, { elevated: true, dacl: { ...dacl, owner: "S-1-5-32-544" } }), ROOT)).toBeUndefined();
  });

  it.each(["en", "ko"] as const)("names the folder and what to do about it when a normal run finds an elevated run's root (%s)", (locale) => {
    const previous = getLocale();
    setLocale(locale);
    try {
      const failure = windowsRuntimeRootFailure(privateFacts(ROOT, { dacl: { ...dacl, owner: "S-1-5-32-544" } }), ROOT);
      expect(failure).toContain(ROOT);
      expect(failure).toMatch(locale === "en" ? /Delete that folder.*run Ave as administrator again/u : /삭제.*관리자 권한/u);
      expect(failure).not.toMatch(/be_mxcRuntimeRoot|\{path\}/u);
    } finally {
      setLocale(previous);
    }
  });

  it.each<[string, Partial<WindowsDaclFacts>, RegExp]>([
    ["a volume without access control lists", { fileSystemName: "FAT32" }, /NTFS/u],
    ["a volume that reports no filesystem", { fileSystemName: undefined }, /NTFS/u],
    ["a share", { canonical: "\\\\?\\UNC\\server\\share\\ai.agent-connector.ave\\mxc-runtime" }, /share/u],
    ["a mapped drive, which resolves to its share", { canonical: `\\\\?\\UNC\\server\\profiles${ROOT.slice(2)}` }, /mapped drive/u],
    ["a path that resolves elsewhere on the drive", { canonical: "\\\\?\\C:\\Elsewhere\\mxc-runtime" }, /alias/u],
    ["a path with no resolution", { canonical: null }, /alias/u],
    ["a file", { directory: false }, /not a directory/u],
    ["a missing entry", { exists: false, directory: false, dacl: null }, /not a directory/u],
    ["a junction", { reparseTag: 0xa0000003, attributes: 0x410 }, /link or junction/u],
    ["a directory below a junction", { ancestors: [{ ...privateFacts("C:\\Users"), reparseTag: 0xa0000003, attributes: 0x410 }] }, /link or junction/u],
    ["a directory below a component the walk could not open", { ancestors: [{ ...privateFacts("C:\\Users"), exists: null }] }, /link or junction/u],
    ["an unrestricted directory", { dacl: { ...dacl, nullDacl: true } }, /no access control list/u],
    ["a directory with no descriptor", { dacl: null }, /no access control list/u],
    ["inherited access", { dacl: { ...dacl, protected: false } }, /inherits/u],
    ["another account's directory", { dacl: { ...dacl, owner: "S-1-5-21-1-2-3-1002" } }, /another account/u],
    ["a second account let in", { dacl: { ...dacl, aces: [...dacl.aces, { type: 0, flags: 3, mask: 0x1200a9, sid: "S-1-5-32-545" }] } }, /open to other accounts/u],
    ["the system account let in", { dacl: { ...dacl, aces: [...dacl.aces, { type: 0, flags: 3, mask: FULL_CONTROL, sid: "S-1-5-18" }] } }, /open to other accounts/u],
    ["access its children do not inherit", { dacl: { ...dacl, aces: [{ type: 0, flags: 0, mask: FULL_CONTROL, sid: ACCOUNT }] } }, /open to other accounts/u],
    ["less than full control for the account", { dacl: { ...dacl, aces: [{ type: 0, flags: 3, mask: 0x1200a9, sid: ACCOUNT }] } }, /open to other accounts/u],
    ["an entry of an unknown kind", { dacl: { ...dacl, aces: [...dacl.aces, { type: 9, flags: 0, mask: 1, sid: ACCOUNT }] } }, /unknown kind/u],
  ])("refuses %s", (_what, overrides, reason) => {
    expect(windowsRuntimeRootFailure(privateFacts(ROOT, overrides), ROOT)).toMatch(reason);
  });
});

describe.runIf(windows)("Windows runtime root", () => {
  let scratch: string;
  let base: string;
  let home: string;
  let created: string[];
  let facts: (path: string) => WindowsDaclFacts;

  const rootPath = (): string => join(base, AVE_APP_ID, "mxc-runtime");
  /** A host whose directories are real and whose descriptor facts are stated by the test. */
  const hostOf = (overrides: Partial<MxcRuntimeHost> = {}, deps: Partial<MxcWindowsRuntimeHost> = {}): MxcRuntimeHost => ({
    ...currentMxcRuntimeHost(), platform: "win32", cacheHome: base, aveHome: home,
    windows: {
      createPrivateDirectory: (path) => { created.push(path); if (!existsSync(path)) mkdirSync(path); },
      readFacts: (path) => facts(path),
      ...deps,
    },
    ...overrides,
  });
  /** The production helpers: a descriptor written at creation and read back from the OS. */
  const nativeHost = (overrides: Partial<MxcRuntimeHost> = {}): MxcRuntimeHost => hostOf({ windows: WINDOWS_RUNTIME_HOST, ...overrides });
  const junction = (target: string, path: string): void => {
    mkdirSync(target, { recursive: true });
    symlinkSync(target, path, "junction");
  };

  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

  beforeEach(() => {
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-rtw-")));
    base = join(scratch, "Local");
    home = join(scratch, "example", ".ave");
    mkdirSync(base);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), "secret");
    created = [];
    facts = (path) => privateFacts(path);
  });

  afterEach(() => {
    for (const cacheHome of [base, join(scratch, "link"), join(scratch, "absent", "Local"), home]) _forgetMxcRuntimeRootForTest(cacheHome);
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("selection", () => {
    it("is <local application data>\\<app id>\\mxc-runtime, the same for every call, with staging inside it", () => {
      expect(mxcRuntimeRootFloorPath(base)).toBe(rootPath());
      // Naming the root creates nothing.
      expect(readdirSync(base)).toEqual([]);
      const root = establishMxcRuntimeRoot(hostOf());
      expect(root).toBe(rootPath());
      expect(created).toEqual([rootPath()]);
      expect(establishMxcRuntimeRoot(hostOf())).toBe(root);
      expect(requireMxcRuntimeRoot(hostOf())).toBe(root);
      const staging = mxcStagingParent("win32", hostOf());
      expect(staging).toBe(join(root, "staging"));
      expect(lstatSync(staging).isDirectory()).toBe(true);
      expect(readdirSync(home)).toEqual(["config.json"]);
    });

    it("resolves a local application data directory reached through a junction, the floor's path included", () => {
      const linked = join(scratch, "link");
      junction(base, linked);
      expect(mxcRuntimeRootFloorPath(linked)).toBe(rootPath());
      expect(establishMxcRuntimeRoot(hostOf({ cacheHome: linked }))).toBe(rootPath());
    });

    it("creates a local application data directory that is not there yet", () => {
      const absent = join(scratch, "absent", "Local");
      expect(mxcRuntimeRootFloorPath(absent)).toBe(join(absent, AVE_APP_ID, "mxc-runtime"));
      expect(establishMxcRuntimeRoot(hostOf({ cacheHome: absent }))).toBe(join(absent, AVE_APP_ID, "mxc-runtime"));
    });

    it("names the floor's path as spelled when the directory cannot be resolved", () => {
      const file = join(scratch, "file");
      writeFileSync(file, "");
      expect(mxcRuntimeRootFloorPath(join(file, "Local"))).toBe(join(file, "Local", AVE_APP_ID, "mxc-runtime"));
    });

    it("is only resolved on Windows", () => {
      expect(() => mxcStagingParent("win32", hostOf({ platform: "linux" }))).toThrow(MxcRuntimeRootError);
    });
  });

  describe("created by the OS helpers", () => {
    it("is this account's alone: a protected descriptor with one inheritable full-control entry", () => {
      const root = establishMxcRuntimeRoot(nativeHost());
      const row = WINDOWS_RUNTIME_HOST.readFacts(root);
      expect(row.fileSystemName).toBe("NTFS");
      expect(row.dacl?.protected).toBe(true);
      // An elevated run's new objects may be owned by the Administrators group instead.
      expect(row.elevated ? [row.currentUserSid, "S-1-5-32-544"] : [row.currentUserSid]).toContain(row.dacl?.owner);
      expect(windowsGrantingRules(windowsOwnerRules(daclOf(row)))).toEqual([expect.objectContaining({
        sid: row.currentUserSid, accessControlType: 0, fileSystemRights: 2032127, inheritanceFlags: 3, propagationFlags: 0, isInherited: false,
      })]);
      expect(windowsRuntimeRootFailure(row, root)).toBeUndefined();
      // The staging parent inherits the same single entry and nothing from above the root.
      const staging = WINDOWS_RUNTIME_HOST.readFacts(mxcStagingParent("win32", nativeHost()));
      expect(windowsGrantingRules(windowsOwnerRules(daclOf(staging))).map((rule) => [rule.sid, rule.isInherited])).toEqual([[row.currentUserSid, true]]);
    });

    it("refuses a root that is already there with inherited access, and leaves it as it was", () => {
      mkdirSync(rootPath(), { recursive: true });
      const before = WINDOWS_RUNTIME_HOST.readFacts(rootPath()).dacl;
      expect(() => establishMxcRuntimeRoot(nativeHost())).toThrow(/inherits access/u);
      expect(WINDOWS_RUNTIME_HOST.readFacts(rootPath()).dacl).toEqual(before);
      expect(readdirSync(rootPath())).toEqual([]);
    });

    it("is planned, and proved, at its real location when local application data lies below a junction", () => {
      const target = join(scratch, "elsewhere");
      junction(target, join(scratch, "via"));
      const cacheHome = join(scratch, "via", "Local");
      expect(establishMxcRuntimeRoot(nativeHost({ cacheHome }))).toBe(join(target, "Local", AVE_APP_ID, "mxc-runtime"));
      _forgetMxcRuntimeRootForTest(cacheHome);
    });
  });

  describe("fails closed", () => {
    const refused = (host: MxcRuntimeHost): void => {
      expect(() => establishMxcRuntimeRoot(host)).toThrow(MxcRuntimeRootError);
      expect(() => requireMxcRuntimeRoot(host)).toThrow(MxcRuntimeRootError);
      expect(() => mxcStagingParent("win32", host)).toThrow(MxcRuntimeRootError);
      // Staging never falls back into the Ave home.
      expect(readdirSync(home)).toEqual(["config.json"]);
    };

    it("refuses a junction at the root, and creates nothing behind it", () => {
      const target = join(scratch, "target");
      mkdirSync(join(base, AVE_APP_ID));
      junction(target, rootPath());
      refused(hostOf());
      expect(readdirSync(target)).toEqual([]);
      expect(created).toEqual([]);
    });

    it("refuses a junction at the app directory, and creates nothing behind it", () => {
      const target = join(scratch, "target");
      junction(target, join(base, AVE_APP_ID));
      refused(hostOf());
      expect(readdirSync(target)).toEqual([]);
    });

    it("refuses a file at the app directory or at the root", () => {
      writeFileSync(join(base, AVE_APP_ID), "");
      refused(hostOf());
      rmSync(join(base, AVE_APP_ID));
      _forgetMxcRuntimeRootForTest(base);
      mkdirSync(join(base, AVE_APP_ID));
      writeFileSync(rootPath(), "");
      refused(hostOf());
      expect(created).toEqual([]);
    });

    it.each<[string, Partial<WindowsDaclFacts>]>([
      ["on a volume without access control lists", { fileSystemName: "FAT32" }],
      ["that inherits access from above", { dacl: { ...PRIVATE_DACL, protected: false } }],
      ["that another account owns", { dacl: { ...PRIVATE_DACL, owner: "S-1-5-21-1-2-3-1002" } }],
    ])("refuses a root %s", (_what, overrides) => {
      facts = (path) => privateFacts(path, overrides);
      refused(hostOf());
    });

    it("keeps refusing an elevated run's root, naming the folder to delete at start-up and at every later start", () => {
      facts = (path) => privateFacts(path, { dacl: { ...PRIVATE_DACL, owner: "S-1-5-32-544" } });
      const previous = getLocale();
      setLocale("en");
      try {
        expect(() => establishMxcRuntimeRoot(hostOf())).toThrow(/Delete that folder/u);
        // The facts are not read again: the refusal repeats what start-up found.
        facts = (path) => privateFacts(path);
        for (const start of [() => requireMxcRuntimeRoot(hostOf()), () => mxcStagingParent("win32", hostOf())]) {
          expect(start).toThrow(MxcRuntimeRootError);
          expect(start).toThrow(/not established/u);
          expect(start).toThrow(rootPath());
          expect(start).toThrow(/Delete that folder/u);
        }
      } finally {
        setLocale(previous);
      }
      expect(readdirSync(rootPath())).toEqual([]);
    });

    it("names the folder in every refusal of a root that is already there", () => {
      facts = (path) => privateFacts(path, { fileSystemName: "FAT32" });
      expect(() => establishMxcRuntimeRoot(hostOf())).toThrow(rootPath());
    });

    it("refuses a root that the OS resolves to a share", () => {
      facts = () => privateFacts("UNC\\server\\share\\mxc-runtime");
      refused(hostOf());
    });

    it("refuses a root whose facts cannot be read, or that could not be created", () => {
      refused(hostOf({}, { readFacts: () => { throw new Error("helper unavailable"); } }));
      _forgetMxcRuntimeRootForTest(base);
      rmSync(rootPath(), { recursive: true });
      refused(hostOf({}, { createPrivateDirectory: () => { throw new Error("create refused"); } }));
    });

    it("refuses a local application data directory that is not a local drive path, before creating anything", () => {
      for (const cacheHome of ["Local", "\\\\server\\share\\Local", "/home/example/.cache"]) {
        expect(() => establishMxcRuntimeRoot(hostOf({ cacheHome }))).toThrow(MxcRuntimeRootError);
        _forgetMxcRuntimeRootForTest(cacheHome);
      }
      expect(created).toEqual([]);
    });

    it("refuses a root inside or above the Ave home, before creating anything", () => {
      refused(hostOf({ cacheHome: home }));
      // The home is compared whatever case it is spelled in.
      refused(hostOf({ aveHome: join(rootPath(), "home").toUpperCase() }));
      _forgetMxcRuntimeRootForTest(base);
      refused(hostOf({ aveHome: base.toUpperCase() }));
      expect(created).toEqual([]);
      expect(readdirSync(base)).toEqual([]);
    });

    it("refuses a host without the Windows directory helpers", () => {
      refused(hostOf({ windows: undefined }));
    });
  });

  describe("established at start-up or not at all", () => {
    it("refuses a run when start-up never established the root", () => {
      expect(() => requireMxcRuntimeRoot(hostOf())).toThrow(/not established/u);
      expect(() => mxcStagingParent("win32", hostOf())).toThrow(/not established/u);
      expect(readdirSync(base)).toEqual([]);
    });

    it("keeps refusing after a failed start-up, even once the root could be created", () => {
      facts = (path) => privateFacts(path, { fileSystemName: "exFAT" });
      expect(() => establishMxcRuntimeRoot(hostOf())).toThrow(MxcRuntimeRootError);
      facts = (path) => privateFacts(path);
      expect(() => establishMxcRuntimeRoot(hostOf())).toThrow(/not established/u);
      expect(() => requireMxcRuntimeRoot(hostOf())).toThrow(/not established/u);
    });

    it("refuses a run after the root is removed, replaced by a junction, or replaced by another directory", () => {
      const root = establishMxcRuntimeRoot(hostOf());
      const mark = markIn(root);
      rmSync(root, { recursive: true });
      expect(() => requireMxcRuntimeRoot(hostOf())).toThrow(/no longer there/u);
      junction(join(scratch, "target"), root);
      expect(() => requireMxcRuntimeRoot(hostOf())).toThrow(/no longer the directory/u);
      rmdirSync(root);
      // A new directory at the path, even one holding a copy of the mark's name, is not the established one.
      mkdirSync(root);
      expect(() => requireMxcRuntimeRoot(hostOf())).toThrow(/no longer the directory/u);
      writeFileSync(join(root, mark), "");
      expect(() => mxcStagingParent("win32", hostOf())).toThrow(/no longer the directory/u);
    });

    describe("a directory above the root replaced by a junction", () => {
      const appDirectory = (): string => join(base, AVE_APP_ID);
      const identity = (path: string): bigint => lstatSync(path, { bigint: true }).ino;

      it("refuses a run when the app directory is renamed and a junction to it planted at its name", () => {
        const host = nativeHost();
        const root = establishMxcRuntimeRoot(host);
        const moved = join(base, "moved");
        renameSync(appDirectory(), moved);
        junction(moved, appDirectory());
        // Through the junction the path still names the established directory, mark and all.
        expect(identity(root)).toBe(identity(join(moved, "mxc-runtime")));
        expect(existsSync(join(root, markIn(root)))).toBe(true);
        expect(() => requireMxcRuntimeRoot(host)).toThrow(/no longer reached/u);
        expect(() => mxcStagingParent("win32", host)).toThrow(MxcRuntimeRootError);
        expect(existsSync(join(moved, "mxc-runtime", "staging"))).toBe(false);
      });

      it("refuses a run when the local application data directory is renamed and a junction to it planted", () => {
        const host = nativeHost();
        const root = establishMxcRuntimeRoot(host);
        const moved = join(scratch, "moved-local");
        renameSync(base, moved);
        junction(moved, base);
        expect(identity(root)).toBe(identity(join(moved, AVE_APP_ID, "mxc-runtime")));
        expect(() => mxcStagingParent("win32", host)).toThrow(/no longer reached/u);
        expect(existsSync(join(moved, AVE_APP_ID, "mxc-runtime", "staging"))).toBe(false);
      });

      it("refuses a run when a directory above local application data becomes a junction", () => {
        const deep = join(scratch, "profile", "AppData", "Local");
        mkdirSync(deep, { recursive: true });
        const host = nativeHost({ cacheHome: deep });
        const root = establishMxcRuntimeRoot(host);
        try {
          const moved = join(scratch, "moved-profile");
          renameSync(join(scratch, "profile"), moved);
          junction(moved, join(scratch, "profile"));
          expect(identity(root)).toBe(identity(join(moved, "AppData", "Local", AVE_APP_ID, "mxc-runtime")));
          expect(() => mxcStagingParent("win32", host)).toThrow(/no longer reached/u);
        } finally {
          _forgetMxcRuntimeRootForTest(deep);
        }
      });

      it("hands out no staging parent when the junction is retargeted between the check and the creation", () => {
        const attacker = join(scratch, "attacker");
        mkdirSync(join(attacker, "mxc-runtime"), { recursive: true });
        let armed = false;
        // The Ave home is read after the root's path is checked and before staging is created: the swap happens there.
        const host = Object.defineProperty({ ...nativeHost() }, "aveHome", {
          get: (): string => {
            if (armed) {
              armed = false;
              renameSync(appDirectory(), join(base, "moved"));
              junction(attacker, appDirectory());
            }
            return home;
          },
        }) as MxcRuntimeHost;
        const root = establishMxcRuntimeRoot(host);
        expect(mxcStagingParent("win32", host)).toBe(join(root, "staging"));
        rmdirSync(join(root, "staging"));
        armed = true;
        expect(() => mxcStagingParent("win32", host)).toThrow(/no longer reached/u);
        expect(armed).toBe(false);
        expect(lstatSync(appDirectory()).isSymbolicLink()).toBe(true);
      });

      it("still admits a root whose local application data was reached through a junction at start-up", () => {
        const linked = join(scratch, "link");
        junction(base, linked);
        const host = nativeHost({ cacheHome: linked });
        const root = establishMxcRuntimeRoot(host);
        expect(root).toBe(rootPath());
        expect(mxcStagingParent("win32", host)).toBe(join(root, "staging"));
      });
    });

    it("tells a root whose mark is gone from the one it established", () => {
      const root = establishMxcRuntimeRoot(hostOf());
      const mark = markIn(root);
      expect(mark).toMatch(new RegExp(`^\\.established-${process.pid}-[0-9a-f]{32}$`, "u"));
      rmSync(join(root, mark));
      expect(() => requireMxcRuntimeRoot(hostOf())).toThrow(/no longer the directory/u);
    });

    it("leaves every other process's mark where it is", () => {
      mkdirSync(rootPath(), { recursive: true });
      const others = [".established-999999-0123456789abcdef0123456789abcdef", `.established-${process.ppid}-fedcba9876543210fedcba9876543210`];
      for (const name of others) writeFileSync(join(rootPath(), name), "");
      establishMxcRuntimeRoot(hostOf({ processExists: (pid) => pid !== 999999 }));
      expect(readdirSync(rootPath()).filter((name) => others.includes(name)).sort()).toEqual([...others].sort());
    });

    it("refuses a junction or a file at the staging parent", () => {
      const root = establishMxcRuntimeRoot(hostOf());
      junction(join(scratch, "target"), join(root, "staging"));
      expect(() => mxcStagingParent("win32", hostOf())).toThrow(MxcRuntimeRootError);
      expect(readdirSync(join(scratch, "target"))).toEqual([]);
      rmdirSync(join(root, "staging"));
      writeFileSync(join(root, "staging"), "");
      expect(() => mxcStagingParent("win32", hostOf())).toThrow(MxcRuntimeRootError);
    });
  });

  describe("the sandbox HOME parent", () => {
    it("is <root>\\homes beside staging, created by start-up only", () => {
      expect(() => mxcSandboxHomesParent(hostOf())).toThrow(/not established/u);
      expect(created).toEqual([]);
      expect(existsSync(rootPath())).toBe(false);
      const homes = establishMxcSandboxHomesParent(hostOf());
      expect(homes).toBe(join(rootPath(), "homes"));
      expect(created).toEqual([rootPath()]);
      expect(lstatSync(homes).isDirectory()).toBe(true);
      expect(requireMxcRuntimeRoot(hostOf())).toBe(rootPath());
      expect(mxcSandboxHomesParent(hostOf())).toBe(homes);
      expect(created).toEqual([rootPath()]);
    });

    it("is refused while start-up proved the root but created no HOME parent, and is not created then", () => {
      establishMxcRuntimeRoot(hostOf());
      expect(() => mxcSandboxHomesParent(hostOf())).toThrow(/HOME parent was not established/u);
      expect(existsSync(join(rootPath(), "homes"))).toBe(false);
    });

    it("is refused with the root, at every later call too, and no HOME parent is created", () => {
      facts = (path) => privateFacts(path, { fileSystemName: "exFAT" });
      expect(() => establishMxcSandboxHomesParent(hostOf())).toThrow(MxcRuntimeRootError);
      facts = (path) => privateFacts(path);
      expect(() => establishMxcSandboxHomesParent(hostOf())).toThrow(/not established/u);
      expect(() => mxcSandboxHomesParent(hostOf())).toThrow(/not established/u);
      expect(existsSync(join(rootPath(), "homes"))).toBe(false);
    });

    it("is refused once the root is replaced", () => {
      const root = establishMxcRuntimeRoot(hostOf());
      rmSync(root, { recursive: true });
      mkdirSync(root);
      expect(() => establishMxcSandboxHomesParent(hostOf())).toThrow(/no longer the directory/u);
      expect(() => mxcSandboxHomesParent(hostOf())).toThrow(/no longer the directory/u);
      expect(readdirSync(root)).toEqual([]);
    });

    it("refuses a junction or a file at its name", () => {
      const root = establishMxcRuntimeRoot(hostOf());
      junction(join(scratch, "target"), join(root, "homes"));
      expect(() => establishMxcSandboxHomesParent(hostOf())).toThrow(MxcRuntimeRootError);
      expect(readdirSync(join(scratch, "target"))).toEqual([]);
      rmdirSync(join(root, "homes"));
      writeFileSync(join(root, "homes"), "");
      expect(() => establishMxcSandboxHomesParent(hostOf())).toThrow(MxcRuntimeRootError);
    });

    it("is refused once the HOME parent itself is replaced", () => {
      const homes = establishMxcSandboxHomesParent(hostOf());
      rmdirSync(homes);
      mkdirSync(homes);
      expect(() => mxcSandboxHomesParent(hostOf())).toThrow(/no longer the directory first used/u);
    });

    it("is on Windows only", () => {
      expect(() => establishMxcSandboxHomesParent(hostOf({ platform: "linux" }))).toThrow(/Windows only/u);
      expect(() => mxcSandboxHomesParent(hostOf({ platform: "linux" }))).toThrow(/Windows only/u);
      expect(readdirSync(base)).toEqual([]);
    });
  });

  describe("under the test runner", () => {
    const publish = (path: string): void => {
      const proved = lstatSync(path, { bigint: true });
      vi.stubEnv("AVE_TEST_MXC_RUNTIME_ROOT", JSON.stringify([rootPath(), String(proved.dev), String(proved.ino)]));
    };
    let proofs = 0;
    const counting = (): MxcRuntimeHost => hostOf({}, { readFacts: (path) => { proofs += 1; return facts(path); } });
    beforeEach(() => { proofs = 0; });
    afterEach(() => { vi.unstubAllEnvs(); });

    it("takes the root and HOME parent the run's set-up made and published without proving or creating either", () => {
      mkdirSync(join(rootPath(), "homes"), { recursive: true });
      publish(rootPath());
      expect(mxcSandboxHomesParent(counting())).toBe(join(rootPath(), "homes"));
      expect(proofs).toBe(0);
    });

    it("refuses a published root whose HOME parent the set-up did not create, and creates none", () => {
      mkdirSync(rootPath(), { recursive: true });
      publish(rootPath());
      expect(() => mxcSandboxHomesParent(counting())).toThrow(/could not be inspected/u);
      expect(existsSync(join(rootPath(), "homes"))).toBe(false);
    });

    it("proves, at its own start-up, a root the set-up did not publish, and one put in the published root's place", () => {
      mkdirSync(rootPath(), { recursive: true });
      vi.stubEnv("AVE_TEST_MXC_RUNTIME_ROOT", "");
      expect(() => mxcSandboxHomesParent(counting())).toThrow(/not established/u);
      expect(proofs).toBe(0);
      establishMxcSandboxHomesParent(counting());
      expect(proofs).toBeGreaterThan(0);
      _forgetMxcRuntimeRootForTest(base);
      proofs = 0;
      publish(rootPath());
      rmSync(rootPath(), { recursive: true });
      mkdirSync(rootPath());
      establishMxcSandboxHomesParent(counting());
      expect(proofs).toBeGreaterThan(0);
    });

    it("refuses an existing root the set-up refused", () => {
      mkdirSync(rootPath(), { recursive: true });
      vi.stubEnv("AVE_TEST_MXC_RUNTIME_ROOT", "");
      const open = hostOf({}, { readFacts: () => { throw new Error("helper unavailable"); } });
      expect(() => establishMxcSandboxHomesParent(open)).toThrow(MxcRuntimeRootError);
      expect(() => mxcSandboxHomesParent(open)).toThrow(MxcRuntimeRootError);
      expect(existsSync(join(rootPath(), "homes"))).toBe(false);
    });

    it("lives in the run's own directory, never in the account's local application data", () => {
      const current = currentMxcRuntimeHost();
      expect(current.cacheHome).toBe(winPath.join(process.env.AVE_TEST_SANDBOX_BASE ?? tmpdir(), "mxc-cache"));
      expect(current.cacheHome.toLowerCase().startsWith((process.env.LOCALAPPDATA ?? "\0").toLowerCase())).toBe(false);
      expect(current.windows).toBe(WINDOWS_RUNTIME_HOST);
    });
  });
});
