import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { canonicalRuleSpecifier, normalizeRuleSpecifierInput } from "../rules/rule-specifier.js";
import type { ShellRuleDialect } from "../../shared/permissions-events.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function prepare(): { cwd: string; file: string } {
  const cwd = mkdtempSync(join(tmpdir(), "raw-rule-identity-"));
  roots.push(cwd);
  return { cwd, file: join(cwd, "permissions.json") };
}

function pattern(dialect: ShellRuleDialect, command: string): string {
  return canonicalRuleSpecifier(`${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`);
}

function check(manager: PermissionManager, dialect: ShellRuleDialect, command: string, cwd: string, headless = false) {
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command, cwd },
    shellExecution: { runsSandboxed: false }, headless,
  }).decision;
}

async function expectReplay(dialect: ShellRuleDialect, saved: string, different: string): Promise<void> {
  const { cwd, file } = prepare();
  const expected = pattern(dialect, saved);
  expect(buildShellRuleApproval(dialect, saved, cwd, { allow: true, deny: true }).exactRule).toBe(expected);
  const writer = new PermissionManager(file);
  await writer.addRulePersist({ pattern: expected, action: "allow" }, { kind: "user" });
  const reader = new PermissionManager(file);
  await reader.loadRulesFromFile();
  expect(check(reader, dialect, saved, cwd)).toBe("allow");
  expect(check(reader, dialect, saved, cwd, true)).toBe("allow");
  expect(check(reader, dialect, different, cwd)).toBe("ask");
  expect(check(reader, dialect, different, cwd, true)).toBe("deny");
}

describe("raw exact rule identity", () => {
  it.each((["bash", "powershell"] as const).flatMap((dialect) =>
    ["0x10", "001", "1.0", "1kb"].map((value) => ({ dialect, value }))))
  ("keeps quoted and bare numeric text distinct in $dialect: $value", async ({ dialect, value }) => {
    const head = dialect === "bash" ? "printf" : "Write-Output";
    const quoted = `${head} '${value}'`;
    const bare = `${head} ${value}`;
    expect(pattern(dialect, quoted)).not.toBe(pattern(dialect, bare));
    await expectReplay(dialect, quoted, bare);
    await expectReplay(dialect, bare, quoted);
  });

  it.each(["bash", "powershell"] as const)("keeps single and double quote styles distinct in %s", async (dialect) => {
    const head = dialect === "bash" ? "printf" : "Write-Output";
    const single = `${head} 'literal data'`;
    const double = `${head} "literal data"`;
    expect(pattern(dialect, single)).not.toBe(pattern(dialect, double));
    await expectReplay(dialect, single, double);
    await expectReplay(dialect, double, single);
  });

  it.each(["bash", "powershell"] as const)("normalizes only interword spaces in %s", async (dialect) => {
    const { cwd, file } = prepare();
    const command = "git commit -m 'two  spaces'";
    const expanded = "git   commit\t-m   'two  spaces'";
    const expected = pattern(dialect, command);
    expect(normalizeRuleSpecifierInput(`${dialect === "bash" ? "Bash" : "PowerShell"}(${expanded})`)).toBe(expected);
    expect(buildShellRuleApproval(dialect, expanded, cwd, { allow: true, deny: true }).exactRule).toBe(expected);
    const manager = new PermissionManager(file);
    await manager.addRulePersist({ pattern: expected, action: "allow" }, { kind: "user" });
    expect(check(manager, dialect, expanded, cwd)).toBe("allow");
    expect(check(manager, dialect, "git commit -m 'two spaces'", cwd)).toBe("ask");
  });

  it("does not fold PowerShell parameter word case", async () => {
    expect(pattern("powershell", "Get-ChildItem -Force")).toBe("PowerShell(get-childitem -Force)");
    await expectReplay("powershell", "Get-ChildItem -Force", "Get-ChildItem -force");
    await expectReplay("powershell", "Get-ChildItem -force", "Get-ChildItem -Force");
  });
});
