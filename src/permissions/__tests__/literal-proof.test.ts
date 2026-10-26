import { afterEach, describe, expect, it, vi } from "vitest";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as analysis from "../../shared/shell-analysis.js";
import { PermissionManager } from "../permission-manager.js";
import { ProjectRuleScopes } from "../rules/rule-scopes.js";
import { evaluatePowerShellSubject, evaluateShellSubject } from "../rules/rule-scopes.js";
import { buildShellRuleApproval, shellRuleCoversCommand } from "../rules/shell-rule-approval.js";
import { proveLiteralShell } from "../rules/shell-rule-matcher.js";
import { inspectPowerShellCommand, proveLiteralPowerShell, _recordPowerShellLexesForTest } from "../rules/powershell-exfiltration.js";
import { isPowerShellLauncher, MAX_LITERAL_COMMAND_LENGTH } from "../rules/shell-prefix-values.js";
import { canonicalRuleSpecifier, normalizeRuleSpecifierInput, parseRuleSpecifier } from "../rules/rule-specifier.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "literal-proof-"));
  roots.push(root);
  return root;
}

describe("literal exact-rule proof", () => {
  it.each(["bash", "powershell"] as const)("saves and matches quoted literal argv for %s", async (dialect) => {
    const cwd = projectDirectory();
    const command = "git commit -m 'record fixture changes'";
    const approval = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true });
    const pattern = `${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`;
    expect(approval.exactRule).toBe(pattern);
    const scopes = new ProjectRuleScopes(join(cwd, "rules"));
    await scopes.addRule(cwd, withCurrentShellRuleVersion({ pattern, action: "allow" }));
    const state = await scopes.reload(cwd);
    expect(state.ok).toBe(true);
    if (!state.ok) throw state.error;
    const result = dialect === "bash"
      ? evaluateShellSubject({ command, cwd, exactAllowOnly: true }, state.rules)
      : evaluatePowerShellSubject({ command, exactAllowOnly: true, floorSignal: null }, state.rules);
    expect(result.decision).toBe("allow");
    const different = command.replace("fixture", "different");
    const mismatch = dialect === "bash"
      ? evaluateShellSubject({ command: different, cwd, exactAllowOnly: true }, state.rules)
      : evaluatePowerShellSubject({ command: different, exactAllowOnly: true, floorSignal: null }, state.rules);
    expect(mismatch.decision).not.toBe("allow");
  });

  it.each([
    ["bash", 'printf "%s" "$HOME"'], ["bash", 'printf "%s" "$(id)"'],
    ["bash", "printf a\\ b"], ["bash", 'printf "a\\ b"'], ["bash", "printf *"],
    ["bash", "for x in $HOME/*; do printf ready; done"],
    ["powershell", 'Write-Output "$HOME"'], ["powershell", 'Write-Output "$(whoami)"'],
    ["powershell", "Write-Output a` b"], ["powershell", 'Write-Output "a`nb"'],
    ["powershell", "'git' status"],
  ] as const)("keeps expansions unproven: %s %s", (dialect, command) => {
    const proof = dialect === "bash" ? proveLiteralShell(command) : proveLiteralPowerShell(command);
    expect(proof.proven).toBe(false);
    expect(buildShellRuleApproval(dialect, command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it.each(["printf '%s' '$HOME * $(id)'", 'git commit -m "two  spaces"', "printf '%s' ''"])("proves quoted data: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(true);
  });

  it("preserves raw quote spelling and quoted whitespace", () => {
    expect(canonicalRuleSpecifier('Bash(git commit -m "two  spaces")')).toBe('Bash(git commit -m "two  spaces")');
    expect(normalizeRuleSpecifierInput(' Bash( git   commit -m "two  spaces" ) ')).toBe('Bash(git commit -m "two  spaces")');
    expect(parseRuleSpecifier("Bash(printf '*')")).toMatchObject({ tokens: ["printf", "'*'"], wildcard: false });
    const command = `git commit -m 'say '"'"'hello'"'"' and "ready" $HOME'`;
    expect(buildShellRuleApproval("bash", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBe(`Bash(${command})`);
  });

  it.each(["bash", "powershell"] as const)("preserves quoted tabs and newlines in %s rules", (dialect) => {
    for (const whitespace of ["\t", "\n"]) {
      const command = `git commit -m 'first${whitespace}second'`;
      const pattern = `${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`;
      expect(canonicalRuleSpecifier(pattern)).toBe(pattern);
      expect(buildShellRuleApproval(dialect, command, projectDirectory(), { allow: true, deny: true }).exactRule).toBe(pattern);
    }
  });

  it.each(["-Force", "–Force", "—Force"])("preserves cmdlet parameter provenance for %s", (parameter) => {
    const pattern = canonicalRuleSpecifier(`PowerShell(Get-ChildItem '${parameter}')`);
    expect(pattern).toBe(`PowerShell(Get-ChildItem '${parameter}')`);
    const rule = withCurrentShellRuleVersion({ pattern, action: "allow" as const });
    expect(evaluatePowerShellSubject({ command: `Get-ChildItem '${parameter}'`, exactAllowOnly: true, floorSignal: null }, [rule]).decision).toBe("allow");
    expect(evaluatePowerShellSubject({ command: `Get-ChildItem ${parameter}`, exactAllowOnly: true, floorSignal: null }, [rule]).decision).not.toBe("allow");
    expect(buildShellRuleApproval("powershell", `Get-ChildItem '${parameter}'`, projectDirectory(), { allow: true, deny: true }).exactRule).toBe(pattern);
  });

  it("preserves deny alias normalization with quoted parameters", () => {
    const pattern = canonicalRuleSpecifier("PowerShell(Write-Output '-Path')");
    expect(evaluatePowerShellSubject({ command: "write '-Path'", exactAllowOnly: true, floorSignal: null }, [{ pattern, action: "deny" }]).decision).toBe("deny");
  });

  it.each(["(git status)", "for x in a b; do git status; done"])("does not offer a single argv rule for compound syntax: %s", (command) => {
    expect(buildShellRuleApproval("bash", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it("preserves literal data that resembles another dialect", () => {
    expect(proveLiteralPowerShell("Write-Output '%PATH% $HOME *'").proven).toBe(true);
    expect(proveLiteralPowerShell("printf %s –enc 'not-base64!'").proven).toBe(true);
  });

  it.each(["python3.12 -c 'print(1)'", "ksh93 -c 'printf ready'", "sh -c 'printf ready'", "npx node build.mjs", "npm exec -- node -e 'ready'", "bun exec printf ready", "deno run build.ts", "yarn node script.js", "yarnpkg node script.js", "wsl ls", "env wsl ls", "npx -p node node -e code", "npx --package node node -e code"])("proves visible literal code and delegation: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(true);
    expect(proveLiteralPowerShell(command).proven).toBe(true);
    const pattern = canonicalRuleSpecifier(`Bash(${command})`);
    expect(evaluateShellSubject({ command, exactAllowOnly: true }, [withCurrentShellRuleVersion({ pattern, action: "allow" }), { pattern: "Bash(unrelated *)", action: "deny" }]).decision).toBe("allow");
  });

  it.each(["make build", "sh build.sh", "python3 https://example.invalid/code.py"])("accepts literal file and network indirection: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(true);
    expect(buildShellRuleApproval("bash", command, projectDirectory(), { allow: true, deny: true }).exactRule).not.toBeNull();
  });

  it.each(["xargs -I X env X -c 'printf ready'", "xargs rg --files", "find . -maxdepth 0 -exec sh -c 'printf ready' ';'"])("refuses runtime-completed callback argv: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(false);
    expect(buildShellRuleApproval("bash", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it.each(["git status < input", "git status >/dev/null"])("keeps redirects outside exact argv identity: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(false);
    expect(buildShellRuleApproval("bash", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it.each(["Invoke-Expression 'Write-Output ready'", "iex 'Write-Output ready'", "Microsoft.PowerShell.Utility\\Invoke-Expression 'Get-Date'", "Start-Job -FilePath ./script.ps1"])("accepts visible literal invocation code: %s", (command) => {
    expect(proveLiteralPowerShell(command).proven).toBe(true);
    expect(buildShellRuleApproval("powershell", command, projectDirectory(), { allow: true, deny: true }).exactRule).not.toBeNull();
  });

  it("conservatively refuses encoded arguments after a launcher word", () => {
    const command = "Start-Process pwsh -ArgumentList '-enc literal'";
    expect(proveLiteralPowerShell(command).proven).toBe(false);
    expect(buildShellRuleApproval("powershell", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it.each(["pwsh", "powershell", "pwsh-preview", "powershell_ise"])("excludes encoded execution for every exact launcher: %s", (name) => {
    for (const launcher of [name, `${name}.exe`, `C:\\tools\\${name.toUpperCase()}.EXE`, `Module\\${name}`]) {
      expect(isPowerShellLauncher(launcher)).toBe(true);
      expect(proveLiteralPowerShell(`${launcher} -enc literal`).proven).toBe(false);
    }
    expect(proveLiteralShell(`${name} -c 'printf ready'`).proven).toBe(true);
    expect(proveLiteralPowerShell(`${name} -c 'Write-Output ready'`).proven).toBe(true);
  });

  it.each(["pwsh-tool", "powershellish", "bash5", "ksh93", "python3.12", "node22"])("does not infer encoded launcher identities: %s", (name) => {
    expect(isPowerShellLauncher(name)).toBe(false);
    expect(proveLiteralShell(`${name} -c literal`).proven).toBe(true);
  });

  it("rejects excessive input before either dialect parser", () => {
    const command = `printf ${"x".repeat(MAX_LITERAL_COMMAND_LENGTH)}`;
    const parse = vi.spyOn(analysis, "analyzeShell");
    const lex = _recordPowerShellLexesForTest();
    try {
      expect(proveLiteralShell(command).proven).toBe(false);
      expect(proveLiteralPowerShell(command).proven).toBe(false);
      expect(parse).not.toHaveBeenCalled();
      expect(lex.lexed).toEqual([]);
    } finally { lex.stop(); }
  });

  it("keeps ordinary literal PowerShell arguments within actual path work", () => {
    const cwd = projectDirectory();
    const command = `printf ${Array<string>(20).fill("a").join(" ")}`;
    const pattern = `PowerShell(${command})`;
    expect(proveLiteralPowerShell(command).proven).toBe(true);
    expect(inspectPowerShellCommand(command, cwd)).toEqual({
      outcome: "static-complete", sensitive: null, exfiltration: null,
    });
    expect(buildShellRuleApproval("powershell", command, cwd, { allow: true, deny: true }).exactRule).toBe(pattern);
    expect(shellRuleCoversCommand("powershell", pattern, "allow", command, cwd)).toBe(true);
    const manager = new PermissionManager(join(cwd, "permissions.json"));
    manager.setMode("allow");
    manager.setRules([withCurrentShellRuleVersion({ pattern, action: "allow" })]);
    const context = { ruleSubject: { kind: "shell" as const, dialect: "powershell" as const, command, cwd }, shellExecution: { runsSandboxed: false } };
    expect(manager.checkDetailed("powershell", "builtin", "shell", null, context).decision).toBe("allow");
    expect(manager.checkDetailed("powershell", "builtin", "shell", null, { ...context, headless: true }).decision).toBe("allow");
    expect(manager.checkDetailed("powershell", "builtin", "shell", null, { ...context, shellExecution: { runsSandboxed: true } })).toMatchObject({ decision: "allow", layer: 3 });
  });
});
