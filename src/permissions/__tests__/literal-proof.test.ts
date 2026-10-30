import "../../__tests__/support/trusted-powershell.js";
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
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const roots: string[] = [];
// #223 executable-bound startup admission: win32 outer startup has no exact eligibility.
const UNPROVEN_STARTUP = process.platform === "win32";
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
  it.each([
    { platform: "linux", admitted: true },
    { platform: "darwin", admitted: true },
    { platform: "win32", admitted: false },
  ] as const)("keeps exact rules bound to proven outer startup on $platform", ({ platform, admitted }) => {
    const original = process.platform;
    const cwd = projectDirectory();
    try {
      setProcessPlatform(platform);
      // #223 executable-bound startup admission retains direct evaluators only on proven outer hosts.
      for (const [command, pattern] of [
        ["Write-Output ready", "PowerShell(Write-Output ready)"],
        ["Invoke-Expression 'Get-Date'", "PowerShell(Invoke-Expression 'Get-Date')"],
      ] as const) {
        expect(buildShellRuleApproval("powershell", command, cwd, { allow: true, deny: true }).exactRule).toBe(admitted ? pattern : null);
        const manager = new PermissionManager(join(cwd, "permissions.json"));
        manager.setMode("allow");
        manager.setRules([withCurrentShellRuleVersion({ pattern, action: "allow" })]);
        for (const runsSandboxed of [false, true]) {
          const context = { ruleSubject: { kind: "shell" as const, dialect: "powershell" as const, command, cwd }, shellExecution: { runsSandboxed } };
          expect(manager.checkDetailed("powershell", "builtin", "shell", null, context)).toMatchObject(admitted
            ? { decision: "allow" } : { decision: "allow", reasonCode: "allow-mode" });
          expect(manager.checkDetailed("powershell", "builtin", "shell", null, { ...context, headless: true })).toMatchObject(admitted
            ? { decision: "allow" } : { decision: "allow", reasonCode: "allow-mode" });
        }
      }
      const floorCommand = "Get-Content ~/.ssh/id_rsa";
      expect(inspectPowerShellCommand(floorCommand, cwd)).toMatchObject({ outcome: "visible-floor" });
      expect(buildShellRuleApproval("powershell", floorCommand, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    } finally {
      setProcessPlatform(original);
    }
  });

  it.each((["bash", "powershell"] as const).flatMap((dialect) => [
    { dialect, command: "git commit -m 'record fixture changes'", eligible: false },
    { dialect, command: "printf '%s' 'record fixture changes'", eligible: true },
  ]))("preserves quoted literal argv eligibility for $dialect $command", async ({ dialect, command, eligible }) => {
    const cwd = projectDirectory();
    const approval = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true });
    const pattern = `${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`;
    const exactEligible = eligible && !(dialect === "powershell" && UNPROVEN_STARTUP);
    expect(approval.exactRule).toBe(exactEligible ? pattern : null);
    const scopes = new ProjectRuleScopes(join(cwd, "rules"));
    await scopes.addRule(cwd, withCurrentShellRuleVersion({ pattern, action: "allow" }));
    const state = await scopes.reload(cwd);
    expect(state.ok).toBe(true);
    if (!state.ok) throw state.error;
    const result = dialect === "bash"
      ? evaluateShellSubject({ command, cwd, exactAllowOnly: true }, state.rules)
      : evaluatePowerShellSubject({ command, exactAllowOnly: true, floorSignal: null }, state.rules);
    if (exactEligible) expect(result.decision).toBe("allow");
    else expect(result.decision).not.toBe("allow");
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

  it.each(["printf '%s' '$HOME * $(id)'", "printf '%s' 'two  spaces'", "printf '%s' ''"])("proves quoted data: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(true);
  });

  it.each(['git commit -m "two  spaces"', "make build"])("does not certify executable tool operands as quoted data: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(false);
    expect(proveLiteralPowerShell(command).proven).toBe(false);
    for (const dialect of ["bash", "powershell"] as const) expect(buildShellRuleApproval(dialect, command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it("preserves raw quote spelling and quoted whitespace", () => {
    expect(canonicalRuleSpecifier('Bash(git commit -m "two  spaces")')).toBe('Bash(git commit -m "two  spaces")');
    expect(normalizeRuleSpecifierInput(' Bash( git   commit -m "two  spaces" ) ')).toBe('Bash(git commit -m "two  spaces")');
    expect(parseRuleSpecifier("Bash(printf '*')")).toMatchObject({ tokens: ["printf", "'*'"], wildcard: false });
    const command = `git commit -m 'say '"'"'hello'"'"' and "ready" $HOME'`;
    expect(canonicalRuleSpecifier(`Bash(${command})`)).toBe(`Bash(${command})`);
    expect(buildShellRuleApproval("bash", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it.each(["bash", "powershell"] as const)("preserves quoted tabs and newlines in %s rules", (dialect) => {
    for (const whitespace of ["\t", "\n"]) {
      const command = `git commit -m 'first${whitespace}second'`;
      const pattern = `${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`;
      expect(canonicalRuleSpecifier(pattern)).toBe(pattern);
      expect(buildShellRuleApproval(dialect, command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
      const literal = `printf '%s' 'first${whitespace}second'`;
      expect(buildShellRuleApproval(dialect, literal, projectDirectory(), { allow: true, deny: true }).exactRule).toBe(dialect === "powershell" && UNPROVEN_STARTUP
        ? null : `${dialect === "bash" ? "Bash" : "PowerShell"}(${literal})`);
    }
  });

  it.each(["-Force", "–Force", "—Force"])("preserves cmdlet parameter provenance for %s", (parameter) => {
    const pattern = `PowerShell(Get-ChildItem '${parameter}')`;
    expect(canonicalRuleSpecifier(pattern)).toBe(pattern);
    const rule = withCurrentShellRuleVersion({ pattern, action: "allow" as const });
    expect(evaluatePowerShellSubject({ command: `Get-ChildItem '${parameter}'`, exactAllowOnly: true, floorSignal: null }, [rule]).decision).toBe(UNPROVEN_STARTUP ? null : "allow");
    expect(evaluatePowerShellSubject({ command: `Get-ChildItem ${parameter}`, exactAllowOnly: true, floorSignal: null }, [rule]).decision).not.toBe("allow");
    expect(buildShellRuleApproval("powershell", `Get-ChildItem '${parameter}'`, projectDirectory(), { allow: true, deny: true }).exactRule).toBe(UNPROVEN_STARTUP ? null : pattern);
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

  it.each(["python3.12 -I -S -c 'print(1)'", "bash --noprofile --norc -p -c 'printf ready'", "fish --no-config -c 'printf ready'"])("refuses child startup inferred only from literal argv: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(false);
    expect(proveLiteralPowerShell(command).proven).toBe(false);
    const pattern = canonicalRuleSpecifier(`Bash(${command})`);
    expect(evaluateShellSubject({ command, exactAllowOnly: true }, [withCurrentShellRuleVersion({ pattern, action: "allow" }), { pattern: "Bash(unrelated *)", action: "deny" }]).decision).toBeNull();
  });

  it.each(["python3.12 -c 'print(1)'", "sh -c 'printf ready'", "npx node build.mjs", "npm exec -- node -e 'ready'", "deno run build.ts", "ksh93 -c 'printf ready'", "bun exec printf ready", "yarn node script.js", "yarnpkg node script.js", "wsl ls", "env wsl ls", "npx -p node node -e code", "npx --package node node -e code"])("refuses delegation outside the known grammar: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(false);
    expect(proveLiteralPowerShell(command).proven).toBe(false);
    expect(buildShellRuleApproval("bash", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
    expect(buildShellRuleApproval("powershell", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it.each(["bash --noprofile --norc -p build.sh", "python3 -I -S https://example.invalid/code.py"])("refuses literal file and network indirection without executable startup proof: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(false);
    expect(buildShellRuleApproval("bash", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it.each(["xargs -I X env X -c 'printf ready'", "xargs rg --files", "find . -maxdepth 0 -exec sh -c 'printf ready' ';'"])("refuses runtime-completed callback argv: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(false);
    expect(buildShellRuleApproval("bash", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it.each(["git status < input", "git status >/dev/null"])("keeps redirects outside exact argv identity: %s", (command) => {
    expect(proveLiteralShell(command).proven).toBe(false);
    expect(buildShellRuleApproval("bash", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it.each(["Invoke-Expression 'Write-Output ready'", "iex 'Write-Output ready'", "Microsoft.PowerShell.Utility\\Invoke-Expression 'Get-Date'"])("accepts known visible literal invocation code: %s", (command) => {
    expect(proveLiteralPowerShell(command).proven).toBe(true);
    expect(buildShellRuleApproval("powershell", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBe(UNPROVEN_STARTUP ? null : `PowerShell(${command})`);
  });

  it("refuses an invocation outside the known grammar", () => {
    const command = "Start-Job -FilePath ./script.ps1";
    expect(proveLiteralPowerShell(command).proven).toBe(false);
    expect(buildShellRuleApproval("powershell", command, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
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
    expect(proveLiteralShell(`${name} -c 'printf ready'`).proven).toBe(false);
    expect(proveLiteralPowerShell(`${name} -c 'Write-Output ready'`).proven).toBe(false);
  });

  it.each(["pwsh-tool", "powershellish", "bash5", "ksh93", "node22"])("does not treat unknown names as launchers or positive grammar: %s", (name) => {
    expect(isPowerShellLauncher(name)).toBe(false);
    expect(proveLiteralShell(`${name} -c literal`).proven).toBe(false);
    expect(buildShellRuleApproval("bash", `${name} -c literal`, projectDirectory(), { allow: true, deny: true }).exactRule).toBeNull();
  });

  it("keeps a known interpreter distinct from PowerShell launcher detection", () => {
    expect(isPowerShellLauncher("python3.12")).toBe(false);
    expect(proveLiteralShell("python3.12 -I -S -c literal").proven).toBe(false);
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
    expect(inspectPowerShellCommand(command, cwd)).toMatchObject({
      outcome: UNPROVEN_STARTUP ? "unproven" : "static-complete", sensitive: null, exfiltration: null,
    });
    expect(buildShellRuleApproval("powershell", command, cwd, { allow: true, deny: true }).exactRule).toBe(UNPROVEN_STARTUP ? null : pattern);
    expect(shellRuleCoversCommand("powershell", pattern, "allow", command, cwd)).toBe(!UNPROVEN_STARTUP);
    const manager = new PermissionManager(join(cwd, "permissions.json"));
    manager.setMode("allow");
    manager.setRules([withCurrentShellRuleVersion({ pattern, action: "allow" })]);
    const context = { ruleSubject: { kind: "shell" as const, dialect: "powershell" as const, command, cwd }, shellExecution: { runsSandboxed: false } };
    expect(manager.checkDetailed("powershell", "builtin", "shell", null, context)).toMatchObject(UNPROVEN_STARTUP
      ? { decision: "allow", reasonCode: "allow-mode" } : { decision: "allow" });
    expect(manager.checkDetailed("powershell", "builtin", "shell", null, { ...context, headless: true }).decision).toBe("allow");
    expect(manager.checkDetailed("powershell", "builtin", "shell", null, { ...context, shellExecution: { runsSandboxed: true } })).toMatchObject(UNPROVEN_STARTUP
      ? { decision: "allow", reasonCode: "read-only-shell" } : { decision: "allow" });
  });
});
