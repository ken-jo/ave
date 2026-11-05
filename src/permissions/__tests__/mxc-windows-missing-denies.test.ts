import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as policyHome from "../../shared/policy-home.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { getDefaultSensitiveWriteDenyPaths, getProtectedReadDenyFloor } from "../asrt-sandbox.js";
import { buildMandatorySandboxWritePolicy } from "../sandbox-write-policy.js";
import { buildMxcShellRequest, isWindowsPathAtOrUnder, mxcRequestArgs, powerShellMxcCommandLine, rankMxcFilesystem, resolveHostWxcExecPath, type MxcDirectoryEntry } from "../mxc-windows.js";
import { SENSITIVE_PATH_PATTERNS } from "../sensitive-paths.js";

afterEach(() => vi.restoreAllMocks());

describe("missing deny parents", () => {
  const root = String.raw`C:\Users\alice\work`;
  const policy = (denies: string[]) => ({ allowWrite: [root], allowRead: [], denyRead: denies, denyWrite: [], protectedFloor: [] });
  const exists = (path: string) => isWindowsPathAtOrUnder(root, path);

  it("raises nested denies and preserves a superset of their denied paths", () => {
    const original = [win32.join(root, "a", "b", ".ssh"), win32.join(root, "a", "other")];
    const grants = rankMxcFilesystem(policy(original), exists);
    expect(grants.denied).toEqual([win32.join(root, "a")]);
    for (const deny of original) for (const probe of [deny, win32.join(deny, "child"), win32.join(deny.toUpperCase(), "future", "secret")]) {
      expect(grants.denied.some((raised) => isWindowsPathAtOrUnder(probe, raised)), probe).toBe(true);
    }
  });

  it("keeps a missing leaf unchanged", () => {
    const deny = win32.join(root, ".vscode");
    expect(rankMxcFilesystem(policy([deny]), exists).denied).toEqual([deny]);
  });

  it("names a directory-form deny without its trailing separator", () => {
    const deny = win32.join(root, "routine");
    expect(rankMxcFilesystem(policy([`${deny}\\`]), () => true).denied).toEqual([deny]);
  });

  it("keeps a present deny unchanged", () => {
    const deny = win32.join(root, "a", "b", ".ssh");
    expect(rankMxcFilesystem(policy([deny]), () => true).denied).toEqual([deny]);
  });

  it("fails closed if a grant disappears and raising would deny its root", () => {
    let rootChecks = 0;
    const deny = win32.join(root, "a", "b");
    const racedExists = (path: string) => path === root ? ++rootChecks === 1 : isWindowsPathAtOrUnder(win32.dirname(root), path);
    expect(() => rankMxcFilesystem(policy([deny]), racedExists)).toThrow(/^Windows sandbox policy cannot raise/);
  });

  it("fails closed when the raised component is outside every writable grant", () => {
    const readonly = String.raw`C:\Users\bob`;
    expect(() => rankMxcFilesystem({ ...policy([win32.join(readonly, "a", "b")]), allowRead: [readonly] },
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
    const grants = rankMxcFilesystem(policy([String.raw`${sessions}\**\.ssh`, `${sessions}/**/id_rsa`]), exists, list);
    expect(grants.readonly).toEqual([sessions]);
    expect(grants.denied).toEqual([win32.join(sessions, "one", ".SSH"), win32.join(sessions, "one", "notes", "id_rsa")]);
  });

  it("adds nothing for a pattern with no match", () => {
    expect(rankMxcFilesystem(policy([String.raw`${sessions}\**\.aws`, `${sessions}/proc/*/environ`]), exists, list).denied).toEqual([]);
  });

  it("refuses the shell, naming the pattern, when the shell could create a match", () => {
    expect(() => rankMxcFilesystem(policy([String.raw`${work}\**\.ssh`]), exists, list))
      .toThrow(/^Windows sandbox policy cannot hold pattern deny: .*work\\\*\*\\\.ssh \(the shell can write where it matches\)$/);
  });

  it("fails closed when it cannot list the pattern's directory", () => {
    expect(() => rankMxcFilesystem(policy([String.raw`${sessions}\**\.ssh`]), exists)).toThrow(/^Windows sandbox policy cannot hold pattern deny: .* \(no directory lister\)$/);
  });

  it("refuses the shell with a named reason when the walk passes its cap, and holds every match at the cap", () => {
    const wide = (count: number) => (directory: string) => directory === sessions
      ? [...Array.from({ length: count }, (_, index) => entry(`session-${index}.jsonl`)), entry("id_rsa")]
      : [];
    expect(() => rankMxcFilesystem(policy([`${sessions}/**/id_rsa`]), exists, wide(20_000)))
      .toThrow(/^Windows sandbox policy cannot hold pattern deny: .*id_rsa \(more than 20000 entries to check under .*sessions\)$/);
    expect(rankMxcFilesystem(policy([`${sessions}/**/id_rsa`]), existsIn({ [sessions]: wide(19_999)(sessions) }), wide(19_999)).denied)
      .toEqual([win32.join(sessions, "id_rsa")]);
  });

  it("walks once for every pattern: the cap counts each entry once, across all roots", () => {
    const other = win32.join(home, "notes");
    const files = (count: number) => Array.from({ length: count }, (_, index) => entry(`file-${index}`));
    const directories = { [sessions]: files(12_000), [other]: files(9_000) };
    const both = policy([`${sessions}/**/id_rsa`, `${sessions}/**/.ssh`, `${sessions}/**/.aws`], [sessions]);
    expect(rankMxcFilesystem(both, existsIn(directories), lister(directories)).denied).toEqual([]);
    const twoRoots = policy([`${sessions}/**/id_rsa`, `${other}/**/id_rsa`], [sessions, other]);
    expect(() => rankMxcFilesystem(twoRoots, existsIn(directories), lister(directories))).toThrow(/more than 20000 entries to check/);
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
    const grants = rankMxcFilesystem(policy(sessionPatterns), existsIn(directories), lister(directories));
    const elapsed = performance.now() - started;
    expect(grants.denied).toEqual([win32.join(sessions, "session-5", ".ssh"), win32.join(sessions, "session-7", "id_rsa")]);
    // One pass over 19,9xx entries; a walk per pattern takes seconds here.
    expect(elapsed).toBeLessThan(1_500);
  });

  it("denies a reparse-point directory it cannot walk as a whole, and leaves links alone", () => {
    const directories = { [sessions]: [entry("cloud", "reparse-directory"), entry("elsewhere", "link"), entry("id_rsa", "link")] };
    expect(rankMxcFilesystem(policy([`${sessions}/**/id_rsa`]), existsIn(directories), lister(directories)).denied)
      .toEqual([win32.join(sessions, "cloud"), win32.join(sessions, "id_rsa")]);
  });

  it("skips a directory removed during the walk and refuses, naming the pattern and root, on any other listing error", () => {
    const gone = { [sessions]: [entry("gone", "directory"), entry("id_rsa")] };
    expect(rankMxcFilesystem(policy([`${sessions}/**/id_rsa`]), existsIn(gone), lister(gone)).denied).toEqual([win32.join(sessions, "id_rsa")]);
    const locked = (directory: string): readonly MxcDirectoryEntry[] => {
      if (directory === sessions) return [entry("locked", "directory")];
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    expect(() => rankMxcFilesystem(policy([`${sessions}/**/id_rsa`]), exists, locked))
      .toThrow(/^Windows sandbox policy cannot hold pattern deny: .*id_rsa \(cannot list .*locked under .*sessions: EACCES: permission denied\)$/);
  });

  it("drops a match removed before the policy is handed over", () => {
    const removed = new Set([win32.join(sessions, "one"), win32.join(sessions, "one", "notes"), win32.join(sessions, "one", "notes", "id_rsa")]);
    let walked = false;
    const listOnce = (directory: string) => { walked = true; return list(directory); };
    const vanishing = (path: string) => exists(path) && !(walked && removed.has(path));
    expect(rankMxcFilesystem(policy([`${sessions}/**/id_rsa`]), vanishing, listOnce).denied).toEqual([]);
  });

  it("holds the default layout: a writable workspace beside the read-only sessions root under one home", () => {
    const aveHome = win32.join(home, ".ave");
    const workspace = win32.join(aveHome, "workspace");
    const directories: Record<string, MxcDirectoryEntry[]> = {
      [aveHome]: [entry("workspace", "directory"), entry("sessions", "directory"), entry("config", "directory")],
      [workspace]: [],
      [sessions]: [entry("a", "directory")],
      [win32.join(sessions, "a")]: [entry("note.txt"), entry(".ssh", "directory")],
      [win32.join(sessions, "a", ".ssh")]: [],
    };
    const grants = rankMxcFilesystem({
      allowWrite: [workspace], allowRead: [workspace, sessions], denyRead: sessionPatterns, denyWrite: [],
      protectedFloor: [`${sessions}\\`, `${win32.join(aveHome, "config")}\\`], floorPierces: [sessions],
    }, existsIn(directories), lister(directories));
    expect(grants.readwrite).toEqual([workspace]);
    expect(grants.readonly).toEqual([sessions]);
    expect(grants.denied).toEqual([win32.join(sessions, "a", ".ssh")]);
  });

  it("walks a read-only grant that sits behind a link inside the prefix, and lists a nested root only once", () => {
    const inner = win32.join(sessions, "j", "inner");
    const behindLink = { [sessions]: [entry("j", "link")], [inner]: [entry("id_rsa")] };
    expect(rankMxcFilesystem(policy([`${sessions}/**/id_rsa`], [sessions, inner]), existsIn(behindLink), lister(behindLink)).denied)
      .toEqual([win32.join(inner, "id_rsa")]);
    const nested = win32.join(sessions, "inner");
    const files = (count: number) => Array.from({ length: count }, (_, index) => entry(`file-${index}`));
    const plain = { [sessions]: [...files(6_000), entry("inner", "directory")], [nested]: [...files(8_000), entry("id_rsa")] };
    expect(rankMxcFilesystem(policy([`${sessions}/**/id_rsa`], [sessions, nested]), existsIn(plain), lister(plain)).denied)
      .toEqual([win32.join(nested, "id_rsa")]);
  });

  it("expands an unanchored pattern over every read-only grant, and refuses it beside a writable grant", () => {
    const other = win32.join(home, "notes");
    const directories = { ...tree, [other]: [entry("id_rsa")] };
    expect(rankMxcFilesystem(policy(["**/id_rsa", ".SSH"], [sessions, other], []), existsIn(directories), lister(directories)).denied)
      .toEqual([win32.join(sessions, "one", ".SSH"), win32.join(sessions, "one", "notes", "id_rsa"), win32.join(home, "notes", "id_rsa")]);
    expect(() => rankMxcFilesystem(policy(["**/.ssh"]), exists, list))
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
        const grants = rankMxcFilesystem({ allowWrite: [directory], allowRead: [], denyRead: floorRow ? denies : [],
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
