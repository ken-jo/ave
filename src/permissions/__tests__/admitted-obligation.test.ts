// windows-permission
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";
import { inspectShellExecution } from "../../shared/shell-execution.js";
import {
  admitObligations, consumeObligations, isIssuedObligation, ObligationRefusedError, requireEnforceable,
  type ObligationRow, type Polarity,
  observeWindowsShellDirectories,
} from "../admitted-obligation.js";
import { rankAdmittedMxcLists } from "../../__tests__/support/mxc-policy-rows.js";
import { captureShellWorkingDirectoryIdentity, matchesShellWorkingDirectoryIdentity } from "../shell-working-directory-identity.js";

// The shared setup answers every drive as local; these checks read synthetic drive mappings.
vi.unmock("../../shared/windows-drive-locality.js");

const DENY_READ: Polarity = { effect: "deny", access: "read" };
const ALLOW_READ: Polarity = { effect: "allow", access: "read" };
const deny = (spelling: string): ObligationRow => ({ spelling, polarity: DENY_READ, source: "settings" });
const allow = (spelling: string): ObligationRow => ({ spelling, polarity: ALLOW_READ, source: "settings" });

describe.runIf(process.platform === "win32")("admitObligations", () => {
  let root: string;
  beforeAll(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "obligation-")));
    mkdirSync(join(root, "secrets", "nested"), { recursive: true });
    writeFileSync(join(root, "secrets", "a.env"), "");
    writeFileSync(join(root, "notes[1].txt"), "");
    writeFileSync(join(root, "notes1.txt"), "");
    mkdirSync(join(root, "work"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => setWindowsDriveQueryForTest());
  const local = (drive: string) => setWindowsDriveQueryForTest(letter => letter === drive ? null : String.raw`\Device\HarddiskVolume3`);

  it("preserves both Bash cd outcomes when Windows directory admission is unresolved", () => {
    const observed: string[] = [];
    const run = () => inspectShellExecution("if cd work; then echo entered; else echo stayed; fi", root, { dialect: "bash", environment: {} }, {
      path() {},
      observeDirectory: observeWindowsShellDirectories,
      command(event) {
        if (event.argv[0] === "echo") observed.push(event.argv[1] ?? "");
      },
    });
    const work = join(root, "work");
    expect(observeWindowsShellDirectories(work, work)).toBe("directory");
    run();
    expect(observed).toEqual(["entered"]);
    observed.length = 0;
    local(root.slice(0, 2));
    expect(observeWindowsShellDirectories(work, work)).toBe("unknown");
    run();
    expect(observed).toEqual(["entered", "stayed"]);
  });

  it("admits an existing local file and directory with identity and chain", () => {
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(join(root, "secrets")), deny(join(root, "secrets", "a.env"))] });
    expect(set.unresolved).toEqual([]);
    const [dir, file] = set.admitted;
    expect(dir).toMatchObject({ target: join(root, "secrets"), kind: "dir", enforcement: "acl-exact", followCapable: true });
    expect(file).toMatchObject({ target: join(root, "secrets", "a.env"), kind: "file" });
    expect(file?.identity?.fileId).toMatch(/^0x[0-9a-f]{32}$/u);
    expect(file?.parent).toEqual(dir?.identity);
    expect(file?.chain.at(-1)).toEqual(file?.identity);
    expect(file?.chain.length).toBeGreaterThan(2);
    expect(Object.isFrozen(file) && Object.isFrozen(file?.chain) && Object.isFrozen(set)).toBe(true);
    expect(isIssuedObligation(file)).toBe(true);
    expect(isIssuedObligation({ ...file })).toBe(false);
  });

  it("projects a target missing two levels below its deepest existing ancestor", () => {
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(join(root, "work", "a", "b")), deny(`${join(root, "work", "c")}\\`)] });
    const work = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(join(root, "work"))] }).admitted[0];
    expect(set.unresolved).toEqual([]);
    expect(set.admitted[0]).toMatchObject({ target: join(root, "work", "a", "b"), kind: "missing", identity: null, directory: false, enforcement: "acl-placeholder" });
    expect(set.admitted[0]?.anchor).toEqual(work?.identity);
    expect(set.admitted[1]).toMatchObject({ target: join(root, "work", "c"), kind: "missing", directory: true });
  });

  it("takes a path beneath a file, a short name and a marked literal as the objects they name", () => {
    const file = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(join(root, "secrets", "a.env"))] }).admitted[0];
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [
      deny(join(root, "secrets", "a.env", ".vscode")), deny(join(root, "OTHER~1", "locked")),
      { spelling: { path: join(root, "Work %HOMEPATH%", "profile.ps1"), literal: true }, polarity: DENY_READ, source: "floor" },
    ] });
    expect(set.unresolved).toEqual([]);
    expect(set.admitted.map(entry => [entry.target, entry.kind])).toEqual([
      [join(root, "secrets", "a.env", ".vscode"), "missing"], [join(root, "OTHER~1", "locked"), "missing"],
      [join(root, "Work %HOMEPATH%", "profile.ps1"), "missing"],
    ]);
    expect(set.admitted[0]?.anchor).toEqual(file?.identity);
  });

  it("drops POSIX-only rows as inapplicable before any lookup", () => {
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny("/etc/cron.d"), deny("/tmp/claude")] });
    expect(set.inapplicable.map(row => row.row)).toEqual(["/etc/cron.d", "/tmp/claude"]);
    expect(set.admitted).toEqual([]);
    expect(set.unresolved).toEqual([]);
  });

  it.each([
    [String.raw`\Users\alice\.ssh`, "unbound-rooted"],
    ["C:alice", "drive-relative"],
    [String.raw`alice\.ssh`, "relative"],
    [String.raw`\\example\share\alice`, "share"],
    [String.raw`\\.\pipe\example`, "device"],
    [String.raw`C:\Users\alice\notes.`, "device"],
    [String.raw`C:\Users\alice\notes.txt:hidden`, "device"],
    [String.raw`C:\Users\alice\CON`, "device"],
  ] as const)("leaves %s unresolved as %s without a lookup", (spelling, reason) => {
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(spelling)] });
    expect(set.unresolved.map(row => row.reason)).toEqual([reason]);
  });

  it("anchors a rooted row to its bound base", () => {
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", boundBase: root.slice(0, 2) as `${string}:`, rows: [deny(join(root, "secrets").slice(2))] });
    expect(set.admitted[0]?.target).toBe(join(root, "secrets"));
  });

  it("reads a mapped or substituted drive's mapping before opening it", () => {
    setWindowsDriveQueryForTest(letter => letter === "Y:" ? String.raw`\??\UNC\example\share` : letter === "W:" ? String.raw`\??\C:\alice` : String.raw`\Device\HarddiskVolume3`);
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(String.raw`Y:\alice`), deny(String.raw`W:\alice`)] });
    expect(set.unresolved.map(row => row.reason)).toEqual(["mapped-drive", "subst"]);
    local("Q:");
    expect(admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(String.raw`Q:\alice`)] }).unresolved[0]?.reason).toBe("helper-unavailable");
  });

  it("refuses an MXC pattern deny whose literal prefix is a substituted drive", () => {
    setWindowsDriveQueryForTest(letter => letter === "W:" ? `\\??\\${root}` : String.raw`\Device\HarddiskVolume3`);
    expect(() => rankAdmittedMxcLists({
      allowWrite: [root], allowRead: [], denyRead: [], denyWrite: [], protectedFloor: [String.raw`W:\secrets\**\*.env`],
    })).toThrow(/cannot hold pattern deny: W:\\secrets\\\*\*\\\*\.env \(its literal prefix cannot be admitted: subst\)/);
  });

  it("turns a deny glob into a subtree obligation on its static base", () => {
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(join(root, "secrets", "**")), deny(join(root, "secrets", "*.env"))] });
    expect(set.unresolved).toEqual([]);
    expect(set.admitted.map(row => [row.target, row.extent, row.enforcement])).toEqual([
      [join(root, "secrets"), "subtree", "acl-subtree"], [join(root, "secrets"), "subtree", "acl-subtree"],
    ]);
  });

  it("refuses a deny glob whose base holds a grant or is a volume root", () => {
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox",
      rows: [
        allow(join(root, "secrets", "nested")),
        deny(join(root, "secrets", "*.env")),
        deny(join(root, "secrets", "**")),
        deny(`${root.slice(0, 3)}*.env`),
      ] });
    expect(set.unresolved.map(row => row.reason)).toEqual(["glob-not-subtree", "glob-not-subtree", "glob-not-subtree"]);
  });

  it("refuses a deny pattern whose static base is above the profile root", () => {
    const set = admitObligations({
      purpose: "sandbox-config", principal: "srt-sandbox", unstampableRoots: [join(root, "secrets", "nested")],
      rows: [deny(join(root, "secrets", "*.env"))],
    });
    expect(set.unresolved.map(row => row.reason)).toEqual(["glob-not-subtree"]);
  });

  it("checks a write-deny pattern against write grants", () => {
    const base = join(root, "secrets");
    const nested = join(base, "nested");
    const denyWrite = { ...deny(join(base, "*.env")), polarity: { effect: "deny", access: "write" } as const };
    const set = admitObligations({
      purpose: "sandbox-config", principal: "srt-sandbox", rows: [allow(nested), denyWrite],
    });
    expect(set.unresolved).toEqual([]);
    expect(set.admitted).toContainEqual(expect.objectContaining({ target: base, extent: "subtree" }));
  });

  it("refuses a deny on a volume root or the profile root", () => {
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", unstampableRoots: [join(root, "work")],
      rows: [deny(root.slice(0, 3)), deny(join(root, "work"))] });
    expect(set.unresolved.map(row => row.reason)).toEqual(["root-level", "unstampable-no-evidence"]);
  });

  it("enumerates an allow glob with brackets as name characters, and grants B\\** as one subtree", () => {
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [allow(join(root, "notes[1].txt")), allow(join(root, "notes*.txt")), allow(join(root, "work", "**"))] });
    expect(set.unresolved).toEqual([]);
    expect(set.admitted.map(row => row.target).sort()).toEqual([join(root, "notes1.txt"), join(root, "notes[1].txt"), join(root, "notes[1].txt"), join(root, "work")].sort());
    expect(set.admitted.find(row => row.target === join(root, "work"))).toMatchObject({ extent: "subtree", enforcement: "acl-subtree" });
  });

  it("refuses confinement for an unresolved deny but only withholds an unresolved allow", () => {
    setWindowsDriveQueryForTest(letter => letter === "Y:" ? String.raw`\??\UNC\example\share` : String.raw`\Device\HarddiskVolume3`);
    const allowOnly = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [allow(String.raw`Y:\alice`)] });
    expect(() => requireEnforceable(allowOnly)).not.toThrow();
    const denied = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(String.raw`Y:\alice`)] });
    expect(() => requireEnforceable(denied)).toThrow(ObligationRefusedError);
    const worker = admitObligations({ purpose: "worker-grant", principal: "srt-sandbox", rows: [{ spelling: String.raw`Y:\alice`, polarity: ALLOW_READ, source: "worker-request" }] });
    expect(() => requireEnforceable(worker)).toThrow(expect.objectContaining({ code: "sandbox-obligation-unenforceable" }));
  });

  it("accepts only sets it issued, for the purpose they were issued for", () => {
    const set = admitObligations({ purpose: "shell-cwd", principal: "host-lookup", rows: [allow(root)] });
    expect(set.admitted[0]?.enforcement).toBe("lookup");
    expect(consumeObligations(set, "shell-cwd")).toBe(set.admitted);
    expect(() => consumeObligations(set, "git-pin")).toThrow(TypeError);
    expect(() => consumeObligations({ ...set }, "shell-cwd")).toThrow(TypeError);
    expect(() => requireEnforceable({ ...set })).toThrow(TypeError);
  });

  it("binds the shell working directory only while its drive is proven local", () => {
    const cwd = join(root, "work");
    const localIdentity = captureShellWorkingDirectoryIdentity(cwd);
    if (localIdentity === undefined) throw new Error("The local working directory was not admitted");
    expect(localIdentity).toMatchObject({ realpath: cwd });
    expect(matchesShellWorkingDirectoryIdentity(cwd, localIdentity)).toBe(true);
    const rootDrive = cwd.slice(0, 2).toUpperCase();
    setWindowsDriveQueryForTest(letter => letter.toUpperCase() === rootDrive
      ? "\\??\\UNC\\example\\share" : null);
    expect(captureShellWorkingDirectoryIdentity(cwd)).toBeUndefined();
    expect(matchesShellWorkingDirectoryIdentity(cwd, localIdentity)).toBe(false);
  });
});
