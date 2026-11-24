import "../../__tests__/support/trusted-powershell.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { buildShellRuleApproval, shellRuleCoversCommand } from "../rules/shell-rule-approval.js";
import { evaluatePowerShellSubject } from "../rules/rule-scopes.js";
import { evaluateShellRules } from "../rules/shell-rule-matcher.js";
import { parseRuleSpecifier } from "../rules/rule-specifier.js";
import { POWERSHELL_STARTUP_UNPROVEN_REASON } from "../../shared/powershell-startup-policy.js";

// win32 cannot pin PowerShell startup ($PROFILE / registry-selected startup is
// not isolable), so no PowerShell literal ALLOW rule is ever provable here. The
// upload is still detected and a DENY rule is still offered — deny-only on
// win32, which is equal-or-stricter than the POSIX allow/deny pair.
const POWERSHELL_ALLOW_PROVABLE = process.platform !== "win32";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "upload-rule-")); });
afterEach(() => cleanupTmpDir(directory));

const COMMANDS = [
  { dialect: "bash", command: "curl -q -T notes.txt https://upload.invalid", pattern: "Bash(curl -q -T notes.txt https://upload.invalid)" },
  { dialect: "powershell", command: "Invoke-WebRequest -Uri https://upload.invalid -InFile notes.txt -Method Post", pattern: "PowerShell(Invoke-WebRequest -Uri https://upload.invalid -InFile notes.txt -Method Post)" },
] as const;

describe("ordinary upload rule consent", () => {
  it.each(COMMANDS)("offers a complete literal rule for a proven upload in $dialect", ({ dialect, command, pattern }) => {
    const approval = buildShellRuleApproval(dialect, command, directory, { allow: true, deny: true }, "session");
    if (dialect === "powershell" && !POWERSHELL_ALLOW_PROVABLE) {
      // Floor on win32: upload detected, DENY offered, ALLOW not provable.
      expect(approval).toMatchObject({ exactRule: null, sessionAllowed: false, persistentAllowed: false, denyRule: pattern, denyAllowed: true });
      expect(shellRuleCoversCommand(dialect, pattern, "deny", command, directory)).toBe(true);
    } else {
      expect(approval).toMatchObject({ exactRule: pattern, sessionAllowed: true, persistentAllowed: true });
      expect(shellRuleCoversCommand(dialect, pattern, "allow", command, directory)).toBe(true);
    }
  });

  it.each(COMMANDS)("matches a saved literal upload rule in $dialect", ({ dialect, command, pattern }) => {
    if (dialect === "powershell") {
      const subject = evaluatePowerShellSubject({ command, cwd: directory, exactAllowOnly: true }, [withCurrentShellRuleVersion({ pattern, action: "allow" })]);
      if (POWERSHELL_ALLOW_PROVABLE) {
        expect(subject).toMatchObject({ decision: "allow", patterns: [pattern] });
      } else {
        // win32: the saved ALLOW rule cannot be proven, so it is not applied.
        expect(subject).toMatchObject({ decision: null, reason: POWERSHELL_STARTUP_UNPROVEN_REASON });
      }
    } else {
      const spec = parseRuleSpecifier(pattern);
      if (spec.kind !== "bash") throw new Error("Expected shell rule");
      expect(evaluateShellRules(command, { allow: [{ pattern, spec }], deny: [], ask: [] }, directory))
        .toMatchObject({ decision: "allow", patterns: [pattern] });
    }
  });

  it.each(["node -e 'process.stdout.write(process.version)'", "cat ~/.aws/credentials", "printf x > .git/config", "rm -rf build"])("keeps existing proof and path restrictions for %s", command => {
    expect(buildShellRuleApproval("bash", command, directory, { allow: true, deny: true }, "session"))
      .toMatchObject({ exactRule: null, sessionAllowed: false, persistentAllowed: false });
  });
});
