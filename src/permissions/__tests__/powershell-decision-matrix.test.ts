import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { decidePermission } from "../decision-pipeline.js";
import { buildHostShellExecutionPlan } from "../host-shell-execution-plan.js";
import { PermissionManager } from "../permission-manager.js";
import { __issueHostShellExecutionPlanForTest } from "../sandbox-capability.js";

// POSIX startup proof depends on a protected pwsh install; pin it so every host classifies the same route.
vi.mock("../../shared/powershell-executable.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../shared/powershell-executable.js")>(),
  resolveTrustedPowerShellExecutable: (platform: NodeJS.Platform) =>
    platform === "win32" ? null : { executable: "/usr/local/microsoft/powershell/7/pwsh", kind: "pwsh" },
}));

// decision/reasonCode/floor/pipeline outcome.
const ASK = "ask/shell-approval/-/ask";
const ALLOW = "allow/allow-mode/-/allow";
const SANDBOX = "allow/sandboxed-shell/-/sandbox-auto";
const PROTECTED = "ask/protected-path/protected-path/ask-forced";
const ESCAPE = "ask/project-escape/project-escape/ask-forced";

// Every PowerShell classifier change must keep this whole matrix. Columns: win32 default, win32 allow, darwin default,
// darwin allow, on the sandboxed route (issued MXC plan on win32, ASRT on darwin). Rows marked `main:` are this
// branch's intended deltas from main 5c2ca0868 (`=` is unchanged): pinned MXC startup, providers and relative streams
// unproven (row 148), FileSystem-qualified and stream-suffixed paths kept under the floor.
const MATRIX: readonly (readonly [string, string, string, string, string])[] = [
  ["Set-Content -Path x.txt -Value y", SANDBOX, SANDBOX, SANDBOX, SANDBOX], // main: ASK, ALLOW, =, =
  ["mkdir d", SANDBOX, SANDBOX, SANDBOX, SANDBOX], // main: ASK, ALLOW, =, =
  ["New-Item -ItemType Directory -Path d", SANDBOX, SANDBOX, SANDBOX, SANDBOX], // main: ASK, ALLOW, ASK, ALLOW
  ["Copy-Item src out -Recurse", SANDBOX, SANDBOX, SANDBOX, SANDBOX], // main: ASK, ALLOW, =, =
  ["Get-Content x.txt", SANDBOX, SANDBOX, SANDBOX, SANDBOX], // main: ASK, ALLOW, =, =
  ["Set-Content -Path ../outside.txt -Value y", ESCAPE, ESCAPE, ESCAPE, ESCAPE],
  ["Set-Content -Path C:/outside/x.txt -Value y", SANDBOX, SANDBOX, SANDBOX, SANDBOX], // main: ASK, ALLOW, =, =
  ["Set-Content -Path ~/x.txt -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  ["Set-Content -Path .git/config -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  ["Set-Content -Path .claude/commands/a:b.md -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  ["Set-Content -Path .git/x:y -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  [String.raw`Set-Content -Path .git\hooks\pre-commit:s -Value y`, PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  [String.raw`Set-Content -Path $env:TEMP\x -Value y`, PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  ["Set-Content -Path ${env:X} -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  [String.raw`Set-Content -Path HKCU:\Soft* -Value y`, PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  [String.raw`Remove-Item -Path HKCU:\Soft*`, PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  ["Set-Content -Path HKCU`:\\Soft\\x -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  ["Remove-Item -Path *.txt", PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  [String.raw`Set-Content -Path HKCU:\Software\Foo -Value y`, ASK, ALLOW, ASK, ALLOW], // main: =, =, SANDBOX, SANDBOX
  [String.raw`Set-Content -Path Registry::HKEY_CURRENT_USER\Software\Foo -Value y`, ASK, ALLOW, ASK, ALLOW], // main: =, =, SANDBOX, SANDBOX
  ["Set-Content -Path Env:fixture -Value y", ASK, ALLOW, ASK, ALLOW], // main: =, =, SANDBOX, SANDBOX
  // main on a POSIX host: ASK, ALLOW, SANDBOX, SANDBOX; main on Windows: unchanged.
  ["Set-Content -Path C:fixture -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  ["Get-Content -Path Env:GITHUB_TOKEN", ASK, ALLOW, ASK, ALLOW], // main: =, =, SANDBOX, SANDBOX
  [String.raw`Set-Content -Path Microsoft.PowerShell.Core\Registry::HKEY_CURRENT_USER\Software\Foo -Value y`, ASK, ALLOW, ASK, ALLOW], // main: =, =, SANDBOX, SANDBOX
  [String.raw`Set-Content -Path Microsoft.PowerShell.Core\Environment::GITHUB_TOKEN -Value y`, ASK, ALLOW, ASK, ALLOW], // main: =, =, SANDBOX, SANDBOX
  [String.raw`Get-Content -Path Microsoft.PowerShell.Core\Environment::GITHUB_TOKEN`, ASK, ALLOW, ASK, ALLOW], // main: =, =, SANDBOX, SANDBOX
  [String.raw`Set-Content -Path \\?\C:\x -Value y`, PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  [String.raw`Set-Content -Path \\?\UNC\host\share\x -Value y`, PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  [String.raw`Set-Content -Path \\.\pipe\x -Value y`, ESCAPE, ESCAPE, ESCAPE, ESCAPE],
  [String.raw`Set-Content -Path \\.\C:\x -Value y`, ESCAPE, ESCAPE, ESCAPE, ESCAPE],
  ["Set-Content -Path //host/share/x -Value y", ESCAPE, ESCAPE, ESCAPE, ESCAPE],
  ["Set-Content -Path file.txt:stream -Value y", ASK, ALLOW, ASK, ALLOW], // main: =, =, SANDBOX, SANDBOX
  ["Get-Content file.txt:stream", ASK, ALLOW, ASK, ALLOW], // main: =, =, SANDBOX, SANDBOX
  [String.raw`Set-Content -Path C:\proj\f.txt:s -Value y`, PROTECTED, PROTECTED, PROTECTED, PROTECTED], // main: ASK, ALLOW, SANDBOX, SANDBOX
  ["Set-Content -Path 'x.txt' -Value y", SANDBOX, SANDBOX, SANDBOX, SANDBOX], // main: ASK, ALLOW, =, =
  ["Set-Content -Path \"x.txt\" -Value y", SANDBOX, SANDBOX, SANDBOX, SANDBOX], // main: ASK, ALLOW, =, =
  ["Set-Content -Path x`.txt -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  ["Set-Content -LiteralPath x[1].txt -Value y", ASK, ALLOW, ASK, ALLOW],
  ["Set-Content -Path FileSystem::.git/config -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED], // main: ASK, ALLOW, SANDBOX, SANDBOX
  [String.raw`Set-Content -Path Microsoft.PowerShell.Core\FileSystem::.git\config -Value y`, PROTECTED, PROTECTED, PROTECTED, PROTECTED], // main: ASK, ALLOW, SANDBOX, SANDBOX
  ["Set-Content -LiteralPath FileSystem::.git/config -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED], // main: ASK, ALLOW, SANDBOX, SANDBOX
  ["Set-Content -Path FileSystem::x.txt -Value y", ASK, ALLOW, ASK, ALLOW], // main: =, =, SANDBOX, SANDBOX
  [String.raw`Set-Content -Path '.git\config::$DATA' -Value y`, PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  ["Set-Content -Path '.git/config::$DATA' -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED],
  ["Set-Content -Path .claude/commands::x -Value y", PROTECTED, PROTECTED, PROTECTED, PROTECTED],
];

const CAPABILITY = (platform: NodeJS.Platform) => ({ kind: "asrt", confidence: "verified", platform, reason: "fixture",
  confines: { filesystem: true, process: true, network: true } }) as const;
const COLUMNS = [["win32", "default"], ["win32", "allow"], ["darwin", "default"], ["darwin", "allow"]] as const;
const originalPlatform = process.platform;
let root: string;
let project: string;
beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "powershell-decision-matrix-")));
  project = join(root, "project");
  mkdirSync(project);
  vi.stubEnv("AVE_HOME", join(project, "profile"));
});
afterEach(() => setProcessPlatform(originalPlatform));
afterAll(async () => { vi.unstubAllEnvs(); await cleanupTmpDir(root); });

function classify(command: string, platform: "win32" | "darwin", mode: "default" | "allow"): string {
  setProcessPlatform(platform);
  const plan = __issueHostShellExecutionPlanForTest(buildHostShellExecutionPlan(platform === "win32"
    ? { platform, requestedSandbox: true, shellSubstrate: "mxc", activeCapability: CAPABILITY(platform) }
    : { platform, requestedSandbox: true, activeCapability: CAPABILITY(platform) }));
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode(mode);
  const result = manager.checkDetailed("powershell", "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect: "powershell", command, cwd: project },
    hostShellExecutionPlan: plan,
    shellExecution: { runsSandboxed: plan.sandboxed, environmentSnapshot: {} },
  });
  const outcome = result.pipelineRequest ? decidePermission(result.pipelineRequest).outcome : "-";
  return `${result.decision}/${result.reasonCode}/${result.pipelineRequest?.floor?.code ?? "-"}/${outcome}`;
}

describe("PowerShell decision matrix", () => {
  it.each(MATRIX)("%s", (command, ...expected) => {
    expect(COLUMNS.map(([platform, mode]) => classify(command, platform, mode))).toEqual(expected);
  });
});
