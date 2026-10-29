import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { criticalDeleteTargetFor, isAdmissionDeniedPath, isSensitivePath, permissionPathEvidence, protectedControlEntryFor } from "../sensitive-paths.js";
import { evaluateScopedRules } from "../rules/scoped-rule-matcher.js";
import { inspectPowerShellPermissionPaths } from "../rules/powershell-exfiltration.js";
import { inspectShellPermissionPaths } from "../../tools/shell-path-policy.js";

let root: string;
let project: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "permission-evidence-")));
  project = join(root, "project");
  mkdirSync(project);
  vi.stubEnv("AVE_HOME", join(root, "profile"));
});
afterEach(async () => { vi.unstubAllEnvs(); await cleanupTmpDir(root); });

describe("permission path facts", () => {
  it.each([".env", ".env.production", ".ssh/id_rsa", ".aws/credentials", ".kube/config"])("separates an ordinary secret from host admission for %s", (name) => {
    const path = join(project, name);
    expect(isSensitivePath(path, "read")).not.toBeNull();
    expect(isAdmissionDeniedPath(path, "read")).toBeNull();
    expect(permissionPathEvidence({ lexical: path, canonical: path, effect: "read" }, project)).toMatchObject({
      secret: expect.any(String), admissionDenial: null, protectedControl: undefined, projectEscape: false,
    });
  });

  it.each([".env.example", ".env.sample", ".env.template", ".env.dist"])("retains the environment template exclusion for %s", (name) => {
    expect(isSensitivePath(join(project, name), "read")).toBeNull();
  });

  it.each([".git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn", ".claude", ".config/git", ".bashrc", ".zshrc", ".zprofile", ".profile", ".envrc", ".gitconfig", ".npmrc", ".mcp.json", ".claude.json"])("reports protected paths across case and separators for %s", (name) => {
    const target = `${project}/${name}/child`;
    expect(protectedControlEntryFor(target)).toBe(name);
    expect(permissionPathEvidence({ lexical: target, canonical: target, effect: "read" }, project).protectedControl).toBeUndefined();
    expect(permissionPathEvidence({ lexical: target, canonical: target, effect: "write" }, project).protectedControl).toBe(name);
    expect(protectedControlEntryFor(`C:\\workspace\\${name.toUpperCase().replaceAll("/", "\\")}\\child`)).toBe(name);
  });

  it.each([".githooks", ".pre-commit-config.yaml", "lefthook.yml", ".bash_profile"])("does not extend the protected set with %s", (name) => {
    expect(protectedControlEntryFor(join(project, name))).toBeUndefined();
  });

  it.each([".ave/secrets/token", ".ave/keys/key", ".ave/subscription-runtimes/profile/auth.json", "Library/Keychains/login.keychain-db", "AppData/Roaming/Microsoft/Protect/key", ".config/chromium/Default/Cookies"])("keeps host credential admission for %s", (name) => {
    expect(isAdmissionDeniedPath(join(root, name), "read")).not.toBeNull();
    expect(isAdmissionDeniedPath(join(root, name), "write")).not.toBeNull();
  });

  it("protects relocated application control state without credential admission", () => {
    const path = join(root, "profile", "permissions.json");
    expect(protectedControlEntryFor(path)).toBe("application-home");
    expect(isAdmissionDeniedPath(path)).toBeNull();
  });

  it("retains lexical and canonical protection across a link", () => {
    mkdirSync(join(project, ".git"));
    symlinkSync(join(project, ".git"), join(project, "alias"), process.platform === "win32" ? "junction" : "dir");
    const lexical = join(project, "alias", "config");
    writeFileSync(join(project, ".git", "config"), "synthetic");
    expect(permissionPathEvidence({ lexical, canonical: realpathSync.native(lexical), effect: "write" }, project).protectedControl).toBe(".git");
  });

  it("reports link and parent escape without flooring ordinary absolute external writes", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(project, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(permissionPathEvidence({ lexical: join(project, "link", "new"), canonical: join(outside, "new"), effect: "write" }, project).projectEscape).toBe(true);
    expect(permissionPathEvidence({ lexical: `${project}/../outside/new`, canonical: join(outside, "new"), effect: "write" }, project).projectEscape).toBe(true);
    expect(permissionPathEvidence({ lexical: join(outside, "new"), canonical: join(outside, "new"), effect: "write" }, project).projectEscape).toBe(false);
  });

  it("does not turn ordinary secret edits into a forced floor", () => {
    expect(evaluateScopedRules({ kind: "edit", paths: [".env"], cwd: project }, project, [{ pattern: "Edit(**)", action: "allow" }])).toMatchObject({ decision: "allow" });
  });

  it("retains a protected target among multiple edits", () => {
    expect(evaluateScopedRules({ kind: "edit", paths: ["ordinary", ".GIT/config"], cwd: project }, project, [{ pattern: "Edit(**)", action: "allow" }])).toMatchObject({ floor: "Protected control path: .git" });
  });

  it("distinguishes critical delete intent from ordinary recursive deletion", () => {
    for (const command of ["rm -rf /", "rm -rf .", "rm -rf .."]) {
      const result = inspectShellPermissionPaths(command, project);
      expect(result.paths.some((path) => path.deleteIntent && criticalDeleteTargetFor(path, [project]) !== undefined), command).toBe(true);
    }
    const ordinary = inspectShellPermissionPaths("rm -rf src", project);
    expect(ordinary.paths.some((path) => path.deleteIntent)).toBe(true);
    expect(ordinary.paths.some((path) => path.deleteIntent && criticalDeleteTargetFor(path, [project]) !== undefined)).toBe(false);
    const home = { lexical: join(project, "alias"), canonical: homedir() };
    expect(criticalDeleteTargetFor(home, [project])).toBe(homedir());
    const removed = inspectPowerShellPermissionPaths("Remove-Item -LiteralPath . -Recurse -Force", project);
    expect(removed.paths.some((path) => path.deleteIntent && criticalDeleteTargetFor(path, [project]) !== undefined)).toBe(true);
    const removedHome = inspectPowerShellPermissionPaths("Remove-Item $HOME -Recurse", project);
    expect(removedHome.paths.some((path) => path.deleteIntent && criticalDeleteTargetFor(path, [project]) !== undefined)).toBe(true);
    expect(inspectShellPermissionPaths("mkdir ordinary", project).paths.some((path) => path.deleteIntent)).toBe(false);
  });

  it("reports secret reads and protected endpoints from parsed shell bindings", () => {
    const copied = inspectShellPermissionPaths("cp .env ordinary", project);
    expect(copied.paths.find((path) => path.secret !== null)?.effect).toBe("read");
    const command = inspectPowerShellPermissionPaths("Get-Content .env; Copy-Item -LiteralPath .env -Destination .GIT/config", project);
    expect(command.paths.some((path) => path.secret !== null && path.effect === "read")).toBe(true);
    expect(command.paths.some((path) => path.protectedControl === ".git")).toBe(true);
    expect(inspectPowerShellPermissionPaths("Get-Secret token", project).credentialStore).not.toBeNull();
    expect(inspectPowerShellPermissionPaths("Write-Output '.git/config'", project).paths).toEqual([]);
  });

  it("retains proven read-only status commands", () => {
    expect(inspectShellPermissionPaths("git status", project)).toMatchObject({ unproven: null });
  });

  it("collects both endpoints and later protected targets without a policy short circuit", () => {
    const evidence = inspectShellPermissionPaths(`cp .env ../outside; mv ordinary .GIT/config`, project);
    expect(evidence.unproven).toBeNull();
    expect(evidence.paths.some((path) => path.secret !== null && path.admissionDenial === null)).toBe(true);
    expect(evidence.paths.some((path) => path.projectEscape)).toBe(true);
    expect(evidence.paths.some((path) => path.protectedControl === ".git")).toBe(true);
    expect(evidence.paths).toHaveLength(4);
  });
});
