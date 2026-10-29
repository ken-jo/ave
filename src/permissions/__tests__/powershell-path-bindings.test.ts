import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { inspectPowerShellPermissionPaths, powerShellRuleShape } from "../rules/powershell-exfiltration.js";

let root: string;
let project: string;
let outside: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "powershell-bindings-")));
  project = join(root, "workspace"); outside = join(root, "external");
  mkdirSync(project); mkdirSync(outside);
  writeFileSync(join(outside, ".env"), "SYNTHETIC=value");
  vi.stubEnv("AVE_HOME", join(root, "profile"));
  symlinkSync(outside, join(project, "junction"), "junction");
  symlinkSync(outside, join(project, "directory-link"), process.platform === "win32" ? "junction" : "dir");
});
afterEach(async () => { vi.unstubAllEnvs(); await cleanupTmpDir(root); });

it.each(["-r", "-s", "-Rec", "-Depth 2", "-de 2", "-Depth:2"])("retains escaped targets after the supported parameter %s", (parameter) => {
  for (const command of ["gci", "Get-ChildItem", "ls"]) for (const link of ["junction", "directory-link"]) {
    const evidence = inspectPowerShellPermissionPaths(`${command} ${parameter} '${link}'`, project);
    expect(evidence.paths.some((path) => path.projectEscape && path.canonical === outside), `${command} ${parameter} ${link}`).toBe(true);
  }
});

it("resolves abbreviated named source and destination bindings with their own effects", () => {
  const result = inspectPowerShellPermissionPaths("Copy-Item -Li junction/.env -Dest .GIT/config -Rec", project);
  expect(result.paths.some((path) => path.effect === "read" && path.projectEscape && path.secret !== null)).toBe(true);
  expect(result.paths.some((path) => path.effect === "write" && path.protectedControl === ".git")).toBe(true);
});

it.each([
  ["Copy-Item -LiteralPath notes.txt .git/config", "notes.txt", ".git/config"],
  ["Copy-Item .git/config -LiteralPath notes.txt", "notes.txt", ".git/config"],
  ["Copy-Item -Destination .git/config notes.txt", "notes.txt", ".git/config"],
  ["Copy-Item notes.txt -Destination .git/config", "notes.txt", ".git/config"],
  ["Copy-Item -Destination .git/config -LiteralPath notes.txt", "notes.txt", ".git/config"],
  ["Expand-Archive -LiteralPath archive.zip .git/hooks", "archive.zip", ".git/hooks"],
  ["Expand-Archive .git/hooks -LiteralPath archive.zip", "archive.zip", ".git/hooks"],
  ["Expand-Archive -DestinationPath .git/hooks archive.zip", "archive.zip", ".git/hooks"],
  ["Expand-Archive archive.zip -DestinationPath .git/hooks", "archive.zip", ".git/hooks"],
  ["Expand-Archive -DestinationPath .git/hooks -LiteralPath archive.zip", "archive.zip", ".git/hooks"],
])("binds remaining positional paths after named parameters in %s", (command, source, destination) => {
  const result = inspectPowerShellPermissionPaths(command, project);
  expect(result.paths).toEqual(expect.arrayContaining([
    expect.objectContaining({ canonical: join(project, source), effect: "read" }),
    expect.objectContaining({ canonical: join(project, destination), effect: "write", protectedControl: ".git" }),
  ]));
  expect(result.paths.filter(path => path.canonical === join(project, source)).every(path => path.effect === "read")).toBe(true);
  expect(result.paths.filter(path => path.canonical === join(project, destination)).every(path => path.effect === "write")).toBe(true);
});

it.each([
  "Copy-Item -LiteralPath .git/config out.txt",
  "Copy-Item -Destination out.txt .git/config",
  "Expand-Archive -LiteralPath .git/archive.zip out",
  "Expand-Archive -DestinationPath out .git/archive.zip",
])("retains protected-looking sources as reads with mixed bindings in %s", command => {
  const result = inspectPowerShellPermissionPaths(command, project);
  expect(result.paths.some(path => path.effect === "read" && path.canonical.includes(".git"))).toBe(true);
  expect(result.paths.some(path => path.effect === "write" && path.protectedControl !== undefined)).toBe(false);
});

