import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir, userInfo } from "node:os";
import {
  defaultAveHome,
  ensureAveHomePrivate,
  aveHome,
  refuseRealAveHomeUnderTest,
  win32SystemBinary,
} from "../ave-home.js";
import { useTempDirs, useTempPaths } from "../../__tests__/test-helpers.js";
import { removeLinkOnly } from "../../__tests__/support/tmp-dir-teardown.js";

const originalEnv = {
  AVE_HOME: process.env.AVE_HOME,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  VITEST: process.env.VITEST,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("aveHome", () => {
  it("resolves a relative AVE_HOME against the process working directory", () => {
    process.env.AVE_HOME = join("relative-state", "..", "ave-state");
    expect(aveHome()).toBe(resolve("ave-state"));
  });

  it("normalizes an absolute AVE_HOME override", () => {
    process.env.AVE_HOME = join(tmpdir(), "ave-parent", "..", "ave-state");
    expect(aveHome()).toBe(resolve(tmpdir(), "ave-state"));
  });
});

describe("the test process's Ave home", () => {
  const refusal = /refusing to resolve AVE_HOME to .* from a test process; it is under the real /;
  const scratch = useTempDirs("ave-home-guard-");
  // The person's own home, from the account database: what HOME or a mocked
  // `homedir()` says does not move it.
  const accountAve = join(userInfo().homedir, ".ave");

  it("starts this file in its own home inside the run's, under test-tmp", () => {
    const runHome = process.env.AVE_TEST_RUN_HOME;
    expect(runHome).toBeDefined();
    expect(originalEnv.AVE_HOME).toBeDefined();
    expect(dirname(originalEnv.AVE_HOME!)).toBe(runHome);
    expect(dirname(runHome!)).toBe(join(defaultAveHome(), "test-tmp"));
    expect(aveHome()).toBe(originalEnv.AVE_HOME);
  });

  it("refuses a test that lost its AVE_HOME instead of handing it the real one", () => {
    delete process.env.AVE_HOME;
    expect(() => aveHome()).toThrow(refusal);
  });

  it("refuses the real home and anything in it other than test-tmp", () => {
    for (const home of [
      accountAve,
      join(accountAve, "audit"),
      join(accountAve, "test-tmp-but-not-really"),
      join(accountAve, "test-tmp", "..", "sessions"),
    ]) {
      process.env.AVE_HOME = home;
      expect(() => aveHome(), home).toThrow(refusal);
    }
  });

  it("refuses the real home spelled through a link or, off Linux, in another case", () => {
    const link = join(scratch(), "ave-link");
    symlinkSync(accountAve, link, "junction");
    try {
      process.env.AVE_HOME = join(link, "audit");
      expect(() => aveHome()).toThrow(refusal);
    } finally {
      // Before the scratch directory's recursive removal, which on Windows
      // would walk a junction into the real home.
      removeLinkOnly(link);
    }

    if (process.platform !== "linux") {
      process.env.AVE_HOME = join(accountAve.toUpperCase(), "audit");
      expect(() => aveHome()).toThrow(refusal);
    }
  });

  it("refuses the account's own home when HOME points somewhere else", () => {
    const elsewhere = scratch();
    process.env.HOME = elsewhere;
    process.env.USERPROFILE = elsewhere;
    expect(defaultAveHome()).toBe(join(elsewhere, ".ave"));
    process.env.AVE_HOME = join(accountAve, "audit");
    expect(() => aveHome()).toThrow(refusal);
  });

  it("allows test-tmp, and the scratch home a test pointed HOME at", () => {
    process.env.AVE_HOME = join(accountAve, "test-tmp", "elsewhere");
    expect(aveHome()).toBe(join(accountAve, "test-tmp", "elsewhere"));

    const elsewhere = scratch();
    process.env.HOME = elsewhere;
    process.env.USERPROFILE = elsewhere;
    process.env.AVE_HOME = join(elsewhere, ".ave");
    expect(aveHome()).toBe(join(elsewhere, ".ave"));
  });

  it("guards a sweep against the HOME a test points elsewhere too, and names the action", () => {
    const elsewhere = scratch();
    process.env.HOME = elsewhere;
    process.env.USERPROFILE = elsewhere;
    expect(() => refuseRealAveHomeUnderTest(join(elsewhere, ".ave", "sandbox"), "sweep"))
      .toThrow(/refusing to sweep .* from a test process/);
    expect(() => refuseRealAveHomeUnderTest(join(accountAve, "sandbox"), "sweep"))
      .toThrow(/refusing to sweep .* from a test process/);
  });

  it("guards nothing outside the test runner", () => {
    delete process.env.VITEST;
    expect(() => refuseRealAveHomeUnderTest(join(accountAve, "audit"), "sweep")).not.toThrow();
    delete process.env.AVE_HOME;
    expect(aveHome()).toBe(defaultAveHome());
  });
});

describe("win32SystemBinary", () => {
  it("resolves under SystemRoot so PATH cannot decide which binary answers", () => {
    expect(win32SystemBinary("whoami", { SystemRoot: "C:\\Windows" })).toBe(
      join("C:\\Windows", "System32", "whoami.exe"),
    );
  });

  it("falls back to windir, then to the bare name when the session sets neither", () => {
    expect(win32SystemBinary("icacls", { windir: "D:\\Win" })).toBe(
      join("D:\\Win", "System32", "icacls.exe"),
    );
    expect(win32SystemBinary("icacls", {})).toBe("icacls");
  });
});

describe("ensureAveHomePrivate", () => {
  const home = useTempPaths("ave-home-privacy-", ".ave");

  it("creates the home directory with owner-only POSIX permissions", () => {
    const dir = home();
    const result = ensureAveHomePrivate(dir, {
      platform: "darwin",
      run: () => { throw new Error("no command may run off Win32"); },
    });

    expect(result).toEqual({ enforcement: "posix-mode", home: dir });
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it("hands Windows an inheritable owner-only DACL, because mode buys nothing there", () => {
    const dir = home();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const result = ensureAveHomePrivate(dir, {
      platform: "win32",
      run: (file, args) => {
        calls.push({ file, args });
        return file === win32SystemBinary("whoami") ? '"CORP\\\\example","S-1-5-21-1004336348-11-77-1417"\r\n' : "";
      },
    });

    expect(result).toEqual({
      enforcement: "win32-dacl",
      home: dir,
      sid: "S-1-5-21-1004336348-11-77-1417",
    });
    expect(calls[1]).toEqual({
      file: win32SystemBinary("icacls"),
      args: [
        dir,
        // Inherited ACEs go first: outside %USERPROFILE% they are what would
        // grant other accounts. (OI)(CI) makes the single remaining ACE the
        // one every settings/audit/secret file underneath is created with.
        "/inheritance:r",
        "/grant:r",
        "*S-1-5-21-1004336348-11-77-1417:(OI)(CI)F",
        "/q",
      ],
    });
  });

  it("reports a Windows account whose SID could not be read rather than claiming protection", () => {
    const dir = home();
    const result = ensureAveHomePrivate(dir, {
      platform: "win32",
      run: () => "ERROR: Access is denied.\r\n",
    });

    expect(result).toMatchObject({ enforcement: "none", home: dir });
    expect((result as { reason: string }).reason).toContain("SID");
  });

  // Only a real Windows kernel can say whether the DACL took: the argv test
  // above proves what is asked for, this proves what NTFS actually stored.
  // Runs on the `windows-permission-tests` CI job.
  it.runIf(process.platform === "win32")(
    "leaves the real directory readable to this account and to nobody else",
    () => {
      const dir = home();
      const applied = ensureAveHomePrivate(dir);
      expect(applied.enforcement).toBe("win32-dacl");

      const acl = execFileSync(win32SystemBinary("icacls"), [dir], { encoding: "utf-8" });
      // icacls echoes the path and prints the FIRST ACE on that same line, the
      // rest indented beneath it. Dropping line 0 wholesale discarded the only
      // ACE an enforced directory has — the one this test exists to read — so
      // strip the echoed path rather than the line carrying it.
      const aces = acl
        .split(/\r?\n/)
        .map((line) => (line.startsWith(dir) ? line.slice(dir.length) : line).trim())
        .filter((line) => line.includes(":("));
      expect(aces.length).toBeGreaterThan(0);
      const sid = (applied as { sid: string }).sid;
      const owner = execFileSync(win32SystemBinary("whoami"), [], {
        encoding: "utf-8",
      }).trim();
      // Whether icacls prints the SID or resolves it to an account name is not
      // the property under test. These two are: nothing is inherited any more,
      // and no ACE opens the directory to a group the whole machine is in.
      for (const ace of aces) {
        expect(ace, acl).not.toContain("(I)");
        const account = ace.slice(0, ace.indexOf(":(")).toLowerCase();
        for (const everyone of ["everyone", "s-1-1-0", "\\users", "authenticated users", "s-1-5-11", "s-1-5-32-545"]) {
          expect(account, acl).not.toContain(everyone);
        }
      }
      const mine = aces.some((ace) =>
        ace.includes(sid) || ace.toLowerCase().startsWith(owner.toLowerCase()));
      expect(mine, acl).toBe(true);
      // And the app can still use it.
      writeFileSync(join(dir, "settings.json"), "{}");
      expect(readFileSync(join(dir, "settings.json"), "utf-8")).toBe("{}");
    },
  );
});
