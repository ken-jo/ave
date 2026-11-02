// Native run 2 (Windows, fresh AVE_HOME): the home came out with only inherited ACEs and boot refused it as extra-principals.
// The entry point's first home write was a plain mkdir; the protection helper ran later, opened the existing directory and kept
// its inherited DACL. The fix has two phases: before the host-instance lock a start only creates a missing home through the
// helper; repair and sealing stay in bootstrap() under the lock. This models the helper's create-or-open on a real temp directory.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AveHomeCreateRuntime, AveHomePrivacyRuntime, WindowsDirectoryDacl } from "../../shared/ave-home.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const USER = "S-1-5-21-1004336348-11-77-1417";
const OWNER_ONLY = { sid: USER, accessControlType: 0, fileSystemRights: 2032127, inheritanceFlags: 3, propagationFlags: 0, isInherited: false };
const inherited = (sid: string) => ({ sid, accessControlType: 0, fileSystemRights: 2032127, inheritanceFlags: 3, propagationFlags: 0, isInherited: true });

let createdByHelper: Set<string>;
let createFails = false;
const order: string[] = [];
const fullProtection = vi.hoisted(() => vi.fn());

/** OpenHome with the create disposition: a directory it creates carries the owner-only descriptor. */
const createRuntime = (): AveHomeCreateRuntime => ({
  platform: "win32",
  exists: (path) => existsSync(path),
  create: (home) => {
    order.push("create");
    if (createFails) throw new Error("helper failed");
    mkdirSync(home, { recursive: true });
    createdByHelper.add(home);
  },
});

/** The full protect path's view: a helper-created directory is protected; an existing one keeps the DACL it already had. */
function protectRuntime(): AveHomePrivacyRuntime {
  return { platform: "win32", readDacls: (paths: readonly string[]): WindowsDirectoryDacl[] => paths.map((path) => {
    if (!existsSync(path)) { mkdirSync(path, { recursive: true }); createdByHelper.add(path); }
    return createdByHelper.has(path)
      ? { path, currentUserSid: USER, ownerSid: USER, elevated: false, protected: true, rules: [{ ...OWNER_ONLY }] }
      : { path, currentUserSid: USER, ownerSid: USER, elevated: false, protected: false,
        rules: [{ ...OWNER_ONLY, isInherited: true }, inherited("S-1-5-18"), inherited("S-1-5-32-544")] };
  }) };
}

vi.mock("../../shared/ave-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/ave-home.js")>();
  return {
    ...actual,
    createAveHomeIfAbsent: (home?: string) => actual.createAveHomeIfAbsent(home, createRuntime()),
    // The full protection (repair, runtime-root claim, root repair) belongs to the lock holder only.
    ensureAveHomePrivate: (...args: Parameters<typeof actual.ensureAveHomePrivate>) => { fullProtection(...args); return actual.ensureAveHomePrivate(...args); },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn((...args: Parameters<typeof actual.mkdirSync>) => { order.push(`mkdir ${String(args[0])}`); return actual.mkdirSync(...args); }) };
});

