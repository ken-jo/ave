import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureAveHomePrivate, aveHome, win32SystemBinary, readWindowsDirectoryDacl, setAveHomePrivacyAtBoot, assertAveHomePrivacyForConfinement, _resetAveHomePrivacyForTest } from "../ave-home.js";
import { useTempPaths } from "../../__tests__/test-helpers.js";

const originalAveHome = process.env.AVE_HOME;
const OWNER_SID = "S-1-5-21-1004336348-11-77-1417";
const OWNER_DACL = `D:P(A;OICI;FA;;;${OWNER_SID})`;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => join(actual.tmpdir(), "synthetic-profile") };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});

afterEach(() => {
  _resetAveHomePrivacyForTest();
  if (originalAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = originalAveHome;
});

describe("aveHome", () => {
  it("keeps the default home resolution with a mocked profile and no filesystem writes", () => {
    delete process.env.AVE_HOME;
    expect(aveHome()).toBe(resolve(tmpdir(), "synthetic-profile", ".ave"));
  });
  it("resolves a relative AVE_HOME against the process working directory", () => {
    process.env.AVE_HOME = join("relative-state", "..", "ave-state");
    expect(aveHome()).toBe(resolve("ave-state"));
  });

  it("normalizes an absolute AVE_HOME override", () => {
    process.env.AVE_HOME = join(tmpdir(), "ave-parent", "..", "ave-state");
    expect(aveHome()).toBe(resolve(tmpdir(), "ave-state"));
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

  it("protects the default home and secrets using only mocked profile and filesystem access", () => {
    delete process.env.AVE_HOME;
    const mkdir = vi.mocked(mkdirSync);
    const originalMkdir = mkdir.getMockImplementation()!;
    mkdir.mockImplementation(() => undefined);
    const readDacl = vi.fn(() => OWNER_DACL);
    try {
      const result = ensureAveHomePrivate(undefined, {
        platform: "win32",
        run: () => `"example","${OWNER_SID}"`,
        readDacl,
      });
      const dir = resolve(tmpdir(), "synthetic-profile", ".ave");
      expect(result).toEqual({ enforcement: "win32-dacl", home: dir, sid: OWNER_SID });
      expect(readDacl.mock.calls).toEqual([[dir], [join(dir, "secrets")]]);
    } finally {
      mkdir.mockImplementation(originalMkdir);
    }
  });

  it("creates the home directory with owner-only POSIX permissions", () => {
    const dir = home();
    const result = ensureAveHomePrivate(dir, {
      platform: "darwin",
      run: () => { throw new Error("no command may run off Win32"); },
      readDacl: () => { throw new Error("no DACL may be read off Win32"); },
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
      readDacl: () => OWNER_DACL,
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
    expect(calls[2]?.args).toEqual([join(dir, "secrets"), ...calls[1].args.slice(1)]);
    expect(existsSync(join(dir, "secrets"))).toBe(true);
  });

  it("reports a Windows account whose SID could not be read rather than claiming protection", () => {
    const dir = home();
    const result = ensureAveHomePrivate(dir, {
      platform: "win32",
      run: () => "ERROR: Access is denied.\r\n",
      readDacl: () => OWNER_DACL,
    });

    expect(result).toMatchObject({ enforcement: "none", home: dir });
    expect((result as { reason: string }).reason).toContain("SID");
  });

  it.each([
    `D:(A;OICI;FA;;;${OWNER_SID})`,
    `D:P(A;OICI;FA;;;${OWNER_SID})(A;OICI;FR;;;S-1-1-0)`,
    `D:P(A;OICIID;FA;;;${OWNER_SID})`,
    `D:P(A;CI;FA;;;${OWNER_SID})`,
    `D:P(A;OICI;FR;;;${OWNER_SID})`,
    "D:P(A;OICI;FA;;;S-1-5-18)",
    `D:P(D;OICI;FA;;;${OWNER_SID})`,
    "D:NO_ACCESS_CONTROL",
    "unreadable",
  ])("refuses a read-back that is not exactly the protected owner grant: %s", (sddl) => {
    const dir = home();
    const result = ensureAveHomePrivate(dir, {
      platform: "win32",
      run: () => `"example","${OWNER_SID}"`,
      readDacl: () => sddl,
    });
    expect(result).toMatchObject({ enforcement: "none", home: dir, failedPath: dir });
    setAveHomePrivacyAtBoot(result);
    if (process.platform === "win32") expect(() => assertAveHomePrivacyForConfinement()).toThrow(dir);
  });

  it.each(["icacls", "read-back", "secrets-icacls", "secrets-read-back", "secrets-mismatch"])("reports and refuses %s failures", (failure) => {
    const dir = home();
    const secretPath = join(dir, "secrets");
    const failedPath = failure.startsWith("secrets-") ? secretPath : dir;
    const result = ensureAveHomePrivate(dir, {
      platform: "win32",
      run: (file, args) => {
        if (file === win32SystemBinary("whoami")) return `"example","${OWNER_SID}"`;
        if (args[0] === failedPath && failure.endsWith("icacls")) throw new Error("ACL command failed");
        return "";
      },
      readDacl: (path) => {
        if (path === failedPath && failure.endsWith("read-back")) throw new Error("ACL read failed");
        return path === failedPath && failure.endsWith("mismatch") ? "D:" : OWNER_DACL;
      },
    });
    expect(result).toMatchObject({ enforcement: "none", home: dir, failedPath });
    setAveHomePrivacyAtBoot(result);
    if (process.platform === "win32") expect(() => assertAveHomePrivacyForConfinement()).toThrow(failedPath);
  });

  // Only a real Windows kernel can say whether the DACL took: the argv test
  // above proves what is asked for, this proves what NTFS actually stored.
  // Runs on the `windows-permission-tests` CI job.
  it.runIf(process.platform === "win32")(
    "leaves the real directory readable to this account and to nobody else",
    () => {
      const dir = home();
      mkdirSync(dir);
      const inherited = readWindowsDirectoryDacl(dir);
      expect(inherited).toContain("ID;");
      const applied = ensureAveHomePrivate(dir);
      expect(applied.enforcement).toBe("win32-dacl");

      const sid = (applied as { sid: string }).sid;
      for (const path of [dir, join(dir, "secrets")]) {
        const sddl = readWindowsDirectoryDacl(path);
        console.info(`Verified relocated private directory SDDL: ${sddl}`);
        expect(sddl).toMatch(/^D:P(?:AI|AR)*\(A;OICI;FA;;;S-1-[0-9-]+\)$/);
        expect(sddl).toContain(`;;;${sid})`);
      }

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
      const mismatch = ensureAveHomePrivate(dir, {
        platform: "win32",
        run: (file, args) => execFileSync(file, [...args], { encoding: "utf-8", windowsHide: true }),
        readDacl: (path) => `${readWindowsDirectoryDacl(path)}(A;OICI;FR;;;S-1-1-0)`,
      });
      expect(mismatch.enforcement).toBe("none");
      setAveHomePrivacyAtBoot(mismatch);
      expect(() => assertAveHomePrivacyForConfinement()).toThrow(dir);
    },
  );
});
