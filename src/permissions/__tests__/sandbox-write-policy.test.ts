vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import * as filesystem from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { configureHostResources } from "../../main/host-resources.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSandboxWritePolicySize, buildMandatorySandboxWritePolicy, compactSandboxWriteDenies, findNonRepositoryWriteRoots, isGrantPathWithin, isSandboxGitMetadataEntry, SANDBOX_GIT_SCAN_DEPTH, snapshotSandboxGitControls } from "../sandbox-write-policy.js";
import { getLocale, setLocale, t } from "../../i18n/index.js";
import { PROTECTED_ROOT_ENTRIES } from "../sensitive-paths.js";
import { buildPerCommandSandboxCustomConfig, buildSandboxConfig, getDefaultSensitiveWriteDenyPaths } from "../asrt-sandbox.js";
import { permissionSettingsPath } from "../permission-settings-store.js";
import { egressGrantFilePath } from "../egress-grants.js";
import { userApprovalFilePath } from "../user-approval-store.js";
import { permissionsFilePath } from "../permissions-store.js";
import { getAdminPolicyPath, userPolicyPath } from "../policy-store.js";
import { projectRulesDirectory } from "../rules/project-rule-files.js";
import { settingsFilePath } from "../../data/settings-store.js";
import type { FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...(await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(actual), opendirSync: vi.fn(actual.opendirSync), readSync: vi.fn(actual.readSync) };
});

