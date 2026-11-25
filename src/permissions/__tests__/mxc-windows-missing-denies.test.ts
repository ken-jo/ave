import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { removeLinksUnder } from "../../__tests__/support/tmp-dir-teardown.js";
import { admitMxcLists, rankAdmittedMxcLists, rankMxcLists } from "../../__tests__/support/mxc-policy-rows.js";
import type { MxcShellPolicyLists } from "../../tools/mxc-shell-launch.js";
import { configureHostResources } from "../../main/host-resources.js";
import { localFs } from "../../shared/local-path-io.js";
import * as policyHome from "../../shared/policy-home.js";
import * as facts from "../../shared/windows-path-facts.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { getDefaultSensitiveWriteDenyPaths, getProtectedReadDenyFloor } from "../asrt-sandbox.js";
import { buildMandatorySandboxWritePolicy } from "../sandbox-write-policy.js";
import { assertMxcDenyOutcomes, buildMxcShellRequest, isWindowsPathAtOrUnder, mxcRequestArgs, powerShellMxcCommandLine, resolveHostWxcExecPath, type MxcDenyException, type MxcDirectoryEntry, type MxcFilesystemGrants } from "../mxc-windows.js";
import { SENSITIVE_PATH_PATTERNS } from "../sensitive-paths.js";
import { consumeObligations } from "../admitted-obligation.js";

afterEach(() => vi.restoreAllMocks());