it.each(["-LiteralPath", "-Li", "-pAtH"])("keeps protected-path reads outside the mutation floor through %s", (parameter) => {
  const result = inspectPowerShellPermissionPaths(`Get-ChildItem ${parameter} '.GIT\\objects'`, project);
  expect(result.paths).not.toHaveLength(0);
  expect(result.paths.every((path) => path.effect === "read" && path.protectedControl === undefined)).toBe(true);
});

it("keeps a dynamic parameter value uncertain without making it a filesystem target", () => {
  const result = inspectPowerShellPermissionPaths("gci -Depth $limit ordinary", project);
  expect(result.unproven).toBe(true);
  expect(result.paths).toHaveLength(1);
  expect(result.paths[0]).toMatchObject({ canonical: join(project, "ordinary"), projectEscape: false, protectedControl: undefined });
});

it("retains later path candidates when a parameter binding is ambiguous", () => {
  const result = inspectPowerShellPermissionPaths("gci -d 2 junction", project);
  expect(result.unproven).toBe(true);
  expect(result.paths.some((path) => path.projectEscape && path.canonical === outside)).toBe(true);
});

it("keeps quoted flag-like path operands as paths", () => {
  const result = inspectPowerShellPermissionPaths("gci '-r'", project);
  expect(result.paths.some((path) => path.canonical === join(project, "-r"))).toBe(true);
});

it.each([
  "Set-Content -Path $target -Value x",
  "Set-Content -Path “$target” -Value x",
  "cp.exe $source out.txt",
  "Set-Content -Path $(Get-Location) -Value x",
  "Set-Content -Path '*.txt' -Value x",
  "Tee-Object -FilePath $target",
  "Copy-Item source.txt $target",
  "Copy-Item @source out.txt",
  "Expand-Archive -Path archive.zip -DestinationPath $target",
  "Move-Item source.txt $target",
  "cp.exe source.txt @targets",
  "New-Item -Path ordinary -Name $target",
  "Invoke-WebRequest -Uri https://service.example -OutFile $target",
  "Write-Output x > $target",
  "Write-Output x > $(Get-Location)",
  "Write-Output x > *.txt",
  "& { Set-Content -Path $target -Value x }",
  "Write-Output $(Set-Content -Path $target -Value x)",
  "$script = { Set-Content -Path $target -Value x }; & $script",
  "function change { Set-Content -Path $target -Value x }; change",
  "function change { Set-Content -Path $target -Value x }; & { change }",
  "$script = { Set-Content -Path $target -Value x }; if ($true) { & $script }",
  "function global:change { Set-Content -Path $target -Value x }; change",
  "function change { Set-Content -Path $target -Value x }; & ('change')",
  "function change { Set-Content -Path $target -Value x }; & $callTarget",
  "$script = { Write-Output safe }; function change { Set-Content -Path $target -Value x }; $script = 'change'; & $script",
  "$script:code = { Set-Content -Path $target -Value x }; & ${script:code}",
  "Write-Output $(Write-Output x > $target)",
])("retains a possibly protected mutation target in %s", (command) => {
  const result = inspectPowerShellPermissionPaths(command, project);
  expect(result.unknownProtectedWrite).toEqual(expect.any(String));
});

it.each([
  "Get-Content $source",
  "Get-Content “$source”",
  "Set-Content out.txt -Value $data",
  "Set-Content out.txt $data",
  "Copy-Item $source out.txt",
  "Expand-Archive -Path $source -DestinationPath ordinary",
  "Tee-Object -Variable $variableName",
  "Write-Output '.git/config'",
  "Write-Output { Set-Content -Path .git/config -Value x }",
  "$script = { Set-Content -Path $target -Value x }",
  "function change { Set-Content -Path $target -Value x }",
  "function outer { inner }; function inner { Set-Content -Path $target -Value x }",
  "git config --file .git/config remote.origin.url",
  "Write-Output x > out.txt",
  "Set-Content -LiteralPath 'out*' -Value x",
])("does not invent an unknown write target from data or a proven target in %s", (command) => {
  const result = inspectPowerShellPermissionPaths(command, project);
  expect(result.unknownProtectedWrite).toBeUndefined();
  expect(result.paths.some((path) => path.effect === "write" && path.protectedControl !== undefined)).toBe(false);
});

