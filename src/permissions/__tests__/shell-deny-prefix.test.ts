import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionManager } from "../permission-manager.js";
import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
import { evaluatePowerShellSubject, evaluateShellSubject, shellDenyOnBoundedPrefix } from "../rules/rule-scopes.js";
import { parsePowerShellCommand } from "../rules/powershell-exfiltration.js";
import { parseShellFloorCommand } from "../rules/shell-exfiltration.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "ave-shell-deny-prefix-")); });
afterEach(async () => { await cleanupTmpDir(cwd); });

it("uses the bounded deny scan once and feeds it the decision's rule scopes", () => {
  const root = join(process.cwd(), "src");
  const uses = readdirSync(root, { recursive: true, encoding: "utf8" }).map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".ts") && !file.split("/").includes("__tests__") && file !== "permissions/rules/rule-scopes.ts")
    .flatMap((file) => (readFileSync(join(root, file), "utf8").match(/\bshellDenyOnBoundedPrefix\(/g) ?? []).map(() => file));
  expect(uses).toEqual(["permissions/permission-manager.ts"]);
  const source = readFileSync(new URL("../permission-manager.ts", import.meta.url), "utf8");
  expect(source).toMatch(/shellDenyOnBoundedPrefix\(\{[\s\S]*?ruleScopes[,\s]/);
  expect(source).toMatch(/rules\.deny = deny\?\.pattern \?\? shellDeny\?\.pattern/);
});

describe.each([
  { dialect: "bash" as const, pattern: "Bash(printf *)", first: "printf ready", long: `printf${" x".repeat(450)}` },
  { dialect: "powershell" as const, pattern: "PowerShell(Write-Output *)", first: "Write-Output ready", long: `Write-Output${" 1".repeat(450)}` },
])("bounded $dialect deny rules", ({ dialect, pattern, first, long }) => {
  const overBudgetTail = `date${" x".repeat(450)}`;
  const longTail = Array.from({ length: 1800 }, () => "date x").join("; ");
  async function savedDeny(generic = false) {
    const manager = new PermissionManager(join(cwd, "permissions.json"));
    manager.setMode("allow");
    if (generic) manager.setRules([{ pattern: dialect, action: "deny" }]);
    await manager.addRulePersist({ pattern, action: "deny" }, { kind: "user" });
    return (command: string, headless = false) => manager.checkDetailed(dialect, "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect, command, cwd },
      shellExecution: { runsSandboxed: true },
      headless,
    });
  }

  it.each([overBudgetTail, longTail].map((tail, index) => ({ tail, limit: index === 0 ? "token" : "input" })))(
    "keeps a saved deny in the completed prefix at the $limit limit", async ({ tail }) => {
      expect((await savedDeny())(`${first}; ${tail}`)).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
    },
  );

  if (dialect === "powershell") {
    it.each([
      { tail: overBudgetTail, limit: "token" },
      { tail: `date ${"x".repeat(8000)}`, limit: "input" },
    ])("keeps a completed deny when quote ambiguity is beyond the $limit limit", async ({ tail }) => {
      const check = await savedDeny();
      expect(check(`${first}; ${tail}`)).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
      expect(check(`${first}; ${tail} # it’s a comment`)).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
      expect(check(`Write-Output ‘ready’; ${tail}`))
        .toMatchObject({ decision: "deny", reasonCode: "shell-analysis-limit" });
      expect(check(`date; Write-Output ‘open; ${tail}`))
        .toMatchObject({ decision: "deny", reasonCode: "shell-analysis-limit" });
    });

    it.each([
      { position: "leading comment", command: `# it’s a comment\n${first}\n${overBudgetTail}` },
      { position: "inline comment", command: `${first} # it’s a comment\n${overBudgetTail}` },
      { position: "double-quoted string", command: `Write-Output "it’s ready"; ${overBudgetTail}` },
      { position: "single-quoted string", command: `Write-Output 'say “ready”'; ${overBudgetTail}` },
    ])("refuses an unproven prefix with a typographic quote in the $position", async ({ command }) => {
      expect((await savedDeny())(command)).toMatchObject({ decision: "deny", reasonCode: "shell-analysis-limit" });
    });

    it("ignores quote ambiguity inside the clipped suffix after a completed deny", async () => {
      const check = await savedDeny();
      expect(check(`${first}; date ‘${"x".repeat(8000)}`)).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
    });
  }

  it("preserves the merge-base refusal when the first statement exhausts the token budget", async () => {
    const check = await savedDeny();
    expect(check(first)).toMatchObject({ decision: "deny", reasonCode: "rule-deny", reason: pattern });
    for (const headless of [false, true]) {
      expect(check(long, headless)).toMatchObject({ decision: "deny", reasonCode: "shell-analysis-limit" });
    }
  });

  it("takes a generic deny before the exhausted dialect deny check", async () => {
    expect((await savedDeny(true))(long)).toMatchObject({ decision: "deny", reasonCode: "rule-deny", reason: dialect });
  });

  it("keeps complete commands equivalent to the full evaluator", () => {
    const rules = [{ pattern, action: "deny" as const, shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }];
    for (const command of [first, `date; ${first}`, "date", dialect === "bash" ? "printf 'two words'" : "echo 'two words'"]) {
      const subject = { command, cwd, exactAllowOnly: false };
      const expected = dialect === "bash" ? evaluateShellSubject(subject, rules) : evaluatePowerShellSubject(subject, rules);
      const parsed = dialect === "bash" ? { parsed: parseShellFloorCommand(command) }
        : { parsedPowerShell: parsePowerShellCommand(command) };
      const input = { command, dialect, cwd, ruleScopes: [[], rules, []] };
      expect(shellDenyOnBoundedPrefix(input).pattern).toBe(expected.decision === "deny" ? expected.pattern : undefined);
      expect(shellDenyOnBoundedPrefix({ ...input, ...parsed })).toEqual(shellDenyOnBoundedPrefix(input));
    }
  });

  it("asks when the deny target occurs after the bound", async () => {
    expect((await savedDeny())(`date; ${overBudgetTail}; ${first}`))
      .toMatchObject({ decision: "ask", forceModal: true, reasonCode: "shell-analysis-limit" });
  });

  it("keeps the outer parse cap even when the first statement would be denied", async () => {
    expect((await savedDeny())(`${first}; ${longTail.repeat(10)}`)).toMatchObject(
      dialect === "powershell"
        ? { decision: "deny", reasonCode: "shell-analysis-limit" }
        : { decision: "ask", forceModal: true, reasonCode: "shell-analysis-limit" },
    );
  });
});
