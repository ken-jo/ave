import { stabilizeFixtureAncestorStats } from "../../__tests__/support/fixture-ancestor-stats.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { resolveVerifiedExecutable } from "../../shared/verified-executable.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { PermissionManager } from "../permission-manager.js";
import { prepareVerifiedShellCommand } from "../verified-shell-command.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { CLASSIFIER_WIDENING_FIXTURES } from "./fixtures/classifier-widening.js";

vi.mock("node:fs", { spy: true });
vi.mock("node:child_process", { spy: true });
vi.mock("../../shared/verified-executable.js", () => ({ resolveVerifiedExecutable: vi.fn() }));
vi.mock("../../shared/powershell-startup-policy.js", () => ({ isPowerShellStartupPinned: () => true, POWERSHELL_STARTUP_UNPROVEN_REASON: "startup is unproven" }));
const platform = process.platform;
let cwd: string;
let manager: PermissionManager;
beforeEach(() => {
  setProcessPlatform("linux");
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "widening-battery-")));
  stabilizeFixtureAncestorStats(cwd);
  mkdirSync(join(cwd, ".git", "objects"), { recursive: true });
  mkdirSync(join(cwd, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(cwd, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
  vi.stubEnv("AVE_HOME", join(cwd, "state"));
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
  vi.mocked(childProcess.execFileSync).mockReturnValue("git version 2.54.0\n");
});
afterEach(() => { setProcessPlatform(platform); vi.unstubAllEnvs(); vi.mocked(childProcess.execFileSync).mockRestore(); rmSync(cwd, { recursive: true, force: true }); });

describe("verified command policy battery", () => {
  it.each((["bash", "powershell"] as const).flatMap((dialect) => CLASSIFIER_WIDENING_FIXTURES.map((fixture) => ({ dialect, ...fixture }))))
    ("$dialect $command (installation=$installation)", (fixture) => {
      vi.mocked(resolveVerifiedExecutable).mockImplementation((candidates) => fixture.installation && candidates[0] !== undefined ? { executable: candidates[0].executable } : null);
      const { command, dialect } = fixture;
      const handle = prepareVerifiedShellCommand({ command, dialect, cwd });
      expect(handle !== undefined).toBe(fixture.plan);
      const approval = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle);
      expect(approval.exactRule !== null).toBe(fixture.exact);
      if (fixture.exact) expect(approval.exactRule).toBe(`${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`);
      const check = (sandboxed: boolean, headless: boolean) => manager.checkDetailed(dialect, "builtin", "shell", null, {
        ruleSubject: { kind: "shell", dialect, command, cwd }, shellExecution: { runsSandboxed: sandboxed }, headless,
        ...(handle === undefined ? {} : { verifiedShellCommand: handle }),
      });
      const initial = check(true, false);
      expect(initial.decision).toBe(fixture.sandbox);
      if (fixture.sandbox === "allow") {
        expect(["allow-mode", "read-only-shell", "sandboxed-shell"]).toContain(initial.reasonCode);
      }
      const pattern = `${dialect === "bash" ? "Bash" : "PowerShell"}(${fixture.storable === false ? "git log *" : command})`;
      manager.setRules([withCurrentShellRuleVersion({ pattern, action: "allow" })]);
      for (const sandboxed of [false, true]) {
        expect(check(sandboxed, false).decision).toBe(fixture.saved);
        expect(check(sandboxed, true).decision).toBe(fixture.headless);
      }
      if (command.startsWith("git ")) {
        manager.setRules([withCurrentShellRuleVersion({ pattern: `${dialect === "bash" ? "Bash" : "PowerShell"}(git *)`, action: "allow" })]);
        expect(check(false, false).decision).toBe(fixture.saved);
        expect(check(false, true).decision).toBe(fixture.headless);
        expect(check(true, false).decision).toBe(fixture.sandbox);
      }
    });

  it.each(["bash", "powershell"] as const)("does not upgrade invalid repository inputs under saved %s grants", (dialect) => {
    writeFileSync(join(cwd, ".git", "config"), "[include]\n\tpath = outside-config\n");
    vi.mocked(resolveVerifiedExecutable).mockImplementation((candidates) => candidates[0] === undefined ? null : { executable: candidates[0].executable });
    const command = "git log";
    const handle = prepareVerifiedShellCommand({ command, dialect, cwd });
    expect(handle).toBeUndefined();
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle).exactRule).toBeNull();
    const wrapper = dialect === "bash" ? "Bash" : "PowerShell";
    for (const pattern of [`${wrapper}(git log)`, `${wrapper}(git *)`]) {
      manager.setRules([withCurrentShellRuleVersion({ pattern, action: "allow" })]);
      for (const sandboxed of [false, true]) {
        const context = { ruleSubject: { kind: "shell" as const, dialect, command, cwd }, shellExecution: { runsSandboxed: sandboxed } };
        expect(manager.checkDetailed(dialect, "builtin", "shell", null, context)).toMatchObject({ decision: "allow", reasonCode: dialect === "bash" && sandboxed ? "read-only-shell" : "allow-mode" });
        expect(manager.checkDetailed(dialect, "builtin", "shell", null, { ...context, headless: true })).toMatchObject({ decision: "allow", reasonCode: dialect === "bash" && sandboxed ? "read-only-shell" : "allow-mode" });
      }
    }
  });
});
