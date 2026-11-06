import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { saveApprovalCardRule } from "../approval-rule-save.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { isPowerShellStartupPinned } from "../../shared/powershell-startup-policy.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { buildShellRuleApproval, shellRuleCoversCommand } from "../rules/shell-rule-approval.js";
import { PermissionManager } from "../permission-manager.js";
import { decidePermission } from "../decision-pipeline.js";
import { buildHostShellExecutionPlan as buildPlan, type HostShellExecutionPlan } from "../host-shell-execution-plan.js";
import { recordIssuedHostShellExecutionPlan } from "../host-shell-execution-plan-issuance.js";
import { inspectPowerShellCommand, inspectPowerShellPermissionPaths } from "../rules/powershell-exfiltration.js";
import { powerShellMxcCommandLine } from "../mxc-windows.js";

// Plans as the host provider issues them; startup proof trusts only issued plans.
function buildHostShellExecutionPlan(input: Parameters<typeof buildPlan>[0]): HostShellExecutionPlan {
  const plan = buildPlan(input);
  recordIssuedHostShellExecutionPlan(plan, "fixture");
  return plan;
}
const CAPABILITY = { kind: "asrt", confidence: "verified", platform: "win32", reason: "fixture",
  confines: { filesystem: true, process: true, network: true } } as const;
const MXC_PLAN = buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true,
  shellSubstrate: "mxc", activeCapability: CAPABILITY });
const WRITES = ["Set-Content -Path x.txt -Value y", "mkdir d", "New-Item -ItemType Directory -Path d"];
const originalPlatform = process.platform;
let root: string;
let project: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "powershell-mxc-startup-")));
  project = join(root, "project");
  mkdirSync(project);
  vi.stubEnv("AVE_HOME", join(project, "profile"));
});
afterEach(async () => { setProcessPlatform(originalPlatform); vi.unstubAllEnvs(); await cleanupTmpDir(root); });

function check(command: string, plan?: HostShellExecutionPlan) {
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("default");
  return manager.checkDetailed("powershell", "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect: "powershell", command, cwd: project },
    hostShellExecutionPlan: plan,
    shellExecution: { runsSandboxed: plan?.sandboxed ?? true, environmentSnapshot: {} },
  });
}

describe("confined native shell startup decisions", () => {
  it("pins the container command argv before its encoded payload", () => {
    const command = "Set-Content -Path x.txt -Value '-NoProfile'";
    const line = powerShellMxcCommandLine("C:\\Windows", command);
    const argv = line.match(/^"([^"]+)" (.*)$/)!;
    expect(argv[1]).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    const args = argv[2]!.split(" ");
    expect(args.slice(0, -2)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned"]);
    expect(args.at(-2)).toBe("-EncodedCommand");
    expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).toBe(command);
  });

  it.each(WRITES)("auto-approves an in-project write on the pinned route: %s", command => {
    const result = check(command, MXC_PLAN);
    expect(result).toMatchObject({ decision: "allow", reasonCode: "sandboxed-shell" });
    expect(decidePermission(result.pipelineRequest!).outcome).toBe("sandbox-auto");
    expect(isPowerShellStartupPinned("win32", MXC_PLAN)).toBe(true);
    expect(inspectPowerShellCommand(command, project, undefined, MXC_PLAN).outcome).toBe("static-complete");
    expect(inspectPowerShellPermissionPaths(command, project).unproven).toBe(false);
    expect(result.pipelineRequest?.shell).toMatchObject({ sandboxed: true, unproven: false, destructive: false });
    expect(result.pipelineRequest?.floor).toBeUndefined();
  });

  it.each([
    ["host", buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, executionMode: "host", shellSubstrate: "mxc", activeCapability: CAPABILITY })],
    ["sandbox off", buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: false, shellSubstrate: "mxc", activeCapability: CAPABILITY })],
    ["partial sandbox", buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: { ...CAPABILITY, confines: { filesystem: false, process: false, network: true } } })],
    ["other substrate", buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, shellSubstrate: "asrt", activeCapability: CAPABILITY })],
    ["unknown", undefined],
    ["unissued lookalike", { ...MXC_PLAN }],
  ] as const)("keeps writes unproven on the %s route", (_name, plan) => {
    expect(isPowerShellStartupPinned("win32", plan)).toBe(false);
    for (const command of WRITES) {
      expect(check(command, plan)).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
      expect(inspectPowerShellCommand(command, project, undefined, plan).outcome).toBe("unproven");
    }
  });

  it.each([
    "Set-Content -Path ../outside.txt -Value y", String.raw`Set-Content -Path ..\outside.txt -Value y`, "Remove-Item -Recurse child",
    "Set-Content -Path x.txt -Value y; & $x", "& $x",
    "Set-Content -Path .git/config -Value y", "New-Item -ItemType SymbolicLink -Path d",
    "New-Item -ItemType Directory -Path ../outside", "New-Item -ItemType Directory -Path .git/config",
    "New-Item -ItemType Directory -Path d -Name ../outside",
  ])("retains approval for external, destructive, opaque or protected actions: %s", command => {
    expect(check(command, MXC_PLAN).decision).toBe("ask");
  });

  it("retains approval for application control writes", () => {
    const target = join(project, "profile", "permissions.json").replaceAll("'", "''");
    const result = check(`Set-Content -Path '${target}' -Value y`, MXC_PLAN);
    expect(result.decision).toBe("ask");
    expect(result.pipelineRequest?.floor?.code).toBe("protected-path");
  });
});