function withPlatform<T>(platform: "darwin" | "linux" | "win32", action: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    return action();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

// Compare accepted drive separators without changing names, entry kinds or directory hints.
function nativeDenyRows(entries: readonly FilesystemPathEntry[] | undefined): FilesystemPathEntry[] | undefined {
  return entries?.map(entry => {
    const path = typeof entry === "string" ? entry : entry.path;
    const native = /^[A-Za-z]:[\\/]/u.test(path) ? path.replaceAll("/", "\\") : path;
    return typeof entry === "string" ? native : { ...entry, path: native };
  });
}

function expectLiteralDenyCovers(entries: readonly FilesystemPathEntry[] | undefined, path: string): void {
  const drive = /^[A-Za-z]:[\\/]/u.test(path);
  const native = drive ? path.replaceAll("/", "\\") : path;
  const target = process.platform === "win32" ? native.toLowerCase() : native;
  expect(nativeDenyRows(entries)?.some(entry => {
    if (typeof entry === "string" && /[*?\[\]]/.test(entry)) return false;
    const value = typeof entry === "string" ? entry : entry.path;
    const base = process.platform === "win32" ? value.toLowerCase() : value;
    return target === base || target.startsWith(base + (drive ? "\\" : sep));
  }), path).toBe(true);
}

async function reportMissingChildrenUnder(file: string): Promise<void> {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.spyOn(filesystem, "lstatSync").mockImplementation(((path, options) => {
    if (String(path).startsWith(file + sep) && typeof options === "object" && options?.throwIfNoEntry === false) return undefined;
    return actual.lstatSync(path, options);
  }) as typeof filesystem.lstatSync);
}

describe("mandatory sandbox control-file writes", () => {
  let root: string;
  beforeEach(async () => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
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

  const loaderEntries = [".bash_profile", ".githooks", ".pre-commit-config.yaml", "lefthook.yml", ".idea/workspace.xml", ".envrc", ".mise.toml", "mise.toml", ".tool-versions", ".npmrc", ".yarnrc.yml", "bunfig.toml", ".husky"];

  it.each(["win32", "linux"] as const)("keeps explicit descendant write denies for %s enforcement", platform => {
    const parent = join(root, "protected");
    const child = join(parent, "nested", "control");
    mkdirSync(join(parent, "nested"), { recursive: true });
    const entries = [parent, { path: child, literal: true as const }];
    expect(withPlatform(platform, () => compactSandboxWriteDenies(entries))).toEqual(entries);
    expect(withPlatform("darwin", () => compactSandboxWriteDenies(entries))).toEqual([sep === "\\" ? parent.replaceAll("\\", "/") : parent]);
  });

  it("emits equivalent drive literals once while retaining explicit child denies and directory intent", () => {
    const entries: FilesystemPathEntry[] = ["D:\\MiXeD\\private\\",
      "D:/MiXeD/private/", String.raw`D:\MiXeD\private\allowed\control`,
      String.raw`D:\MiXeD\café`, String.raw`D:\MiXeD\café`];
    expect(withPlatform("win32", () => compactSandboxWriteDenies(entries))).toEqual([
      "D:\\MiXeD\\private\\", String.raw`D:\MiXeD\private\allowed\control`, String.raw`D:\MiXeD\café`, String.raw`D:\MiXeD\café`,
    ]);
  });

  it("preserves pattern readings and opaque namespaces beside marked drive literals", () => {
    const pattern = String.raw`D:\MiXeD\[key]\control`;
    const forwardSlashes = pattern.replaceAll("\\", "/");
    const literal = Object.freeze({ path: forwardSlashes, literal: true as const });
    const extended = String.raw`\\?\D:\MiXeD\control`;
    const network = String.raw`\\server\share\control`;
    const entries = withPlatform("win32", () => compactSandboxWriteDenies([
      pattern, literal, extended, network, "D:relative", String.raw`D:\file:stream`,
    ]));
    expect(entries).toEqual([pattern, { path: pattern, literal: true }, extended, network, "D:relative", String.raw`D:\file:stream`]);
    expect(Object.isFrozen(entries[1])).toBe(true);
    expect(literal.path).toBe(forwardSlashes);
  });

  it.each([".idea"].flatMap(entry => [false, true].map(reportsMissingChild => ({ entry, reportsMissingChild }))))
  ("retains $entry protection after a regular placeholder with native missing-child reporting=$reportsMissingChild", async ({ entry, reportsMissingChild }) => {
    const project = join(root, "project");
    mkdirSync(project);
    const initial = withPlatform("linux", () => buildMandatorySandboxWritePolicy([project]));
    const placeholder = join(project, entry);
    writeFileSync(placeholder, "");
    if (reportsMissingChild) await reportMissingChildrenUnder(placeholder);
    withPlatform("linux", () => {
      const child = join(placeholder, "workspace.xml");
      const repeated = buildMandatorySandboxWritePolicy([project], undefined, [child]);
      expect(repeated.allowWrite).toEqual(initial.allowWrite);
      expect(nativeDenyRows(repeated.denyWrite)).toContain(placeholder);
      expect(nativeDenyRows(repeated.denyWrite)).toEqual(nativeDenyRows(initial.denyWrite));
      expectLiteralDenyCovers(repeated.denyWrite, child);
    });
  });

  it.each([".idea"])("pins a linked regular %s ancestor before omitting impossible children", entry => {
    const project = join(root, "project");
    const work = join(project, "work");
    const target = join(root, "external-placeholder");
    mkdirSync(work, { recursive: true });
    writeFileSync(target, "protected fixture");
    const link = join(project, entry);
    symlinkSync(target, link, "file");
    const policy = withPlatform("linux", () => buildMandatorySandboxWritePolicy([project, work]));
    expect(policy.allowWrite).toEqual([work]);
    expect(policy.narrowedWriteRoots).toEqual([{ root: project, reason: "routing-link" }]);
    expect(nativeDenyRows(policy.denyWrite)).toEqual(expect.arrayContaining([link, target]));
  });

  it.each([false, true])("refuses an unprotected regular ancestor when native missing-child reporting is %s", async reportsMissingChild => {
    const project = join(root, "project");
    mkdirSync(project);
    const blocker = join(project, ".config");
    writeFileSync(blocker, "not protected as a whole project directory");
    if (reportsMissingChild) await reportMissingChildrenUnder(blocker);
    expect(() => withPlatform("linux", () => buildMandatorySandboxWritePolicy([project])))
      .toThrow(/ENOTDIR/);
  });

  it.each(["darwin", "linux", "win32"] as const)("retains an inherited regular configuration directory deny on %s", async platform => {
    const project = join(root, "project");
    const configDirectory = join(root, ".config", "git");
    mkdirSync(project);
    mkdirSync(dirname(configDirectory));
    writeFileSync(configDirectory, "protected placeholder");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "");
    vi.stubEnv("XDG_CONFIG_HOME", join(root, ".config"));
    for (const reportsMissingChild of [false, true]) {
      if (reportsMissingChild) await reportMissingChildrenUnder(configDirectory);
      const policy = withPlatform(platform, () => buildMandatorySandboxWritePolicy([project]));
      expect(policy.allowWrite).toEqual([project]);
      expectLiteralDenyCovers(policy.denyWrite, configDirectory);
      expectLiteralDenyCovers(policy.denyWrite, join(configDirectory, "config"));
      expect(filesystem.readFileSync(configDirectory, "utf8")).toBe("protected placeholder");
    }
  });

  it("fails closed when an inherited configuration directory cannot be inspected", async () => {
    const project = join(root, "project");
    const configDirectory = join(root, ".config", "git");
    mkdirSync(project);
    vi.stubEnv("GIT_CONFIG_GLOBAL", "");
    vi.stubEnv("XDG_CONFIG_HOME", join(root, ".config"));
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.spyOn(filesystem, "lstatSync").mockImplementation(((path, options) => {
      if (String(path) === configDirectory) throw Object.assign(new Error("Configuration inspection denied"), { code: "EACCES" });
      return actual.lstatSync(path, options);
    }) as typeof filesystem.lstatSync);
    expect(() => buildMandatorySandboxWritePolicy([project])).toThrow("Configuration inspection denied");
  });

  it.each(["darwin", "linux", "win32"] as const)("omits only impossible inherited probes below an ordinary regular ancestor on %s", platform => {
    const project = join(root, "project");
    const blocker = join(root, ".config");
    mkdirSync(project);
    writeFileSync(blocker, "ordinary file");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "");
    vi.stubEnv("XDG_CONFIG_HOME", blocker);
    const policy = withPlatform(platform, () => buildMandatorySandboxWritePolicy([project]));
    expect(policy.allowWrite).toEqual([project]);
    expect(nativeDenyRows(policy.denyWrite)).not.toContain(blocker);
    expect(nativeDenyRows(policy.denyWrite)).not.toContain(join(blocker, "git", "config"));
    expectLiteralDenyCovers(policy.denyWrite, join(project, ".config", "git"));
    expect(filesystem.readFileSync(blocker, "utf8")).toBe("ordinary file");
  });

  it("emits no drive-relative system Git file on Windows and keeps an explicit one", () => {
    const project = join(root, "project");
    mkdirSync(project);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "0");
    vi.stubEnv("GIT_CONFIG_SYSTEM", undefined);
    const systemRows = (entries: readonly FilesystemPathEntry[]) => entries
      .map(entry => typeof entry === "string" ? entry : entry.path).filter(path => /[\\/]etc[\\/]gitconfig$/u.test(path));
    expect(systemRows(withPlatform("win32", () => buildMandatorySandboxWritePolicy([project])).denyWrite)).toEqual([]);
    expect(systemRows(withPlatform("linux", () => buildMandatorySandboxWritePolicy([project])).denyWrite)).toContain("/etc/gitconfig");
    const explicit = join(root, "machine", "etc", "gitconfig");
    vi.stubEnv("GIT_CONFIG_SYSTEM", explicit);
    expect(systemRows(withPlatform("win32", () => buildMandatorySandboxWritePolicy([project])).denyWrite)).toContain(explicit);
  });

  it.each(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const)("refuses an obstructed explicit %s target in a writable project", variable => {
    const project = join(root, "project");
    const blocker = join(project, "ordinary-blocker");
    mkdirSync(project);
    writeFileSync(blocker, "replaceable file");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "0");
    vi.stubEnv(variable, join(blocker, "config"));
    expect(() => buildMandatorySandboxWritePolicy([project])).toThrow(/ENOTDIR/);
    expect(filesystem.readFileSync(blocker, "utf8")).toBe("replaceable file");
  });

  it("refuses an optional inherited probe when its unprotected blocker is writable", () => {
    const project = join(root, "project");
    const home = join(project, "home");
    const blocker = join(home, ".config");
    mkdirSync(home, { recursive: true });
    writeFileSync(blocker, "replaceable file");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("GIT_CONFIG_GLOBAL", "");
    vi.stubEnv("XDG_CONFIG_HOME", blocker);
    expect(() => buildMandatorySandboxWritePolicy([project])).toThrow(/ENOTDIR/);
    expect(filesystem.readFileSync(blocker, "utf8")).toBe("replaceable file");
  });

  it("retains literal control denies for an absent grant root", () => {
    const missing = join(root, "absent", "project");
    const policy = withPlatform("darwin", () => buildMandatorySandboxWritePolicy([missing]));
    expect(policy.allowWrite).toEqual([missing]);
    expect(policy.narrowedWriteRoots).toEqual([]);
    expect(nativeDenyRows(policy.denyWrite)).toContain(join(missing, ".bash_profile"));
    expectLiteralDenyCovers(policy.denyWrite, join(missing, ".idea", "workspace.xml"));
    expect(filesystem.existsSync(missing)).toBe(false);
  });

  it("does not treat a denied ancestor inspection as an absent path", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.spyOn(filesystem, "lstatSync").mockImplementation(((path, options) => {
      if (String(path) === root && typeof options === "object" && options?.throwIfNoEntry === false) {
        throw Object.assign(new Error("Access denied"), { code: "EACCES" });
      }
      return actual.lstatSync(path, options);
    }) as typeof filesystem.lstatSync);
    expect(() => withPlatform("darwin", () => buildMandatorySandboxWritePolicy([join(root, "missing")]))).toThrow("Access denied");
  });

  it.each(["darwin", "linux", "win32"] as const)("protects the complete application configuration directory on %s", platform => {
    const project = join(root, "project");
    const configuration = join(root, "ave", "config");
    mkdirSync(project);
    withPlatform(platform, () => {
      const policy = buildMandatorySandboxWritePolicy([root, project]);
      expectLiteralDenyCovers(policy.denyWrite, configuration);
      expectLiteralDenyCovers(policy.denyWrite, join(configuration, "future-control", "policy.json"));
      expect(nativeDenyRows(policy.denyWrite)).not.toContain(join(root, "ave"));
    });
  });

  it.each(["darwin", "linux", "win32"] as const)("protects existing and absent loader paths in the shared policy on %s", platform => {
    withPlatform(platform, () => {
      for (const existing of [false, true]) {
        const project = join(root, existing ? "existing" : "absent");
        mkdirSync(project);
        if (existing) for (const entry of loaderEntries) {
          if ([".husky", ".githooks"].includes(entry)) mkdirSync(join(project, entry), { recursive: true });
          else {
            mkdirSync(dirname(join(project, entry)), { recursive: true });
            writeFileSync(join(project, entry), "loader fixture");
          }
        }
        const policy = buildMandatorySandboxWritePolicy([project]);
        for (const entry of loaderEntries) expectLiteralDenyCovers(policy.denyWrite, join(project, entry));
      }
    });
  });

  it.each(["darwin", "linux", "win32"] as const)("protects existing and absent configured hook targets on %s", platform => {
    withPlatform(platform, () => {
      for (const existing of [false, true]) {
        const project = join(root, existing ? "existing" : "absent");
        const marker = join(project, ".git");
        const hooks = join(project, "custom-hooks");
        mkdirSync(marker, { recursive: true });
        writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
        writeFileSync(join(marker, "config"), '[core]\n hooksPath = "custom-hooks"\n');
        if (existing) { mkdirSync(hooks); writeFileSync(join(hooks, "pre-commit"), "hook fixture"); }
        const policy = buildMandatorySandboxWritePolicy([project]);
        expect(nativeDenyRows(policy.denyWrite)).toContain(hooks);
        expect(nativeDenyRows(policy.denyWrite)).toContain(join(marker, "custom-hooks"));
      }
    });
  });

  it.each(["darwin", "linux"] as const)("protects physical loader and configured-hook targets on %s", platform => {
    withPlatform(platform, () => {
      const project = join(root, "project");
      const marker = join(project, ".git");
      const target = join(root, "physical-hook-target");
      mkdirSync(marker, { recursive: true });
      mkdirSync(target);
      writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(marker, "config"), '[core]\n hooksPath = "linked-hooks"\n');
      symlinkSync(target, join(project, "linked-hooks"), "dir");
      const loader = join(root, "physical-loader");
      writeFileSync(loader, "loader fixture");
      symlinkSync(loader, join(project, "mise.toml"));
      const policy = buildMandatorySandboxWritePolicy([project]);
      expect(nativeDenyRows(policy.denyWrite)).toContain(target);
      expect(nativeDenyRows(policy.denyWrite)).toContain(loader);
      if (platform === "linux") expect(policy.allowWrite).not.toContain(project);
    });
  });

  it.each(["darwin", "linux"] as const)("pins linked child loaders inside separately writable targets on %s", platform => {
    withPlatform(platform, () => {
      const project = join(root, "project");
      const storage = join(root, "storage");
      const work = join(project, "work");
      for (const directory of [join(project, ".config"), join(project, ".idea"), work, storage]) {
        mkdirSync(directory, { recursive: true });
      }
      const hooks = join(storage, "hooks");
      const workspace = join(storage, "workspace.xml");
      mkdirSync(hooks);
      writeFileSync(workspace, "workspace fixture");
      const hookLink = join(project, ".config", "git");
      const workspaceLink = join(project, ".idea", "workspace.xml");
      symlinkSync(hooks, hookLink, "dir");
      symlinkSync(workspace, workspaceLink, "file");
      const policy = buildMandatorySandboxWritePolicy([project, storage, work]);
      expectLiteralDenyCovers(policy.denyWrite, hookLink);
      expectLiteralDenyCovers(policy.denyWrite, workspaceLink);
      expect(nativeDenyRows(policy.denyWrite)).toEqual(expect.arrayContaining([hooks, workspace]));
      if (platform === "linux") expect(policy.allowWrite).toEqual([storage, work]);
      else expect(policy.allowWrite).toEqual([project, storage, work]);
    });
  });

  it.each(["darwin", "linux", "win32"] as const)("preserves the final deny union while compacting inherited literal denies on %s", platform => {
    const project = join(root, "covered", "work");
    const inherited = join(root, "covered");
    const external = join(root, "external-loader");
    mkdirSync(project, { recursive: true });
    writeFileSync(external, "loader fixture");
    symlinkSync(external, join(project, ".bash_profile"), "file");
    withPlatform(platform, () => {
      const original = buildMandatorySandboxWritePolicy([project]);
      const compact = buildMandatorySandboxWritePolicy([project], undefined, [], [inherited]);
      expect(compact.allowWrite).toEqual(original.allowWrite);
      expect(compact.narrowedWriteRoots).toEqual(original.narrowedWriteRoots);
      const final = [inherited, ...(compact.denyWrite ?? [])];
      for (const entry of original.denyWrite ?? []) {
        if (typeof entry === "string" && /[*?\[\]]/.test(entry)) expect(final).toContain(entry);
        else expectLiteralDenyCovers(final, typeof entry === "string" ? entry : entry.path);
      }
      expect(nativeDenyRows(compact.denyWrite)).toContain(external);
      if (platform === "win32") expect(nativeDenyRows(compact.denyWrite)).toEqual(nativeDenyRows(original.denyWrite));
      else expect(Buffer.byteLength(JSON.stringify(compact.denyWrite))).toBeLessThan(Buffer.byteLength(JSON.stringify(original.denyWrite)));
      expect(Buffer.byteLength(JSON.stringify(compact.denyWrite))).toBeLessThan(32_768);
    });
  });

  it.each(["relative/path", join(tmpdir(), "pattern-*")])("refuses nonliteral inherited deny authority: %s", path => {
    expect(() => buildMandatorySandboxWritePolicy([root], undefined, [], [path]))
      .toThrow("Invalid inherited sandbox write deny");
  });

  it("rejects bracket patterns as inherited Linux write denies", () => {
    withPlatform("linux", () => {
      expect(() => buildMandatorySandboxWritePolicy([root], undefined, [], [join(root, "Work [Archive]")]))
        .toThrow("Invalid inherited sandbox write deny");
    });
  });

  it("includes inherited, conditional, common and worktree hook targets without executing configuration", () => {
    const project = join(root, "project");
    const marker = join(project, ".git");
    const metadata = join(root, "metadata");
    const common = join(root, "common");
    mkdirSync(project); mkdirSync(metadata); mkdirSync(common);
    writeFileSync(marker, "gitdir: " + metadata + "\n");
    writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(metadata, "commondir"), common + "\n");
    writeFileSync(join(metadata, "config.worktree"), '[core]\n hooksPath = "worktree-hooks"\n');
    writeFileSync(join(common, "config"), '[core]\n hooksPath = "common-hooks"\n');
    const included = join(root, "included-config");
    writeFileSync(join(root, ".gitconfig"), '[core]\n hooksPath = "global-hooks"\n[includeIf "gitdir:never-matches"]\n path = "included-config"\n');
    writeFileSync(included, '[core]\n hooksPath = "~/included-hooks"\n');
    const policy = buildMandatorySandboxWritePolicy([project]);
    for (const name of ["global-hooks", "worktree-hooks", "common-hooks"]) expect(nativeDenyRows(policy.denyWrite)).toContain(join(project, name));
    expect(nativeDenyRows(policy.denyWrite)).toContain(join(root, "included-hooks"));
    expect(nativeDenyRows(policy.denyWrite)).toContain(included);
  });

  it("decodes quoted hook paths and preserves pattern characters as literal targets", () => {
    const project = join(root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, ".git", "config"), '[CORE] hooksPath = "hooks [local] \\"quoted\\"" # trailing comment\n');
    const target = join(project, 'hooks [local] "quoted"');
    expect(nativeDenyRows(buildMandatorySandboxWritePolicy([project]).denyWrite)).toContainEqual({ path: target, literal: true });
  });

  it("does not write-deny the POSIX null device used to disable hooks", () => {
    const project = join(root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, ".git", "config"), '[core]\n hooksPath = /dev/null\n');
    expect(nativeDenyRows(withPlatform("linux", () => buildMandatorySandboxWritePolicy([project])).denyWrite)).not.toContain("/dev/null");
  });

  it.each(["darwin", "linux", "win32"] as const)("applies inherited relative hooks to every discovered nested repository on %s", platform => {
    withPlatform(platform, () => {
      const workspace = join(root, "workspace");
      const repository = join(workspace, "nested", "repository");
      const marker = join(repository, ".git");
      mkdirSync(marker, { recursive: true });
      writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(root, ".gitconfig"), '[core]\n hooksPath = "custom-hooks"\n');
      const policy = buildMandatorySandboxWritePolicy([workspace]);
      expect(nativeDenyRows(policy.denyWrite)).toContain(join(repository, "custom-hooks"));
      expect(nativeDenyRows(policy.denyWrite)).toContain(join(marker, "custom-hooks"));
    });
  });

  it("protects configured hooks when the write grant starts below the repository root", () => {
    const project = join(root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, "child"));
    writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(project, ".git", "config"), '[core]\n hooksPath = "child/hooks"\n');
    expect(nativeDenyRows(buildMandatorySandboxWritePolicy([join(project, "child")]).denyWrite)).toContain(join(project, "child", "hooks"));
  });

  it("refuses ambiguous hook path interpolation instead of leaving its target writable", () => {
    const project = join(root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, ".git", "config"), '[core]\n hooksPath = "%(prefix)/hooks"\n');
    expect(() => buildMandatorySandboxWritePolicy([project])).toThrow("Unsupported sandbox Git configuration path");
  });

  // The shared floor's own list, so a new entry cannot fall off the sandbox floor unnoticed; `.git/*` controls are covered by the Git tests below.
  // `.agents` is a row per root on Linux only; the macOS wrap carries it as an appended rule (see the named-entry case below).
  it.each([".git", ...PROTECTED_ROOT_ENTRIES.filter(entry => !isSandboxGitMetadataEntry(entry) && entry !== ".agents")])("protects missing %s in every writable root", (entry) => {
    const roots = [join(root, "project"), join(root, "temp")];
    const denies = buildMandatorySandboxWritePolicy(roots).denyWrite;
    for (const base of roots) {
      if (entry === ".git" && process.platform === "linux") expect(nativeDenyRows(denies)).not.toContain(join(base, entry));
      else expect(nativeDenyRows(denies)).toContain(join(base, entry));
    }
  });

  // `.agents`, and the commands and hooks Ave loads from the project. Linux carries a row per root.
  // macOS carries none: a row per root does not fit its policy budget, so its wrap denies the names in the profile
  // (macos-sandbox-wrap.ts). The Windows floor is not changed here.
  it("denies .agents and the project command and hook names in write roots on Linux, and leaves the macOS policy without rows for them", () => {
    const roots = [join(root, "project"), join(root, "temp")];
    const names = [".agents", ".ave/commands", ".ave/hooks"];
    const rowsNaming = (denies: ReturnType<typeof nativeDenyRows>, name: string) => (denies ?? [])
      .map(entry => typeof entry === "string" ? entry : entry.path).filter(path => path.endsWith(join(sep, name)));
    const holding = (denies: ReturnType<typeof nativeDenyRows>, text: string) => (denies ?? [])
      .map(entry => typeof entry === "string" ? entry : entry.path).filter(path => path.includes(text));
    withPlatform("darwin", () => {
      const denies = nativeDenyRows(buildMandatorySandboxWritePolicy(roots).denyWrite);
      for (const name of names) expect(rowsNaming(denies, name)).toEqual([]);
      for (const text of ["srt-sock", ".agents", ".aws", ".ave/"]) expect(holding(denies, text)).toEqual([]);
    });
    withPlatform("linux", () => {
      const denies = nativeDenyRows(buildMandatorySandboxWritePolicy(roots).denyWrite);
      for (const name of names) expect(rowsNaming(denies, name)).toEqual(roots.map(base => join(base, name)));
      // The `.ave` directory is not a row itself, and `.codex` and a project `.aws` are not named.
      for (const base of roots) for (const unnamed of [".ave", ".codex", ".aws"]) expect(holding(denies, join(base, unnamed)).filter(path => !path.includes(join(sep, ".ave", sep)))).toEqual([]);
    });
  });

  it.each(["darwin", "linux"] as const)("expands home grants before deriving controls on %s", (platform) => {
    withPlatform(platform, () => {
      const project = join(root, "project");
      const policies = [
        buildSandboxConfig({ allowWrite: ["~/project"] }).filesystem,
        buildPerCommandSandboxCustomConfig({ allowWrite: ["~/project"] })!.filesystem!,
      ];
      for (const policy of policies) {
        expect(policy.allowWrite).toEqual([project]);
        expect(nativeDenyRows(policy.denyWrite)).toContain(join(project, ".bashrc"));
        expect(nativeDenyRows(policy.denyWrite)).not.toContain(join("~", "project", ".bashrc"));
      }
    });
  });

  it("hands only the .git marker and its children to the Git control policy", () => {
    expect(PROTECTED_ROOT_ENTRIES.filter(isSandboxGitMetadataEntry))
      .toEqual([".git"]);
    for (const entry of [".git", ".git/hooks", ".git/config", ".git/modules"]) {
      expect(isSandboxGitMetadataEntry(entry)).toBe(true);
    }
    for (const entry of [".gitconfig", ".githooks", ".github", ".gitignore"]) {
      expect(isSandboxGitMetadataEntry(entry)).toBe(false);
    }
    const project = join(root, "project");
    const marker = join(project, ".git");
    mkdirSync(join(marker, "modules", "inner", "hooks"), { recursive: true });
    mkdirSync(join(marker, "hooks"));
    writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(marker, "config"), "existing control");
    writeFileSync(join(marker, "modules", "inner", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(marker, "modules", "inner", "config"), "existing control");
    const denies = buildMandatorySandboxWritePolicy([project]).denyWrite;
    for (const entry of [".gitconfig", ".githooks", ".husky", ".idea", ".idea/workspace.xml"]) expectLiteralDenyCovers(denies, join(project, entry));
    for (const path of [marker, join(marker, "modules"), join(marker, "modules", "inner")]) expect(nativeDenyRows(denies)).not.toContain(path);
    for (const path of [join(marker, "hooks"), join(marker, "config"), join(marker, "modules", "inner", "hooks"), join(marker, "modules", "inner", "config")]) {
      expect(nativeDenyRows(denies)).toContain(path);
    }
  });

  it.each([".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile"])("keeps the host-home %s in the existing sensitive floor only", (entry) => {
    expect(getDefaultSensitiveWriteDenyPaths()).toContain(join(root, entry));
    expect(nativeDenyRows(buildMandatorySandboxWritePolicy([join(root, "project")]).denyWrite)).not.toContain(join(root, entry));
  });

  it("takes settings, rules, approvals and policy locations from their stores", () => {
    const userData = join(root, "desktop-data");
    const denies = buildMandatorySandboxWritePolicy([root], userData).denyWrite;
    for (const path of [
      settingsFilePath(userData), permissionSettingsPath(), permissionsFilePath(),
      userPolicyPath(), getAdminPolicyPath(), egressGrantFilePath(), userApprovalFilePath(), dirname(projectRulesDirectory(join(root, "ave"))),
    ]) expectLiteralDenyCovers(denies, path);
  });

  it("keeps the entry and canonical target of a linked project", () => {
    const target = join(root, "target");
    mkdirSync(target);
    const link = join(root, "linked");
    symlinkSync(target, link, "dir");
    const denies = buildMandatorySandboxWritePolicy([link]).denyWrite;
    if (process.platform === "linux") expect(nativeDenyRows(denies)).not.toContain(join(target, ".git"));
    else expect(nativeDenyRows(denies)).toContain(join(target, ".git"));
    expect(new Set(denies).size).toBe(denies.length);
  });

  it("allows ordinary metadata writes while denying execution and routing controls", () => {
    const marker = join(root, ".git");
    mkdirSync(marker);
    writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    for (const entry of ["hooks", "config", "config.worktree", "commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates", "branches", "remotes"]) {
      mkdirSync(dirname(join(marker, entry)), { recursive: true });
      if (["hooks", "branches", "remotes"].includes(entry)) mkdirSync(join(marker, entry));
      else writeFileSync(join(marker, entry), entry === "commondir" ? ".\n" : "existing control");
    }
    const policy = buildMandatorySandboxWritePolicy([root]);
    expect(policy.allowWrite).toEqual([root]);
    for (const entry of ["", "objects", "refs", "index", "HEAD", "logs", "COMMIT_EDITMSG", "info/attributes", "info/grafts"]) {
      expect(nativeDenyRows(policy.denyWrite)).not.toContain(join(marker, entry));
    }
    for (const entry of ["hooks", "config", "config.worktree", "commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates", "branches", "remotes"]) {
      expect(nativeDenyRows(policy.denyWrite)).toContain(join(marker, entry));
    }
    expect(nativeDenyRows(policy.denyWrite)).not.toContain("/**/.[gG][iI][tT]");
  });

  it("protects existing module and worktree controls without freezing metadata directories", () => {
    const marker = join(root, ".git");
    const module = join(marker, "modules", "group", "inner");
    const worktree = join(marker, "worktrees", "linked");
    for (const directory of [marker, module, worktree]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "HEAD"), "ref: refs/heads/main\n");
      for (const entry of ["hooks", "config", "config.worktree", "commondir", "gitdir"]) {
        if (entry === "hooks") mkdirSync(join(directory, entry));
        else writeFileSync(join(directory, entry), entry === "commondir" ? ".\n" : "existing control");
      }
    }
    const policy = buildMandatorySandboxWritePolicy([root]);
    for (const directory of [marker, module, worktree]) {
      expect(nativeDenyRows(policy.denyWrite)).not.toContain(directory);
      for (const entry of ["hooks", "config", "config.worktree", "commondir", "gitdir"]) {
        expect(nativeDenyRows(policy.denyWrite)).toContain(join(directory, entry));
      }
    }
  });

  it("keeps a run's workspace anchor and the pins of a repository off a stage that can write the repository", () => {
    const marker = join(root, ".git");
    const worktree = join(marker, "worktrees", "linked");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(marker, "ave-pins"));
    writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(worktree, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(worktree, "commondir"), "../..\n");
    writeFileSync(join(worktree, "ave.id"), "");
    const policy = buildMandatorySandboxWritePolicy([root]);
    expect(nativeDenyRows(policy.denyWrite)).toEqual(expect.arrayContaining([join(marker, "ave-pins"), join(worktree, "ave.id")]));
    expect(nativeDenyRows(policy.denyWrite)).not.toContain(join(marker, "ave.id"));
    expect(nativeDenyRows(policy.denyWrite)).not.toContain(join(worktree, "ave-pins"));
    const darwin = (withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite ?? []).map(entry => typeof entry === "string" ? entry : entry.path);
    expect(darwin).toEqual(expect.arrayContaining([
      "/**/.[gG][iI][tT]/[aA][vV][eE]-[pP][iI][nN][sS]",
      "/**/.[gG][iI][tT]/[mM][oO][dD][uU][lL][eE][sS]/**/[aA][vV][eE]-[pP][iI][nN][sS]",
      "/**/.[gG][iI][tT]/[wW][oO][rR][kK][tT][rR][eE][eE][sS]/*/[aA][vV][eE].[iI][dD]",
    ]));
    expect(darwin.filter(row => row.endsWith("[aA][vV][eE]-[pP][iI][nN][sS]") || row.endsWith("[aA][vV][eE].[iI][dD]")).filter(row => row.startsWith("/**/"))).toHaveLength(3);
  });

  it.each(["win32", "linux"] as const)("keeps the pins of stores under a folder named worktrees and the anchor of a stage's own admin folder on %s", platform => {
    const head = (directory: string) => { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "HEAD"), "ref: refs/heads/main\n"); };
    const marker = join(root, ".git");
    const moduleStore = join(marker, "modules", "worktrees", "foo");
    const nestedModuleStore = join(marker, "modules", "group", "worktrees", "bar");
    const separate = join(root, "worktrees", "proj.git");
    const separateAdmin = join(separate, "worktrees", "w1");
    const stageAdmin = join(marker, "worktrees", "stage");
    // Linux denies only existing controls, so both names exist everywhere.
    for (const directory of [marker, moduleStore, nestedModuleStore, separate, separateAdmin, stageAdmin]) {
      head(directory);
      mkdirSync(join(directory, "ave-pins"));
      writeFileSync(join(directory, "ave.id"), "");
    }
    writeFileSync(join(separateAdmin, "commondir"), "../..\n");
    writeFileSync(join(stageAdmin, "commondir"), "../..\n");
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", ".git"), `gitdir: ${separate}\n`);
    const stage = join(root, "stage");
    mkdirSync(stage);
    writeFileSync(join(stage, ".git"), `gitdir: ${stageAdmin}\n`);
    for (const roots of [[stage], [root]]) {
      const rows = nativeDenyRows(withPlatform(platform, () => buildMandatorySandboxWritePolicy(roots)).denyWrite);
      if (roots[0] === stage) {
        expect(rows).toContain(join(stageAdmin, "ave.id"));
        expect(rows).not.toContain(join(stageAdmin, "ave-pins"));
        expect(rows).toContain(join(marker, "ave-pins"));
        continue;
      }
      for (const store of [marker, moduleStore, nestedModuleStore, separate]) {
        expect(rows).toContain(join(store, "ave-pins"));
        expect(rows).not.toContain(join(store, "ave.id"));
      }
      for (const admin of [separateAdmin, stageAdmin]) {
        expect(rows).toContain(join(admin, "ave.id"));
        expect(rows).not.toContain(join(admin, "ave-pins"));
      }
    }
  });

  it.skipIf(process.platform !== "win32")("denies both work-board names in a worktrees folder whose commondir is unusable", () => {
    const marker = join(root, ".git");
    mkdirSync(marker);
    writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    const admins = { empty: "", split: "../..\nother\n" };
    for (const [name, commondir] of Object.entries(admins)) {
      const admin = join(marker, "worktrees", name);
      mkdirSync(admin, { recursive: true });
      writeFileSync(join(admin, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(admin, "commondir"), commondir);
    }
    const rows = nativeDenyRows(buildMandatorySandboxWritePolicy([root]).denyWrite);
    for (const name of Object.keys(admins)) {
      expect(rows).toEqual(expect.arrayContaining([join(marker, "worktrees", name, "ave.id"), join(marker, "worktrees", name, "ave-pins")]));
    }
  });

  it("discovers new Linux repositories on each policy build using HEAD markers", () => {
    const nested = join(root, "new", ".git");
    mkdirSync(nested, { recursive: true });
    expect(nativeDenyRows(withPlatform("linux", () => buildMandatorySandboxWritePolicy([root])).denyWrite))
      .not.toContain(join(nested, "hooks"));
    writeFileSync(join(nested, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(nested, "hooks"));
    expect(nativeDenyRows(withPlatform("linux", () => buildMandatorySandboxWritePolicy([root])).denyWrite))
      .toContain(join(nested, "hooks"));
  });

  it("keeps missing Linux Git controls absent while retaining application and startup denies", () => {
    const marker = join(root, ".git");
    mkdirSync(marker);
    writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(marker, "config"), "existing control");
    const policy = withPlatform("linux", () => buildMandatorySandboxWritePolicy([root]));
    expect(nativeDenyRows(policy.denyWrite)).toContain(join(marker, "config"));
    for (const entry of ["commondir", "gitdir", "hooks", "config.worktree", "info/attributes", "modules", "worktrees"]) {
      expect(nativeDenyRows(policy.denyWrite)).not.toContain(join(marker, entry));
      expect(filesystem.existsSync(join(marker, entry))).toBe(false);
    }
    expect(nativeDenyRows(policy.denyWrite)).toContain(join(root, ".bashrc"));
    expect(nativeDenyRows(policy.denyWrite)).toContain(permissionSettingsPath());
  });

  it("discovers existing controls in Linux partial markers while preserving macOS attributes policy", () => {
    const marker = join(root, "partial", ".git");
    mkdirSync(join(marker, "hooks"), { recursive: true });
    mkdirSync(join(marker, "info"));
    writeFileSync(join(marker, "info", "attributes"), "existing attributes");
    const linux = withPlatform("linux", () => buildMandatorySandboxWritePolicy([root]));
    expect(nativeDenyRows(linux.denyWrite)).toContain(join(marker, "hooks"));
    expect(nativeDenyRows(linux.denyWrite)).toContain(join(marker, "info", "attributes"));
    const mac = withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root]));
    expect(nativeDenyRows(mac.denyWrite)).not.toContain(join(marker, "info", "attributes"));
  });

  it("fails a post-command snapshot visibly when bounded discovery cannot finish", () => {
    const before = snapshotSandboxGitControls([root]);
    vi.mocked(filesystem.opendirSync).mockImplementation(() => {
      throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    });
    expect(() => snapshotSandboxGitControls([root], before)).toThrow("could not complete");
  });

  it("retains the bare-entry mount snapshot when a reserved name appears during later discovery", () => {
    const openDirectory = vi.mocked(filesystem.opendirSync).getMockImplementation()!;
    vi.mocked(filesystem.opendirSync).mockImplementation((...args) => {
      if (String(args[0]) === root) writeFileSync(join(root, "config"), "appeared after the mount snapshot");
      return openDirectory(...args);
    });
    const policy = withPlatform("linux", () => buildMandatorySandboxWritePolicy([root]));
    expect(filesystem.existsSync(join(root, "config"))).toBe(true);
    expect(nativeDenyRows(policy.denyWrite)).not.toContain(join(root, "config"));
    expect(policy.gitControlSnapshot?.entries.get(join(root, "config"))).toBeUndefined();
  });

  it("fails a post-command snapshot when the shared entry budget is exhausted", () => {
    writeFileSync(join(root, "ordinary"), "ordinary");
    const before = snapshotSandboxGitControls([root]);
    const entry = filesystem.readdirSync(root, { withFileTypes: true }).find(item => item.name === "ordinary")!;
    const openDirectory = vi.mocked(filesystem.opendirSync).getMockImplementation()!;
    vi.mocked(filesystem.opendirSync).mockImplementation((...args) => {
      const directory = openDirectory(...args);
      if (String(args[0]) === root) vi.spyOn(directory, "readSync").mockReturnValue(entry);
      return directory;
    });
    expect(() => snapshotSandboxGitControls([root], before)).toThrow("discovery budget");
  });

  it("revokes Linux grants that could replace a nested repository control link", () => {
    const project = join(root, "project");
    const child = join(project, "work");
    const sibling = join(root, "sibling");
    const marker = join(project, ".git");
    const target = join(root, "control-target");
    for (const directory of [marker, child, sibling]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(target, "[core]\n");
    symlinkSync(target, join(marker, "config"));
    const policy = withPlatform("linux", () => buildMandatorySandboxWritePolicy([root, project, child, sibling]));
    expect(policy.allowWrite).toEqual([child, sibling]);
  });

  it("classifies worktree descendants separately from bare and non-repository roots", () => {
    const project = join(root, "project");
    const child = join(project, "src", "nested");
    const bare = join(root, "bare");
    const linked = join(root, "linked");
    const invalid = join(root, "invalid");
    for (const directory of [join(project, ".git"), child, bare, linked, invalid]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(linked, ".git"), `gitdir: ${join(project, ".git")}\n`);
    writeFileSync(join(invalid, ".git"), "not a repository pointer\n");
    expect(findNonRepositoryWriteRoots([root, project, child, bare, linked, invalid])).toEqual([root, bare, invalid]);
  });

  it("denies absent bare-layout entries on macOS without creating Linux mount targets", () => {
    const mac = withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root]));
    const linux = withPlatform("linux", () => buildMandatorySandboxWritePolicy([root]));
    for (const entry of ["HEAD", "objects", "refs", "config"]) {
      expect(nativeDenyRows(mac.denyWrite)).toContain(join(root, entry));
      expect(nativeDenyRows(linux.denyWrite)).not.toContain(join(root, entry));
    }
    writeFileSync(join(root, "HEAD"), "ref: refs/heads/main\n");
    expect(nativeDenyRows(withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite)).toContain(join(root, "hooks"));
    expect(nativeDenyRows(withPlatform("linux", () => buildMandatorySandboxWritePolicy([root])).denyWrite)).not.toContain(join(root, "hooks"));
  });

  it.runIf(process.platform !== "win32")(
    "revokes only Linux grants that can replace linked startup entries",
    () => {
      const ancestor = join(root, "grants");
      const protectedRoot = join(ancestor, "project");
      const child = join(protectedRoot, "work");
      const sibling = join(ancestor, "sibling");
      const targets = join(root, "targets");
      for (const directory of [child, sibling, targets]) mkdirSync(directory, { recursive: true });
      const controls = [".bashrc", ".bash_profile", ".gitconfig"].map((entry) => {
        const link = join(protectedRoot, entry);
        const target = join(targets, entry.slice(1));
        writeFileSync(target, "protected");
        symlinkSync(target, link);
        return { link, target };
      });
      const writeRoots = [ancestor, protectedRoot, child, sibling];

      expect(withPlatform("darwin", () => buildMandatorySandboxWritePolicy(writeRoots).allowWrite))
        .toEqual(writeRoots);
      const linux = withPlatform("linux", () => buildMandatorySandboxWritePolicy(writeRoots));
      expect(linux.allowWrite).toEqual([child, sibling]);
      for (const { link, target } of controls) {
        expect(nativeDenyRows(linux.denyWrite)).toEqual(expect.arrayContaining([link, target]));
        expect(nativeDenyRows(linux.denyWrite)).not.toContainEqual({ path: link, literal: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses a supplied floor routing link only to revoke covering Linux grants",
    () => {
      const ancestor = join(root, "floor-grants");
      const grant = join(ancestor, "project");
      const child = join(grant, "work");
      const sibling = join(ancestor, "sibling");
      const target = join(root, "synthetic-floor-target");
      const floor = join(grant, "synthetic-floor");
      for (const directory of [child, sibling]) mkdirSync(directory, { recursive: true });
      writeFileSync(target, "protected");
      symlinkSync(target, floor);

      const policy = withPlatform("linux", () =>
        buildMandatorySandboxWritePolicy([ancestor, grant, child, sibling], undefined, [floor]));
      expect(policy.allowWrite).toEqual([child, sibling]);
      expect(nativeDenyRows(policy.denyWrite)).not.toContainEqual({ path: floor, literal: true });
      expect(nativeDenyRows(policy.denyWrite)).not.toContain(floor);
      expect(nativeDenyRows(policy.denyWrite)).not.toContain(target);
    },
  );

  it.runIf(process.platform === "linux")("keeps distinct NFC and NFD grant spellings as distinct directories", () => {
    const nfc = join(root, "caf\u00e9");
    const nfd = join(root, "cafe\u0301");
    mkdirSync(nfc);
    mkdirSync(nfd);
    const nfdPolicy = buildMandatorySandboxWritePolicy([nfd]);
    expect(nfdPolicy.allowWrite).toEqual([nfd]);
    expect(nativeDenyRows(nfdPolicy.denyWrite)).not.toContain(join(nfc, ".git"));
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
    if (process.platform === "linux") expect(nativeDenyRows(backslashPolicy.denyWrite)).not.toContain(join(backslash, ".git"));
    else expect(nativeDenyRows(backslashPolicy.denyWrite)).toContain(join(backslash, ".git"));
    expect(nativeDenyRows(backslashPolicy.denyWrite)).not.toContain(join(slash, ".git"));
    expect(buildMandatorySandboxWritePolicy([backslash, slash]).allowWrite).toEqual([backslash, slash]);
  });

  it("bounds missing ancestry and Linux routing components independently", () => {
    // The deepest protected root entry (`.idea/workspace.xml`) adds two components.
    const withinMissingLimit = join(root, ...Array.from({ length: 62 }, (_, index) => `missing-${index}`));
    const beyondMissingLimit = join(withinMissingLimit, "missing-62");
    const buildWithoutLinuxRouting = (path: string) => process.platform === "win32"
      ? buildMandatorySandboxWritePolicy([path])
      : withPlatform("darwin", () => buildMandatorySandboxWritePolicy([path]));
    expect(buildWithoutLinuxRouting(withinMissingLimit).allowWrite).toEqual([withinMissingLimit]);
    expect(() => buildWithoutLinuxRouting(beyondMissingLimit)).toThrow("missing ancestor limit");

    if (process.platform === "win32") return;
    const existingComponents = root.split(sep).filter(Boolean).length;
    const linuxMissingLimit = 64 - existingComponents - 2;
    const withinRoutingLimit = join(root, ...Array.from(
      { length: linuxMissingLimit },
      (_, index) => `routing-${index}`,
    ));
    const beyondRoutingLimit = join(withinRoutingLimit, "routing-overflow");
    expect(withPlatform("linux", () => buildMandatorySandboxWritePolicy([withinRoutingLimit]).allowWrite))
      .toEqual([withinRoutingLimit]);
    expect(() => withPlatform("linux", () => buildMandatorySandboxWritePolicy([beyondRoutingLimit])))
      .toThrow("component limit");
  });

  it("denies linked gitdir, common metadata and their pointer files beyond the admitted root", () => {
    const checkout = join(root, "checkout");
    const gitDir = join(root, "metadata", "worktree");
    const common = join(root, "common");
    mkdirSync(checkout);
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(common);
    writeFileSync(join(gitDir, "config"), "existing control");
    writeFileSync(join(common, "config"), "existing control");
    writeFileSync(join(checkout, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "commondir"), "../../common\n");
    const denies = buildMandatorySandboxWritePolicy([checkout]).denyWrite;
    for (const directory of [gitDir, common]) {
      expect(nativeDenyRows(denies)).not.toContain(directory);
      expect(nativeDenyRows(denies)).toContain(join(directory, "config"));
    }
  });

  it.runIf(process.platform !== "win32")("resolves link and parent operands before git metadata targets", () => {
    const checkout = join(root, "checkout");
    const external = join(root, "external");
    const gitDir = join(external, "metadata");
    const commonRoot = join(root, "shared");
    const commonDir = join(commonRoot, "common");
    const independent = join(external, "independent");
    mkdirSync(checkout);
    mkdirSync(join(external, "nested"), { recursive: true });
    mkdirSync(gitDir);
    mkdirSync(join(commonRoot, "nested"), { recursive: true });
    mkdirSync(commonDir);
    mkdirSync(independent);
    const metadataLink = join(external, "metadata-link");
    symlinkSync(join(external, "nested"), metadataLink, "dir");
    symlinkSync(join(commonRoot, "nested"), join(gitDir, "common-link"), "dir");
    writeFileSync(join(checkout, ".git"), `gitdir: ${metadataLink}/../metadata\n`);
    writeFileSync(join(gitDir, "commondir"), "common-link/../common\n");
    const policy = buildMandatorySandboxWritePolicy([root, checkout, external, independent]);
    const denies = policy.denyWrite;
    expect(nativeDenyRows(denies)).not.toContain(gitDir);
    expect(nativeDenyRows(denies)).not.toContain(commonDir);
    if (process.platform !== "linux") {
      expect(nativeDenyRows(denies)).toContain(join(gitDir, "config"));
      expect(nativeDenyRows(denies)).toContain(join(commonDir, "config"));
    }
    const routingPins = [metadataLink, join(gitDir, "common-link")]
      .map(path => ({ path, literal: true } as const));
    for (const routingPin of routingPins) {
      if (process.platform === "linux") expect(nativeDenyRows(denies)).not.toContainEqual(routingPin);
      else expect(nativeDenyRows(denies)).toContainEqual(routingPin);
    }
    expect(nativeDenyRows(denies)).not.toContain(join(checkout, "metadata"));
    const linuxGrants = [checkout, independent];
    expect(policy.allowWrite).toEqual(process.platform === "linux"
      ? linuxGrants
      : [root, checkout, external, independent]);
    const linuxPolicy = withPlatform("linux", () =>
      buildMandatorySandboxWritePolicy([root, checkout, external, independent]));
    expect(linuxPolicy.allowWrite).toEqual(linuxGrants);
    // These targets are outside every retained writable grant, so the default read-only filesystem protects them without a deny mount.
    for (const directory of [gitDir, commonDir]) {
      expect(linuxGrants.some(grant => isGrantPathWithin(grant, directory))).toBe(false);
      expect(nativeDenyRows(linuxPolicy.denyWrite)).not.toContain(join(directory, "config"));
    }
    for (const routingPin of routingPins) expect(nativeDenyRows(linuxPolicy.denyWrite)).not.toContainEqual(routingPin);
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

  it("keeps Linux repository discovery within the inclusive depth bound", () => {
    const deepest = join(root, ...Array.from({ length: SANDBOX_GIT_SCAN_DEPTH }, (_, i) => `nested-${i}`));
    const below = join(deepest, "below");
    mkdirSync(join(deepest, ".git", "modules"), { recursive: true });
    writeFileSync(join(deepest, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(deepest, ".git", "config"), "existing control");
    mkdirSync(join(below, ".git"), { recursive: true });
    writeFileSync(join(below, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(below, ".git", "config"), "existing control");
    const denies = withPlatform("linux", () => buildMandatorySandboxWritePolicy([root])).denyWrite;
    expect(nativeDenyRows(denies)).toContain(join(deepest, ".git", "config"));
    expect(nativeDenyRows(denies)).not.toContain(join(deepest, ".git"));
    expect(nativeDenyRows(denies)).not.toContain(join(below, ".git", "config"));
  });

  it("does not traverse Linux dependency or build trees or directory-link cycles", () => {
    for (const name of ["node_modules", ".venv", "vendor", "dist", "build", ".cache"]) {
      mkdirSync(join(root, name, "inner", ".git"), { recursive: true });
    }
    const nested = join(root, "source");
    mkdirSync(join(nested, ".git"), { recursive: true });
    writeFileSync(join(nested, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(nested, ".git", "config"), "existing control");
    symlinkSync(root, join(nested, "cycle"), "dir");
    const denies = withPlatform("linux", () => buildMandatorySandboxWritePolicy([root])).denyWrite;
    expect(nativeDenyRows(denies)).toContain(join(nested, ".git", "config"));
    expect(nativeDenyRows(denies)).not.toContain(join(root, "node_modules", "inner", ".git", "config"));
  });

  it.each(["source", "node_modules", "build", ".git/objects"])(
    "discovers macOS deep gitdir pointers through %s trees",
    (tree) => {
      const checkout = join(root, "project");
      const nested = join(checkout, tree, "one", "two", "three", "four");
      const metadata = join(root, "storage-without-marker-name");
      mkdirSync(nested, { recursive: true });
      mkdirSync(metadata);
      writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(nested, ".git"), `gitdir: ${metadata}\n`);
      const policy = withPlatform("darwin", () => buildMandatorySandboxWritePolicy([checkout, metadata]));
      expect(policy.allowWrite).toEqual([checkout, metadata]);
      expect(nativeDenyRows(policy.denyWrite)).toContain(join(nested, ".git"));
      expect(nativeDenyRows(policy.denyWrite)).toContain(join(metadata, "config"));
      expect(nativeDenyRows(policy.denyWrite)).toContain(join(metadata, "hooks"));
      expect(nativeDenyRows(policy.denyWrite)).not.toContain(metadata);
    },
  );

  it.each(["source", "node_modules", "build", ".git/objects"])(
    "refuses macOS deep symbolic markers through %s trees",
    (tree) => {
      const checkout = join(root, "project");
      const nested = join(checkout, tree, "one", "two", "three", "four");
      const metadata = join(root, "storage-without-marker-name");
      mkdirSync(nested, { recursive: true });
      mkdirSync(metadata);
      symlinkSync(metadata, join(nested, ".git"), "dir");
      expect(() => withPlatform("darwin", () => buildMandatorySandboxWritePolicy([checkout, metadata])))
        .toThrow("markers are unsupported");
    },
  );

  it("revokes an incomplete macOS dependency-tree grant while retaining an independent child", () => {
    const dependency = join(root, "node_modules");
    const child = join(root, "workspace");
    mkdirSync(dependency);
    mkdirSync(child);
    writeFileSync(join(dependency, "ordinary"), "ordinary");
    const file = filesystem.readdirSync(dependency, { withFileTypes: true })[0]!;
    const openDirectory = vi.mocked(filesystem.opendirSync).getMockImplementation()!;
    let reads = 0;
    vi.mocked(filesystem.opendirSync).mockImplementation((...args) => {
      const directory = openDirectory(...args);
      if (String(args[0]) === dependency) vi.spyOn(directory, "readSync").mockImplementation(() => {
        reads += 1;
        if (reads > 16_385) throw new Error("Unbounded dependency scan");
        return file;
      });
      return directory;
    });
    const policy = withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root, child]));
    expect(policy.allowWrite).toEqual([child]);
    expect(reads).toBeLessThanOrEqual(16_385);
    expect(nativeDenyRows(policy.denyWrite)).not.toContain(root);
    expect(nativeDenyRows(policy.denyWrite)).not.toContain(child);
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

  // Exercises the identity check on hosts without O_NOFOLLOW.
  it.skipIf(filesystem.constants.O_NOFOLLOW !== undefined)("rejects common-directory metadata replaced between inspection and open", () => {
    const marker = join(root, ".git");
    const pointer = join(marker, "commondir");
    const replacement = join(root, "replacement");
    mkdirSync(marker);
    writeFileSync(pointer, "common");
    writeFileSync(replacement, "common");
    const open = filesystem.openSync;
    vi.spyOn(filesystem, "openSync").mockImplementation((...args) => {
      if (args[0] === pointer) filesystem.renameSync(replacement, pointer);
      return open(...args);
    });
    expect(() => buildMandatorySandboxWritePolicy([root])).toThrow("metadata changed during discovery");
  });

  // 2^53 and 2^53 + 1 are equal as Numbers, so only a bigint comparison sees the swap.
  it.skipIf(filesystem.constants.O_NOFOLLOW !== undefined)("rejects common-directory metadata whose file ID differs only beyond Number precision", () => {
    const marker = join(root, ".git");
    const pointer = join(marker, "commondir");
    mkdirSync(marker);
    writeFileSync(pointer, "common");
    const withIno = <T extends object>(stats: T, ino: number | bigint): T => Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino });
    const lstat = filesystem.lstatSync;
    const open = filesystem.openSync;
    const fstat = filesystem.fstatSync;
    let pointerFd: number | undefined;
    vi.spyOn(filesystem, "lstatSync").mockImplementation(((path: string, options?: { bigint?: boolean }) => {
      const stats = lstat(path, options);
      if (path !== pointer || stats === undefined) return stats;
      return withIno(stats, options?.bigint ? 2n ** 53n : 2 ** 53);
    }) as typeof filesystem.lstatSync);
    vi.spyOn(filesystem, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (args[0] === pointer) pointerFd = fd;
      return fd;
    });
    vi.spyOn(filesystem, "fstatSync").mockImplementation(((fd: number, options?: { bigint?: boolean }) => {
      const stats = fstat(fd, options);
      if (fd !== pointerFd) return stats;
      return withIno(stats, options?.bigint ? 2n ** 53n + 1n : 2 ** 53);
    }) as typeof filesystem.fstatSync);
    expect(() => buildMandatorySandboxWritePolicy([root])).toThrow("metadata changed during discovery");
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
    expect(policy.narrowedWriteRoots).toEqual([{ root, reason: "entry-budget" }]);
    expect(nativeDenyRows(denies)).not.toContain(root);
    expect(nativeDenyRows(denies)).not.toContain(queued);
    expect(nativeDenyRows(denies)).not.toContain(second);
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
    writeFileSync(join(common, "config"), "existing control");
    writeFileSync(join(gitDir, "commondir"), " common\n");
    expect(nativeDenyRows(buildMandatorySandboxWritePolicy([root]).denyWrite)).toContain(join(common, "config"));
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
  )("preserves a trailing $label in a macOS $kind target", ({ kind, label, suffix }) => {
    const marker = join(root, ".git");
    const target = join(root, `${kind}-${label}${suffix}`);
    if (kind === "gitdir") {
      writeFileSync(marker, `gitdir: ${target}\r\n`);
    } else {
      mkdirSync(marker);
      writeFileSync(join(marker, "commondir"), `${target}\r\n`);
    }
    expect(nativeDenyRows(withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite)).toContain(target);
  });

  it("treats absent gitdir and common targets with pattern characters as literal entries", () => {
    const marker = join(root, ".git");
    const target = join(root, "metadata-[*?]-absent");
    writeFileSync(marker, `gitdir: ${target}\n`);
    expect(nativeDenyRows(withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite)).toContainEqual({ path: target, literal: true });
    rmSync(marker);
    mkdirSync(marker);
    writeFileSync(join(marker, "commondir"), `${target}\n`);
    expect(nativeDenyRows(withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite)).toContainEqual({ path: target, literal: true });
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
    const denies = withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite;
    expect(nativeDenyRows(denies)).toContain(firstMissing);
    expectLiteralDenyCovers(denies, target);
    expect(nativeDenyRows(denies)).not.toContain(storage);
    const snapshot = withPlatform("linux", () => buildMandatorySandboxWritePolicy([root])).gitControlSnapshot;
    expect(snapshot?.storeMissingAncestors.get(target)).toBe(firstMissing);
  });

  // Win32 and Git for Windows resolve ".." lexically, so a missing component cannot later redirect it; the ambiguity is POSIX-only.
  it.skipIf(process.platform === "win32")("rejects unresolved parent traversal in a missing gitdir target", () => {
    const marker = join(root, ".git");
    const storage = join(root, "gitdir-storage");
    mkdirSync(storage);
    const target = `${storage}${sep}missing${sep}..${sep}metadata`;
    writeFileSync(marker, `gitdir: ${target}\n`);
    expect(() => buildMandatorySandboxWritePolicy([root])).toThrow("unresolved parent traversal");
  });

  // Win32 and Git for Windows resolve ".." lexically, so a missing component cannot later redirect it; the ambiguity is POSIX-only.
  it.skipIf(process.platform === "win32")("rejects unresolved parent traversal in a missing commondir target", () => {
    const marker = join(root, ".git");
    const storage = join(root, "commondir-storage");
    mkdirSync(storage);
    const target = `${storage}${sep}missing${sep}..${sep}metadata`;
    mkdirSync(marker);
    writeFileSync(join(marker, "commondir"), `${target}\n`);
    expect(() => buildMandatorySandboxWritePolicy([root])).toThrow("unresolved parent traversal");
  });

  it("inspects unknown directory-entry types instead of skipping nested repositories", () => {
    const nested = join(root, "unknown");
    mkdirSync(join(nested, ".git"), { recursive: true });
    writeFileSync(join(nested, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(nested, ".git", "config"), "existing control");
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
    expect(nativeDenyRows(buildMandatorySandboxWritePolicy([root]).denyWrite)).toContain(join(nested, ".git", "config"));
  });

  it("does not enumerate directory links outside the admitted root or read linked marker files", () => {
    const project = join(root, "project");
    const external = join(root, "external");
    mkdirSync(project);
    mkdirSync(join(external, ".git"), { recursive: true });
    symlinkSync(external, join(project, "outside"), "dir");
    expect(nativeDenyRows(buildMandatorySandboxWritePolicy([project]).denyWrite)).not.toContain(join(external, ".git", "config"));
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
    expect(nativeDenyRows(withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite)).toContain(target);
    expect(vi.mocked(filesystem.readSync).mock.calls.length).toBeGreaterThan(2);
    let calls = 0;
    vi.mocked(filesystem.readSync).mockImplementation(((fd, buffer, offset, length, position) =>
      calls++ === 0 ? read(fd, buffer, offset, Math.min(length, 10), position) : 0) as typeof filesystem.readSync);
    expect(() => buildMandatorySandboxWritePolicy([root]).denyWrite).toThrow("metadata changed during discovery");
  });

  it("bounds metadata policy growth before the entry budget is exhausted", () => {
    const child = join(root, "child");
    for (let index = 0; index < 180; index++) {
      const marker = join(child, `repository-${index}-${"x".repeat(100)}`, ".git");
      mkdirSync(marker, { recursive: true });
      writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    }
    const policy = buildMandatorySandboxWritePolicy([root, child]);
    expect(policy.allowWrite).toEqual([]);
    expect(nativeDenyRows(policy.denyWrite)).not.toContain(root);
    expect(nativeDenyRows(policy.denyWrite)).not.toContain(child);
    expect(Buffer.byteLength(JSON.stringify(policy.denyWrite))).toBeLessThan(32_768);
  });

  it("refuses aggregate metadata growth with actionable folder guidance", () => {
    const grants = Array.from({ length: 48 }, (_, index) => join(root, `project-${index}-${"x".repeat(100)}`));
    for (const grant of grants) {
      mkdirSync(join(grant, ".git"), { recursive: true });
      writeFileSync(join(grant, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    expect(() => withPlatform("darwin", () => buildMandatorySandboxWritePolicy(grants)))
      .toThrow(t("sandboxPolicy.tooLarge"));
  });

  it.each([65_536, 65_537])("bounds the POSIX serialized policy at %i bytes independently of discovery", bytes => {
    const target = `/p/${"x".repeat(bytes - 7)}`;
    expect(Buffer.byteLength(JSON.stringify([target]))).toBe(bytes);
    const check = () => withPlatform("darwin", () => assertSandboxWritePolicySize([target], new Set([target])));
    if (bytes === 65_536) expect(check).not.toThrow();
    else expect(check).toThrow(t("sandboxPolicy.tooLarge"));
  });

  it("bounds Windows discovery independently of the ACL policy size", () => {
    const mandatory = Array.from({ length: 160 }, (_, index) => `D:/fixed/${index}-`.padEnd(253, "x"));
    const discovered = Array.from({ length: 128 }, (_, index) => `D:/discovered/${index}-`.padEnd(253, "x"));
    const atLimit = discovered.map((path, index) => index === 0 ? path.slice(0, -1) : path);
    const floor = new Set(mandatory);
    expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(32_768);
    expect(Buffer.byteLength(JSON.stringify(discovered))).toBe(32_769);
    expect(Buffer.byteLength(JSON.stringify([...mandatory, ...atLimit]))).toBeGreaterThan(65_536);
    const check = (entries: string[]) => withPlatform("win32", () => assertSandboxWritePolicySize([...mandatory, ...entries], floor));
    expect(() => check(atLimit)).not.toThrow();
    expect(() => check(discovered)).toThrow(t("sandboxPolicy.tooLarge"));
  });

  it("overflows discovery even with a two-character simulated temp root", () => {
    const simulatedTemp = "/p";
    const entries = Array.from({ length: 48 }, (_, index) =>
      ["config", "config.worktree", "hooks", "commondir", "gitdir", "remotes", "branches"].map(name =>
        `${simulatedTemp}/project-${index}-${"x".repeat(100)}/.git/${name}`)).flat();
    expect(Buffer.byteLength(JSON.stringify(entries))).toBeGreaterThan(32_768);
    expect(() => assertSandboxWritePolicySize(entries, new Set())).toThrow(t("sandboxPolicy.tooLarge"));
  });

  it.each(["en", "ko"] as const)("localizes policy overflow guidance in %s", locale => {
    const previous = getLocale();
    try {
      setLocale(locale);
      expect(() => assertSandboxWritePolicySize(["x".repeat(65_536)], new Set()))
        .toThrow(locale === "en" ? "grant fewer or narrower write folders" : "쓰기 허용 폴더 수를 줄이거나");
    } finally { setLocale(previous); }
  });

  it.each(["en", "ko"] as const)("points at configured denies when they dominate overflow in %s", locale => {
    const previous = getLocale();
    try {
      setLocale(locale);
      const entries = Array.from({ length: 800 }, (_, index) => `/p/${index}-${"x".repeat(100)}`);
      expect(() => withPlatform("darwin", () => buildSandboxConfig({ denyWrite: entries })))
        .toThrow(t("sandboxPolicy.configuredDeniesTooLarge"));
      expect(() => withPlatform("darwin", () => assertSandboxWritePolicySize(entries, undefined, entries.slice(0, 1))))
        .toThrow(t("sandboxPolicy.tooLarge"));
    } finally { setLocale(previous); }
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
    expect(nativeDenyRows(policy.denyWrite)).toContain(join(metadata, "hooks"));
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
        unlinkSync(alias); symlinkSync(replacement, alias, "dir");
        if (exhausted) vi.spyOn(directory, "readSync").mockReturnValue(file);
      }
      return directory;
    });
    const policy = buildMandatorySandboxWritePolicy([alias]);
    expect(realpathSync(alias)).toBe(replacement);
    expect(policy.allowWrite).toEqual(exhausted ? [] : [original]);
    if (!exhausted && process.platform !== "linux") expect(nativeDenyRows(policy.denyWrite)).toContain(join(original, ".git"));
    expect(nativeDenyRows(policy.denyWrite)).not.toContain(join(replacement, ".git"));
  });
});
