import { stabilizeFixtureAncestorStats } from "../../__tests__/support/fixture-ancestor-stats.js";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import * as windowsPathFacts from "../../shared/windows-path-facts.js";
import { inspectGitRepository } from "../rules/git-repository-inputs.js";

vi.mock("node:child_process", { spy: true });
vi.mock("node:fs", { spy: true });
vi.mock("../../shared/windows-path-facts.js", { spy: true });

const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const ORIGINAL_PLATFORM = process.platform;
const CHILD_ENTRY_POINTS = ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"] as const;
const ORDINARY_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n[remote \"origin\"]\n\turl = https://example.invalid/repository.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n";
let root: string;
let cwd: string;

beforeEach(() => {
  vi.mocked(fs.openSync).mockImplementation(nativeFs.openSync);
  vi.mocked(fs.readSync).mockImplementation(nativeFs.readSync);
  vi.mocked(fs.fstatSync).mockImplementation(nativeFs.fstatSync);
  vi.mocked(fs.lstatSync).mockImplementation(nativeFs.lstatSync);
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "git-inputs-")));
  stabilizeFixtureAncestorStats(root);
  cwd = join(root, "workspace");
  fs.mkdirSync(join(cwd, ".git", "objects", "info"), { recursive: true });
  fs.mkdirSync(join(cwd, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(join(cwd, ".git", "config"), ORDINARY_CONFIG);
  // Platform simulations must never launch the native metadata helper.
  vi.mocked(windowsPathFacts.pinWindowsPaths).mockImplementation(paths => paths.map(path => ({
    exists: true, canonical: path, volumeSerial: "0x0000000000000001", fileId: "0x00000000000000000000000000000001",
    volumeSerialNumber: "0x0000000000000001", fileIndex: "0x0000000000000001", changeTime: "0x0000000000000001",
    attributes: 0, reparseTag: 0, reparseTarget: null, directory: fs.lstatSync(path).isDirectory(), ancestors: [],
  })));
  vi.mocked(windowsPathFacts.pinWindowsPaths).mockClear();
  for (const entry of CHILD_ENTRY_POINTS) vi.mocked(childProcess[entry]).mockClear();
});

afterEach(() => {
  setProcessPlatform(ORIGINAL_PLATFORM);
  for (const entry of CHILD_ENTRY_POINTS) expect(childProcess[entry]).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.mocked(fs.lstatSync).mockImplementation(nativeFs.lstatSync);
  fs.rmSync(root, { recursive: true, force: true });
});

function configure(text: string): void {
  fs.writeFileSync(join(cwd, ".git", "config"), text);
}

