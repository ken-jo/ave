import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkShellPermission, literalShellRulePattern } from "../../__tests__/support/permission-lane.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { PermissionManager } from "../permission-manager.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";

// Reusable proof and mode routing are separate policy decisions.
const NESTED_EXECUTABLE_CASES = [
  "python3 -I -S ordinary.py", "python3.11 -I -S ordinary.py", "python3.15 -I -S ordinary.py",
  "python3 -I -S -c 'print(1)'", "python3 -S -I ordinary.py", "python -I -S ordinary.py",
  "bash --noprofile --norc -p ordinary.sh", "bash --noprofile --norc -p -c 'printf ready'",
  "fish -N ordinary.fish", "fish --no-config --command 'printf ready'", "fish -N '--command=printf ready'",
  "zsh -f -c 'printf ready'", "sh -c 'printf ready'", "dash -c 'printf ready'", "ksh -c 'printf ready'",
  "node --no-addons ordinary.js", "bun ordinary.js", "deno run ordinary.ts", "ruby ordinary.rb", "perl ordinary.pl",
  "pwsh -NoProfile -File ordinary.ps1", "powershell -NoProfile -Command 'Get-Date'", "cmd /d /c 'echo ready'",
  "./bin/python3 -I -S ordinary.py", "/usr/bin/python3 -I -S ordinary.py",
] as const;
let cwd: string;
let manager: PermissionManager;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "nested-startup-")));
  vi.stubEnv("AVE_HOME", join(cwd, "state"));
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); });

describe("nested executable startup requires more than argv", () => {
  it.each((["bash", "powershell"] as const).flatMap((dialect) =>
    NESTED_EXECUTABLE_CASES.flatMap((command) => [command, `env ${command}`].map((text) => ({ dialect, command: text }))),
  ))("offers no exact approval for $dialect $command", ({ dialect, command }) => {
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    for (const pattern of [literalShellRulePattern(dialect, command), `${dialect === "bash" ? "Bash" : "PowerShell"}(${command.split(" ")[0]} *)`]) {
      manager.setRules([withCurrentShellRuleVersion({ pattern, action: "allow" })]);
      for (const sandboxed of [false, true]) {
        expect(checkShellPermission(manager, cwd, "nested-startup", command, dialect, sandboxed))
          .toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
        expect(checkShellPermission(manager, cwd, "nested-startup", command, dialect, sandboxed, true))
          .toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
        manager.setMode("default");
        expect(checkShellPermission(manager, cwd, "nested-startup", command, dialect, sandboxed))
          .toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
        expect(checkShellPermission(manager, cwd, "nested-startup", command, dialect, sandboxed, true))
          .toMatchObject({ decision: "deny", reasonCode: "no-approver" });
        manager.setMode("allow");
      }
    }
  });
});