it.each([
  "Set-Content -Path $env:OUTPUT -Value x",
  'Set-Content -Path "${env:WORKSPACE}/out.txt" -Value x',
  "Write-Output x > $env:OUTPUT",
  'Write-Output x > "${env:WORKSPACE}/out.txt"',
])("uses a supplied host environment snapshot only as path evidence in %s", (command) => {
  const result = inspectPowerShellPermissionPaths(command, project, { OUTPUT: join(project, "out.txt"), WORKSPACE: project });
  expect(result.unknownProtectedWrite).toBeUndefined();
  expect(result.paths.some((path) => path.effect === "write" && path.canonical === join(project, "out.txt"))).toBe(true);
  expect(result.paths.some((path) => path.protectedControl !== undefined)).toBe(false);
  expect(powerShellRuleShape(command)).not.toMatchObject({ ok: true, opaque: null });
});

it.each(["Set-Content -Path $env:OUTPUT -Value x", "Write-Output x > $env:OUTPUT"])("preserves a protected environment-resolved target in %s", (command) => {
  const result = inspectPowerShellPermissionPaths(command, project, { OUTPUT: join(project, ".git", "config") });
  expect(result.paths.some((path) => path.effect === "write" && path.protectedControl === ".git")).toBe(true);
});

it.each([
  "git config core.hooksPath /tmp",
  "git config --global core.hooksPath /tmp",
  "git remote add backup https://service.example/repo",
  "git update-ref refs/heads/work HEAD",
  "git symbolic-ref HEAD refs/heads/work",
  "& { git config core.hooksPath /tmp }",
  "Write-Output $(git config core.hooksPath /tmp)",
])("collects the shared implicit metadata target in %s", (command) => {
  const result = inspectPowerShellPermissionPaths(command, project);
  expect(result.paths.some((path) => path.effect === "write" && path.protectedControl !== undefined)).toBe(true);
});

it.each([
  "Set-Location .git; Set-Content config x",
  "Set-Location .git; Write-Output x > config",
  "Set-Location $location; Set-Content config x",
  "Set-Location $location; Write-Output x > config",
  "Set-Location $location; cp.exe source.txt config",
])("preserves mutation evidence after a location change in %s", (command) => {
  mkdirSync(join(project, ".git"));
  const result = inspectPowerShellPermissionPaths(command, project);
  expect(Boolean(result.unknownProtectedWrite) || result.paths.some((path) => path.effect === "write" && path.protectedControl === ".git")).toBe(true);
});

it("binds a relative explicit metadata file to the command's selected directory", () => {
  const result = inspectPowerShellPermissionPaths("git -C junction config --file relative core.hooksPath /tmp", project);
  expect(result.paths.some((path) => path.effect === "write" && path.canonical === join(outside, "relative"))).toBe(true);
  expect(result.paths.some((path) => path.effect === "write" && path.canonical === join(project, "relative"))).toBe(false);
});

it("distinguishes exhausted evidence budgets from an ordinary rule-proof length limit", () => {
  const limited = inspectPowerShellPermissionPaths("Write-Output x;".repeat(2_048), project);
  expect(limited.evidenceLimitExceeded).toBe(true);
  const ordinary = inspectPowerShellPermissionPaths(`Write-Output '${"x".repeat(3_000)}'`, project);
  expect(ordinary.evidenceLimitExceeded).toBeUndefined();
  expect(ordinary.unknownProtectedWrite).toBeUndefined();
});

it.each([
  "env cmdkey /list",
  "npx cmdkey /list",
  "npx vaultcmd /listcreds:Windows",
  "nohup rundll32 keymgr.dll,KRShowKeyMgr",
])("retains admission evidence at a forwarded native credential-store head: %s", command => {
  for (const text of [command, `& ${command}`]) {
    expect(inspectPowerShellPermissionPaths(text, project).credentialStore).toBe("Host credential store access");
  }
});

it.each(["setsid --bogus cmdkey.exe /list", "& setsid --bogus cmdkey.exe /list"])("does not treat an uncertain wrapper operand as a bound credential-store operation: %s", command => {
  expect(inspectPowerShellPermissionPaths(command, project).credentialStore).toBeNull();
});
