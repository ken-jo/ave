import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMandatorySandboxWriteDenyPaths } from "../sandbox-write-policy.js";
import { permissionSettingsPath } from "../permission-settings-store.js";
import { egressGrantFilePath } from "../egress-grants.js";
import { userApprovalFilePath } from "../user-approval-store.js";
import { permissionsFilePath } from "../permissions-store.js";
import { getAdminPolicyPath, userPolicyPath } from "../policy-store.js";
import { projectRulesDirectory } from "../rules/project-rule-files.js";
import { settingsFilePath } from "../../data/settings-store.js";

describe("mandatory sandbox control-file writes", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-write-policy-")));
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    vi.stubEnv("AVE_HOME", join(root, "ave"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".gitconfig",
    ".git/hooks", ".git/config", ".vscode",
  ])("protects missing %s in every writable root and the host home", (entry) => {
    const roots = [join(root, "project"), join(root, "temp")];
    const denies = getMandatorySandboxWriteDenyPaths(roots);
    for (const base of [root, ...roots]) expect(denies).toContain(join(base, entry));
  });

  it("takes settings, rules, approvals and policy locations from their stores", () => {
    const userData = join(root, "desktop-data");
    expect(getMandatorySandboxWriteDenyPaths([root], userData)).toEqual(expect.arrayContaining([
      settingsFilePath(userData), permissionSettingsPath(), permissionsFilePath(),
      userPolicyPath(), getAdminPolicyPath(), egressGrantFilePath(), userApprovalFilePath(), dirname(projectRulesDirectory(join(root, "ave"))),
    ]));
  });

  it("keeps the entry and canonical target of a linked project", () => {
    const target = join(root, "target");
    mkdirSync(target);
    const link = join(root, "linked");
    symlinkSync(target, link, "dir");
    const denies = getMandatorySandboxWriteDenyPaths([link]);
    expect(denies).toContain(join(link, ".git", "config"));
    expect(denies).toContain(join(target, ".git", "config"));
    expect(new Set(denies).size).toBe(denies.length);
  });
});
