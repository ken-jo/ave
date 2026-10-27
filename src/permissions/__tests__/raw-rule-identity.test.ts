import "../../__tests__/support/trusted-powershell.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { normalizeRuleSpecifierInput } from "../rules/rule-specifier.js";
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
import { literalShellRulePattern as pattern } from "../../__tests__/support/permission-lane.js";

// These cases model a pinned-startup host; win32 is never pinned (permission-policy-design.md, Windows startup proof).
vi.mock("../../shared/powershell-startup-policy.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../../shared/powershell-startup-policy.js")>(), isPowerShellStartupPinned: () => true }));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function prepare(): { cwd: string; file: string } {
  const cwd = mkdtempSync(join(tmpdir(), "raw-rule-identity-"));
  roots.push(cwd);
  return { cwd, file: join(cwd, "permissions.json") };
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

async function expectInertIdentity(dialect: ShellRuleDialect, saved: string, different: string): Promise<void> {
  const { cwd, file } = prepare();
  const expected = pattern(dialect, saved);
  expect(expected).not.toBe(pattern(dialect, different));
  expect(buildShellRuleApproval(dialect, saved, cwd, { allow: true, deny: true }).exactRule).toBeNull();
  const writer = new PermissionManager(file);
  await writer.addRulePersist({ pattern: expected, action: "allow" }, { kind: "user" });
  const reader = new PermissionManager(file);
  await reader.loadRulesFromFile();
  expect(check(reader, dialect, saved, cwd)).toBe("ask");
  expect(check(reader, dialect, saved, cwd, true)).toBe("deny");
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
    expect(buildShellRuleApproval(dialect, expanded, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    const manager = new PermissionManager(file);
    await manager.addRulePersist({ pattern: expected, action: "allow" }, { kind: "user" });
    expect(check(manager, dialect, expanded, cwd)).toBe("ask");
    expect(check(manager, dialect, expanded, cwd, true)).toBe("deny");
    expect(check(manager, dialect, "git commit -m 'two spaces'", cwd)).toBe("ask");
  });

  it.each(["bash", "powershell"] as const)("saves and matches literally quoted data with interword normalization in %s", async (dialect) => {
    const { cwd, file } = prepare();
    const command = "printf '%s' 'two  spaces'";
    const expanded = "printf   '%s'\t  'two  spaces'";
    const expected = pattern(dialect, command);
    expect(buildShellRuleApproval(dialect, expanded, cwd, { allow: true, deny: true }).exactRule).toBe(expected);
    const writer = new PermissionManager(file);
    await writer.addRulePersist({ pattern: expected, action: "allow" }, { kind: "user" });
    const reader = new PermissionManager(file);
    await reader.loadRulesFromFile();
    expect(check(reader, dialect, expanded, cwd)).toBe("allow");
    expect(check(reader, dialect, expanded, cwd, true)).toBe("allow");
    expect(check(reader, dialect, "printf '%s' 'two spaces'", cwd)).toBe("ask");
  });

  it("keeps complete module program tokens distinct after save and replay", async () => {
    const alpha = "Alpha\\Invoke-Probe ready";
    const beta = "Beta\\Invoke-Probe ready";
    const bare = "Invoke-Probe ready";
    for (const [saved, other] of [[alpha, beta], [beta, alpha], [alpha, bare], [bare, alpha]]) {
      expect(pattern("powershell", saved)).not.toBe(pattern("powershell", other));
      await expectInertIdentity("powershell", saved, other);
    }
  });

  it.each(["bash", "powershell"] as const)("preserves program token case in %s", async (dialect) => {
    const mixed = dialect === "bash" ? "Printf ready" : "Write-Output ready";
    const lower = dialect === "bash" ? "printf ready" : "write-output ready";
    expect(pattern(dialect, mixed)).not.toBe(pattern(dialect, lower));
    if (dialect === "bash") await expectInertIdentity(dialect, mixed, lower);
    else await expectReplay(dialect, mixed, lower);
    await expectReplay(dialect, lower, mixed);
  });

  it.each(["bash", "powershell"] as const)("preserves quoted program token text in %s rule keys", (dialect) => {
    const head = dialect === "bash" ? "printf" : "Write-Output";
    const variants = [head, `'${head}'`, `"${head}"`].map((rawHead) => pattern(dialect, `${rawHead} ready`));
    expect(new Set(variants).size).toBe(3);
    expect(variants[1]).toContain(`'${head}' ready`);
    expect(variants[2]).toContain(`"${head}" ready`);
  });

  it("does not fold PowerShell parameter word case", async () => {
    expect(pattern("powershell", "Get-ChildItem -Force")).toBe("PowerShell(Get-ChildItem -Force)");
    await expectReplay("powershell", "Get-ChildItem -Force", "Get-ChildItem -force");
    await expectReplay("powershell", "Get-ChildItem -force", "Get-ChildItem -Force");
  });
});
