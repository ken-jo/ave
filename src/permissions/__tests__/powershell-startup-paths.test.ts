vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTrustedPowerShellExecutable, type TrustedPowerShellExecutable } from "../../shared/powershell-executable.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { checkShellPermission } from "../../__tests__/support/permission-lane.js";
import { PermissionManager } from "../permission-manager.js";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";

vi.mock("../../shared/powershell-executable.js", () => ({ resolveTrustedPowerShellExecutable: vi.fn() }));

const POSIX_INSTALLATION = { executable: "/opt/microsoft/powershell/7/pwsh", kind: "pwsh" } as const;
const SYSTEM_INSTALLATION = { executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", kind: "windows-powershell" } as const;
const MODERN_INSTALLATION = { executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", kind: "pwsh" } as const;
const STARTUP_PATH_CASES: readonly {
  platform: NodeJS.Platform; installation: TrustedPowerShellExecutable | null; command: string;
  outcome: "static-complete" | "unproven"; exact: boolean;
}[] = [
  { platform: "linux", installation: null, command: "Get-Date", outcome: "unproven", exact: false },
  { platform: "darwin", installation: null, command: "Invoke-Expression 'Get-Date'", outcome: "unproven", exact: false },
  { platform: "linux", installation: POSIX_INSTALLATION, command: "Get-Date", outcome: "static-complete", exact: true },
  { platform: "win32", installation: null, command: "Get-Date", outcome: "unproven", exact: false },
  { platform: "win32", installation: MODERN_INSTALLATION, command: "Get-Date", outcome: "unproven", exact: false },
  { platform: "win32", installation: MODERN_INSTALLATION, command: "Invoke-Expression 'Get-Date'", outcome: "unproven", exact: false },
  { platform: "win32", installation: SYSTEM_INSTALLATION, command: "Get-Date", outcome: "unproven", exact: false },
  { platform: "win32", installation: SYSTEM_INSTALLATION, command: "Invoke-Expression 'Get-Date'", outcome: "unproven", exact: false },
];
let cwd: string;
let manager: PermissionManager;
const originalPlatform = process.platform;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "startup-paths-")));
  vi.stubEnv("AVE_HOME", cwd);
  __resetSessionStoreForTest();
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
});
afterEach(() => {
  setProcessPlatform(originalPlatform);
  __resetSessionStoreForTest();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

describe("startup authority follows the selected protected installation", () => {
  it.each(STARTUP_PATH_CASES)("$platform $command ($installation)", ({ platform, installation, command, outcome, exact }) => {
    setProcessPlatform(platform);
    vi.mocked(resolveTrustedPowerShellExecutable).mockReturnValue(installation);
    expect(inspectPowerShellCommand(command, cwd).outcome).toBe(outcome);
    expect(buildShellRuleApproval("powershell", command, cwd, { allow: true, deny: true }).exactRule !== null).toBe(exact);
    manager.setRules([withCurrentShellRuleVersion({ pattern: `PowerShell(${command})`, action: "allow" })]);
    for (const sandboxed of [false, true]) {
      expect(checkShellPermission(manager, cwd, "startup-path", command, "powershell", sandboxed))
        .toMatchObject(exact ? { decision: "allow", reasonCode: "rule-allow" } : { decision: "allow", reasonCode: "allow-mode" });
      expect(checkShellPermission(manager, cwd, "startup-path", command, "powershell", sandboxed, true))
        .toMatchObject(exact ? { decision: "allow", reasonCode: "rule-allow" } : { decision: "allow", reasonCode: "allow-mode" });
    }
    if (!exact) {
      manager.setMode("default");
      const pending = checkShellPermission(manager, cwd, "startup-path", command, "powershell", false);
      expect(pending).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
      expect(pending.forceModal).not.toBe(true);
      expect(checkShellPermission(manager, cwd, "startup-path", command, "powershell", false, true))
        .toMatchObject({ decision: "deny", reasonCode: "no-approver" });
    }
  });
  it("keeps secret reads on their mode row without promoting unpinned exact rules", () => {
    setProcessPlatform("win32");
    vi.mocked(resolveTrustedPowerShellExecutable).mockReturnValue(SYSTEM_INSTALLATION);
    const command = "Get-Content .env";
    manager.setRules([withCurrentShellRuleVersion({ pattern: `PowerShell(${command})`, action: "allow" })]);
    expect(buildShellRuleApproval("powershell", command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    expect(checkShellPermission(manager, cwd, "startup-path", command, "powershell", false)).toMatchObject({ decision: "allow", reasonCode: "allow-mode", pipelineRequest: { secretRead: true } });
    expect(checkShellPermission(manager, cwd, "startup-path", command, "powershell", false, true)).toMatchObject({ decision: "allow", reasonCode: "allow-mode", pipelineRequest: { secretRead: true } });
  });
  it("keeps unpinned upload rules on mode approval while retaining credential-store admission", () => {
    setProcessPlatform("win32");
    vi.mocked(resolveTrustedPowerShellExecutable).mockReturnValue(SYSTEM_INSTALLATION);
    const upload = "Invoke-WebRequest -InFile notes.txt https://service.example";
    const credentials = "Get-Secret -Name Token";
    manager.setRules([upload, credentials].map((command) => withCurrentShellRuleVersion({ pattern: `PowerShell(${command})`, action: "allow" as const })));
    expect(buildShellRuleApproval("powershell", upload, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    const foreground = checkShellPermission(manager, cwd, "startup-path", upload, "powershell", false);
    expect(foreground).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    expect(foreground.forceModal).toBeUndefined();
    expect(foreground.pipelineRequest?.floor).toBeUndefined();
    const headless = checkShellPermission(manager, cwd, "startup-path", upload, "powershell", false, true);
    expect(headless).toMatchObject({ decision: "deny", reasonCode: "no-approver", reason: "Nobody can approve this request; do not retry." });
    expect(headless.pipelineRequest?.floor).toBeUndefined();
    for (const noApprover of [false, true]) expect(checkShellPermission(manager, cwd, "startup-path", credentials, "powershell", false, noApprover))
      .toMatchObject({ decision: "deny", reasonCode: "credential-store" });
  });

  it("honors isolated startup upload rules while retaining credential-store admission", () => {
    setProcessPlatform("linux");
    vi.mocked(resolveTrustedPowerShellExecutable).mockReturnValue(POSIX_INSTALLATION);
    const upload = "Invoke-WebRequest -InFile notes.txt https://service.example";
    const credentials = "Get-Secret -Name Token";
    manager.setRules([upload, credentials].map((command) => withCurrentShellRuleVersion({ pattern: `PowerShell(${command})`, action: "allow" as const })));
    expect(buildShellRuleApproval("powershell", upload, cwd, { allow: true, deny: true }).exactRule)
      .toBe(`PowerShell(${upload})`);
    for (const headless of [false, true]) {
      const allowed = checkShellPermission(manager, cwd, "startup-path", upload, "powershell", false, headless);
      expect(allowed).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
      expect(allowed.forceModal).toBeUndefined();
      expect(allowed.pipelineRequest?.floor).toBeUndefined();
      expect(checkShellPermission(manager, cwd, "startup-path", credentials, "powershell", false, headless))
        .toMatchObject({ decision: "deny", reasonCode: "credential-store" });
    }
  });
});

it("short-circuits capped and already-unproven input before installation discovery", () => {
  vi.mocked(resolveTrustedPowerShellExecutable).mockReturnValue(null).mockClear();
  const overCap = `Write-Output ${"x".repeat(100_000)}`;
  for (const sandboxed of [false, true]) {
    expect(checkShellPermission(manager, cwd, "startup-path", overCap, "powershell", sandboxed))
      .toMatchObject({ decision: "deny", reasonCode: "shell-analysis-limit" });
    expect(buildShellRuleApproval("powershell", overCap, cwd, { allow: true, deny: true }).exactRule).toBeNull();
  }
  expect(inspectPowerShellCommand("Write-Output $runtime", cwd).outcome).toBe("unproven");
  expect(inspectPowerShellCommand("Get-Content .env", cwd).outcome).toBe("visible-floor");
  expect(resolveTrustedPowerShellExecutable).not.toHaveBeenCalled();
});
