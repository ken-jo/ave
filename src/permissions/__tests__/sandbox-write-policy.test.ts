import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as filesystem from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMandatorySandboxWritePolicy, SANDBOX_GIT_SCAN_DEPTH } from "../sandbox-write-policy.js";
import { getDefaultSensitiveWriteDenyPaths } from "../asrt-sandbox.js";
import { permissionSettingsPath } from "../permission-settings-store.js";
import { egressGrantFilePath } from "../egress-grants.js";
import { userApprovalFilePath } from "../user-approval-store.js";
import { permissionsFilePath } from "../permissions-store.js";
import { getAdminPolicyPath, userPolicyPath } from "../policy-store.js";
import { projectRulesDirectory } from "../rules/project-rule-files.js";
import { settingsFilePath } from "../../data/settings-store.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, opendirSync: vi.fn(actual.opendirSync), readSync: vi.fn(actual.readSync) };
});

describe("mandatory sandbox control-file writes", () => {
  let root: string;
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(filesystem.opendirSync).mockImplementation(actual.opendirSync);
    vi.mocked(filesystem.readSync).mockImplementation(actual.readSync);
    root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-write-policy-")));
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    vi.stubEnv("AVE_HOME", join(root, "ave"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".gitconfig",
    ".git", ".git/hooks", ".git/config", ".git/modules", ".vscode",
  ])("protects missing %s in every writable root", (entry) => {
    const roots = [join(root, "project"), join(root, "temp")];
    const denies = buildMandatorySandboxWritePolicy(roots).denyWrite;
    for (const base of roots) expect(denies).toContain(join(base, entry));
  });

  it.each([".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile"])("keeps the host-home %s in the existing sensitive floor only", (entry) => {
    expect(getDefaultSensitiveWriteDenyPaths()).toContain(join(root, entry));
    expect(buildMandatorySandboxWritePolicy([join(root, "project")]).denyWrite).not.toContain(join(root, entry));
  });

  it("takes settings, rules, approvals and policy locations from their stores", () => {
    const userData = join(root, "desktop-data");
    expect(buildMandatorySandboxWritePolicy([root], userData).denyWrite).toEqual(expect.arrayContaining([
      settingsFilePath(userData), permissionSettingsPath(), permissionsFilePath(),
      userPolicyPath(), getAdminPolicyPath(), egressGrantFilePath(), userApprovalFilePath(), dirname(projectRulesDirectory(join(root, "ave"))),
    ]));
  });

  it("keeps the entry and canonical target of a linked project", () => {
    const target = join(root, "target");
    mkdirSync(target);
    const link = join(root, "linked");
    symlinkSync(target, link, "dir");
    const denies = buildMandatorySandboxWritePolicy([link]).denyWrite;
    expect(denies).toContain(join(link, ".git", "config"));
    expect(denies).toContain(join(target, ".git", "config"));
    expect(new Set(denies).size).toBe(denies.length);
  });

  it.runIf(process.platform === "linux")("keeps distinct NFC and NFD grant spellings as distinct directories", () => {
    const nfc = join(root, "caf\u00e9");
    const nfd = join(root, "cafe\u0301");
    mkdirSync(nfc);
    mkdirSync(nfd);
    const nfdPolicy = buildMandatorySandboxWritePolicy([nfd]);
    expect(nfdPolicy.allowWrite).toEqual([nfd]);
    expect(nfdPolicy.denyWrite).not.toContain(join(nfc, ".git"));
    expect(buildMandatorySandboxWritePolicy([nfd, nfc]).allowWrite).toEqual([nfd, nfc]);
    const openDirectory = vi.mocked(filesystem.opendirSync).getMockImplementation()!;
    vi.mocked(filesystem.opendirSync).mockImplementation((...args) => {
      if (String(args[0]) === nfd) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      return openDirectory(...args);
    });
    expect(buildMandatorySandboxWritePolicy([nfd, nfc]).allowWrite).toEqual([nfc]);
  });

  it.runIf(process.platform !== "win32")("keeps a POSIX backslash as a filename character in a grant", () => {
    const backslash = join(root, "project\\literal");
    const slash = join(root, "project", "literal");
    mkdirSync(backslash);
    mkdirSync(slash, { recursive: true });
    const backslashPolicy = buildMandatorySandboxWritePolicy([backslash]);
    expect(backslashPolicy.allowWrite).toEqual([backslash]);
    expect(backslashPolicy.denyWrite).toContain(join(backslash, ".git"));
    expect(backslashPolicy.denyWrite).not.toContain(join(slash, ".git"));
    expect(buildMandatorySandboxWritePolicy([backslash, slash]).allowWrite).toEqual([backslash, slash]);
  });

  it("bounds physical resolution of prepared control paths at 64 missing ancestors", () => {
    const withinLimit = join(root, ...Array.from({ length: 62 }, (_, index) => `missing-${index}`));
    const beyondLimit = join(withinLimit, "missing-62");
    expect(buildMandatorySandboxWritePolicy([withinLimit]).allowWrite).toEqual([withinLimit]);
    expect(() => buildMandatorySandboxWritePolicy([beyondLimit])).toThrow("missing ancestor limit");
  });

  it("denies linked gitdir, common metadata and their pointer files beyond the admitted root", () => {
    const checkout = join(root, "checkout");
    const gitDir = join(root, "metadata", "worktree");
    const common = join(root, "common");
    mkdirSync(checkout);
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(common);
    writeFileSync(join(checkout, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "commondir"), "../../common\n");
    const denies = buildMandatorySandboxWritePolicy([checkout]).denyWrite;
    for (const directory of [gitDir, common]) {
      expect(denies).toContain(directory);
    }
  });

  it.runIf(process.platform !== "win32")("resolves link and parent operands before git metadata targets", () => {
    const checkout = join(root, "checkout");
    const external = join(root, "external");
    const gitDir = join(external, "metadata");
    const commonRoot = join(root, "shared");
    const commonDir = join(commonRoot, "common");
    mkdirSync(checkout);
    mkdirSync(join(external, "nested"), { recursive: true });
    mkdirSync(gitDir);
    mkdirSync(join(commonRoot, "nested"), { recursive: true });
    mkdirSync(commonDir);
    symlinkSync(join(external, "nested"), join(checkout, "metadata-link"), "dir");
    symlinkSync(join(commonRoot, "nested"), join(gitDir, "common-link"), "dir");
    writeFileSync(join(checkout, ".git"), "gitdir: metadata-link/../metadata\n");
    writeFileSync(join(gitDir, "commondir"), "common-link/../common\n");
    const denies = buildMandatorySandboxWritePolicy([checkout]).denyWrite;
    expect(denies).toContain(gitDir);
    expect(denies).toContain(commonDir);
    expect(denies).toContainEqual({ path: join(checkout, "metadata-link"), literal: true });
    expect(denies).toContainEqual({ path: join(gitDir, "common-link"), literal: true });
    expect(denies).not.toContain(join(checkout, "metadata"));
  });

  it.each(["gitdir", "commondir"])("rejects non-roundtrippable UTF-8 in %s metadata", (kind) => {
    const marker = join(root, ".git");
    const invalid = Buffer.from([0x66, 0x6f, 0x80, 0x6f, 0x0a]);
    if (kind === "gitdir") {
      writeFileSync(marker, Buffer.concat([Buffer.from("gitdir: "), invalid]));
    } else {
      mkdirSync(marker);
      writeFileSync(join(marker, "commondir"), invalid);
    }
    expect(() => buildMandatorySandboxWritePolicy([root])).toThrow("valid UTF-8");
  });

  it("finds nested directory and pointer markers through the inclusive depth bound", () => {
    const deepest = join(root, ...Array.from({ length: SANDBOX_GIT_SCAN_DEPTH }, (_, i) => `nested-${i}`));
    const below = join(deepest, "below");
    mkdirSync(join(deepest, ".git", "modules"), { recursive: true });
    mkdirSync(join(below, ".git"), { recursive: true });
    const denies = buildMandatorySandboxWritePolicy([root]).denyWrite;
    expect(denies).toContain(join(deepest, ".git"));
    expect(denies).not.toContain(join(below, ".git"));
  });

  it("does not traverse dependency or build trees or directory-link cycles", () => {
    for (const name of ["node_modules", ".venv", "vendor", "dist", "build", ".cache"]) {
      mkdirSync(join(root, name, "inner", ".git"), { recursive: true });
    }
    const nested = join(root, "source");
    mkdirSync(join(nested, ".git"), { recursive: true });
    symlinkSync(root, join(nested, "cycle"), "dir");
    const denies = buildMandatorySandboxWritePolicy([root]).denyWrite;
    expect(denies).toContain(join(nested, ".git"));
    expect(denies).not.toContain(join(root, "node_modules", "inner", ".git"));
  });

  it("rejects oversized or linked common-directory metadata instead of omitting its target", () => {
    const marker = join(root, ".git");
    mkdirSync(marker);
    writeFileSync(join(marker, "commondir"), "x".repeat(65_537));
    expect(() => buildMandatorySandboxWritePolicy([root]).denyWrite).toThrow("metadata");
    rmSync(join(marker, "commondir"));
    writeFileSync(join(root, "pointer"), "common");
    symlinkSync(join(root, "pointer"), join(marker, "commondir"));
    expect(() => buildMandatorySandboxWritePolicy([root]).denyWrite).toThrow();
  });

  it("revokes an exhausted broad grant while retaining a separately scanned child grant and bounded policy", () => {
    const queued = join(root, "queued");
    mkdirSync(queued);
    writeFileSync(join(root, "ordinary.txt"), "ordinary");
    const entries = filesystem.readdirSync(root, { withFileTypes: true });
    const child = entries.find((entry) => entry.name === "queued")!;
    const file = entries.find((entry) => entry.name === "ordinary.txt")!;
    const openDirectory = vi.mocked(filesystem.opendirSync).getMockImplementation()!;
    let reads = 0;
    vi.mocked(filesystem.opendirSync).mockImplementation((...args) => {
      const directory = openDirectory(...args);
      if (String(args[0]) === root) {
        vi.spyOn(directory, "readSync").mockImplementation(() => {
          reads += 1;
          if (reads > 100_000) throw new Error("Unbounded directory scan");
          return reads === 1 ? child : file;
        });
      }
      return directory;
    });
    const second = join(root, "second-root");
    mkdirSync(second);
    const policy = buildMandatorySandboxWritePolicy([root, second]);
    const denies = policy.denyWrite;
    expect(reads).toBeLessThanOrEqual(16_385);
    expect(policy.allowWrite).toEqual([second]);
    expect(denies).not.toContain(root);
    expect(denies).not.toContain(queued);
    expect(denies).not.toContain(second);
    expect(Buffer.byteLength(JSON.stringify(denies))).toBeLessThan(32_768);
  });

  it("revokes a grant with unreadable discovery instead of assuming no repositories exist beneath it", () => {
    const unreadable = join(root, "unreadable");
    mkdirSync(unreadable);
    const openDirectory = vi.mocked(filesystem.opendirSync).getMockImplementation()!;
    vi.mocked(filesystem.opendirSync).mockImplementation((...args) => {
      if (String(args[0]) === unreadable) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      return openDirectory(...args);
    });
    expect(buildMandatorySandboxWritePolicy([root]).allowWrite).toEqual([]);
  });

  it("retains leading space in a valid common-directory name and rejects ambiguous pointers", () => {
    const gitDir = join(root, ".git");
    mkdirSync(gitDir);
    const common = join(gitDir, " common");
    mkdirSync(common);
    writeFileSync(join(gitDir, "commondir"), " common\n");
    expect(buildMandatorySandboxWritePolicy([root]).denyWrite).toContain(common);
    rmSync(gitDir, { recursive: true });
    writeFileSync(gitDir, "gitdir: planted\nother\n");
    expect(() => buildMandatorySandboxWritePolicy([root]).denyWrite).toThrow("directory pointer");
  });

  it.each(
    (["gitdir", "commondir"] as const).flatMap(kind => [
      { kind, label: "ASCII space", suffix: " " },
      { kind, label: "tab", suffix: "\t" },
      { kind, label: "NBSP", suffix: "\u00a0" },
    ]),
  )("preserves a trailing $label in a $kind target", ({ kind, label, suffix }) => {
    const marker = join(root, ".git");
    const target = join(root, `${kind}-${label}${suffix}`);
    if (kind === "gitdir") {
      writeFileSync(marker, `gitdir: ${target}\r\n`);
    } else {
      mkdirSync(marker);
      writeFileSync(join(marker, "commondir"), `${target}\r\n`);
    }
    expect(buildMandatorySandboxWritePolicy([root]).denyWrite).toContain(target);
  });

  it("treats absent gitdir and common targets with pattern characters as literal entries", () => {
    const marker = join(root, ".git");
    const target = join(root, "metadata-[*?]-absent");
    writeFileSync(marker, `gitdir: ${target}\n`);
    expect(buildMandatorySandboxWritePolicy([root]).denyWrite).toContainEqual({ path: target, literal: true });
    rmSync(marker);
    mkdirSync(marker);
    writeFileSync(join(marker, "commondir"), `${target}\n`);
    expect(buildMandatorySandboxWritePolicy([root]).denyWrite).toContainEqual({ path: target, literal: true });
  });

  it.each(["gitdir", "commondir"] as const)("denies the first missing component of an absent %s target", (kind) => {
    const marker = join(root, ".git");
    const storage = join(root, `${kind}-storage`);
    const firstMissing = join(storage, "missing");
    const target = join(firstMissing, "metadata");
    mkdirSync(storage);
    if (kind === "gitdir") {
      writeFileSync(marker, `gitdir: ${target}\n`);
    } else {
      mkdirSync(marker);
      writeFileSync(join(marker, "commondir"), `${target}\n`);
    }
    expect(buildMandatorySandboxWritePolicy([root]).denyWrite).toEqual(expect.arrayContaining([firstMissing, target]));
  });

  it.each(["gitdir", "commondir"] as const)("rejects unresolved parent traversal in a missing %s target", (kind) => {
    const marker = join(root, ".git");
    const storage = join(root, `${kind}-storage`);
    mkdirSync(storage);
    const target = `${storage}${sep}missing${sep}..${sep}metadata`;
    if (kind === "gitdir") {
      writeFileSync(marker, `gitdir: ${target}\n`);
    } else {
      mkdirSync(marker);
      writeFileSync(join(marker, "commondir"), `${target}\n`);
    }
    expect(() => buildMandatorySandboxWritePolicy([root])).toThrow("unresolved parent traversal");
  });

  it("inspects unknown directory-entry types instead of skipping nested repositories", () => {
    const nested = join(root, "unknown");
    mkdirSync(join(nested, ".git"), { recursive: true });
    const openDirectory = vi.mocked(filesystem.opendirSync).getMockImplementation()!;
    vi.mocked(filesystem.opendirSync).mockImplementation((...args) => {
      const directory = openDirectory(...args);
      if (String(args[0]) === root) {
        const read = directory.readSync.bind(directory);
        vi.spyOn(directory, "readSync").mockImplementation(() => {
          const entry = read();
          if (entry?.name === "unknown") {
            for (const method of ["isDirectory", "isSymbolicLink", "isFile", "isBlockDevice", "isCharacterDevice", "isFIFO", "isSocket"] as const) {
              vi.spyOn(entry, method).mockReturnValue(false);
            }
          }
          return entry;
        });
      }
      return directory;
    });
    expect(buildMandatorySandboxWritePolicy([root]).denyWrite).toContain(join(nested, ".git"));
  });

  it("does not enumerate directory links outside the admitted root or read linked marker files", () => {
    const project = join(root, "project");
    const external = join(root, "external");
    mkdirSync(project);
    mkdirSync(join(external, ".git"), { recursive: true });
    symlinkSync(external, join(project, "outside"), "dir");
    expect(buildMandatorySandboxWritePolicy([project]).denyWrite).not.toContain(join(external, ".git", "config"));
    expect(vi.mocked(filesystem.opendirSync).mock.calls.map(args => String(args[0]))).not.toContain(join(project, "outside"));
    writeFileSync(join(external, "pointer"), "gitdir: metadata\n");
    symlinkSync(join(external, "pointer"), join(project, ".git"));
    expect(() => buildMandatorySandboxWritePolicy([project]).denyWrite).toThrow("markers are unsupported");
  });

  it("shares metadata byte limits across all admitted roots", () => {
    const roots = Array.from({ length: 17 }, (_, index) => join(root, `project-${index}`));
    const pointer = "gitdir: metadata".padEnd(65_536, "\n");
    for (const project of roots) {
      mkdirSync(project);
      writeFileSync(join(project, ".git"), pointer);
    }
    expect(() => buildMandatorySandboxWritePolicy(roots).denyWrite).toThrow("metadata budget exhausted");
  });

  it("finishes short metadata reads and refuses an early EOF instead of accepting a truncated pointer", async () => {
    const target = join(root, "actual-metadata");
    writeFileSync(join(root, ".git"), `gitdir: ${target}\n`);
    const { readSync: read } = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(filesystem.readSync).mockImplementation(((fd, buffer, offset, length, position) =>
      read(fd, buffer, offset, Math.min(length, 3), position)) as typeof filesystem.readSync);
    expect(buildMandatorySandboxWritePolicy([root]).denyWrite).toContain(target);
    expect(vi.mocked(filesystem.readSync).mock.calls.length).toBeGreaterThan(2);
    let calls = 0;
    vi.mocked(filesystem.readSync).mockImplementation(((fd, buffer, offset, length, position) =>
      calls++ === 0 ? read(fd, buffer, offset, Math.min(length, 10), position) : 0) as typeof filesystem.readSync);
    expect(() => buildMandatorySandboxWritePolicy([root]).denyWrite).toThrow("metadata changed during discovery");
  });

  it("bounds metadata policy growth before the entry budget is exhausted", () => {
    const child = join(root, "child");
    for (let index = 0; index < 180; index++) {
      mkdirSync(join(child, `repository-${index}-${"x".repeat(100)}`, ".git"), { recursive: true });
    }
    const policy = buildMandatorySandboxWritePolicy([root, child]);
    expect(policy.allowWrite).toEqual([]);
    expect(policy.denyWrite).not.toContain(root);
    expect(policy.denyWrite).not.toContain(child);
    expect(Buffer.byteLength(JSON.stringify(policy.denyWrite))).toBeLessThan(32_768);
  });

  it.each(["gitdir", "commondir"])("keeps a discovered %s deny above a retained child grant", (kind) => {
    const broad = join(root, "broad");
    const checkout = join(root, "workspace", "checkout");
    const metadata = join(broad, "metadata");
    const hooks = join(metadata, "hooks");
    const nested = join(checkout, "nested");
    mkdirSync(hooks, { recursive: true });
    mkdirSync(nested, { recursive: true });
    const gitDir = kind === "gitdir" ? metadata : join(metadata, "worktree");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(nested, ".git"), `gitdir: ${gitDir}\n`);
    if (kind === "commondir") writeFileSync(join(gitDir, "commondir"), "..\n");
    writeFileSync(join(broad, "ordinary"), "ordinary");
    const file = filesystem.readdirSync(broad, { withFileTypes: true }).find(entry => entry.name === "ordinary")!;
    const openDirectory = vi.mocked(filesystem.opendirSync).getMockImplementation()!;
    vi.mocked(filesystem.opendirSync).mockImplementation((...args) => {
      const directory = openDirectory(...args);
      if (String(args[0]) === broad) vi.spyOn(directory, "readSync").mockReturnValue(file);
      return directory;
    });
    const policy = buildMandatorySandboxWritePolicy([broad, checkout, hooks]);
    expect(policy.allowWrite).toEqual([checkout, hooks]);
    expect(policy.denyWrite).toContain(metadata);
  });

  it.each([false, true])("keeps canonical grant identity when an alias retargets during discovery (exhausted=%s)", (exhausted) => {
    const original = join(root, "original");
    const replacement = join(root, "replacement");
    const alias = join(root, "alias");
    mkdirSync(original); mkdirSync(replacement);
    symlinkSync(original, alias, "dir");
    writeFileSync(join(original, "ordinary"), "ordinary");
    const file = filesystem.readdirSync(original, { withFileTypes: true })[0]!;
    const openDirectory = vi.mocked(filesystem.opendirSync).getMockImplementation()!;
    vi.mocked(filesystem.opendirSync).mockImplementation((...args) => {
      const directory = openDirectory(...args);
      if (String(args[0]) === original) {
        rmSync(alias); symlinkSync(replacement, alias, "dir");
        if (exhausted) vi.spyOn(directory, "readSync").mockReturnValue(file);
      }
      return directory;
    });
    const policy = buildMandatorySandboxWritePolicy([alias]);
    expect(policy.allowWrite).toEqual(exhausted ? [] : [original]);
    expect(policy.denyWrite).toContain(join(original, ".git"));
  });
});
