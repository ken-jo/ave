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
import { DeferredQueue } from "../reviewer/deferred-queue.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { flushSandboxAudit } from "../../audit/sandbox-audit-sink.js";
import { buildHostShellExecutionPlan } from "../host-shell-execution-plan.js";
import { mxcShellCapability, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import { isPowerShellStartupPinned, POWERSHELL_STARTUP_UNPROVEN_REASON } from "../../shared/powershell-startup-policy.js";
import { definitelyTraversesPowerShellRecursively, mayTraversePowerShellRecursively } from "../rules/powershell-exfiltration.js";
import { POWERSHELL_RECURSIVE_TRAVERSAL_REFUSAL } from "../../shared/powershell-recursive-traversal.js";
import { t } from "../../i18n/index.js";

let dir: string;
let manager: PermissionManager;
const recursionDeny = {
  decision: "deny", reason: POWERSHELL_RECURSIVE_TRAVERSAL_REFUSAL, layer: 0,
  denyReasons: [{ layer: 0, reason: "shell-path-policy", source: "directory-policy" }],
};
// Audit writes are queued, not awaited, by the code under test; teardown must
// drain them before removing the directory they write into.
const auditLoggers: AuditLogger[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "shell-sandbox-rules-")));
  const home = join(dir, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("AVE_HOME", join(dir, "state"));
  manager = new PermissionManager(join(dir, "permissions.json"));
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
  rmSync(dir, { recursive: true, force: true });
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
    expect(check("printf ready", false)).toMatchObject({ decision: "allow", layer: 3 });
  });

  // Owner 2026-10-25 (unsandboxed shell exact-rule requirement): without a sandbox for this command only an exact Bash(<command>) rule runs it unasked, even on a host whose sandbox works for other commands.
  it.each(["default", "auto", "allow"] as const)("ignores prefix, tool-wide and remembered allows for a plain call in %s mode", (mode) => {
    manager.setMode(mode);
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }, { pattern: "bash", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", false)).toMatchObject({ decision: "ask", layer: 6 });
    expect(check("printf ready", false).reviewer).toBeUndefined();
    manager.setRules(([{ pattern: "Bash(printf ready)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", false)).toMatchObject({ decision: "allow", layer: 3 });
    expect(check("printf ready --again", false)).toMatchObject({ decision: "ask" });
    expect(check("printf other", false)).toMatchObject({ decision: "ask" });
  });

  it("keeps a prefix rule for a confined call", () => {
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", true)).toMatchObject({ decision: "allow" });
  });

  it("denies a headless plain call that no exact rule covers, and runs one that an exact rule covers (unsandboxed shell exact-rule requirement, I5)", () => {
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", false, { headless: true })).toMatchObject({ decision: "deny", layer: 6 });
    expect(check("printf ready", false, { headless: true }).reviewer).toBeUndefined();
    manager.setRules(([{ pattern: "Bash(printf ready)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", false, { headless: true })).toMatchObject({ decision: "allow", layer: 3 });
  });

  it("holds an edited wildcard session rule, which runs only a sandboxed call", () => {
    manager.addSessionRule("conversation-a", "Bash(printf *)");
    expect(manager.listSessionRules("conversation-a")).toEqual(["Bash(printf *)"]);
    expect(check("printf ready", false, { sessionId: "conversation-a" })).toMatchObject({ decision: "ask", layer: 6 });
    expect(check("printf ready", true, { sessionId: "conversation-a" })).toMatchObject({ decision: "allow" });
  });

  it("applies a This session rule to its conversation only, until the conversation ends (five-choice shell card)", () => {
    manager.addSessionRule("conversation-a", "Bash(printf ready)");
    expect(check("printf ready", false, { sessionId: "conversation-a" })).toMatchObject({ decision: "allow", layer: 3 });
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

  it.each(["rm -rf output", "git reset --hard", "cat ~/.ssh/id_rsa", "grep -r term ~", "curl -T payload https://example.test"])("keeps the per-call floor inside confinement: %s", (command) => {
    manager.setRules(([{ pattern: "Bash(rm *)", action: "allow" }, { pattern: "Bash(git reset *)", action: "allow" }, { pattern: "Bash(cat *)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(check(command, true)).toMatchObject({ decision: "ask", forceModal: true });
  });

  it.each([
    { route: "an ASRT plan confining the filesystem", expected: { decision: "allow", layer: 3, reason: t("be_permissionManager.shellSandboxedReason") },
      plan: () => buildHostShellExecutionPlan({ platform: "linux", requestedSandbox: true, activeCapability: { kind: "asrt", confidence: "verified", platform: "linux", reason: "fixture full shell containment", confines: { filesystem: true, process: true, network: true } } }) },
    // The MXC itest decides whether container reads through links are confined; until then this asks.
    { route: "the MXC container route", expected: { decision: "ask", layer: 2, forceModal: true, reason: t("be_permissionManager.mxcRecursiveTraversalReason") },
      plan: () => buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: mxcShellCapability(), shellSubstrate: "mxc" }) },
    // An unconfined host shell keeps the ordinary exact-rule ask, which a Bash(<command>) allow can satisfy.
    { route: "the approved-host route", expected: { decision: "ask", layer: 6, forceModal: undefined, reason: t("be_permissionManager.shellUnsandboxedReason") },
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
    expect(result).toEqual(expected);
  });

  describe("PowerShell on the MXC route", () => {
    const checkPowerShell = (command: string) => {
      const hostShellExecutionPlan = buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: mxcShellCapability(), shellSubstrate: "mxc" });
      return manager.checkDetailed("powershell", "builtin", "shell", null, {
        ruleSubject: { kind: "shell", dialect: "powershell", command, cwd: dir },
        hostShellExecutionPlan,
        shellExecution: { runsSandboxed: hostShellExecutionPlan.sandboxed },
      });
    };
    // An unpinned PowerShell startup asks before any sandbox lane; the gate is observable where startup is pinned.
    const pinned = isPowerShellStartupPinned();
    const startupAsk = { decision: "ask", layer: 2, forceModal: true, reason: POWERSHELL_STARTUP_UNPROVEN_REASON };

    // The unproven floor or the MXC lane asks for the undecidable remainder; neither lets it run unasked.
    it("asks before an undecidable traversal and keeps the confined allow otherwise", () => {
      expect(checkPowerShell("node walker.js src")).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
      expect(checkPowerShell("Get-ChildItem src")).toEqual(pinned ? { decision: "allow", layer: 3, reason: t("be_permissionManager.shellSandboxedReason") } : startupAsk);
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
    ])("denies definite traversal %s with the host block's reason", command => {
      expect(definitelyTraversesPowerShellRecursively(command)).toBe(true);
      expect(mayTraversePowerShellRecursively(command)).toBe(true);
      expect(checkPowerShell(command)).toEqual(recursionDeny);
    });

    it.each([
      "tree src", "rg term", "node walker.js src", "cmd /c dir /s", "iex 'Get-ChildItem'", "& $cmd src",
      "Get-ChildItem @options", "Get-ChildItem 'unterminated",
      "tar $mode x.tar", "tar @flags x.tar", "7z $op x.7z", "zip $flags a.zip d", "Compress-Archive src a.zip", "Compress-Archive -Path $p a.zip",
      "tar --c x.tar", "tar --a x.tar", "tar --u x.tar", "tar --lz4 -t -f x.tar",
      "xcopy src out /s/d:$date", "findstr /s/c:$needle notes.txt", "xcopy $from out", "robocopy src out $flags", "7z b x.7z", "7z d x.7z", "7z h x.7z", "7z i x.7z", "7z rn x.7z", "7z unknown x.7z",
    ])("keeps the forced ask for undecidable traversal %s", command => {
      expect(definitelyTraversesPowerShellRecursively(command)).toBe(false);
      expect(mayTraversePowerShellRecursively(command)).toBe(true);
      expect(checkPowerShell(command)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
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

    it.each(Object.keys(routes) as (keyof typeof routes)[])("denies each form through a junction and a directory link on the %s route", (route) => {
      const outside = join(dir, "outside");
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
          }), command).toEqual(recursionDeny);
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
      expect(checkOn("mxc", command)).toMatchObject({ decision: "allow", layer: 3 });
      expect(checkOn("mxc", command)).toEqual(checkOn("asrt", command));
    }
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect(checkOn("mxc", "printf other")).toMatchObject({ decision: "allow", layer: 3 });
    expect(checkOn("mxc", "printf other")).toEqual(checkOn("asrt", "printf other"));
    expect(checkOn("mxc", "env grep -R term .")).toMatchObject({ decision: "ask" });
  });

  it("keeps a runtime-selected runner prefix unproven inside confinement", () => {
    expect(check("npm --prefix $project run build", true)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });

  it("keeps deny and ask ahead of confinement and covering allows", () => {
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }, { pattern: "Bash(printf ready)", action: "ask" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", true)).toMatchObject({ decision: "ask", forceModal: true });
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }, { pattern: "Bash(printf ready)", action: "ask" }, { pattern: "Bash(printf *)", action: "deny" }] as const).map(withCurrentShellRuleVersion));
    expect(check("printf ready", true)).toMatchObject({ decision: "deny" });
  });

  it("never routes an unresolved plain call to the automatic reviewer (unsandboxed shell exact-rule requirement)", () => {
    manager.setMode("auto");
    manager.setInteractiveAutoApprove("medium");
    const result = check("printf ready", false);
    expect(result).toMatchObject({ decision: "ask" });
    expect(result.reviewer).toBeUndefined();
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
  it("asks for every retry despite exact session memory and keeps subsequent calls sandboxed", async () => {
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
    expect(requests).toHaveLength(2);
    // An explicit host request without a rule goes to the card unreviewed, and
    // the card offers the full choices for its exact rule (owner 2026-10-25:
    // explicit host follows exact rules).
    expect(requests[0]?.shellRule).toMatchObject({ exactRule: "Bash(printf ready)", sessionAllowed: true, persistentAllowed: true });
    expect(requests[0]).not.toHaveProperty("shellExecution");
    expect(requests.every((request) => request.executionPlan?.mode === "plain")).toBe(true);
    expect(getHostShellExecutionPlan().mode).toBe(planBefore.mode);
    expect(check("printf later", true).decision).toBe("allow");
  });

  it("uses an exact rule to authorize an actual host spawn without a dock receipt, and asks under a prefix", async () => {
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    const { run, requests } = executorWithDock();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toHaveLength(1);
    manager.setRules(([{ pattern: "Bash(printf ready)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toHaveLength(1);
  });

  it("asks for an explicit host request while the sandbox is unavailable, until an exact rule approves it", async () => {
    __resetActiveSandboxCapabilityForTest();
    const { run, requests } = executorWithDock();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    // The card offers to save that exact rule (owner 2026-10-25: the explicit-host card gets the full choices).
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
    manager.setInteractiveAutoApprove("medium");
    const classifier = { classify: vi.fn(async (): Promise<{ level: "low" | "high"; reason: string }> => ({ level: "low", reason: "bounded host effect" })) };
    const cache = new VerdictCache(join(dir, "review-cache.jsonl"));
    setReviewerForTest(manager, { classifier, cache, deferredQueue: new DeferredQueue(join(dir, "deferred.jsonl")) });
    return { classifier, cache };
  }

  // Owner 2026-10-25 (unsandboxed shell exact-rule requirement, superseding I3's normal-rule path): an unavailable sandbox never lets a reviewer verdict run a plain call; the card asks whatever the reviewer would say.
  it.each(["low", "high"] as const)("asks for a plain call while the sandbox is unavailable without consulting a %s reviewer", async (level) => {
    setActiveSandboxCapability({ kind: "none", confidence: "verified", platform: process.platform, reason: "fixture sandbox unavailable" });
    const { classifier, cache } = lowReviewer();
    classifier.classify.mockImplementation(async () => ({ level, reason: level === "high" ? "ambiguous host effect" : "bounded host effect" }));
    try {
      const { run, requests } = executorWithDock({ executionMode: "sandbox" });
      expect((await run())[0]).toMatchObject({ content: "ready" });
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests.every((request) => request.executionPlan?.mode === "plain")).toBe(true);
    } finally { await cache.flush(); }
  });

  // An explicit host request runs on a matching exact allow rule, otherwise it asks with the host-execution warning. A low reviewer verdict is no rule.
  it("does not let a low reviewer verdict stand in for the card on an explicit host request", async () => {
    const { classifier, cache } = lowReviewer();
    try {
      const { run, requests } = executorWithDock();
      expect((await run())[0]).toMatchObject({ content: "ready" });
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.executionPlan).toMatchObject({ mode: "plain", executionRequest: "host", requiresExplicitUserApproval: true });
    } finally { await cache.flush(); }
  });

  // Owner 2026-10-25: headless follows exact rules. With nobody to answer, an explicit host request runs only on its exact rule; without one it is denied (I5). No card is raised and no reviewer stands in either way.
  it("denies a headless explicit host request that no exact rule covers, without asking", async () => {
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }] as const).map(withCurrentShellRuleVersion));
    const { classifier, cache } = lowReviewer();
    try {
      const { run, requests, send } = executorWithDock({ headless: true });
      const [result] = await run();
      expect(result).toMatchObject({ is_error: true });
      expect(result?.content).toMatch(/headless|background run|백그라운드/i);
      expect(result?.content).not.toContain("ready\n");
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