describe("the pre-lock AVE_HOME write of a process start", () => {
  let parent: string;
  let home: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    parent = realpathSync(mkdtempSync(join(tmpdir(), "ave-first-write-")));
    home = join(parent, "ave-379-run2");
    vi.stubEnv("AVE_HOME", home);
    vi.stubEnv("SystemRoot", "C:\\Windows");
    createdByHelper = new Set();
    createFails = false;
    order.length = 0;
    fullProtection.mockClear();
  });

  afterEach(async () => {
    const leftCwd = process.cwd();
    process.chdir(prevCwd);
    if (basename(leftCwd).startsWith("ave-workspace-")) await cleanupTmpDir(leftCwd);
    vi.unstubAllEnvs();
    const { _resetAveHomePrivacyForTest } = await import("../../shared/ave-home.js");
    _resetAveHomePrivacyForTest();
    await cleanupTmpDir(parent);
  });

  it("creates a fresh home through the helper before any other write, so the lock holder finds it protected", async () => {
    const { ensureWorkspaceCwd } = await import("../ensure-workspace-cwd.js");
    const actual = await vi.importActual<typeof import("../../shared/ave-home.js")>("../../shared/ave-home.js");
    expect(existsSync(home)).toBe(false);

    ensureWorkspaceCwd(); // desktop module load and the headless host, before the host-instance lock
    expect(order[0]).toBe("create");
    expect(order.indexOf(`mkdir ${join(home, "workspace")}`)).toBeGreaterThan(0);
    expect(createdByHelper.has(home)).toBe(true);

    // bootstrap(), under the lock
    expect(actual.ensureAveHomePrivate(home, protectRuntime()).enforcement).toBe("win32-dacl");
  });

  it("never runs the full protection (repair, claim, root repair) before the lock", async () => {
    const { ensureWorkspaceCwd } = await import("../ensure-workspace-cwd.js");
    ensureWorkspaceCwd();
    mkdirSync(join(home, "secrets")); // a second start on a home that now needs subdirectory work
    ensureWorkspaceCwd();
    expect(fullProtection).not.toHaveBeenCalled();
    // The native create request (Windows-only to execute): its script after the helper source may open and read, never repair.
    const { readFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const source = readFileSync(new URL("../../shared/ave-home.ts", import.meta.url), "utf8");
    const request = source.slice(source.indexOf("function windowsHomeCreateRequest("), source.indexOf("/** Windows needs an explicit owner-only inheritable DACL"));
    const body = request.slice(request.indexOf("'@;"));
    expect(body).toContain("[HomeDirectoryDacl]::OpenHome($request.home, $identity.User, $true)");
    for (const mutation of ["[HomeDirectoryDacl]::Repair(", "[HomeDirectoryDacl]::RepairInheritedRoot(", "[HomeDirectoryDacl]::ClaimRuntimeRoot("]) {
      expect(body).not.toContain(mutation);
    }
  });

  it("spawns nothing once the home exists", async () => {
    mkdirSync(home, { recursive: true });
    order.length = 0;
    const { ensureWorkspaceCwd } = await import("../ensure-workspace-cwd.js");
    ensureWorkspaceCwd();
    expect(order).not.toContain("create");
  });

  it("never plain-creates the home when the helper fails; the start anchors outside AVE_HOME", async () => {
    createFails = true;
    const { ensureWorkspaceCwd } = await import("../ensure-workspace-cwd.js");
    const cwd = ensureWorkspaceCwd();
    expect(existsSync(home)).toBe(false);
    expect(order.filter((entry) => entry.startsWith(`mkdir ${home}`))).toEqual([]);
    // A fresh, empty directory of its own: the cwd is the default workspace root, so the shared temp root must never be it.
    expect(cwd).not.toBe(tmpdir());
    expect(dirname(cwd)).toBe(tmpdir());
    expect(basename(cwd)).toMatch(/^ave-workspace-/);
    expect(readdirSync(cwd)).toEqual([]);
    expect(realpathSync(process.cwd())).toBe(realpathSync(cwd));
    const { buildAllowedScope } = await import("../../permissions/allowed-directories.js");
    const { directories } = buildAllowedScope([]);
    const fold = (path: string) => realpathSync(path).toLowerCase();
    expect(directories.map((dir) => dir.toLowerCase())).toContain(fold(cwd));
    expect(directories.map((dir) => dir.toLowerCase())).not.toContain(fold(tmpdir()));
  });

  it("is the defect it fixes: a plain mkdir before the helper leaves a home the lock holder refuses", async () => {
    const actual = await vi.importActual<typeof import("../../shared/ave-home.js")>("../../shared/ave-home.js");
    mkdirSync(join(home, "workspace"), { recursive: true }); // the old ensureWorkspaceCwd
    expect(actual.ensureAveHomePrivate(home, protectRuntime())).toMatchObject({ enforcement: "none", category: "extra-principals" });
  });
});
