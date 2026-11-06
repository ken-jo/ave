import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { isPowerShellStartupPinned } from "../../shared/powershell-startup-policy.js";
import { PermissionManager } from "../permission-manager.js";
import { decidePermission } from "../decision-pipeline.js";
import { buildHostShellExecutionPlan, type HostShellExecutionPlan } from "../host-shell-execution-plan.js";
import { inspectPowerShellCommand, inspectPowerShellPermissionPaths } from "../rules/powershell-exfiltration.js";
import { powerShellMxcCommandLine } from "../mxc-windows.js";

const CAPABILITY = { kind: "asrt", confidence: "verified", platform: "win32", reason: "fixture",
  confines: { filesystem: true, process: true, network: true } } as const;
const MXC_PLAN = buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true,
  shellSubstrate: "mxc", activeCapability: CAPABILITY });
const WRITES = ["Set-Content -Path x.txt -Value y", "mkdir d", "New-Item -ItemType Directory -Path d"];
let root: string;
let project: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "powershell-mxc-startup-")));
  project = join(root, "project");
  mkdirSync(project);
  vi.stubEnv("AVE_HOME", join(project, "profile"));
});
afterEach(async () => { vi.unstubAllEnvs(); await cleanupTmpDir(root); });

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
  ] as const)("keeps writes unproven on the %s route", (_name, plan) => {
    expect(isPowerShellStartupPinned("win32", plan)).toBe(false);
    for (const command of WRITES) {
      expect(check(command, plan)).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
      expect(inspectPowerShellCommand(command, project, undefined, plan).outcome).toBe("unproven");
    }
  });

  it.each([
    "Set-Content -Path ../outside.txt -Value y", "Remove-Item -Recurse child",
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
