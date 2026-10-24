import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, loadLocaleMessages, setLocale } from "../../i18n/index.js";
import * as atomicFile from "../../lib/atomic-file.js";
import { prepareSandboxBareRepositoryCleanup } from "../sandbox-bare-repository-cleanup.js";
import { createSandboxQuarantine, sandboxQuarantineRoot } from "../sandbox-quarantine.js";
import { buildMandatorySandboxWritePolicy, isGrantPathWithin, restrictSandboxGitControlSnapshot, snapshotSandboxGitControls } from "../sandbox-write-policy.js";

const { warnings } = vi.hoisted(() => ({ warnings: vi.fn() }));
vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ warn: warnings }) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), lstatSync: vi.fn(actual.lstatSync), closeSync: vi.fn(actual.closeSync) };
});

describe("sandbox protected Git quarantine", () => {
  let base: string;
  let root: string;
  let previousLocale: ReturnType<typeof getLocale>;
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.openSync).mockImplementation(actual.openSync);
    vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync);
    vi.mocked(fs.closeSync).mockImplementation(actual.closeSync);
    previousLocale = getLocale();
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-bare-cleanup-")));
    root = join(base, "work");
    mkdirSync(root);
    vi.stubEnv("AVE_HOME", join(base, "host"));
    setLocale("en");
    warnings.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    setLocale(previousLocale);
    rmSync(base, { recursive: true, force: true });
  });

  const quarantinedEntries = (): string[] => readdirSync(sandboxQuarantineRoot())
    .flatMap(slot => readdirSync(join(sandboxQuarantineRoot(), slot)).map(name => join(sandboxQuarantineRoot(), slot, name)));

  it("moves newly appeared entries intact and reports every restore mapping once", async () => {
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "bare-layout");
    writeFileSync(join(root, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, "config"), "[core]\n bare=true\n");
    for (const name of ["objects", "refs", "hooks"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "payload"), name);
    }
    writeFileSync(join(root, "ordinary"), "kept");
    const notice = cleanup();
    expect(cleanup()).toBe(notice);
    for (const name of ["HEAD", "objects", "refs", "config", "hooks"]) expect(existsSync(join(root, name))).toBe(false);
    const entries = quarantinedEntries();
    expect(entries).toHaveLength(5);
    for (const path of entries) {
      const name = basename(path).replace(/^\d+-/, "");
      expect(notice).toContain(`${JSON.stringify(join(root, name))} -> ${JSON.stringify(path)}`);
      if (["objects", "refs", "hooks"].includes(name)) expect(readFileSync(join(path, "payload"), "utf8")).toBe(name);
      else expect(readFileSync(path, "utf8")).toContain(name === "HEAD" ? "refs/heads/main" : "bare=true");
    }
    expect(notice).toMatch(/^Sandbox protected Git entries were moved to quarantine \(not deleted\):\n/);
    expect(notice).toContain("Restore each entry from the shown quarantine path to its original path after inspecting it.");
    expect(readFileSync(join(root, "ordinary"), "utf8")).toBe("kept");
    expect(readdirSync(root)).toEqual(["ordinary"]);
    expect(warnings).toHaveBeenCalledTimes(5);
  });

  it("preserves pre-existing entries and hooks without HEAD", async () => {
    writeFileSync(join(root, "config"), "source configuration");
    mkdirSync(join(root, "objects"));
    writeFileSync(join(root, "objects", "original"), "kept");
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "preserved");
    mkdirSync(join(root, "hooks"));
    expect(cleanup()).toBeUndefined();
    expect(readFileSync(join(root, "config"), "utf8")).toBe("source configuration");
    expect(readFileSync(join(root, "objects", "original"), "utf8")).toBe("kept");
    expect(existsSync(join(root, "hooks"))).toBe(true);
    expect(warnings).not.toHaveBeenCalled();
  });

  it("reports moved paths and restoration guidance in Korean", async () => {
    await loadLocaleMessages("ko");
    setLocale("ko");
    const quarantine = await createSandboxQuarantine("korean-notice");
    const original = join(root, "config");
    writeFileSync(original, "retained");
    quarantine.move(original);
    const moved = quarantine.moved[0]!;
    expect(quarantine.notice()).toContain("삭제하지 않고 격리 위치로 옮겼습니다");
    expect(quarantine.notice()).toContain(`${JSON.stringify(original)} -> ${JSON.stringify(moved.quarantined)}`);
    expect(quarantine.notice()).toContain("원래 경로로 각 항목을 복원하세요.");
  });

  it("moves a symbolic link as a link without following its target", async () => {
    const target = join(base, "outside");
    mkdirSync(target);
    writeFileSync(join(target, "original"), "kept");
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "link-entry");
    symlinkSync(target, join(root, "objects"), "dir");
    const identity = lstatSync(join(root, "objects"));
    cleanup();
    const [moved] = quarantinedEntries();
    expect(lstatSync(moved!).isSymbolicLink()).toBe(true);
    expect(lstatSync(moved!).ino).toBe(identity.ino);
    expect(readlinkSync(moved!)).toBe(target);
    expect(existsSync(join(root, "objects"))).toBe(false);
    expect(readFileSync(join(target, "original"), "utf8")).toBe("kept");
  });

  it("fails clearly on cross-device rename without deleting or copying the source", async () => {
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "cross-device");
    writeFileSync(join(root, "HEAD"), "retained");
    vi.spyOn(atomicFile, "replaceStagedFile").mockImplementation(() => {
      throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" });
    });
    expect(cleanup).toThrow(/EXDEV: cross-device rename/);
    expect(readFileSync(join(root, "HEAD"), "utf8")).toBe("retained");
    expect(quarantinedEntries()).toEqual([]);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("EXDEV"));
  });

  it("retains and reports earlier moves if a later rename fails", async () => {
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "partial-failure");
    writeFileSync(join(root, "HEAD"), "moved");
    mkdirSync(join(root, "objects"));
    const replace = atomicFile.replaceStagedFile;
    vi.spyOn(atomicFile, "replaceStagedFile").mockImplementation((from, to) => {
      if (basename(from) === "objects") throw Object.assign(new Error("denied"), { code: "EACCES" });
      replace(from, to);
    });
    expect(cleanup).toThrow(/EACCES: denied/);
    const [moved] = quarantinedEntries();
    expect(readFileSync(moved!, "utf8")).toBe("moved");
    expect(existsSync(join(root, "objects"))).toBe(true);
    expect(warnings).toHaveBeenLastCalledWith(expect.stringContaining(`${JSON.stringify(join(root, "HEAD"))} -> ${JSON.stringify(moved)}`));
  });

  it("pins Linux rename directories against a concurrent source-parent link swap", async () => {
    const quarantine = await createSandboxQuarantine("parent-race");
    const original = join(root, "config");
    writeFileSync(original, "sandbox entry");
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "config"), "unrelated user entry");
    const previous = `${root}-previous`;
    const replace = atomicFile.replaceStagedFile;
    const nativeLinux = process.platform === "linux";
    const directories = new Map<number, string>();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const open = actualFs.openSync;
    const stat = actualFs.lstatSync;
    if (!nativeLinux) {
      const linuxProcess = Object.create(process) as NodeJS.Process;
      Object.defineProperty(linuxProcess, "platform", { value: "linux" });
      vi.stubGlobal("process", linuxProcess);
      vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
        const fd = open(path, flags, mode);
        directories.set(fd, String(path));
        return fd;
      });
      vi.spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
        const anchor = /^\/proc\/self\/fd\/(\d+)\/(.+)$/.exec(String(path));
        return stat(anchor ? join(directories.get(Number(anchor[1]))!, anchor[2]!) : path);
      }) as typeof fs.lstatSync);
    }
    const close = vi.spyOn(fs, "closeSync");
    vi.spyOn(atomicFile, "replaceStagedFile").mockImplementation((from, to) => {
      expect(from).toMatch(/^\/proc\/self\/fd\/\d+\/config$/);
      expect(to).toMatch(/^\/proc\/self\/fd\/\d+\/1-config$/);
      renameSync(root, previous);
      symlinkSync(outside, root, "dir");
      if (nativeLinux) replace(from, to);
      else {
        const target = /^\/proc\/self\/fd\/(\d+)\/(.+)$/.exec(to)!;
        replace(join(previous, "config"), join(directories.get(Number(target[1]))!, target[2]!));
      }
    });
    close.mockClear();
    expect(() => quarantine.move(original)).toThrow(/identity changed/);
    expect(close).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(outside, "config"), "utf8")).toBe("unrelated user entry");
    expect(quarantine.moved).toHaveLength(1);
    expect(readFileSync(quarantine.moved[0]!.quarantined, "utf8")).toBe("sandbox entry");
    expect(existsSync(join(previous, "config"))).toBe(false);
  });

  it("preserves a real root replacement between the outer identity check and quarantine", async () => {
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "original-root-identity");
    writeFileSync(join(root, "HEAD"), "original HEAD");
    writeFileSync(join(root, "config"), "original config");
    const previous = `${root}-previous`;
    const realpath = fs.realpathSync.native;
    let replaced = false;
    vi.spyOn(fs.realpathSync, "native").mockImplementation(((path) => {
      const result = realpath(path);
      if (String(path) === root && !replaced) {
        replaced = true;
        renameSync(root, previous);
        mkdirSync(root);
        writeFileSync(join(root, "HEAD"), "unrelated HEAD");
        writeFileSync(join(root, "config"), "unrelated config");
      }
      return result;
    }) as typeof fs.realpathSync.native);
    expect(cleanup).toThrow(/identity changed/);
    expect(readFileSync(join(root, "HEAD"), "utf8")).toBe("unrelated HEAD");
    expect(readFileSync(join(root, "config"), "utf8")).toBe("unrelated config");
    expect(readFileSync(join(previous, "HEAD"), "utf8")).toBe("original HEAD");
    expect(readFileSync(join(previous, "config"), "utf8")).toBe("original config");
    expect(quarantinedEntries()).toEqual([]);
  });

  it("uses unique timestamped invocation slots and quotes control characters in notices", async () => {
    const first = await createSandboxQuarantine("same-invocation");
    const second = await createSandboxQuarantine("same-invocation");
    const path = join(root, "config\nextra");
    writeFileSync(path, "retained");
    first.move(path);
    expect(first.notice()).toContain(JSON.stringify(path));
    expect(first.notice()).not.toContain("config\nextra");
    expect(first.moved).toHaveLength(1);
    expect(second.notice()).toBeUndefined();
    const slots = readdirSync(sandboxQuarantineRoot());
    expect(slots).toHaveLength(2);
    expect(new Set(slots).size).toBe(2);
    for (const slot of slots) expect(slot).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses a symbolic quarantine namespace before moving user data", async () => {
    mkdirSync(join(base, "host"));
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, sandboxQuarantineRoot(), "dir");
    await expect(createSandboxQuarantine("namespace-link")).rejects.toThrow("not a link");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a replaced quarantine slot without following its symbolic link", async () => {
    const quarantine = await createSandboxQuarantine("replaced-slot");
    const [slot] = readdirSync(sandboxQuarantineRoot());
    const slotPath = join(sandboxQuarantineRoot(), slot!);
    renameSync(slotPath, `${slotPath}-previous`);
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, slotPath, "dir");
    const source = join(root, "config");
    writeFileSync(source, "retained");
    expect(() => quarantine.move(source)).toThrow();
    expect(readFileSync(source, "utf8")).toBe("retained");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("preserves an unrelated replacement root", async () => {
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "replacement");
    renameSync(root, join(base, "previous"));
    mkdirSync(root);
    writeFileSync(join(root, "HEAD"), "unrelated");
    expect(cleanup).toThrow("write root identity changed");
    expect(readFileSync(join(root, "HEAD"), "utf8")).toBe("unrelated");
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("replaced root"));
  });

  it("leaves ordinary names inside an existing repository alone", async () => {
    mkdirSync(join(root, ".git", "objects"), { recursive: true });
    mkdirSync(join(root, ".git", "refs"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "existing-repository");
    writeFileSync(join(root, "HEAD"), "ordinary source file");
    expect(cleanup()).toBeUndefined();
    expect(readFileSync(join(root, "HEAD"), "utf8")).toBe("ordinary source file");
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each([
    "config", "config.worktree", "commondir", "gitdir", "hooks/pre-commit", "info/attributes",
    "objects/info/alternates", "objects/info/http-alternates", "modules/new/config", "worktrees/new/gitdir",
  ])("quarantines a newly created %s while retaining ordinary repository data", async (control) => {
    const marker = join(root, ".git");
    mkdirSync(marker);
    writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], `new-${control}`);
    const path = join(marker, control);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "new control");
    const notice = cleanup();
    expect(notice).toContain("moved to quarantine");
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(marker, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(quarantinedEntries()).toHaveLength(1);
  });

  it.each([0, 1, 3])("quarantines a newly created hooks-only marker at depth %s without requiring HEAD", async depth => {
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], `new-marker-${depth}`);
    const parent = join(root, ...Array.from({ length: depth }, (_, index) => `nested-${index}`));
    const marker = join(parent, ".git");
    mkdirSync(join(marker, "hooks"), { recursive: true });
    writeFileSync(join(marker, "hooks", "pre-commit"), "preserved hook");
    const notice = cleanup();
    expect(notice).toContain(JSON.stringify(marker));
    expect(existsSync(marker)).toBe(false);
    const [moved] = quarantinedEntries();
    expect(readFileSync(join(moved!, "hooks", "pre-commit"), "utf8")).toBe("preserved hook");
  });

  it.each(["file", "link"] as const)("quarantines a new marker %s without reading its external target", async kind => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "config"), "external configuration");
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], `new-marker-${kind}`);
    const marker = join(root, ".git");
    if (kind === "file") writeFileSync(marker, `gitdir: ${outside}\n`);
    else symlinkSync(outside, marker, "dir");
    expect(cleanup()).toContain(JSON.stringify(marker));
    expect(existsSync(marker)).toBe(false);
    const [moved] = quarantinedEntries();
    if (kind === "link") expect(lstatSync(moved!).isSymbolicLink()).toBe(true);
    else expect(readFileSync(moved!, "utf8")).toBe(`gitdir: ${outside}\n`);
    expect(readFileSync(join(outside, "config"), "utf8")).toBe("external configuration");
  });

  it("moves new routing pointers and symbolic controls without selecting their targets", async () => {
    const marker = join(root, ".git");
    mkdirSync(marker);
    writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "config"), "unrelated config");
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "untrusted-routing");
    writeFileSync(join(marker, "commondir"), outside);
    symlinkSync(outside, join(marker, "hooks"), "dir");
    cleanup();
    expect(readFileSync(join(outside, "config"), "utf8")).toBe("unrelated config");
    const moved = quarantinedEntries();
    expect(moved).toHaveLength(2);
    expect(moved.some(path => lstatSync(path).isSymbolicLink() && readlinkSync(path) === outside)).toBe(true);
  });

  it.each(["modules", "worktrees"] as const)("moves a new cyclic %s link without resolving its target", async name => {
    const marker = join(root, ".git");
    mkdirSync(marker);
    writeFileSync(join(marker, "HEAD"), "root HEAD");
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], `cyclic-${name}`);
    const path = join(marker, name);
    symlinkSync(name, path, "dir");
    expect(cleanup()).toContain(JSON.stringify(path));
    const [moved] = quarantinedEntries();
    expect(lstatSync(moved!).isSymbolicLink()).toBe(true);
    expect(readlinkSync(moved!)).toBe(name);
  });

  it("quarantines a replaced marker without treating the replacement as a trusted store", async () => {
    const marker = join(root, ".git");
    mkdirSync(marker);
    writeFileSync(join(marker, "HEAD"), "original HEAD");
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "replaced-marker");
    renameSync(marker, join(root, "previous-metadata"));
    mkdirSync(marker);
    writeFileSync(join(marker, "commondir"), "invalid new routing bytes");
    expect(cleanup()).toContain(JSON.stringify(marker));
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(root, "previous-metadata", "HEAD"), "utf8")).toBe("original HEAD");
    expect(readFileSync(join(quarantinedEntries()[0]!, "commondir"), "utf8")).toBe("invalid new routing bytes");
  });

  it("never changes controls in an inaccessible external store selected before preparation", async () => {
    const store = join(base, "external-store");
    mkdirSync(store);
    writeFileSync(join(store, "HEAD"), "external HEAD");
    writeFileSync(join(root, ".git"), `gitdir: ${store}\n`);
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "external-store");
    writeFileSync(join(store, "config.worktree"), "external new control");
    expect(cleanup()).toBeUndefined();
    expect(readFileSync(join(store, "config.worktree"), "utf8")).toBe("external new control");
  });

  it("sweeps an already resolved common store inside a writable root through an external gitdir", async () => {
    const store = join(base, "external-store");
    const common = join(root, "common");
    mkdirSync(store);
    mkdirSync(common);
    writeFileSync(join(store, "HEAD"), "external HEAD");
    writeFileSync(join(store, "commondir"), `${common}\n`);
    writeFileSync(join(root, ".git"), `gitdir: ${store}\n`);
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "writable-common");
    writeFileSync(join(common, "config.worktree"), "new common control");
    expect(cleanup()).toContain(JSON.stringify(join(common, "config.worktree")));
    expect(existsSync(join(common, "config.worktree"))).toBe(false);
    expect(readFileSync(quarantinedEntries()[0]!, "utf8")).toBe("new common control");
    expect(readFileSync(join(store, "HEAD"), "utf8")).toBe("external HEAD");
  });

  it("sweeps common metadata already resolved from a module store", async () => {
    const marker = join(root, ".git");
    const module = join(marker, "modules", "inner");
    const common = join(root, "shared-module");
    mkdirSync(module, { recursive: true });
    mkdirSync(common);
    writeFileSync(join(marker, "HEAD"), "root HEAD");
    writeFileSync(join(module, "HEAD"), "module HEAD");
    writeFileSync(join(module, "commondir"), `${common}\n`);
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "module-common");
    writeFileSync(join(common, "config.worktree"), "new module control");
    expect(cleanup()).toContain(JSON.stringify(join(common, "config.worktree")));
    expect(existsSync(join(common, "config.worktree"))).toBe(false);
    expect(readFileSync(join(module, "HEAD"), "utf8")).toBe("module HEAD");
  });

  it.each(["modules", "worktrees"] as const)("quarantines an entirely new %s metadata store", async container => {
    const marker = join(root, ".git");
    mkdirSync(marker);
    writeFileSync(join(marker, "HEAD"), "existing root HEAD");
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], `new-${container}-store`);
    const store = join(marker, container, "new");
    mkdirSync(join(store, "objects"), { recursive: true });
    mkdirSync(join(store, "refs"));
    writeFileSync(join(store, "HEAD"), "new store HEAD");
    writeFileSync(join(store, "config"), "new store configuration");
    expect(cleanup()).toContain(JSON.stringify(store));
    expect(existsSync(store)).toBe(false);
    const [moved] = quarantinedEntries();
    expect(readFileSync(join(moved!, "HEAD"), "utf8")).toBe("new store HEAD");
    expect(readFileSync(join(moved!, "config"), "utf8")).toBe("new store configuration");
    expect(lstatSync(join(moved!, "objects")).isDirectory()).toBe(true);
    expect(readFileSync(join(marker, "HEAD"), "utf8")).toBe("existing root HEAD");
  });

  it.each(["metadata", "bare"] as const)("keeps the actual policy snapshot before a new %s control appears", async kind => {
    const marker = join(root, ".git");
    if (kind === "metadata") {
      mkdirSync(marker);
      writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    }
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const initial = (() => {
      try {
        Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
        return buildMandatorySandboxWritePolicy([root]).gitControlSnapshot;
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    })();
    expect(initial).toBeDefined();
    const path = kind === "metadata" ? join(marker, "config.worktree") : join(root, "config");
    writeFileSync(path, "appeared after policy");
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "actual-policy-baseline", initial);
    expect(cleanup()).toContain(JSON.stringify(path));
    expect(existsSync(path)).toBe(false);
  });

  it("quarantines only effective roots when a later floor withholds another captured root", async () => {
    const retained = join(root, "retained");
    const withheld = join(root, "withheld");
    for (const directory of [retained, withheld]) {
      mkdirSync(join(directory, ".git"), { recursive: true });
      writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const initial = (() => {
      try {
        Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
        return buildMandatorySandboxWritePolicy([retained, withheld]).gitControlSnapshot;
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    })();
    expect(initial?.roots.size).toBe(2);
    const cleanup = await prepareSandboxBareRepositoryCleanup([retained], "effective-roots", initial);
    const retainedControl = join(retained, ".git", "config.worktree");
    const withheldControl = join(withheld, ".git", "config.worktree");
    writeFileSync(retainedControl, "retained root new control");
    writeFileSync(withheldControl, "withheld root external control");
    const notice = cleanup();
    expect(notice).toContain(JSON.stringify(retainedControl));
    expect(notice).not.toContain(withheldControl);
    expect(existsSync(retainedControl)).toBe(false);
    expect(readFileSync(withheldControl, "utf8")).toBe("withheld root external control");
  });

  it("does not use a new ordinary directory link to expand post-command repository coverage", async () => {
    const deep = join(root, "a", "b", "c", "d");
    mkdirSync(join(deep, ".git"), { recursive: true });
    writeFileSync(join(deep, ".git", "HEAD"), "deep repository HEAD");
    writeFileSync(join(deep, ".git", "config"), "deep original config");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "root HEAD");
    const initial = snapshotSandboxGitControls([root]);
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "new-directory-alias", initial);
    const alias = join(root, "alias");
    symlinkSync(deep, alias, "dir");
    const control = join(root, ".git", "config.worktree");
    writeFileSync(control, "new root control");
    const after = snapshotSandboxGitControls([root], initial);
    expect(after.directories.get(alias)?.kind).toBe("link");
    expect(after.markers.has(join(deep, ".git"))).toBe(false);
    const notice = cleanup();
    expect(notice).toContain(JSON.stringify(control));
    expect(notice).not.toContain(JSON.stringify(join(deep, ".git")));
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(deep, ".git", "config"), "utf8")).toBe("deep original config");
    expect(existsSync(control)).toBe(false);
  });

  it("uses an unchanged initial directory link only through its physical target", async () => {
    const deep = join(root, "a", "b", "c", "d");
    mkdirSync(deep, { recursive: true });
    const alias = join(root, "alias");
    symlinkSync(deep, alias, "dir");
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "initial-directory-alias");
    mkdirSync(join(deep, ".git", "hooks"), { recursive: true });
    writeFileSync(join(deep, ".git", "hooks", "pre-commit"), "new hook");
    expect(cleanup()).toContain(JSON.stringify(join(deep, ".git")));
    expect(existsSync(join(deep, ".git"))).toBe(false);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  });

  it("preserves an excluded nested store while sweeping accessible controls in the same write root", async () => {
    const blocked = join(root, "private-store");
    for (const directory of [root, blocked]) {
      mkdirSync(join(directory, ".git"), { recursive: true });
      writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    const initial = restrictSandboxGitControlSnapshot(snapshotSandboxGitControls([root]), [root], path =>
      isGrantPathWithin(blocked, path));
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "excluded-nested-store", initial);
    const accessibleControl = join(root, ".git", "config.worktree");
    const blockedControl = join(blocked, ".git", "config.worktree");
    writeFileSync(accessibleControl, "new accessible control");
    writeFileSync(blockedControl, "concurrent external control");
    const notice = cleanup();
    expect(notice).toContain(JSON.stringify(accessibleControl));
    expect(notice).not.toContain(blocked);
    expect(existsSync(accessibleControl)).toBe(false);
    expect(readFileSync(blockedControl, "utf8")).toBe("concurrent external control");
  });

  it("fails instead of moving a new metadata directory containing an excluded descendant", async () => {
    const marker = join(root, ".git");
    const protectedPath = join(marker, "private-data");
    const initial = restrictSandboxGitControlSnapshot(snapshotSandboxGitControls([root]), [root], (path, includesChildren) =>
      isGrantPathWithin(protectedPath, path) || (includesChildren === true && isGrantPathWithin(path, protectedPath)));
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "excluded-descendant", initial);
    mkdirSync(marker);
    writeFileSync(protectedPath, "external protected data");
    writeFileSync(join(marker, "config"), "new config");
    expect(cleanup).toThrow("quarantine would include a protected path");
    expect(readFileSync(protectedPath, "utf8")).toBe("external protected data");
    expect(readFileSync(join(marker, "config"), "utf8")).toBe("new config");
    expect(quarantinedEntries()).toEqual([]);
  });

  it.each(["retargeted", "removed"] as const)("keeps a frozen directory target when its intermediate route is %s", async mode => {
    const known = join(root, "known", "a", "b", "c");
    const foreign = join(root, "foreign", "a", "b", "c");
    for (const directory of [known, foreign]) {
      mkdirSync(join(directory, ".git"), { recursive: true });
      writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(directory, ".git", "config"), "pre-existing configuration");
    }
    mkdirSync(join(root, ".cache"));
    const router = join(root, ".cache", "router");
    const alias = join(root, "alias");
    symlinkSync(known, router, "dir");
    symlinkSync(join(".cache", "router"), alias, "dir");
    const initial = snapshotSandboxGitControls([root]);
    expect(initial.directoryTargets.get(alias)).toBe(known);
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], `frozen-${mode}`, initial);
    if (mode === "retargeted") {
      rmSync(router);
      symlinkSync(foreign, router, "dir");
    } else rmSync(alias);
    const control = join(known, ".git", "config.worktree");
    writeFileSync(control, "new known-target control");
    const current = snapshotSandboxGitControls([root], initial);
    expect(current.directoryTargets.get(alias)).toBe(known);
    expect(current.replacedMarkers.has(alias)).toBe(true);
    expect(current.markers.has(join(foreign, ".git"))).toBe(false);
    const notice = cleanup();
    expect(notice).toContain(JSON.stringify(control));
    expect(notice).not.toContain(foreign);
    expect(existsSync(control)).toBe(false);
    expect(readFileSync(join(foreign, ".git", "config"), "utf8")).toBe("pre-existing configuration");
    expect(readFileSync(join(known, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  });

  it.each(["gitdir", "commondir"] as const)("quarantines the first missing %s routing ancestor without following a new link", async kind => {
    const storage = join(root, "storage");
    const missing = join(storage, "future");
    const target = join(missing, "metadata");
    const actualParent = join(root, "actual-parent");
    mkdirSync(storage);
    mkdirSync(join(actualParent, "metadata"), { recursive: true });
    writeFileSync(join(actualParent, "metadata", "config"), "pre-existing target configuration");
    if (kind === "gitdir") writeFileSync(join(root, ".git"), `gitdir: ${target}\n`);
    else {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(root, ".git", "commondir"), `${target}\n`);
    }
    const initial = snapshotSandboxGitControls([root]);
    expect(initial.storeMissingAncestors.get(target)).toBe(missing);
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], `missing-${kind}`, initial);
    symlinkSync(actualParent, missing, "dir");
    expect(cleanup()).toContain(JSON.stringify(missing));
    const [moved] = quarantinedEntries();
    expect(lstatSync(moved!).isSymbolicLink()).toBe(true);
    expect(readlinkSync(moved!)).toBe(actualParent);
    expect(readFileSync(join(actualParent, "metadata", "config"), "utf8")).toBe("pre-existing target configuration");
    expect(existsSync(missing)).toBe(false);
  });

  it("leaves an unchanged ordinary external directory alias outside cleanup coverage", async () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "config"), "external configuration");
    const alias = join(root, "alias");
    symlinkSync(outside, alias, "dir");
    const initial = snapshotSandboxGitControls([root]);
    expect(initial.directoryTargets.get(alias)).toBe(outside);
    expect(initial.directories.has(outside)).toBe(false);
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "external-alias", initial);
    const current = snapshotSandboxGitControls([root], initial);
    expect(current.replacedMarkers.has(alias)).toBe(false);
    expect(cleanup()).toBeUndefined();
    expect(readFileSync(join(outside, "config"), "utf8")).toBe("external configuration");
  });

  it("flags an external alias chain retarget without adding its new internal repository to cleanup", async () => {
    const outside = join(base, "outside");
    const deep = join(root, "deep", "a", "b", "c");
    mkdirSync(outside);
    mkdirSync(join(deep, ".git"), { recursive: true });
    writeFileSync(join(deep, ".git", "HEAD"), "pre-existing deep HEAD");
    writeFileSync(join(deep, ".git", "config"), "pre-existing deep configuration");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "root HEAD");
    mkdirSync(join(root, ".cache"));
    const router = join(root, ".cache", "router");
    const alias = join(root, "alias");
    symlinkSync(outside, router, "dir");
    symlinkSync(join(".cache", "router"), alias, "dir");
    const initial = snapshotSandboxGitControls([root]);
    const cleanup = await prepareSandboxBareRepositoryCleanup([root], "external-alias-retarget", initial);
    rmSync(router);
    symlinkSync(deep, router, "dir");
    const control = join(root, ".git", "config.worktree");
    writeFileSync(control, "new root control");
    const current = snapshotSandboxGitControls([root], initial);
    expect(current.replacedMarkers.has(alias)).toBe(true);
    expect(current.directoryTargets.get(alias)).toBe(outside);
    expect(current.markers.has(join(deep, ".git"))).toBe(false);
    expect(cleanup()).toContain(JSON.stringify(control));
    expect(readFileSync(join(deep, ".git", "config"), "utf8")).toBe("pre-existing deep configuration");
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  });
});