const PROVIDER_TARGETS = [String.raw`HKCU:\Software\Foo`, String.raw`HKLM:\Software\Foo`,
  String.raw`Cert:\CurrentUser\My\fixture`, String.raw`WSMan:\localhost\Client`, String.raw`Registry::HKEY_CURRENT_USER\Software\Foo`,
  "Env:fixture", "Function:fixture", "Variable:fixture",
  String.raw`Microsoft.PowerShell.Core\Registry::HKEY_CURRENT_USER\Software\Foo`, String.raw`Microsoft.PowerShell.Security\Certificate::CurrentUser\My\ABC`,
  String.raw`Microsoft.PowerShell.Core\Variable::x`, String.raw`Microsoft.PowerShell.Core\Environment::GITHUB_TOKEN`, String.raw`C:fixture`];
describe("provider targets stay outside filesystem authority", () => {
  it.each(["win32", "darwin"] as const)("asks for provider writes on %s", platform => {
    setProcessPlatform(platform);
    for (const target of PROVIDER_TARGETS) for (const command of [
      `Remove-Item -Path ${target}`, `Move-Item ${target} ${target}Destination`,
      `New-Item -ItemType Directory -Path ${target}`, `Set-Content -Path ${target} -Value y`,
      `Set-ItemProperty -Path ${target} -Name fixture -Value y`, `Get-Content -Path ${target}`,
    ]) {
      const result = check(command, MXC_PLAN);
      expect(result, command).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
      expect(result.pipelineRequest?.floor, command).toBeUndefined();
      expect(decidePermission(result.pipelineRequest!).outcome, command).toBe("ask");
      expect(result.pipelineRequest?.shell?.unproven, command).toBe(true);
      expect(inspectPowerShellPermissionPaths(command, project).unproven, command).toBe(true);
    }
  });
});

describe("pinned reusable exact authority", () => {
  it("offers, validates and replays the full-text literal-evaluation rule only on the pinned route", () => {
    setProcessPlatform("win32");
    const command = "Invoke-Expression 'Get-Date'";
    const pattern = `PowerShell(${command})`;
    const card = buildShellRuleApproval("powershell", command, project, { allow: true, deny: true }, "fixture", undefined, MXC_PLAN);
    expect(card).toMatchObject({ exactRule: pattern, persistentAllowed: true, sessionAllowed: true });
    expect(shellRuleCoversCommand("powershell", pattern, "allow", command, project, undefined, MXC_PLAN)).toBe(true);
    const manager = new PermissionManager(join(root, "saved-permissions.json"));
    manager.setMode("default");
    manager.setRules([withCurrentShellRuleVersion({ pattern, action: "allow" })]);
    const run = (plan?: HostShellExecutionPlan) => manager.checkDetailed("powershell", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "powershell", command, cwd: project },
      hostShellExecutionPlan: plan, shellExecution: { runsSandboxed: true, environmentSnapshot: {} },
    });
    expect(run(MXC_PLAN)).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    expect(run()).toMatchObject({ decision: "ask" });
    expect(buildShellRuleApproval("powershell", command, project, { allow: true, deny: true }).exactRule).toBeNull();
    manager.setRules([withCurrentShellRuleVersion({ pattern: "PowerShell(Invoke-Expression *)", action: "allow" })]);
    expect(run(MXC_PLAN).decision).toBe("ask");
  });
});

it("keeps the plan host-only through the card and saved-rule validation", async () => {
  setProcessPlatform("win32");
  const command = "Invoke-Expression 'Get-Date'";
  const wc = { isDestroyed: () => false, send: vi.fn<(channel: string, payload: unknown) => void>() };
  const gate = new ApprovalGate(wc as never);
  const controller = new AbortController();
  const pending = gate.requestAndWait({
    id: "pinned-rule", category: "tool", toolName: "powershell", toolCategory: "shell", source: "builtin",
    args: { command }, reason: "Shell approval", createdAt: Date.now(), sessionId: "pinned-session",
    hostShellExecutionPlan: MXC_PLAN, abortSignal: controller.signal,
    evaluationContext: buildPermissionEvaluationContext({ policyMode: "default", headless: false,
      source: "builtin", category: "shell", trustOrigin: "llm-tool-arg", executionCwd: project,
      allowedDirectories: [project], pathFields: [], targetFilePaths: [], sensitivePathsAdjacent: [] }),
  });
  try {
    const sent = wc.send.mock.calls.find(call => call[0] === "ave:approval:request")?.[1] as ApprovalRequest;
    expect(sent.shellRule?.exactRule).toBe(`PowerShell(${command})`);
    expect(sent).not.toHaveProperty("hostShellExecutionPlan");
    const snapshot = gate.getRequestSnapshot("pinned-rule")!;
    expect(snapshot.hostShellExecutionPlan).toBe(MXC_PLAN);
    const manager = new PermissionManager(join(root, "card-permissions.json"));
    expect(await saveApprovalCardRule(snapshot, { action: "allow", scope: "session" }, {
      decision: "allow", scope: "session", displayedVerdictAtApproval: snapshot.verdictAtApproval,
    }, manager)).toMatchObject({ ok: true, pattern: `PowerShell(${command})` });
    expect(manager.checkDetailed("powershell", "builtin", "shell", null, {
      sessionId: "pinned-session", ruleSubject: { kind: "shell", dialect: "powershell", command, cwd: project },
      hostShellExecutionPlan: MXC_PLAN, shellExecution: { runsSandboxed: true },
    })).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
  } finally { controller.abort(); gate.disposeAll(); await pending; }
});