function withMxcWorkspace(run: (root: string) => void): void {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mxc-denies-")));
  try {
    run(root);
  } finally {
    // A forced recursive removal stops silently at a junction whose target it already removed.
    removeLinksUnder(root);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("missing deny parents", () => {
  const root = String.raw`C:\Users\alice\work`;
  const policy = (denies: string[]) => ({ allowWrite: [root], allowRead: [], denyRead: denies, denyWrite: [], protectedFloor: [] });
  const exists = (path: string) => isWindowsPathAtOrUnder(root, path);

  it.runIf(process.platform === "win32")("raises admitted nested denies and preserves a superset of their denied paths", () => {
    withMxcWorkspace((workspace) => {
      const original = [join(workspace, "a", "b", ".ssh"), join(workspace, "a", "other")];
      const grants = rankAdmittedMxcLists({ ...policy(original), allowWrite: [workspace] });
      expect(grants.denied).toEqual([join(workspace, "a")]);
      for (const deny of original) for (const probe of [deny, win32.join(deny, "child"), win32.join(deny.toUpperCase(), "future", "secret")]) {
        expect(grants.denied.some((raised) => isWindowsPathAtOrUnder(probe, raised)), probe).toBe(true);
      }
    });
  });

  it("keeps a missing leaf unchanged", () => {
    const deny = win32.join(root, ".vscode");
    expect(rankMxcLists(policy([deny]), exists).denied).toEqual([deny]);
  });

  it("names a directory-form deny without its trailing separator", () => {
    const deny = win32.join(root, "routine");
    expect(rankMxcLists(policy([`${deny}\\`]), () => true).denied).toEqual([deny]);
  });

  it("keeps a present deny unchanged", () => {
    const deny = win32.join(root, "a", "b", ".ssh");
    expect(rankMxcLists(policy([deny]), () => true).denied).toEqual([deny]);
  });

  it("fails closed if a grant disappears and raising would deny its root", () => {
    let rootChecks = 0;
    const deny = win32.join(root, "a", "b");
    const racedExists = (path: string) => path === root ? ++rootChecks === 1 : isWindowsPathAtOrUnder(win32.dirname(root), path);
    expect(() => rankMxcLists(policy([deny]), racedExists)).toThrow(/^Windows sandbox policy cannot raise/);
  });

  it("fails closed when the raised component is outside every writable grant", () => {
    const readonly = String.raw`C:\Users\bob`;
    expect(() => rankMxcLists({ ...policy([win32.join(readonly, "a", "b")]), allowRead: [readonly] },
      (path) => exists(path) || isWindowsPathAtOrUnder(readonly, path))).toThrow(/^Windows sandbox policy cannot raise/);
  });
});

describe("pattern denies", () => {
  type Kind = MxcDirectoryEntry["kind"];
  const home = String.raw`C:\Users\alice`;
  const work = win32.join(home, "work");
  const sessions = win32.join(home, ".ave", "sessions");
  const entry = (name: string, kind: Kind = "file"): MxcDirectoryEntry => ({ name, kind });
  const tree: Record<string, MxcDirectoryEntry[]> = {
    [sessions]: [entry("one", "directory"), entry("one.jsonl")],
    [win32.join(sessions, "one")]: [entry(".SSH", "directory"), entry("notes", "directory")],
    [win32.join(sessions, "one", "notes")]: [entry("id_rsa")],
    [win32.join(sessions, "one", ".SSH")]: [],
  };
  const lister = (directories: Record<string, readonly MxcDirectoryEntry[]>) => (directory: string): readonly MxcDirectoryEntry[] => {
    const entries = directories[directory];
    if (entries === undefined) throw Object.assign(new Error(`ENOENT: ${directory}`), { code: "ENOENT" });
    return entries;
  };
  const list = lister(tree);
  const existsIn = (directories: Record<string, readonly MxcDirectoryEntry[]>) => {
    const present = new Set([home, win32.join(home, ".ave"), work, ...Object.keys(directories),
      ...Object.entries(directories).flatMap(([directory, entries]) => entries.map((child) => win32.join(directory, child.name)))]);
    return (path: string) => present.has(path);
  };
  const exists = existsIn(tree);
  const policy = (denyRead: string[], allowRead = [work, sessions], allowWrite = [work]) => ({
    allowWrite, allowRead, denyRead, denyWrite: [],
    protectedFloor: [win32.join(home, ".ave")], floorPierces: [sessions],
  });
  const sessionPatterns = SENSITIVE_PATH_PATTERNS.map((pattern) => `${sessions}/${pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern}`);

  it("denies each existing match of a pattern under a read-only grant", () => {
    const grants = rankMxcLists(policy([String.raw`${sessions}\**\.ssh`, `${sessions}/**/id_rsa`]), exists, list);
    expect(grants.readonly).toEqual([sessions]);
    expect(grants.denied).toEqual([win32.join(sessions, "one", ".SSH"), win32.join(sessions, "one", "notes", "id_rsa")]);
  });

  it("adds nothing for a pattern with no match", () => {
    expect(rankMxcLists(policy([String.raw`${sessions}\**\.aws`, `${sessions}/proc/*/environ`]), exists, list).denied).toEqual([]);
  });

  it("refuses the shell, naming the pattern, when the shell could create a match", () => {
    expect(() => rankMxcLists(policy([String.raw`${work}\**\.ssh`]), exists, list))
      .toThrow(/^Windows sandbox policy cannot hold pattern deny: .*work\\\*\*\\\.ssh \(the shell can write where it matches\)$/);
  });

  it("fails closed when it cannot list the pattern's directory", () => {
    expect(() => rankMxcLists(policy([String.raw`${sessions}\**\.ssh`]), exists)).toThrow(/^Windows sandbox policy cannot hold pattern deny: .* \(no directory lister\)$/);
  });

  it.runIf(process.platform === "win32").each(["interior dot", "mixed separators", "drive case", "extended drive", "relative dot"] as const)(
    "denies the existing match in a writable root with %s",
    (spelling) => {
      withMxcWorkspace((workspace) => {
        const nested = join(workspace, "nested");
        const match = join(nested, "private.pem");
        mkdirSync(nested);
        writeFileSync(match, "");
        const pattern = {
          "interior dot": String.raw`${workspace}\.\nested\**\*.pem`,
          "mixed separators": String.raw`${workspace}/nested\**/*.pem`,
          "drive case": String.raw`${workspace[0]?.toLowerCase()}${workspace.slice(1)}\nested\**\*.pem`,
          "extended drive": `\\\\?\\${String.raw`${workspace}\nested\**\*.pem`}`,
          "relative dot": String.raw`.\nested\**\*.pem`,
        }[spelling];
        const grants = rankAdmittedMxcLists({
          allowWrite: [workspace], allowRead: [], denyRead: [], denyWrite: [],  protectedFloor: [pattern],
        });
        expect(grants).toEqual({ readwrite: [workspace], readonly: [], denied: [match] });
      });
    },
  );

  it.runIf(process.platform === "win32")("refuses to normalize a parent component after a wildcard", () => {
    withMxcWorkspace((workspace) => {
      const pattern = String.raw`${workspace}\**\..\*.pem`;
      expect(() => rankAdmittedMxcLists({
        allowWrite: [workspace], allowRead: [], denyRead: [], denyWrite: [],  protectedFloor: [pattern],
      })).toThrow(/cannot hold pattern deny.*cannot normalize the spelling/);
    });
  });

  const userPattern = (allowWrite: string[], pattern: string) => rankAdmittedMxcLists({
    allowWrite, allowRead: [], denyRead: [], denyWrite: [],  protectedFloor: [pattern],
  });

  it.runIf(process.platform === "win32").each([
    ["junction", "grant through the link"], ["junction", "pattern through the link"], ["junction", "grant and pattern through the link"],
    ["symlink", "grant through the link"], ["symlink", "pattern through the link"], ["symlink", "grant and pattern through the link"],
  ] as const)("denies the existing match with a %s and the %s", (link, spelled) => {
    withMxcWorkspace((workspace) => {
      const real = join(workspace, "real");
      const alias = join(workspace, "alias");
      const match = join(real, "nested", "private.pem");
      mkdirSync(join(real, "nested"), { recursive: true });
      writeFileSync(match, "");
      symlinkSync(real, alias, link === "junction" ? "junction" : "dir");
      const grant = spelled === "pattern through the link" ? real : alias;
      const base = spelled === "grant through the link" ? real : alias;
      expect(userPattern([grant], String.raw`${base}\nested\**\*.pem`)).toEqual({ readwrite: [real], readonly: [], denied: [match] });
    });
  });

  it.runIf(process.platform === "win32")("drops a write grant inside a protected floor row instead of granting beneath it", () => {
    withMxcWorkspace((workspace) => {
      const inner = join(workspace, "inner");
      mkdirSync(inner);
      expect(rankAdmittedMxcLists({
        allowWrite: [inner], allowRead: [], denyRead: [], denyWrite: [], protectedFloor: [workspace],
      })).toEqual({ readwrite: [], readonly: [], denied: [] });
    });
  });

  it.runIf(process.platform === "win32")("carries a pattern whose canonical prefix reaches no grant", () => {
    withMxcWorkspace((workspace) => {
      const grant = join(workspace, "work");
      const other = join(workspace, "other");
      mkdirSync(grant);
      mkdirSync(other);
      writeFileSync(join(other, "private.pem"), "");
      expect(userPattern([grant], String.raw`${other}\**\*.pem`)).toEqual({ readwrite: [grant], readonly: [], denied: [] });
    });
  });

  it.runIf(process.platform === "win32")("refuses a pattern whose prefix overlaps a grant but leaves it through a link", () => {
    withMxcWorkspace((workspace) => {
      const grant = join(workspace, "work");
      const outside = join(workspace, "outside");
      mkdirSync(grant);
      mkdirSync(outside);
      writeFileSync(join(outside, "private.pem"), "");
      symlinkSync(outside, join(grant, "out"), "junction");
      expect(() => userPattern([grant], String.raw`${grant}\out\**\*.pem`))
        .toThrow(/cannot hold pattern deny: .*\\out\\\*\*\\\*\.pem \(its literal prefix overlaps a grant but resolves outside every grant\)/);
    });
  });

  const hidingFromListings = (name: string) => {
    const open = localFs.opendir;
    vi.spyOn(localFs, "opendir").mockImplementation(verdict => {
      const opened = open(verdict);
      const read = opened.readSync.bind(opened);
      vi.spyOn(opened, "readSync").mockImplementation(() => {
        let entry = read();
        while (entry !== null && entry.name.toLowerCase() === name) entry = read();
        return entry;
      });
      return opened;
    });
  };

  it.runIf(process.platform === "win32").each(["prefix", "remainder after a wildcard"] as const)("accepts a literal `~digit` name in the %s", (where) => {
    withMxcWorkspace((workspace) => {
      const named = join(workspace, "foo~1");
      const match = join(named, "private.pem");
      mkdirSync(named);
      writeFileSync(match, "");
      const pattern = where === "prefix" ? String.raw`${named}\*.pem` : String.raw`${workspace}\**\foo~1\*.pem`;
      expect(userPattern([workspace], pattern)).toEqual({ readwrite: [workspace], readonly: [], denied: [match] });
    });
  });

  it.runIf(process.platform === "win32").each(["prefix", "remainder after a wildcard"] as const)("refuses a `~digit` component in the %s that resolves as a short name", (where) => {
    withMxcWorkspace((workspace) => {
      const named = join(workspace, "foo~1");
      mkdirSync(named);
      writeFileSync(join(named, "private.pem"), "");
      // A short name opens its object but is never listed: hiding the long name from listings reproduces that.
      hidingFromListings("foo~1");
      const pattern = where === "prefix" ? String.raw`${named}\*.pem` : String.raw`${workspace}\**\foo~1\*.pem`;
      expect(() => userPattern([workspace], pattern)).toThrow(/cannot hold pattern deny: .* \(foo~1 is an 8\.3 short name\)/);
    });
  });

  it.runIf(process.platform === "win32")("accepts a missing `~digit` prefix component: nothing it names exists to match", () => {
    withMxcWorkspace((workspace) => {
      expect(userPattern([workspace], String.raw`${workspace}\foo~1\*.pem`)).toEqual({ readwrite: [workspace], readonly: [], denied: [] });
    });
  });

  it.runIf(process.platform === "win32")("refuses, naming the row, when a walk root becomes a link after admission", () => {
    withMxcWorkspace((workspace) => {
      const sub = join(workspace, "sub");
      mkdirSync(sub);
      writeFileSync(join(sub, "private.pem"), "");
      const pattern = String.raw`${sub}\**\*.pem`;
      // Swap the prefix directory for a junction to its moved contents once its admission has pinned it.
      const pin = facts.pinWindowsPaths;
      vi.spyOn(facts, "pinWindowsPaths").mockImplementation(paths => {
        const pinned = pin(paths);
        if (paths.includes(sub) && !existsSync(`${sub}-moved`)) {
          renameSync(sub, `${sub}-moved`);
          symlinkSync(`${sub}-moved`, sub, "junction");
        }
        return pinned;
      });
      expect(() => rankAdmittedMxcLists({
        allowWrite: [], allowRead: [workspace], denyRead: [], denyWrite: [],  protectedFloor: [pattern],
      })).toThrow(`Windows sandbox policy cannot hold pattern deny: ${pattern} (A pattern deny root changed while expanding a read deny)`);
    });
  });

  it.runIf(process.platform === "win32")("keeps a writable root and denies the existing pattern match at the walk cap", () => {
    withMxcWorkspace((workspace) => {
      const match = join(workspace, "private.pem");
      writeFileSync(match, "");
      writeFileSync(join(workspace, "public.txt"), "");
      const entries = readdirSync(workspace, { withFileTypes: true });
      const ordinary = entries.find(row => row.name === "public.txt");
      const denied = entries.find(row => row.name === "private.pem");
      assert(ordinary && denied, "Expected both pattern walk fixture entries");
      const open = localFs.opendir;
      let ordinaryCount = 19_999;
      const directories = vi.spyOn(localFs, "opendir").mockImplementation(verdict => {
        const opened = open(verdict);
        let index = 0;
        vi.spyOn(opened, "readSync").mockImplementation(() => {
          if (index++ < ordinaryCount) return ordinary;
          return index === ordinaryCount + 1 ? denied : null;
        });
        return opened;
      });
      const rank = () => rankAdmittedMxcLists({
        allowWrite: [workspace], allowRead: [], denyRead: [], denyWrite: [],
        protectedFloor: [join(workspace, "**", "*.pem"), join(workspace, "**", "*.key")],
      });
      expect(rank()).toEqual({ readwrite: [workspace], readonly: [], denied: [match] });
      expect(directories).toHaveBeenCalledTimes(1);
      ordinaryCount += 1;
      expect(rank).toThrow(/Windows sandbox policy cannot hold pattern deny: .*more than 20000 entries to check/);
    });
  });

  it.runIf(process.platform === "win32")("counts pattern walk entries across admitted roots", () => {
    withMxcWorkspace((workspace) => {
      const first = join(workspace, "first");
      const second = join(workspace, "second");
      mkdirSync(first);
      mkdirSync(second);
      writeFileSync(join(first, "public.txt"), "");
      const [ordinary] = readdirSync(first, { withFileTypes: true });
      assert(ordinary, "Expected the pattern walk fixture entry");
      const open = localFs.opendir;
      vi.spyOn(localFs, "opendir").mockImplementation(verdict => {
        const opened = open(verdict);
        const count = opened.path === first ? 12_000 : 9_000;
        let index = 0;
        vi.spyOn(opened, "readSync").mockImplementation(() => index++ < count ? ordinary : null);
        return opened;
      });
      const rank = (allowRead: string[]) => rankAdmittedMxcLists({
        allowRead, allowWrite: [], denyRead: [], denyWrite: [],  protectedFloor: ["**/*.pem"],
      });
      expect(rank([first]).denied).toEqual([]);
      expect(() => rank([first, second])).toThrow(/more than 20000 entries to check/);
    });
  });

  it("holds every sensitive pattern over a large session store within one shell start", () => {
    const directories: Record<string, MxcDirectoryEntry[]> = { [sessions]: [] };
    for (let index = 0; index < 1_990; index += 1) {
      directories[sessions]!.push(entry(`session-${index}`, "directory"));
      directories[win32.join(sessions, `session-${index}`)] = Array.from({ length: 9 }, (_, file) => entry(`part-${file}.jsonl`));
    }
    directories[win32.join(sessions, "session-5")]!.push(entry(".ssh", "directory"));
    directories[win32.join(sessions, "session-5", ".ssh")] = [];
    directories[win32.join(sessions, "session-7")]!.push(entry("id_rsa"));
    const started = performance.now();
    const grants = rankMxcLists(policy(sessionPatterns), existsIn(directories), lister(directories));
    const elapsed = performance.now() - started;
    expect(grants.denied).toEqual([win32.join(sessions, "session-5", ".ssh"), win32.join(sessions, "session-7", "id_rsa")]);
    // One pass over 19,9xx entries; a walk per pattern takes seconds here.
    expect(elapsed).toBeLessThan(1_500);
  });

  it("denies a reparse-point directory it cannot walk as a whole, and leaves links alone", () => {
    const directories = { [sessions]: [entry("cloud", "reparse-directory"), entry("elsewhere", "link"), entry("id_rsa", "link")] };
    expect(rankMxcLists(policy([`${sessions}/**/id_rsa`]), existsIn(directories), lister(directories)).denied)
      .toEqual([win32.join(sessions, "cloud"), win32.join(sessions, "id_rsa")]);
  });

  it("skips a directory removed during the walk and refuses, naming the pattern and root, on any other listing error", () => {
    const gone = { [sessions]: [entry("gone", "directory"), entry("id_rsa")] };
    expect(rankMxcLists(policy([`${sessions}/**/id_rsa`]), existsIn(gone), lister(gone)).denied).toEqual([win32.join(sessions, "id_rsa")]);
    const locked = (directory: string): readonly MxcDirectoryEntry[] => {
      if (directory === sessions) return [entry("locked", "directory")];
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    expect(() => rankMxcLists(policy([`${sessions}/**/id_rsa`]), exists, locked))
      .toThrow(/^Windows sandbox policy cannot hold pattern deny: .*id_rsa \(cannot list .*locked under .*sessions: EACCES: permission denied\)$/);
  });

  it("drops a match removed before the policy is handed over", () => {
    const removed = new Set([win32.join(sessions, "one"), win32.join(sessions, "one", "notes"), win32.join(sessions, "one", "notes", "id_rsa")]);
    let walked = false;
    const listOnce = (directory: string) => { walked = true; return list(directory); };
    const vanishing = (path: string) => exists(path) && !(walked && removed.has(path));
    expect(rankMxcLists(policy([`${sessions}/**/id_rsa`]), vanishing, listOnce).denied).toEqual([]);
  });

  it.runIf(process.platform === "win32")("denies pattern matches inside an admitted read pierce beside a writable workspace", () => {
    withMxcWorkspace((root) => {
      const workspace = join(root, "work");
      const certs = join(root, "certs");
      const nested = join(certs, "nested");
      const deny = join(nested, "private.pem");
      mkdirSync(workspace);
      mkdirSync(nested, { recursive: true });
      writeFileSync(deny, "");
      writeFileSync(join(nested, "public.txt"), "");
      const grants = rankAdmittedMxcLists({
        allowWrite: [workspace], allowRead: [workspace, certs], denyRead: [], denyWrite: [],
        protectedFloor: [certs, join(certs, "**", "*.pem")], floorPierces: [certs],
      });
      expect(grants.readwrite).toEqual([workspace]);
      expect(grants.readonly).toEqual([certs]);
      expect(grants.denied).toEqual([deny]);
    });
  });

  it.runIf(process.platform === "win32")("lifts the admitted pierce across case and separators while retaining other floor rows", () => {
    withMxcWorkspace((root) => {
      const certs = join(root, "certs");
      const pierce = certs.toLowerCase().replaceAll("\\", "/");
      const config = join(root, "config");
      const deny = join(certs, "private.pem");
      mkdirSync(certs);
      mkdirSync(config);
      writeFileSync(deny, "");
      const grants = rankAdmittedMxcLists({
        allowWrite: [root], allowRead: [certs],
        denyRead: [], denyWrite: [],
        protectedFloor: [`${certs}\\`, `${config}\\`, `${pierce}/**/*.pem`], floorPierces: [pierce],
      });
      expect(grants.readonly).toEqual([certs]);
      expect(grants.denied.map((path) => path.toLowerCase()).sort()).toEqual([deny, config].map((path) => path.toLowerCase()).sort());
    });
  });

  it("walks a read-only grant that sits behind a link inside the prefix, and lists a nested root only once", () => {
    const inner = win32.join(sessions, "j", "inner");
    const behindLink = { [sessions]: [entry("j", "link")], [inner]: [entry("id_rsa")] };
    expect(rankMxcLists(policy([`${sessions}/**/id_rsa`], [sessions, inner]), existsIn(behindLink), lister(behindLink)).denied)
      .toEqual([win32.join(inner, "id_rsa")]);
    const nested = win32.join(sessions, "inner");
    const files = (count: number) => Array.from({ length: count }, (_, index) => entry(`file-${index}`));
    const plain = { [sessions]: [...files(6_000), entry("inner", "directory")], [nested]: [...files(8_000), entry("id_rsa")] };
    expect(rankMxcLists(policy([`${sessions}/**/id_rsa`], [sessions, nested]), existsIn(plain), lister(plain)).denied)
      .toEqual([win32.join(nested, "id_rsa")]);
  });

  it("expands an unanchored pattern over every read-only grant, and refuses it beside a writable grant", () => {
    const other = win32.join(home, "notes");
    const directories = { ...tree, [other]: [entry("id_rsa")] };
    expect(rankMxcLists(policy(["**/id_rsa", ".SSH"], [sessions, other], []), existsIn(directories), lister(directories)).denied)
      .toEqual([win32.join(sessions, "one", ".SSH"), win32.join(sessions, "one", "notes", "id_rsa"), win32.join(home, "notes", "id_rsa")]);
    expect(() => rankMxcLists(policy(["**/.ssh"]), exists, list))
      .toThrow(/^Windows sandbox policy cannot hold pattern deny: \*\*\\\.ssh \(an unanchored pattern reaches a writable grant\)$/);
  });
});

describe.skipIf(process.platform !== "win32")("native missing deny parents", () => {
  it("starts with no denies, a missing leaf, nested denies and mandatory workspace denies", async (context) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    await requireMxcCapability(context.skip);
    const launcher = await resolveHostWxcExecPath();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "example-mxc-missing-")));
    const home = join(directory, "alice");
    mkdirSync(home);
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([home]);
    const sensitive = getDefaultSensitiveWriteDenyPaths();
    const mandatory = buildMandatorySandboxWritePolicy([directory], undefined, sensitive);
    const workspaceDenies = [...sensitive, ...mandatory.denyWrite.map((entry) => typeof entry === "string" ? entry : entry.path)];
    const floor = getProtectedReadDenyFloor();
    try {
      expect(existsSync(join(directory, ".claude"))).toBe(false);
      expect(existsSync(join(directory, ".idea"))).toBe(false);
      writeFileSync(join(directory, "routine"), "");
      for (const [label, denies] of [["none", []], ["leaf", [join(directory, ".vscode")]], ["file in directory form", [`${join(directory, "routine")}\\`]],
        ["nested", [join(directory, "a", "b", ".ssh")]], ["workspace", workspaceDenies]] as const) {
        // A floor row in directory form over a placeholder file, as `~/.ave/routine` can be.
        const floorRow = label === "file in directory form";
        const grants = rankMxcLists({ allowWrite: [directory], allowRead: [], denyRead: floorRow ? denies : [],
          denyWrite: floorRow ? [] : denies, protectedFloor: label === "workspace" ? floor : [] }, existsSync);
        const request = buildMxcShellRequest({ commandLine: powerShellMxcCommandLine(process.env.SystemRoot!, "exit 0"), cwd: directory, grants,
          env: { SYSTEMROOT: process.env.SystemRoot!, LOCALAPPDATA: directory }, proxyUrl: "http://127.0.0.1:9", timeoutMs: TOOL_TIMEOUT_POLICY.shellDefaultMs });
        const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult, reject) => {
          execFile(launcher, mxcRequestArgs(request, launcher), { cwd: win32.dirname(launcher), windowsHide: true,
            timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs }, (error, stdout, stderr) => {
            if (error && typeof error.code !== "number") { reject(error); return; }
            resolveResult({ code: error?.code as number | undefined ?? 0, stdout, stderr });
          });
        });
        expect(result.code, `${label}: ${JSON.stringify(result)}`).toBe(0);
        const relative = (paths: readonly string[]) => paths.filter((path) => isWindowsPathAtOrUnder(path, directory))
          .map((path) => win32.relative(directory, path));
        console.info(`MXC deny evidence ${JSON.stringify({ label, before: relative([...denies, ...(label === "workspace" ? floor : [])]), after: relative(grants.denied) })}`);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, TOOL_TIMEOUT_POLICY.shellDefaultMs * 5 + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs);
});

