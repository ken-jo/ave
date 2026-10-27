vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as filesystem from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { configureHostResources } from "../../main/host-resources.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMandatorySandboxWritePolicy, findNonRepositoryWriteRoots, isGrantPathWithin, isSandboxGitMetadataEntry, SANDBOX_GIT_SCAN_DEPTH, snapshotSandboxGitControls } from "../sandbox-write-policy.js";
import { PROTECTED_ROOT_ENTRIES } from "../sensitive-paths.js";
import { buildPerCommandSandboxCustomConfig, buildSandboxConfig, getDefaultSensitiveWriteDenyPaths } from "../asrt-sandbox.js";
import { permissionSettingsPath } from "../permission-settings-store.js";
import { egressGrantFilePath } from "../egress-grants.js";
import { userApprovalFilePath } from "../user-approval-store.js";
import { permissionsFilePath } from "../permissions-store.js";
import { getAdminPolicyPath, userPolicyPath } from "../policy-store.js";
import { projectRulesDirectory } from "../rules/project-rule-files.js";
import { settingsFilePath } from "../../data/settings-store.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...(await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(actual), opendirSync: vi.fn(actual.opendirSync), readSync: vi.fn(actual.readSync) };
});

function withPlatform<T>(platform: "darwin" | "linux", action: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    return action();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
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

  // The shared floor's own list, so a new entry cannot fall off the sandbox floor unnoticed; `.git/*` controls are covered by the Git tests below.
  it.each([".git", ...PROTECTED_ROOT_ENTRIES.filter(entry => !isSandboxGitMetadataEntry(entry))])("protects missing %s in every writable root", (entry) => {
    const roots = [join(root, "project"), join(root, "temp")];
    const denies = buildMandatorySandboxWritePolicy(roots).denyWrite;
    for (const base of roots) {
      if (entry === ".git" && process.platform === "linux") expect(denies).not.toContain(join(base, entry));
      else expect(denies).toContain(join(base, entry));
    }
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
        expect(policy.denyWrite).toContain(join(project, ".bashrc"));
        expect(policy.denyWrite).not.toContain(join("~", "project", ".bashrc"));
      }
    });
  });

  it("hands only the .git marker and its children to the Git control policy", () => {
    expect(PROTECTED_ROOT_ENTRIES.filter(isSandboxGitMetadataEntry))
      .toEqual([".git", ".git/hooks", ".git/config", ".git/modules"]);
    const project = join(root, "project");
    const marker = join(project, ".git");
    mkdirSync(join(marker, "modules", "inner", "hooks"), { recursive: true });
    mkdirSync(join(marker, "hooks"));
    writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(marker, "config"), "existing control");
    writeFileSync(join(marker, "modules", "inner", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(marker, "modules", "inner", "config"), "existing control");
    const denies = buildMandatorySandboxWritePolicy([project]).denyWrite;
    for (const entry of [".gitconfig", ".githooks", ".husky", ".claude/hooks"]) expect(denies).toContain(join(project, entry));
    for (const path of [marker, join(marker, "modules"), join(marker, "modules", "inner")]) expect(denies).not.toContain(path);
    for (const path of [join(marker, "hooks"), join(marker, "config"), join(marker, "modules", "inner", "hooks"), join(marker, "modules", "inner", "config")]) {
      expect(denies).toContain(path);
    }
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
    if (process.platform === "linux") expect(denies).not.toContain(join(target, ".git"));
    else expect(denies).toContain(join(target, ".git"));
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
      expect(policy.denyWrite).not.toContain(join(marker, entry));
    }
    for (const entry of ["hooks", "config", "config.worktree", "commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates", "branches", "remotes"]) {
      expect(policy.denyWrite).toContain(join(marker, entry));
    }
    expect(policy.denyWrite).not.toContain("/**/.[gG][iI][tT]");
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
      expect(policy.denyWrite).not.toContain(directory);
      for (const entry of ["hooks", "config", "config.worktree", "commondir", "gitdir"]) {
        expect(policy.denyWrite).toContain(join(directory, entry));
      }
    }
  });

  it("discovers new Linux repositories on each policy build using HEAD markers", () => {
    const nested = join(root, "new", ".git");
    mkdirSync(nested, { recursive: true });
    expect(withPlatform("linux", () => buildMandatorySandboxWritePolicy([root])).denyWrite)
      .not.toContain(join(nested, "hooks"));
    writeFileSync(join(nested, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(nested, "hooks"));
    expect(withPlatform("linux", () => buildMandatorySandboxWritePolicy([root])).denyWrite)
      .toContain(join(nested, "hooks"));
  });

  it("keeps missing Linux Git controls absent while retaining application and startup denies", () => {
    const marker = join(root, ".git");
    mkdirSync(marker);
    writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(marker, "config"), "existing control");
    const policy = withPlatform("linux", () => buildMandatorySandboxWritePolicy([root]));
    expect(policy.denyWrite).toContain(join(marker, "config"));
    for (const entry of ["commondir", "gitdir", "hooks", "config.worktree", "info/attributes", "modules", "worktrees"]) {
      expect(policy.denyWrite).not.toContain(join(marker, entry));
      expect(filesystem.existsSync(join(marker, entry))).toBe(false);
    }
    expect(policy.denyWrite).toContain(join(root, ".bashrc"));
    expect(policy.denyWrite).toContain(permissionSettingsPath());
  });

  it("discovers existing controls in Linux partial markers while preserving macOS attributes policy", () => {
    const marker = join(root, "partial", ".git");
    mkdirSync(join(marker, "hooks"), { recursive: true });
    mkdirSync(join(marker, "info"));
    writeFileSync(join(marker, "info", "attributes"), "existing attributes");
    const linux = withPlatform("linux", () => buildMandatorySandboxWritePolicy([root]));
    expect(linux.denyWrite).toContain(join(marker, "hooks"));
    expect(linux.denyWrite).toContain(join(marker, "info", "attributes"));
    const mac = withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root]));
    expect(mac.denyWrite).not.toContain(join(marker, "info", "attributes"));
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
    expect(policy.denyWrite).not.toContain(join(root, "config"));
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
      expect(mac.denyWrite).toContain(join(root, entry));
      expect(linux.denyWrite).not.toContain(join(root, entry));
    }
    writeFileSync(join(root, "HEAD"), "ref: refs/heads/main\n");
    expect(withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite).toContain(join(root, "hooks"));
    expect(withPlatform("linux", () => buildMandatorySandboxWritePolicy([root])).denyWrite).not.toContain(join(root, "hooks"));
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
      const controls = [".bashrc", ".gitconfig"].map((entry) => {
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
        expect(linux.denyWrite).toEqual(expect.arrayContaining([link, target]));
        expect(linux.denyWrite).not.toContainEqual({ path: link, literal: true });
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
      expect(policy.denyWrite).not.toContainEqual({ path: floor, literal: true });
      expect(policy.denyWrite).not.toContain(floor);
      expect(policy.denyWrite).not.toContain(target);
    },
  );

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
    if (process.platform === "linux") expect(backslashPolicy.denyWrite).not.toContain(join(backslash, ".git"));
    else expect(backslashPolicy.denyWrite).toContain(join(backslash, ".git"));
    expect(backslashPolicy.denyWrite).not.toContain(join(slash, ".git"));
    expect(buildMandatorySandboxWritePolicy([backslash, slash]).allowWrite).toEqual([backslash, slash]);
  });

  it("bounds missing ancestry and Linux routing components independently", () => {
    // The deepest protected root entry (`.claude/settings.json`) adds two components.
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
      expect(denies).not.toContain(directory);
      expect(denies).toContain(join(directory, "config"));
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
    expect(denies).not.toContain(gitDir);
    expect(denies).not.toContain(commonDir);
    if (process.platform !== "linux") {
      expect(denies).toContain(join(gitDir, "config"));
      expect(denies).toContain(join(commonDir, "config"));
    }
    const routingPins = [metadataLink, join(gitDir, "common-link")]
      .map(path => ({ path, literal: true } as const));
    for (const routingPin of routingPins) {
      if (process.platform === "linux") expect(denies).not.toContainEqual(routingPin);
      else expect(denies).toContainEqual(routingPin);
    }
    expect(denies).not.toContain(join(checkout, "metadata"));
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
      expect(linuxPolicy.denyWrite).not.toContain(join(directory, "config"));
    }
    for (const routingPin of routingPins) expect(linuxPolicy.denyWrite).not.toContainEqual(routingPin);
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
    expect(denies).toContain(join(deepest, ".git", "config"));
    expect(denies).not.toContain(join(deepest, ".git"));
    expect(denies).not.toContain(join(below, ".git", "config"));
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
    expect(denies).toContain(join(nested, ".git", "config"));
    expect(denies).not.toContain(join(root, "node_modules", "inner", ".git", "config"));
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
      expect(policy.denyWrite).toContain(join(nested, ".git"));
      expect(policy.denyWrite).toContain(join(metadata, "config"));
      expect(policy.denyWrite).toContain(join(metadata, "hooks"));
      expect(policy.denyWrite).not.toContain(metadata);
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
    expect(policy.denyWrite).not.toContain(root);
    expect(policy.denyWrite).not.toContain(child);
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
    writeFileSync(join(common, "config"), "existing control");
    writeFileSync(join(gitDir, "commondir"), " common\n");
    expect(buildMandatorySandboxWritePolicy([root]).denyWrite).toContain(join(common, "config"));
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
    expect(withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite).toContain(target);
  });

  it("treats absent gitdir and common targets with pattern characters as literal entries", () => {
    const marker = join(root, ".git");
    const target = join(root, "metadata-[*?]-absent");
    writeFileSync(marker, `gitdir: ${target}\n`);
    expect(withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite).toContainEqual({ path: target, literal: true });
    rmSync(marker);
    mkdirSync(marker);
    writeFileSync(join(marker, "commondir"), `${target}\n`);
    expect(withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite).toContainEqual({ path: target, literal: true });
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
    expect(withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite).toEqual(expect.arrayContaining([firstMissing, target]));
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
    expect(buildMandatorySandboxWritePolicy([root]).denyWrite).toContain(join(nested, ".git", "config"));
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
    expect(withPlatform("darwin", () => buildMandatorySandboxWritePolicy([root])).denyWrite).toContain(target);
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
    expect(policy.denyWrite).toContain(join(metadata, "hooks"));
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
    if (!exhausted && process.platform !== "linux") expect(policy.denyWrite).toContain(join(original, ".git"));
    expect(policy.denyWrite).not.toContain(join(replacement, ".git"));
  });
});
