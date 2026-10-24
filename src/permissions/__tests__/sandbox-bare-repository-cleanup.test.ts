import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, loadLocaleMessages, setLocale } from "../../i18n/index.js";
import * as atomicFile from "../../lib/atomic-file.js";
import { prepareSandboxBareRepositoryCleanup } from "../sandbox-bare-repository-cleanup.js";
import { createSandboxQuarantine, sandboxQuarantineRoot } from "../sandbox-quarantine.js";

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
  beforeEach(() => {
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
    expect(cleanup()).toBeUndefined();
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
});