describe("excepted deny outcomes", () => {
  const cases = {
    // A floor row the saved-session read grant at the same path replaces.
    "lifted-floor": (root: string) => {
      const certs = join(root, "certs");
      mkdirSync(certs);
      return { held: certs, policy: { allowWrite: [], allowRead: [certs], denyRead: [], denyWrite: [], protectedFloor: [certs], floorPierces: [certs] } };
    },
    // A host read mask carved open by the grant at its own path.
    "read-mask-carve-out": (root: string) => {
      const home = join(root, "home");
      mkdirSync(home);
      return { held: home, policy: { allowWrite: [], allowRead: [home],  denyRead: [home], denyWrite: [], protectedFloor: [] } };
    },
  } as const;
  const outcomeInput = (policy: MxcShellPolicyLists, exceptions: (plan: ReturnType<typeof consumeObligations>) => MxcDenyException[]) => {
    const plan = consumeObligations(admitMxcLists(policy), "mxc-launch");
    const reach = plan.filter(entry => entry.polarity.effect === "allow" && entry.polarity.access !== "lookup");
    return { denies: plan.filter(entry => entry.polarity.effect === "deny"), exceptions: exceptions(plan), patterns: [], outcomes: new Map(),
      reachable: reach, reach, result: rankAdmittedMxcLists(policy) };
  };
  const evidence = (reason: keyof typeof cases, plan: ReturnType<typeof consumeObligations>): MxcDenyException => {
    const rowOf = (effect: "allow" | "deny") => {
      const entry = plan.find(candidate => candidate.polarity.effect === effect && candidate.polarity.access === "read");
      if (entry === undefined) throw new Error(`fixture has no ${effect} read row`);
      return entry.origin.row;
    };
    const row = rowOf("deny");
    const grant = rowOf("allow");
    return { reason, row, grant };
  };

  it.runIf(process.platform === "win32").each(Object.keys(cases) as (keyof typeof cases)[])("launches a %s row with its evidence, leaving the grant open", (reason) => {
    withMxcWorkspace((root) => {
      const { held, policy } = cases[reason](root);
      const grants = rankAdmittedMxcLists(policy);
      expect(grants).toEqual({ readwrite: [], readonly: [held], denied: [] });
      expect(() => assertMxcDenyOutcomes(outcomeInput(policy, plan => [evidence(reason, plan)]))).not.toThrow();
    });
  });

  it.runIf(process.platform === "win32").each(Object.keys(cases) as (keyof typeof cases)[])("refuses a %s row whose evidence is missing", (reason) => {
    withMxcWorkspace((root) => {
      const { held, policy } = cases[reason](root);
      const without = (plan: ReturnType<typeof consumeObligations>): MxcDenyException[] => {
        const valid = evidence(reason, plan);
        // The named grant is not in this launch's reach, or names no row.
        return [{ ...valid, grant: join(root, "elsewhere") }, { ...valid, grant: undefined as never }];
      };
      expect(() => assertMxcDenyOutcomes(outcomeInput(policy, () => []))).toThrow(`Windows sandbox policy left a deny without an outcome: ${held}`);
      expect(() => assertMxcDenyOutcomes(outcomeInput(policy, without))).toThrow(`Windows sandbox policy left a deny without an outcome: ${held}`);
    });
  });

  it.runIf(process.platform === "win32")("refuses a launch naming an unknown exception reason, even beside valid evidence", () => {
    withMxcWorkspace((root) => {
      const { held, policy } = cases["lifted-floor"](root);
      const input = outcomeInput(policy, plan => [evidence("lifted-floor", plan), { ...evidence("lifted-floor", plan), reason: "reviewed" as never }]);
      expect(() => assertMxcDenyOutcomes(input)).toThrow(`Windows sandbox policy named an unknown deny exception for ${held}: reviewed`);
    });
  });

  const rowAt = (plan: ReturnType<typeof consumeObligations>, effect: "allow" | "deny", target: string, access: "read" | "write" = "read") => {
    const entry = plan.find(candidate => candidate.polarity.effect === effect && candidate.polarity.access === access && candidate.target === target);
    if (entry === undefined) throw new Error(`fixture has no ${effect} ${access} row at ${target}`);
    return entry.origin.row;
  };
  // The ranker's result grants `readonly`/`readwrite` and denies nothing, so only a holding exception keeps the launch.
  const unstamped = (policy: MxcShellPolicyLists, result: Pick<MxcFilesystemGrants, "readonly" | "readwrite">,
    exceptions: (plan: ReturnType<typeof consumeObligations>) => MxcDenyException[]) =>
    ({ ...outcomeInput(policy, exceptions), result: { ...result, denied: [] } });

  it.runIf(process.platform === "win32")("refuses a read-mask-carve-out exception for a mask no grant at its own path carves", () => {
    withMxcWorkspace((root) => {
      const home = join(root, "home");
      mkdirSync(home);
      const policy = { allowWrite: [], allowRead: [root],  denyRead: [home], denyWrite: [], protectedFloor: [] };
      const result = { readwrite: [], readonly: [root] };
      expect(() => assertMxcDenyOutcomes(unstamped(policy, result, () => []))).toThrow(`Windows sandbox policy left a deny without an outcome: ${home}`);
      // The mask naming itself, and the ancestor grant that reaches it without carving it.
      expect(() => assertMxcDenyOutcomes(unstamped(policy, result, plan => [{ reason: "read-mask-carve-out", row: home, mask: home } as never,
        { reason: "read-mask-carve-out", row: home, grant: rowAt(plan, "allow", root) }])))
        .toThrow(`Windows sandbox policy left a deny without an outcome: ${home}`);
    });
  });

  it.runIf(process.platform === "win32")("refuses a lifted-floor exception whose grant is an ancestor read grant or a write grant at the same path", () => {
    withMxcWorkspace((root) => {
      const { held: certs } = cases["lifted-floor"](root);
      const ancestor = { allowWrite: [], allowRead: [root], denyRead: [], denyWrite: [], protectedFloor: [certs] };
      expect(() => assertMxcDenyOutcomes(unstamped(ancestor, { readwrite: [], readonly: [root] },
        plan => [{ reason: "lifted-floor", row: certs, grant: rowAt(plan, "allow", root) }])))
        .toThrow(`Windows sandbox policy left a deny without an outcome: ${certs}`);
      const write = { allowWrite: [certs], allowRead: [], denyRead: [], denyWrite: [], protectedFloor: [certs] };
      expect(() => assertMxcDenyOutcomes(unstamped(write, { readwrite: [certs], readonly: [] },
        plan => [{ reason: "lifted-floor", row: certs, grant: rowAt(plan, "allow", certs, "write") }])))
        .toThrow(`Windows sandbox policy left a deny without an outcome: ${certs}`);
    });
  });

  it.runIf(process.platform === "win32")("launches a read mask carved by a write grant at its own path", () => {
    withMxcWorkspace((root) => {
      const home = join(root, "home");
      mkdirSync(home);
      const policy = { allowWrite: [home], allowRead: [root],  denyRead: [home], denyWrite: [], protectedFloor: [] };
      expect(rankAdmittedMxcLists(policy)).toMatchObject({ readwrite: [home], denied: [] });
    });
  });

  it.runIf(process.platform === "win32")("refuses a read-mask-carve-out label on a write deny or a floor row", () => {
    withMxcWorkspace((root) => {
      const certs = join(root, "certs");
      mkdirSync(certs);
      const carve = (): MxcDenyException[] => [{ reason: "read-mask-carve-out", row: certs, grant: certs }];
      const write = { allowWrite: [certs], allowRead: [], denyRead: [], denyWrite: [certs], protectedFloor: [] };
      expect(() => assertMxcDenyOutcomes(unstamped(write, { readwrite: [certs], readonly: [] }, () => [])))
        .toThrow(`Windows sandbox policy left a deny without an outcome: ${certs}`);
      expect(() => assertMxcDenyOutcomes(unstamped(write, { readwrite: [certs], readonly: [] }, carve)))
        .toThrow(`Windows sandbox policy left a deny without an outcome: ${certs}`);
      const floor = { allowWrite: [], allowRead: [certs], denyRead: [], denyWrite: [], protectedFloor: [certs], floorPierces: [certs] };
      expect(() => assertMxcDenyOutcomes(unstamped(floor, { readwrite: [], readonly: [certs] }, carve)))
        .toThrow(`Windows sandbox policy left a deny without an outcome: ${certs}`);
    });
  });

  it.runIf(process.platform === "win32")("refuses a lifted-floor label on a write deny with a read grant at the same path", () => {
    withMxcWorkspace((root) => {
      const certs = join(root, "certs");
      mkdirSync(certs);
      const policy = { allowWrite: [certs], allowRead: [certs], denyRead: [], denyWrite: [certs], protectedFloor: [] };
      expect(() => assertMxcDenyOutcomes(unstamped(policy, { readwrite: [certs], readonly: [] },
        plan => [{ reason: "lifted-floor", row: certs, grant: rowAt(plan, "allow", certs) }])))
        .toThrow(`Windows sandbox policy left a deny without an outcome: ${certs}`);
    });
  });

  it.runIf(process.platform === "win32")("ignores an unused exception with stale evidence, and never lends it to another row", () => {
    withMxcWorkspace((root) => {
      const keys = join(root, "keys");
      const { held: certs, policy: lifted } = cases["lifted-floor"](root);
      mkdirSync(keys);
      const policy = { ...lifted, protectedFloor: [keys, certs] };
      // Named for the unreached keys row; its grant is the certs grant, at another path.
      const stale = (plan: ReturnType<typeof consumeObligations>): MxcDenyException =>
        ({ reason: "lifted-floor", row: rowAt(plan, "deny", keys), grant: rowAt(plan, "allow", certs) });
      const certsException = (plan: ReturnType<typeof consumeObligations>): MxcDenyException =>
        ({ reason: "lifted-floor", row: rowAt(plan, "deny", certs), grant: rowAt(plan, "allow", certs) });
      expect(() => assertMxcDenyOutcomes(outcomeInput(policy, plan => [stale(plan), certsException(plan)]))).not.toThrow();
      expect(() => assertMxcDenyOutcomes(outcomeInput(policy, plan => [stale(plan)])))
        .toThrow(`Windows sandbox policy left a deny without an outcome: ${certs}`);
    });
  });
});
