/** Mock the account home so a broken isolation guard can only resolve scratch paths. */
import { mkdirSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, parse, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, userInfo: vi.fn(actual.userInfo) };
});

import { defaultAveHome, aveHome } from "../shared/ave-home.js";
import { checkSandboxSweepRoot, AVE_HOME_ISOLATION_GUARD_ACTIVE } from "../shared/ave-home-test-guard.js";
import { AVE_HOME_AT_IMPORT } from "./fixtures/import-time-ave-home.js";
import { canonicalPath } from "./support/ave-home-isolation-guard.js";
import { configuredTestTmpRoot } from "./support/test-tmp-root.js";
import { useScratchLinks, useTempDirs } from "./test-helpers.js";

const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
const fileEnv = {
  AVE_HOME: process.env.AVE_HOME,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  AVE_TEST_TMP_ROOT: process.env.AVE_TEST_TMP_ROOT,
};
const refusal = /refusing to resolve AVE_HOME to .* from a test process; it is under the real /;
const scratch = useTempDirs("ave-home-guard-");
const link = useScratchLinks();

afterEach(() => {
  vi.mocked(userInfo).mockImplementation(actualOs.userInfo);
  for (const [name, value] of Object.entries(fileEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function account(home: string = scratch()): { home: string; ave: string } {
  mkdirSync(join(home, ".ave"), { recursive: true });
  vi.mocked(userInfo).mockReturnValue({ ...actualOs.userInfo(), homedir: home });
  return { home, ave: join(home, ".ave") };
}

function pointHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  expect(homedir()).toBe(home);
}

describe("the test process's Ave home", () => {
  it("is guarded: the test configuration put the guard in the seam's place", () => {
    expect(AVE_HOME_ISOLATION_GUARD_ACTIVE).toBe(true);
  });

  // A file link needs a privilege Windows does not grant by default.
  it.runIf(process.platform !== "win32")("is the guard however the seam is reached, through a link of another name too", async () => {
    const seam = fileURLToPath(new URL("../shared/ave-home-test-guard.ts", import.meta.url));
    const renamed = join(scratch(), "renamed-module.ts");
    link(seam, renamed);
    const viaLink = (await import(renamed)) as typeof import("../shared/ave-home-test-guard.js");
    expect(viaLink.AVE_HOME_ISOLATION_GUARD_ACTIVE).toBe(true);
    expect(() => viaLink.checkSandboxSweepRoot(join(account().ave, "sandbox"))).toThrow(/refusing to sweep/);
  });

  it("starts this file in its own home inside the run's, under test-tmp", () => {
    const runHome = process.env.AVE_TEST_RUN_HOME;
    expect(runHome).toBeDefined();
    expect(fileEnv.AVE_HOME).toBeDefined();
    expect(dirname(fileEnv.AVE_HOME!)).toBe(runHome);
    expect(dirname(runHome!)).toBe(configuredTestTmpRoot(homedir()) ?? join(defaultAveHome(), "test-tmp"));
    expect(aveHome()).toBe(fileEnv.AVE_HOME);
  });

  it("is what a module resolving it at import captures, or that import is refused", async () => {
    expect(AVE_HOME_AT_IMPORT).toBe(fileEnv.AVE_HOME);

    const { home } = account();
    pointHome(home);
    delete process.env.AVE_HOME;
    vi.resetModules();
    await expect(import("./fixtures/import-time-ave-home.js")).rejects.toThrow(refusal);
  });

  it("refuses a test that lost its AVE_HOME while HOME is the account's", () => {
    const { home } = account();
    pointHome(home);
    delete process.env.AVE_HOME;
    expect(() => aveHome()).toThrow(refusal);
  });

  it("refuses the account's home and anything in it other than test-tmp", () => {
    const { ave } = account();
    for (const home of [
      ave,
      join(ave, "audit"),
      join(ave, "test-tmp-but-not-really"),
      join(ave, "test-tmp", "..", "sessions"),
    ]) {
      process.env.AVE_HOME = home;
      expect(() => aveHome(), home).toThrow(refusal);
    }
  });

  it("refuses it through a link, below parts not created yet", () => {
    const { ave } = account();
    const via = link(ave, join(scratch(), "ave-link"));
    for (const home of [via, join(via, "audit"), join(via, "not", "created", "yet")]) {
      process.env.AVE_HOME = home;
      expect(() => aveHome(), home).toThrow(refusal);
    }
  });

  it("refuses it under another name for a parent, either way round", () => {
    // `/tmp` and `/private/tmp` on macOS, made explicit on every platform.
    const real = scratch();
    const alias = link(real, join(scratch(), "alias"));
    account(join(real, "person"));
    process.env.AVE_HOME = join(alias, "person", ".ave", "missing", "child");
    expect(() => aveHome()).toThrow(refusal);

    account(join(alias, "person"));
    process.env.AVE_HOME = join(real, "person", ".ave", "missing", "child");
    expect(() => aveHome()).toThrow(refusal);
  });

  it.runIf(process.platform !== "linux")("refuses it in another letter case, the same directory there", () => {
    const { ave } = account();
    process.env.AVE_HOME = join(ave.toUpperCase(), "audit");
    expect(() => aveHome()).toThrow(refusal);
  });

  it("refuses the account's home when HOME points somewhere else", () => {
    const { ave } = account();
    pointHome(scratch());
    process.env.AVE_HOME = join(ave, "audit");
    expect(() => aveHome()).toThrow(refusal);
  });

  it("allows the account's test-tmp, and the scratch home a test pointed HOME at", () => {
    const { ave } = account();
    process.env.AVE_HOME = join(ave, "test-tmp", "elsewhere");
    expect(aveHome()).toBe(join(ave, "test-tmp", "elsewhere"));

    const elsewhere = scratch();
    pointHome(elsewhere);
    delete process.env.AVE_HOME;
    expect(aveHome()).toBe(join(elsewhere, ".ave"));
  });

  it("allows exactly an explicit AVE_TEST_TMP_ROOT under the account's Ave home, and nothing beside it", () => {
    const { ave } = account();
    const root = join(ave, "scratch-root");
    process.env.AVE_TEST_TMP_ROOT = root;
    process.env.AVE_HOME = join(root, "h-explicit");
    expect(aveHome()).toBe(join(root, "h-explicit"));
    expect(() => checkSandboxSweepRoot(join(root, "sbx-x"))).not.toThrow();
    process.env.AVE_HOME = join(ave, "scratch-root-sibling");
    expect(() => aveHome()).toThrow(refusal);
    process.env.AVE_HOME = join(ave, "audit");
    expect(() => aveHome()).toThrow(refusal);
  });

  it("throws on an explicit AVE_TEST_TMP_ROOT that is relative or contains the real account home", () => {
    const { ave } = account();
    process.env.AVE_HOME = join(ave, "test-tmp", "elsewhere");
    for (const [value, error] of [
      ["relative-root", /AVE_TEST_TMP_ROOT must be absolute/],
      ["", /AVE_TEST_TMP_ROOT must be absolute/],
      // Checked against the real account home global setup captured, not HOME or the mocked one; on a Windows runner HOME
      // may sit on another drive (D:\a\_temp\home) than the account profile, so the root must come from that capture.
      [parse(inject("realAccountHome")).root, /AVE_TEST_TMP_ROOT must not contain/],
    ] as const) {
      process.env.AVE_TEST_TMP_ROOT = value;
      expect(() => aveHome(), value).toThrow(error);
    }
  });

  it("guards a sandbox sweep against HOME's ~/.ave as well as the account's", () => {
    const { ave } = account();
    const elsewhere = scratch();
    pointHome(elsewhere);
    expect(() => checkSandboxSweepRoot(join(elsewhere, ".ave", "sandbox")))
      .toThrow(/refusing to sweep .* from a test process/);
    expect(() => checkSandboxSweepRoot(join(ave, "sandbox", "not-yet")))
      .toThrow(/refusing to sweep .* from a test process/);
    expect(() => checkSandboxSweepRoot(join(ave, "test-tmp", "sbx-x"))).not.toThrow();
  });
});

describe("canonicalPath", () => {
  it.skipIf(process.platform !== "win32")("normalizes an unreachable network path when realpath fails", () => {
    const path = "\\\\unreachable\\profiles\\tester\\work\\..\\locked";
    const realpath = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      throw Object.assign(new Error("unreachable share"), { code: "UNKNOWN" });
    });
    try {
      expect(canonicalPath(path)).toBe(resolve(path));
    } finally {
      realpath.mockRestore();
    }
  });

  it.skipIf(process.platform !== "win32")("normalizes an unreachable extended network path when realpath fails", () => {
    const path = "\\\\?\\UNC\\unreachable\\profiles\\tester\\locked";
    const realpath = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      throw Object.assign(new Error("unreachable share"), { code: "EACCES" });
    });
    try {
      expect(canonicalPath(path)).toBe(resolve(path));
    } finally {
      realpath.mockRestore();
    }
  });

  it("preserves local realpath permission failures", () => {
    const path = join(scratch(), "locked");
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const realpath = vi.spyOn(realpathSync, "native").mockImplementation(() => { throw error; });
    try {
      expect(() => canonicalPath(path)).toThrow(error);
    } finally {
      realpath.mockRestore();
    }
  });

  it.skipIf(process.platform !== "win32")("preserves extended local realpath failures", () => {
    const path = `\\\\?\\${join(scratch(), "locked")}`;
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const realpath = vi.spyOn(realpathSync, "native").mockImplementation(() => { throw error; });
    try {
      expect(() => canonicalPath(path)).toThrow(error);
    } finally {
      realpath.mockRestore();
    }
  });

  it("resolves the nearest existing ancestor and keeps the parts not created yet", () => {
    const real = scratch();
    const via = link(real, join(scratch(), "via"));
    expect(canonicalPath(join(via, "a", "b"))).toBe(join(canonicalPath(real), "a", "b"));
  });

  it("follows a dangling link to where creating through it would land", () => {
    const real = scratch();
    const dangling = link(join(real, "later"), join(scratch(), "dangling"));
    expect(canonicalPath(join(dangling, "child"))).toBe(join(canonicalPath(real), "later", "child"));
  });

  it.runIf(process.platform === "darwin")("reads /tmp as /private/tmp for a path that does not exist", () => {
    expect(canonicalPath("/tmp/ave-home-guard-not-there/child")).toBe("/private/tmp/ave-home-guard-not-there/child");
  });
});

