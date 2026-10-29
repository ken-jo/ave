import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { createPermissionPathEvidence, criticalDeleteTargetFor, isAdmissionDeniedPath, isSensitivePath, protectedControlEntryFor } from "../sensitive-paths.js";
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
    expect(createPermissionPathEvidence(project)({ lexical: path, canonical: path, effect: "read" })).toMatchObject({
      secret: expect.any(String), admissionDenial: null, protectedControl: undefined, projectEscape: false,
    });
  });

  it("keeps read and write facts separate while sharing each decision's policy roots", () => {
    const collect = createPermissionPathEvidence(project);
    const cases = ["ordinary", ".env", ".env.example", ".git/config", "../profile/keys/secret"];
    for (const effect of ["read", "write", "read"] as const) {
      for (const name of cases) {
        const target = join(project, name);
        const path = { lexical: target, canonical: target, effect };
        expect(collect(path)).toEqual({
          ...path,
          secret: isSensitivePath(target, effect),
          admissionDenial: isAdmissionDeniedPath(target, effect),
          protectedControl: effect === "write" ? protectedControlEntryFor(target) : undefined,
          projectEscape: false,
        });
      }
    }
    const secret = join(project, ".env");
    const redirected = join(root, "profile", "keys", "secret");
    expect(collect({ lexical: secret, canonical: redirected, effect: "read" })).toMatchObject({ secret: expect.any(String), admissionDenial: expect.any(String) });
    expect(collect({ lexical: secret, canonical: secret, effect: "read" }).admissionDenial).toBeNull();
  });

  it("refreshes relocated policy roots between decisions without reinterpreting frozen targets", () => {
    const firstHome = join(root, "first-host");
    const nextHome = join(root, "next-host");
    mkdirSync(firstHome);
    mkdirSync(nextHome);
    const homeLink = join(root, "host-state");
    symlinkSync(firstHome, homeLink, "junction");
    vi.stubEnv("AVE_HOME", homeLink);
    const collectFirst = createPermissionPathEvidence(project);
    const firstKey = join(firstHome, "keys", "secret");
    const nextKey = join(nextHome, "keys", "secret");
    const path = (target: string) => ({ lexical: target, canonical: target, effect: "read" as const });
    expect(collectFirst(path(firstKey)).admissionDenial).not.toBeNull();
    expect(collectFirst(path(nextKey)).admissionDenial).toBeNull();
    unlinkSync(homeLink);
    symlinkSync(nextHome, homeLink, "junction");
    const collectNext = createPermissionPathEvidence(project);
    expect(collectNext(path(nextKey)).admissionDenial).not.toBeNull();
    expect(collectNext(path(firstKey)).admissionDenial).toBeNull();
    expect(collectFirst(path(firstKey)).admissionDenial).not.toBeNull();
  });

  it.each([".env.example", ".env.sample", ".env.template", ".env.dist"])("retains the environment template exclusion for %s", (name) => {
    expect(isSensitivePath(join(project, name), "read")).toBeNull();
  });

  it.each([".git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn", ".claude", ".config/git", ".bashrc", ".zshrc", ".zprofile", ".profile", ".envrc", ".gitconfig", ".npmrc", ".mcp.json", ".claude.json"])("reports protected paths across case and separators for %s", (name) => {
    const target = `${project}/${name}/child`;
    expect(protectedControlEntryFor(target)).toBe(name);
    expect(createPermissionPathEvidence(project)({ lexical: target, canonical: target, effect: "read" }).protectedControl).toBeUndefined();
    expect(createPermissionPathEvidence(project)({ lexical: target, canonical: target, effect: "write" }).protectedControl).toBe(name);
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
    expect(createPermissionPathEvidence(project)({ lexical, canonical: realpathSync.native(lexical), effect: "write" }).protectedControl).toBe(".git");
  });

  it("reports link and parent escape without flooring ordinary absolute external writes", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(project, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(createPermissionPathEvidence(project)({ lexical: join(project, "link", "new"), canonical: join(outside, "new"), effect: "write" }).projectEscape).toBe(true);
    expect(createPermissionPathEvidence(project)({ lexical: `${project}/../outside/new`, canonical: join(outside, "new"), effect: "write" }).projectEscape).toBe(true);
    expect(createPermissionPathEvidence(project)({ lexical: join(outside, "new"), canonical: join(outside, "new"), effect: "write" }).projectEscape).toBe(false);
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
