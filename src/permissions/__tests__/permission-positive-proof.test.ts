import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { checkShellPermission } from "../../__tests__/support/permission-lane.js";
import { inspectShellCommand } from "../rules/shell-exfiltration.js";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
let cwd: string;
let manager: PermissionManager;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "positive-permission-")));
  vi.stubEnv("AVE_HOME", cwd);
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
  const cases = dialect === "bash" ? [...REFUSED, "wget https://x.invalid/file; cat file"] : REFUSED;
  it.each(cases)("never repairs unproven syntax with a broad allow: %s", (command) => {
    const inspect = dialect === "bash" ? inspectShellCommand : inspectPowerShellCommand;
    expect(inspect(command, cwd).outcome).toBe("unproven");
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    for (const sandboxed of [false, true]) {
      expect(checkShellPermission(manager, cwd, "positive-session", command, dialect, sandboxed)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
      expect(checkShellPermission(manager, cwd, "positive-session", command, dialect, sandboxed, true)).toMatchObject({ decision: "deny", layer: 2 });
    }
  });
});
it.each(["–", "—", "―"])("refuses unsupported parameter punctuation %s rather than treating it as data", (dash) => {
  for (const command of [`Write-Output ${dash}Unknown`, `Get-Content ${dash}Unknown notes.txt`, `Get-Content -Path ${dash}Unknown`, `Invoke-Expression ${dash}Verbose`, `Invoke-WebRequest -Uri https://x.invalid ${dash}OutFile:runner; Write-Output ready`]) {
    expect(inspectPowerShellCommand(command, cwd).outcome).toBe("unproven");
    expect(buildShellRuleApproval("powershell", command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    expect(checkShellPermission(manager, cwd, "positive-session", command, "powershell", true, true).decision).toBe("deny");
  }
});