describe("checked repository metadata inputs", () => {
  it("captures stable metadata evidence without depending on access timestamps", () => {
    const first = inspectGitRepository(cwd);
    expect(first).not.toBeNull();
    expect(first).toMatchObject({ stateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    fs.readFileSync(join(cwd, ".git", "HEAD"));
    expect(inspectGitRepository(cwd)).toEqual(first);
  });

  it("changes evidence conservatively when unrelated workspace entries change", () => {
    const first = inspectGitRepository(cwd);
    expect(first).not.toBeNull();
    fs.mkdirSync(join(cwd, "ordinary-directory"));
    fs.writeFileSync(join(cwd, "ordinary-output"), "temporary output");
    const second = inspectGitRepository(cwd);
    expect(second).not.toBeNull();
    expect(second!.stateFingerprint).not.toBe(first!.stateFingerprint);
  });

  it("changes evidence after the workspace root is renamed and restored", () => {
    const first = inspectGitRepository(cwd);
    expect(first).not.toBeNull();
    const moved = join(root, "detached-workspace");
    fs.renameSync(cwd, moved);
    fs.renameSync(moved, cwd);
    const second = inspectGitRepository(cwd);
    expect(second).not.toBeNull();
    expect(second!.stateFingerprint).not.toBe(first!.stateFingerprint);
  });

  it("changes evidence after a physical ancestor is renamed and restored", () => {
    const first = inspectGitRepository(cwd);
    expect(first).not.toBeNull();
    const moved = root + "-detached";
    fs.renameSync(root, moved);
    fs.renameSync(moved, root);
    const second = inspectGitRepository(cwd);
    expect(second).not.toBeNull();
    expect(second!.stateFingerprint).not.toBe(first!.stateFingerprint);
  });

  it("bounds physical ancestor depth", () => {
    const deeplyNested = join(cwd, ...Array.from({ length: 33 }, () => "nested"));
    fs.mkdirSync(join(deeplyNested, ".git"), { recursive: true });
    expect(inspectGitRepository(deeplyNested)).toBeNull();
  });

  it.each([
    ["a new file", () => fs.writeFileSync(join(cwd, ".git", "refs", "heads", "new"), "a".repeat(40) + "\n")],
    ["a changed HEAD", () => fs.writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/next\n")],
    ["a changed config", () => configure(ORDINARY_CONFIG + "[core]\nfilemode = false\n")],
    ["a changed index", () => fs.writeFileSync(join(cwd, ".git", "index"), "synthetic index")],
    ["a removed file", () => fs.unlinkSync(join(cwd, ".git", "HEAD"))],
    ["a new directory", () => fs.mkdirSync(join(cwd, ".git", "additional"))],
  ] as const)("changes evidence for %s", (_name, change) => {
    const first = inspectGitRepository(cwd);
    expect(first).not.toBeNull();
    change();
    const second = inspectGitRepository(cwd);
    expect(second).not.toBeNull();
    expect(second!.stateFingerprint).not.toBe(first!.stateFingerprint);
  });

  it("changes evidence for an observed metadata mode change", () => {
    const readStat = vi.mocked(fs.lstatSync).getMockImplementation()!;
    const head = nativeFs.lstatSync(join(cwd, ".git", "HEAD"), { bigint: true });
    let mode = 0o100644n;
    vi.mocked(fs.fstatSync).mockImplementation(((descriptor, options) => {
      const stat = nativeFs.fstatSync(descriptor, options);
      return options?.bigint === true && stat.ino === head.ino && stat.dev === head.dev
        ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode }) : stat;
    }) as typeof fs.fstatSync);
    vi.mocked(fs.lstatSync).mockImplementation(((path, options) => {
      const stat = readStat(path, options);
      if (path === join(cwd, ".git", "HEAD") && options?.bigint === true) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode });
      }
      return stat;
    }) as typeof fs.lstatSync);
    const first = inspectGitRepository(cwd);
    expect(first).not.toBeNull();
    mode = 0o100600n;
    const second = inspectGitRepository(cwd);
    expect(second).not.toBeNull();
    expect(second!.stateFingerprint).not.toBe(first!.stateFingerprint);
  });

  it.each([
    ["HEAD", "ref: refs/heads/main\n", "ref: refs/heads/next\n"],
    ["ORIG_HEAD", "a".repeat(40) + "\n", "b".repeat(40) + "\n"],
    ["refs/heads/main", "a".repeat(40) + "\n", "b".repeat(40) + "\n"],
    ["packed-refs", "a".repeat(40) + " refs/heads/main\n", "b".repeat(40) + " refs/heads/main\n"],
    ["shallow", "a".repeat(40) + "\n", "b".repeat(40) + "\n"],
    ["info/grafts", "a".repeat(40) + "\n", "b".repeat(40) + "\n"],
    ["config", "[core]\nbare = false\n", "[core]\nbare = true \n"],
    ["config.worktree", "[core]\nbare = false\n", "[core]\nbare = true \n"],
  ])("changes content evidence for %s with identical metadata", (relative, before, after) => {
    const path = join(cwd, ".git", relative);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, before);
    const fixedStat = nativeFs.lstatSync(path, { bigint: true });
    const readStat = vi.mocked(fs.lstatSync).getMockImplementation()!;
    vi.mocked(fs.lstatSync).mockImplementation(((candidate, options) =>
      candidate === path && options?.bigint === true ? fixedStat : readStat(candidate, options)) as typeof fs.lstatSync);
    vi.mocked(fs.fstatSync).mockImplementation(((descriptor, options) => {
      const stat = nativeFs.fstatSync(descriptor, options);
      return options?.bigint === true && stat.ino === fixedStat.ino && stat.dev === fixedStat.dev ? fixedStat : stat;
    }) as typeof fs.fstatSync);
    const first = inspectGitRepository(cwd);
    expect(first).not.toBeNull();
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    fs.writeFileSync(path, after);
    const second = inspectGitRepository(cwd);
    expect(second).not.toBeNull();
    expect(second!.stateFingerprint).not.toBe(first!.stateFingerprint);
  });

  it("bounds each control file without reading oversized contents", () => {
    const path = join(cwd, ".git", "packed-refs");
    fs.writeFileSync(path, "#".repeat(65536));
    expect(inspectGitRepository(cwd)).not.toBeNull();
    fs.writeFileSync(path, "#".repeat(65537));
    const oversizedStat = nativeFs.lstatSync(path, { bigint: true });
    let readOversized = false;
    vi.mocked(fs.readSync).mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const stat = nativeFs.fstatSync(args[0], { bigint: true });
      if (stat.dev === oversizedStat.dev && stat.ino === oversizedStat.ino) readOversized = true;
      return nativeFs.readSync(...args);
    });
    expect(inspectGitRepository(cwd)).toBeNull();
    expect(readOversized).toBe(false);
  });

  it("bounds aggregate control bytes including configuration", () => {
    const used = Buffer.byteLength(ORDINARY_CONFIG) + Buffer.byteLength("ref: refs/heads/main\n");
    for (let index = 0; index < 63; index += 1) {
      fs.writeFileSync(join(cwd, ".git", "refs", "heads", `ref-${index}`), Buffer.alloc(65536));
    }
    const last = join(cwd, ".git", "refs", "heads", "last");
    fs.writeFileSync(last, Buffer.alloc(65536 - used));
    expect(inspectGitRepository(cwd)).not.toBeNull();
    fs.appendFileSync(last, "x");
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("does not read large index, object or reflog data", () => {
    for (const relative of ["index", "sharedindex.abc", "objects/pack/data.pack", "logs/HEAD"]) {
      const path = join(cwd, ".git", relative);
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(path, Buffer.alloc(65537));
    }
    vi.mocked(fs.openSync).mockClear();
    expect(inspectGitRepository(cwd)).not.toBeNull();
    const opened = vi.mocked(fs.openSync).mock.calls.map(([path]) => path);
    for (const relative of ["index", "sharedindex.abc", "objects/pack/data.pack", "logs/HEAD"]) {
      expect(opened).not.toContain(join(cwd, ".git", relative));
    }
  });

  it("changes evidence when packed refs change type", () => {
    fs.writeFileSync(join(cwd, ".git", "packed-refs"), "# pack-refs with: peeled\n");
    const first = inspectGitRepository(cwd);
    expect(first).not.toBeNull();
    fs.unlinkSync(join(cwd, ".git", "packed-refs"));
    fs.mkdirSync(join(cwd, ".git", "packed-refs"));
    expect(inspectGitRepository(cwd)?.stateFingerprint).not.toBe(first!.stateFingerprint);
  });

  it("changes evidence for an equal-content replacement of the metadata root", () => {
    const first = inspectGitRepository(cwd);
    expect(first).not.toBeNull();
    const previous = join(cwd, "previous-metadata");
    fs.renameSync(join(cwd, ".git"), previous);
    fs.cpSync(previous, join(cwd, ".git"), { recursive: true });
    const second = inspectGitRepository(cwd);
    expect(second).not.toBeNull();
    expect(second!.stateFingerprint).not.toBe(first!.stateFingerprint);
  });

  it("rejects a config replacement between path inspection and open", () => {
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === join(cwd, ".git", "config")) {
        nativeFs.renameSync(args[0], join(cwd, ".git", "old-config"));
        nativeFs.writeFileSync(args[0], ORDINARY_CONFIG);
      }
      return nativeFs.openSync(...args);
    });
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("rejects a config mutation during its descriptor read", () => {
    let changed = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const result = nativeFs.readSync(...args);
      if (!changed) {
        changed = true;
        nativeFs.appendFileSync(join(cwd, ".git", "config"), "# mutation\n");
      }
      return result;
    });
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it.each(["darwin", "linux", "win32"] as const)("accepts ordinary metadata with a fixed file backend on %s", platform => {
    setProcessPlatform(platform);
    expect(inspectGitRepository(cwd)).toEqual({ gitDirectory: join(cwd, ".git"), workTree: cwd, referenceBackend: "files", stateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    if (platform === "win32") {
      // The cwd pin carries every ancestor component; each metadata directory pins its children in one batch.
      const metadata = join(cwd, ".git");
      const batches = vi.mocked(windowsPathFacts.pinWindowsPaths).mock.calls.map(([paths]) => [...paths].sort().join("|"));
      expect(batches.slice(0, 2)).toEqual([cwd, metadata]);
      expect(batches.slice(2).sort()).toEqual([
        [join(metadata, "HEAD"), join(metadata, "config"), join(metadata, "objects"), join(metadata, "refs")].sort().join("|"),
        join(metadata, "objects", "info"), join(metadata, "refs", "heads"),
      ].sort());
    } else expect(windowsPathFacts.pinWindowsPaths).not.toHaveBeenCalled();
  });

  it.each(["relative", "", "invalid\0cwd"])("refuses unsupported root spelling %j", path => {
    expect(inspectGitRepository(path)).toBeNull();
  });

  it("does not discover a repository in an ancestor", () => {
    const nested = join(cwd, "nested");
    fs.mkdirSync(nested);
    expect(inspectGitRepository(nested)).toBeNull();
  });

  it("refuses metadata pointer files", () => {
    fs.rmSync(join(cwd, ".git"), { recursive: true });
    fs.writeFileSync(join(cwd, ".git"), `gitdir: ${root}\n`);
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it.each(["commondir", "objects/info/commondir", "refs/heads/COMMONDIR", "objects/info/alternates", "objects/info/http-alternates"])("refuses metadata routing through %s", relative => {
    fs.writeFileSync(join(cwd, ".git", relative), root);
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it.each(["worktrees", "WORKTREES"])("refuses even empty linked-worktree administration at %s", relative => {
    fs.mkdirSync(join(cwd, ".git", relative));
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("refuses an existing linked-worktree administration backlink to an outside checkout", () => {
    const linked = join(cwd, ".git", "worktrees", "linked");
    fs.mkdirSync(linked, { recursive: true });
    fs.writeFileSync(join(linked, "gitdir"), join(root, "outside-checkout", ".git"));
    fs.writeFileSync(join(linked, "commondir"), "../..\n");
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it.each(["", "config", "objects", "objects/info/linked", "refs/heads/linked", "hooks/linked"])("refuses metadata symbolic links at %j", relative => {
    const target = join(root, "outside");
    fs.mkdirSync(target);
    const path = join(cwd, ".git", relative);
    fs.rmSync(path, { recursive: true, force: true });
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.symlinkSync(target, path, "junction");
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("refuses hard-linked metadata files", () => {
    fs.linkSync(join(cwd, ".git", "HEAD"), join(root, "head-alias"));
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("refuses special metadata entries without opening them", () => {
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      if (args[0] === join(cwd, ".git", "HEAD")) return { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false } as fs.Stats;
      return nativeFs.lstatSync(...args);
    });
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it.each(["cwd", "metadata", "ancestor", "unknown-tag"])("refuses non-following reparse evidence at %s", location => {
    setProcessPlatform("win32");
    const ordinaryPin = vi.mocked(windowsPathFacts.pinWindowsPaths).getMockImplementation()!;
    vi.mocked(windowsPathFacts.pinWindowsPaths).mockImplementation(paths => ordinaryPin(paths).map((row, index) => {
      if (location === "cwd" && paths[index] !== cwd || location !== "cwd" && paths[index] !== join(cwd, ".git")) return row;
      const reparse = { ...row, attributes: 0x400, reparseTag: location === "unknown-tag" ? 0xa0000042 : 0xa0000003 };
      return location === "ancestor" ? { ...row, ancestors: [reparse] } : reparse;
    }));
    expect(inspectGitRepository(cwd)).toBeNull();
    expect(windowsPathFacts.admitWindowsReparse).toHaveBeenCalledWith(expect.anything(), "evidence");
  });

  it("refuses missing native evidence", () => {
    setProcessPlatform("win32");
    vi.mocked(windowsPathFacts.pinWindowsPaths).mockReturnValue([]);
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it.each([["a first-level child", ["config"]], ["a nested child", ["refs", "heads"]]] as const)("refuses a reparse row for %s in a child batch", (_name, relative) => {
    setProcessPlatform("win32");
    const target = join(cwd, ".git", ...relative);
    const ordinaryPin = vi.mocked(windowsPathFacts.pinWindowsPaths).getMockImplementation()!;
    vi.mocked(windowsPathFacts.pinWindowsPaths).mockImplementation(paths => ordinaryPin(paths).map((row, index) =>
      paths[index] === target ? { ...row, attributes: 0x400, reparseTag: 0xa000000c } : row));
    expect(inspectGitRepository(cwd)).toBeNull();
    expect(vi.mocked(windowsPathFacts.pinWindowsPaths).mock.calls.some(([paths]) => paths.length > 0 && paths.includes(target))).toBe(true);
  });

  it("refuses a child batch answered with fewer rows than requested", () => {
    setProcessPlatform("win32");
    const ordinaryPin = vi.mocked(windowsPathFacts.pinWindowsPaths).getMockImplementation()!;
    vi.mocked(windowsPathFacts.pinWindowsPaths).mockImplementation(paths => ordinaryPin(paths).slice(paths.length > 1 ? 1 : 0));
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("splits a child batch that would exceed the helper command line", () => {
    setProcessPlatform("win32");
    const heads = join(cwd, ".git", "refs", "heads");
    const names = Array.from({ length: 160 }, (_, index) => `${String(index).padStart(3, "0")}-${"r".repeat(96)}`);
    for (const name of names) fs.writeFileSync(join(heads, name), "0000000000000000000000000000000000000000\n");
    expect(inspectGitRepository(cwd)).not.toBeNull();
    const batches = vi.mocked(windowsPathFacts.pinWindowsPaths).mock.calls.map(([paths]) => paths)
      .filter(paths => paths.length > 0 && paths.every(path => dirname(path) === heads));
    expect(batches.length).toBeGreaterThan(1);
    // Every path is pinned exactly once, and each helper command line stays below the CreateProcess limit.
    expect(batches.flat().sort()).toEqual(names.map(name => join(heads, name)).sort());
    for (const batch of batches) expect(batch.reduce((total, path) => total + path.length + 3, 0)).toBeLessThan(32_767);
  });

  it.each([
    "[include]\npath = /outside", "[INCLUDE]\nPATH = /outside", "[include \"scope\"]\npath = /outside", "[include.scope]\npath = /outside",
    "[includeIf \"gitdir:/outside\"]\npath = /outside", "[InClUdEiF]\npath = /outside", "[includeIf.gitdir:/outside]\npath = /outside",
    "[mailmap]\nfile = /outside", "[mailmap]\nblob = HEAD:map", "[MAILMAP]\nunknown = anything", "[mailmap \"scope\"]\nfile = /outside",
    "[diff]\norderFile = /outside", "[DIFF]\nORDERFILE = /outside", "[diff \"driver\"]\norderFile = /outside",
    "[core]\nworktree = /outside", "[CORE]\nWORKTREE = /outside", "[core \"scope\"]\nworktree = /outside",
    "[extensions]\nrefStorage = reftable", "[extensions]\nobjectFormat = sha256", "[extensions]\nworktreeConfig = true", "[EXTENSIONS]\nunknown = true",
  ])("refuses routing and backend configuration %j", text => {
    configure(text);
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it.each([
    "[broken", "key = value", "[core]\ninvalid_key = true", "[core]\nvalue = \"quoted\"", "[core]\nvalue = escaped\\tvalue",
    "[core]\nvalue = continued\\\nline", "[core]\nvalue = unbalanced\"", "[core]\nvalue = text\0", "[core]\nvalue = caf\u00e9",
    "[core]\rvalue = true", "[core] trailing", "[core \"unbalanced]\nvalue = true", "\ufeff[core]\nvalue = true",
  ])("refuses malformed or unimplemented configuration %j", text => {
    configure(text);
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("accepts empty configuration, ordinary comments, CRLF and implicit booleans", () => {
    for (const text of ["", "# heading\n; comment\n", "[core] # heading\r\nfilemode\r\nbare = false ; comment\r\n"]) {
      configure(text);
      expect(inspectGitRepository(cwd)).toEqual({ gitDirectory: join(cwd, ".git"), workTree: cwd, referenceBackend: "files", stateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    }
  });

  it("refuses a long malformed assignment with whitespace before a quote", () => {
    configure('[core]\nx=' + " ".repeat(32000) + '"\n');
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("inspects worktree configuration even when it is inactive", () => {
    fs.writeFileSync(join(cwd, ".git", "config.worktree"), "[include]\npath = /outside\n");
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("refuses a directory in place of configuration", () => {
    fs.rmSync(join(cwd, ".git", "config"));
    fs.mkdirSync(join(cwd, ".git", "config"));
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("bounds configuration bytes", () => {
    configure("#".repeat(65536));
    expect(inspectGitRepository(cwd)).not.toBeNull();
    configure("#".repeat(65537));
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("bounds total metadata entries", () => {
    const directory = join(cwd, ".git", "objects");
    for (let index = 0; index < 4096; index++) fs.writeFileSync(join(directory, `object-${index}`), "");
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("bounds metadata depth", () => {
    fs.mkdirSync(join(cwd, ".git", ...Array.from({ length: 33 }, () => "nested")), { recursive: true });
    expect(inspectGitRepository(cwd)).toBeNull();
  });

  it("fails closed when an inspection raises", () => {
    vi.spyOn(fs, "lstatSync").mockImplementation(() => { throw new Error("Inspection failed"); });
    expect(inspectGitRepository(cwd)).toBeNull();
  });
});