describe("an explicit AVE_TEST_TMP_ROOT", () => {
  it("is refused on Windows when it is the drive root, or any ancestor, of the account home, whatever the letter case", () => {
    const home = "D:\\a\\_temp\\home";
    for (const value of ["D:\\", "d:\\", "D:/", "D:\\a", "D:\\A\\_TEMP\\", home, `${home}\\.ave`]) {
      expect(() => configuredTestTmpRoot(home, value, true, win32), value).toThrow(/AVE_TEST_TMP_ROOT must not contain/);
    }
    expect(() => configuredTestTmpRoot(home, "scratch", true, win32)).toThrow(/AVE_TEST_TMP_ROOT must be absolute/);
    expect(configuredTestTmpRoot(home, "D:\\scratch\\", true, win32)).toBe("D:\\scratch");
    expect(configuredTestTmpRoot(home, "E:\\", true, win32)).toBe("E:\\");
    expect(configuredTestTmpRoot(home, `${home}\\.ave\\scratch`, true, win32)).toBe(`${home}\\.ave\\scratch`);
    expect(configuredTestTmpRoot(home, "D:\\a\\_temp\\home-sibling", true, win32)).toBe("D:\\a\\_temp\\home-sibling");
  });

  it("is refused on POSIX when it is / or an ancestor of the account home, case-sensitively on Linux", () => {
    const home = "/home/runner";
    for (const value of ["/", "/home", "/home/", home, `${home}/.ave`]) {
      expect(() => configuredTestTmpRoot(home, value, false, posix), value).toThrow(/AVE_TEST_TMP_ROOT must not contain/);
    }
    expect(configuredTestTmpRoot(home, "/HOME", false, posix)).toBe("/HOME");
    expect(() => configuredTestTmpRoot(home, "/HOME", true, posix)).toThrow(/AVE_TEST_TMP_ROOT must not contain/);
    expect(configuredTestTmpRoot(home, "/tmp/ave-scratch", false, posix)).toBe("/tmp/ave-scratch");
  });
});
