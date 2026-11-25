import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { ExecutionMode } from "../../shared/permission-mode.js";
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
])("$dialect saved deny rules", ({ dialect, pattern, first, long }) => {
  const overBudgetTail = `date${" x".repeat(450)}`;
  const longTail = Array.from({ length: 1800 }, () => "date x").join("; ");
  const pastLimit = { decision: "deny", reasonCode: "shell-analysis-limit" };
  const limitCard = { decision: "ask", forceModal: true, reasonCode: "shell-analysis-limit", pipelineRequest: { shellAnalysisLimited: true } };
  async function evaluate({ saveDeny = true, generic = false, executionMode = "allow" }: {
    saveDeny?: boolean;
    generic?: boolean;
    executionMode?: ExecutionMode;
  } = {}) {
    const manager = new PermissionManager(join(cwd, "permissions.json"));
    manager.setMode(executionMode);
    if (generic) manager.setRules([{ pattern: dialect, action: "deny" }]);
    if (saveDeny) await manager.addRulePersist({ pattern, action: "deny" }, { kind: "user" });
    return (command: string, headless = false) => manager.checkDetailed(dialect, "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect, command, cwd },
      shellExecution: { runsSandboxed: true },
      headless,
    });
  }

  it.each([overBudgetTail, longTail].map((tail, index) => ({ tail, limit: index === 0 ? "token" : "input" })))(
    "checks a saved deny before approval at the $limit limit", async ({ tail }) => {
      expect((await evaluate())(`${first}; ${tail}`)).toMatchObject(
        dialect === "bash" ? { decision: "deny", reasonCode: "rule-deny" } : pastLimit,
      );
    },
  );

  if (dialect === "powershell") {
    const tokenFiller = " x".repeat(450);
    const inputFiller = ` ${"x".repeat(8000)}`;
    it.each([
      { shape: "an escaped brace at the token limit before a later command", command: '${a`};b' + tokenFiller + '}; Write-Output s' },
      { shape: "a quote inside a braced expansion at the token limit before a later command", command: '"${a";b' + tokenFiller + '}"; Write-Output s' },
      { shape: "a quote inside a braced expansion at the input limit before a pipeline stage", command: '"${a";b' + inputFiller + '}" | Write-Output s' },
      { shape: "an escaped brace at the input limit inside an argument", command: 'date ${a`};b' + inputFiller + '}' },
      { shape: "a quote inside a braced expansion at the input limit inside an argument", command: 'date "${a";b' + inputFiller + '}"' },
    ])("refuses $shape with a saved deny", async ({ command }) => {
      const withDeny = await evaluate({ executionMode: "default" });
      expect(withDeny(command)).toMatchObject(pastLimit);
    });

    it.each(["strict", "default", "auto", "allow"] as const)("asks in %s mode at either limit without a saved deny", async (executionMode) => {
      const withoutDeny = await evaluate({ saveDeny: false, executionMode });
      expect(withoutDeny('${a`};b' + tokenFiller + '}; Write-Output s')).toMatchObject(limitCard);
      expect(withoutDeny('"${a";b' + inputFiller + '}" | Write-Output s')).toMatchObject(limitCard);
    });

    describe.each([
      { shape: "an escaped brace in a variable name", command: '${a`};b}; Write-Output s' },
      { shape: "a quote in a braced expansion", command: '"${a";b}"; Write-Output s' },
    ])("unreadable command with $shape", ({ command }) => {
      it.each(["strict", "default", "auto", "allow"] as const)("refuses in %s mode with a saved deny", async (executionMode) => {
        const withDeny = await evaluate({ executionMode });
        const result = withDeny(command);
        expect(result).toMatchObject(pastLimit);
        expect(result.pipelineRequest?.rules).not.toHaveProperty("ask");
      });

      it("keeps the ordinary allow-mode decision without a saved deny", async () => {
        const withoutDeny = await evaluate({ saveDeny: false });
        expect(withoutDeny(command)).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
      });
    });

    it.each([" |\n  ", "\n  | ", " ||\n  "])("refuses an over-budget first statement across %j", async (separator) => {
      const check = await evaluate();
      expect(check(`date${separator}${overBudgetTail}`)).toMatchObject(pastLimit);
      expect(check(`date; date${separator}${overBudgetTail}`)).toMatchObject(pastLimit);
    });

    it.each([
      { tail: overBudgetTail, limit: "token" },
      { tail: `date ${"x".repeat(8000)}`, limit: "input" },
    ])("refuses at the $limit limit even with a completed statement", async ({ tail }) => {
      const check = await evaluate();
      expect(check(`${first}; ${tail} # it’s a comment`)).toMatchObject(pastLimit);
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
    ])("refuses an over-limit command with a typographic quote in the $position", async ({ command }) => {
      expect((await evaluate())(command)).toMatchObject(pastLimit);
    });

    it("refuses at the input limit with a typographic quote after a completed statement", async () => {
      expect((await evaluate())(`${first}; date ‘${"x".repeat(8000)}`)).toMatchObject(pastLimit);
    });
  }

  it("preserves the merge-base refusal when the first statement exhausts the token budget", async () => {
    const check = await evaluate();
    expect(check(first)).toMatchObject({ decision: "deny", reasonCode: "rule-deny", reason: pattern });
    for (const headless of [false, true]) {
      expect(check(long, headless)).toMatchObject({ decision: "deny", reasonCode: "shell-analysis-limit" });
    }
  });

  it("takes a generic deny before the exhausted dialect deny check", async () => {
    expect((await evaluate({ generic: true }))(long)).toMatchObject({ decision: "deny", reasonCode: "rule-deny", reason: dialect });
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

  it("applies the dialect's limit policy when the deny target occurs after the bound", async () => {
    expect((await evaluate())(`date; ${overBudgetTail}; ${first}`))
      .toMatchObject(dialect === "bash" ? limitCard : pastLimit);
  });

  it("keeps the outer parse cap even when the first statement would be denied", async () => {
    expect((await evaluate())(`${first}; ${longTail.repeat(10)}`)).toMatchObject(
      dialect === "powershell"
        ? { decision: "deny", reasonCode: "shell-analysis-limit" }
        : { decision: "ask", forceModal: true, reasonCode: "shell-analysis-limit" },
    );
  });
});
