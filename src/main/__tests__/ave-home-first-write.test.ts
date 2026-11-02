// Native run 2 (Windows, fresh AVE_HOME): the home came out with only inherited ACEs and boot refused it as extra-principals.
// The entry point's first home write was a plain mkdir; the protection helper ran later, opened the existing directory and kept
// its inherited DACL. This models the helper's create-or-open on a real temp directory and checks the boot order.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AveHomePrivacyRuntime, WindowsDirectoryDacl } from "../../shared/ave-home.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const USER = "S-1-5-21-1004336348-11-77-1417";
const OWNER_ONLY = { sid: USER, accessControlType: 0, fileSystemRights: 2032127, inheritanceFlags: 3, propagationFlags: 0, isInherited: false };
const inherited = (sid: string) => ({ sid, accessControlType: 0, fileSystemRights: 2032127, inheritanceFlags: 3, propagationFlags: 0, isInherited: true });

/** FILE_OPEN_IF with an owner-only descriptor: a directory it creates is protected; an existing one keeps the DACL it already had. */
function windowsHelper(createdByHelper: Set<string>): AveHomePrivacyRuntime & { readDacls: ReturnType<typeof vi.fn> } {
  const readDacls = vi.fn((paths: readonly string[]): WindowsDirectoryDacl[] => paths.map((path) => {
    if (!existsSync(path)) { mkdirSync(path, { recursive: true }); createdByHelper.add(path); }
    return createdByHelper.has(path)
      ? { path, currentUserSid: USER, ownerSid: USER, elevated: false, protected: true, rules: [{ ...OWNER_ONLY }] }
      : { path, currentUserSid: USER, ownerSid: USER, elevated: false, protected: false,
        rules: [{ ...OWNER_ONLY, isInherited: true }, inherited("S-1-5-18"), inherited("S-1-5-32-544")] };
  }));
  return { platform: "win32", readDacls };
}

let runtime: ReturnType<typeof windowsHelper>;
let createdByHelper: Set<string>;
const order: string[] = [];

vi.mock("../../shared/ave-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/ave-home.js")>();
  return {
    ...actual,
    establishAveHomePrivacyAtBoot: (home?: string) => {
      order.push("establish");
      return actual.establishAveHomePrivacyAtBoot(home, runtime);
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn((...args: Parameters<typeof actual.mkdirSync>) => { order.push(`mkdir ${String(args[0])}`); return actual.mkdirSync(...args); }) };
});

describe("the first AVE_HOME write of a process", () => {
  let parent: string;
  let home: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    parent = realpathSync(mkdtempSync(join(tmpdir(), "ave-first-write-")));
    home = join(parent, "ave-379-run2");
    vi.stubEnv("AVE_HOME", home);
    createdByHelper = new Set();
    runtime = windowsHelper(createdByHelper);
    order.length = 0;
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    vi.unstubAllEnvs();
    const { _resetAveHomePrivacyForTest } = await import("../../shared/ave-home.js");
    _resetAveHomePrivacyForTest();
    await cleanupTmpDir(parent);
  });

  it("lets the protection helper create a fresh home, so boot finds it protected", async () => {
    const { ensureWorkspaceCwd } = await import("../ensure-workspace-cwd.js");
    const { establishAveHomePrivacyAtBoot } = await import("../../shared/ave-home.js");
    expect(existsSync(home)).toBe(false);

    ensureWorkspaceCwd(); // desktop module load and the headless host, before bootstrap()
    const atBoot = establishAveHomePrivacyAtBoot(); // what bootstrap() does

    expect(atBoot.enforcement).toBe("win32-dacl");
    // The helper was the first to touch the home and created it; the workspace mkdir came after.
    expect(order[0]).toBe("establish");
    expect(createdByHelper.has(home)).toBe(true);
    expect(order.indexOf(`mkdir ${join(home, "workspace")}`)).toBeGreaterThan(order.indexOf(`mkdir ${home}`));
  });

  it("seals the result once: bootstrap() reuses it instead of opening the home again", async () => {
    const { ensureWorkspaceCwd } = await import("../ensure-workspace-cwd.js");
    const { establishAveHomePrivacyAtBoot } = await import("../../shared/ave-home.js");
    ensureWorkspaceCwd();
    establishAveHomePrivacyAtBoot();
    expect(runtime.readDacls).toHaveBeenCalledTimes(1);
  });

  it("still refuses a home that already existed with inherited access (the check is not weakened)", async () => {
    mkdirSync(home, { recursive: true });
    const { ensureWorkspaceCwd } = await import("../ensure-workspace-cwd.js");
    const { establishAveHomePrivacyAtBoot } = await import("../../shared/ave-home.js");
    ensureWorkspaceCwd();
    const atBoot = establishAveHomePrivacyAtBoot();
    expect(atBoot).toMatchObject({ enforcement: "none", category: "extra-principals" });
    expect(atBoot.enforcement === "none" ? atBoot.extraPrincipals?.map(({ sid }) => sid) : []).toEqual(["S-1-5-18", "S-1-5-32-544"]);
  });
});
