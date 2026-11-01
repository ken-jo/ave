vi.mock("../../../shared/windows-path-facts.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../../shared/windows-configuration-handles.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { projectRuleRoot, projectRulesLocation, readProjectRulesFile, updateProjectRulesFile } from "../project-rule-files.js";
import { buildShellRuleApproval } from "../shell-rule-approval.js";
import { captureApprovalWorkingDirectory } from "../../user-approval-store.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

let root: string;
let home: string;

function repository(dir: string): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, ".git", "objects"));
  mkdirSync(join(dir, ".git", "refs"));
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ave-rule-root-")));
  home = join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTmpDir(root);
});

describe("project rule root boundaries", () => {
  it("shows the dock the repository root a project rule is stored under, not the cwd", () => {
    const repo = join(home, "repo");
    const cwd = join(repo, "packages", "app");
    repository(repo);
    mkdirSync(cwd, { recursive: true });
    const approval = buildShellRuleApproval("bash", "printf ready", cwd, { allow: true, deny: true }, "conversation-a");
    expect(approval.projectCwd).toBe(cwd);
    expect(approval.projectRoot).toBe(captureApprovalWorkingDirectory(repo).path);
    expect(projectRuleRoot(cwd)).toBe(projectRulesLocation(root, cwd).projectRoot);
    const unproven = buildShellRuleApproval("bash", "git status", cwd, { allow: true, deny: true }, "conversation-a");
    expect(unproven.exactRule).toBeNull();
    expect(unproven.projectRoot).toBe(approval.projectRoot);
  });

  it.each([
    { name: "unset", value: undefined, inherits: true },
    { name: "empty", value: "", inherits: false },
    { name: "filesystem root", value: "/", inherits: false },
    { name: "relative", value: "relative-home", inherits: false },
  ])("handles a $name home environment before repository discovery", ({ value, inherits }) => {
    const repo = join(home, "repo");
    const cwd = join(repo, "src");
    repository(repo);
    mkdirSync(cwd);
    vi.stubEnv("HOME", value);
    vi.stubEnv("USERPROFILE", value);
    // An unset environment uses the account's absolute home; invalid values must not let this child inherit an otherwise valid repository identity.
    expect(projectRulesLocation(root, cwd).projectRoot).toBe(captureApprovalWorkingDirectory(inherits ? repo : cwd).path);
  });

  it.each([
    { name: "home repository", marker: "home", cwd: "home/a", expected: "home/a" },
    { name: "exact home", marker: "home", cwd: "home", expected: "home" },
    { name: "repository above home", marker: "", cwd: "home/a", expected: "home/a" },
    { name: "sibling below an ancestor of home", marker: "", cwd: "other/a", expected: "other/a" },
    { name: "exact ancestor of home", marker: "", cwd: "", expected: "" },
    { name: "ordinary repository", marker: "home/repo", cwd: "home/repo/src/app", expected: "home/repo" },
    { name: "nested repository", marker: "home/repo/inner", cwd: "home/repo/inner/src", expected: "home/repo/inner" },
  ])("$name", ({ marker, cwd, expected }) => {
    repository(join(root, marker));
    if (marker.startsWith("home/repo")) repository(home);
    if (marker.includes("inner")) repository(join(home, "repo"));
    const start = join(root, cwd);
    mkdirSync(start, { recursive: true });
    const location = projectRulesLocation(root, start);
    const approved = captureApprovalWorkingDirectory(join(root, expected));
    expect(location).toMatchObject({ projectRoot: approved.path, identity: approved.identity });
  });

  it.each(["submodule", "linked worktree"])("resolves a %s gitdir file without adopting the metadata directory", (kind) => {
    const repo = join(home, "checkout");
    const gitDir = join(root, "metadata", kind);
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(repo, ".git"), `gitdir: ${kind === "linked worktree" ? gitDir : relative(repo, gitDir)}\n`);
    const common = kind === "linked worktree" ? join(root, "common") : gitDir;
    mkdirSync(join(common, "objects"), { recursive: true });
    mkdirSync(join(common, "refs"));
    if (kind === "linked worktree") {
      writeFileSync(join(gitDir, "commondir"), `${relative(gitDir, common)}\n`);
      writeFileSync(join(gitDir, "gitdir"), `${join(repo, ".git")}\n`);
    }
    expect(projectRulesLocation(root, join(repo, "src")).projectRoot).toBe(captureApprovalWorkingDirectory(repo).path);
  });

  it.each(["plain file", "empty directory", "missing gitdir", "invalid HEAD", "oversized file", "symlink"])(
    "an invalid %s marker blocks inheritance from an outer repository",
    (kind) => {
      const outer = join(home, "outer");
      const repo = join(outer, "inner");
      const cwd = join(repo, "src");
      repository(outer);
      mkdirSync(cwd, { recursive: true });
      const marker = join(repo, ".git");
      if (kind === "plain file") writeFileSync(marker, "not a repository\n");
      if (kind === "empty directory") mkdirSync(marker);
      if (kind === "missing gitdir") writeFileSync(marker, "gitdir: missing\n");
      if (kind === "oversized file") writeFileSync(marker, `gitdir: ${"a".repeat(65_537)}\n`);
      if (kind === "invalid HEAD") {
        repository(repo);
        writeFileSync(join(marker, "HEAD"), "not a HEAD\n");
      }
      if (kind === "symlink") symlinkSync(join(outer, ".git"), marker, "junction");
      expect(projectRulesLocation(root, cwd).projectRoot).toBe(captureApprovalWorkingDirectory(cwd).path);
    },
  );

  it.each(["missing backlink", "different checkout"])("refuses a linked worktree with a %s", (kind) => {
    const repo = join(home, "checkout");
    const cwd = join(repo, "src");
    const gitDir = join(root, "metadata");
    repository(join(root, "common"));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(gitDir);
    writeFileSync(join(repo, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), `${"a".repeat(40)}\n`);
    writeFileSync(join(gitDir, "commondir"), `${join(root, "common", ".git")}\n`);
    if (kind === "different checkout") writeFileSync(join(gitDir, "gitdir"), `${join(home, "other", ".git")}\n`);
    expect(projectRulesLocation(root, cwd).projectRoot).toBe(captureApprovalWorkingDirectory(cwd).path);
  });

  it("canonicalizes a symlinked home before enforcing its ceiling", () => {
    repository(home);
    const alias = join(root, "home-alias");
    symlinkSync(home, alias, "junction");
    vi.stubEnv("HOME", alias);
    vi.stubEnv("USERPROFILE", alias);
    const cwd = join(home, "a");
    mkdirSync(cwd);
    expect(projectRulesLocation(root, cwd).projectRoot).toBe(captureApprovalWorkingDirectory(cwd).path);
  });

  it.each(["ordinary repository", "home repository"])("canonicalizes a symlinked cwd in a %s", (kind) => {
    const repo = kind === "home repository" ? home : join(home, "repo");
    repository(repo);
    const cwd = join(repo, "src");
    mkdirSync(cwd);
    const alias = join(root, "alias");
    symlinkSync(cwd, alias, "junction");
    expect(projectRulesLocation(root, alias).projectRoot).toBe(captureApprovalWorkingDirectory(kind === "home repository" ? cwd : repo).path);
  });

  it("compares the home ceiling without case distinctions on Windows", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    repository(home);
    const cwd = join(home, "a");
    mkdirSync(cwd);
    vi.stubEnv("HOME", home.toUpperCase());
    vi.stubEnv("USERPROFILE", home.toUpperCase());
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(projectRulesLocation(root, cwd).identity).toBe(captureApprovalWorkingDirectory(cwd).identity);
      expect(projectRulesLocation(root, cwd).identity).not.toBe(captureApprovalWorkingDirectory(home).identity);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it.each(["home", "ancestor of home"])("preserves legacy %s rules only for exact-cwd sessions", async (kind) => {
    const legacyRoot = kind === "home" ? home : root;
    repository(legacyRoot);
    const legacy = projectRulesLocation(root, legacyRoot);
    await updateProjectRulesFile(legacy, (file) => {
      file.rules.push({ pattern: "Bash(npm test)", action: "allow" });
    });
    const original = readFileSync(legacy.filePath, "utf8");
    for (const name of ["a", "b"]) {
      const cwd = join(home, name);
      mkdirSync(cwd);
      await expect(readProjectRulesFile(projectRulesLocation(root, cwd))).resolves.toBeNull();
    }
    await expect(readProjectRulesFile(projectRulesLocation(root, legacyRoot))).resolves.toMatchObject({ rules: [{ action: "allow" }] });
    expect(readFileSync(legacy.filePath, "utf8")).toBe(original);
  });

  it("recognizes an initialized repository and a detached linked checkout", () => {
    const repo = join(home, "repo");
    const checkout = join(home, "checkout");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(root, "init", "--template=", repo);
    git(repo, "-c", "user.name=Fixture User", "-c", "user.email=fixture@example.test", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "Initialize fixture");
    git(repo, "worktree", "add", "--detach", checkout);
    for (const cwd of [repo, checkout]) {
      const child = join(cwd, "src");
      mkdirSync(child);
      expect(projectRulesLocation(root, child).identity).toBe(captureApprovalWorkingDirectory(git(child, "rev-parse", "--show-toplevel").trim()).identity);
    }
  });
});


it("preserves project rules when identity changes during asynchronous commit preparation", async () => {
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const location = projectRulesLocation(root, cwd);
  await updateProjectRulesFile(location, file => { file.rules.push({ pattern: "Bash(printf before)", action: "allow" }); });
  const before = readFileSync(location.filePath, "utf8");
  let current = true;
  await expect(updateProjectRulesFile(location, file => {
    file.rules.push({ pattern: "Bash(printf after)", action: "allow" });
    current = false;
  }, { refresh: async () => current, isCurrent: () => current })).rejects.toThrow("Approval authority is unavailable");
  expect(readFileSync(location.filePath, "utf8")).toBe(before);
});
