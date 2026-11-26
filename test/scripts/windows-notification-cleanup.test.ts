import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../src/__tests__/test-helpers.js";

const cleanup = readRepoFile("build/uninstall-windows-notification-artifacts.ps1");
const registryFixture = readRepoFile("test/fixtures/windows-notification-registry.ps1");

describe("current-user toast cleanup", () => {
  it("preserves a same-target shortcut with missing ownership fields", () => {
    expect(cleanup).toMatch(/\[AllowNull\(\)\]\[AllowEmptyString\(\)\]\[string\]\$Left/);
    expect(cleanup).toContain("if ([string]::IsNullOrWhiteSpace($Left)) { return $false }");
    expect(cleanup).toMatch(
      /if \(-not \(Test-SamePath \$Record\.WorkingDirectory \$ExpectedWorkingDirectory\)\) \{\s+\$mismatches \+= "workingDirectory"/,
    );
    expect(cleanup).toMatch(
      /if \(\$mismatches\.Count -ne 0\) \{\s+Write-CleanupEvent "foreign-preserved" "shortcut"/,
    );
  });

  it("continues to registry cleanup when Programs or its shortcut is missing", () => {
    expect(cleanup).toMatch(
      /\[Environment\]::GetFolderPath\(\s+\[Environment\+SpecialFolder\]::Programs,\s+\[Environment\+SpecialFolderOption\]::DoNotVerify\s+\)/,
    );
    expect(cleanup).toMatch(
      /\$shortcutAttributes = Get-ShortcutAttributes \$shortcutPath\s+if \(\$null -eq \$shortcutAttributes\) \{\s+Write-CleanupEvent "verified-absent" "shortcut"[^}]+\}\s+elseif/,
    );
    expect(cleanup).toMatch(
      /\n {2}foreach \(\$registration in @\(Find-ExactToastRegistrations \$installedExe \$candidateClsids\)\) \{\s+if \(Remove-ExactToastRegistration/,
    );
  });

  it("fails closed when either lookup is denied", () => {
    expect(cleanup).toMatch(
      /function Get-ShortcutAttributes \{[^}]+\{\s+return \[System\.IO\.File\]::GetAttributes\(\$Path\)\s+\}\s+catch \[System\.IO\.FileNotFoundException\], \[System\.IO\.DirectoryNotFoundException\] \{\s+return \$null\s+\}\s+\}/,
    );
    expect(cleanup).toContain("$shortcutAttributes = Get-ShortcutAttributes $shortcutPath");
    expect(cleanup).toContain("$shortcutResidue = Get-ShortcutAttributes $shortcutPath");
    expect(cleanup).toMatch(/\ncatch \{[\s\S]+Write-CleanupEvent "contract-failed" "notification-artifacts"[\s\S]+exit 1/);
  });

  it.runIf(process.platform === "win32").each([
    ["value read throws", "read-error", "fixture denied the value read"],
    ["a delete silently leaves a value", "delete-noop", "CustomActivator"],
  ])("fails and keeps the owned shortcut when %s", (_label, scenario, failureDetail) => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new Error("SystemRoot/WINDIR is required for registry fixtures");
    const installDir = mkdtempSync(join(tmpdir(), "ave-toast-registry-"));
    try {
      const executable = join(installDir, "Ave.exe");
      const marker = join(installDir, ".ave-nsis-per-machine-v1");
      const shortcut = join(installDir, "Ave.lnk");
      const script = join(installDir, "cleanup.ps1");
      const evidence = "fixture shortcut evidence";
      writeFileSync(marker, "");
      writeFileSync(shortcut, evidence);

      // Substitute external lookups in the copied script. Its quarantine, cleanup and exit path run unchanged.
      const programsLookup =
        /\[Environment\]::GetFolderPath\(\s*\[Environment\+SpecialFolder\]::Programs,\s*\[Environment\+SpecialFolderOption\]::DoNotVerify\s*\)/;
      const registryOpen =
        /\[Microsoft\.Win32\.RegistryKey\]::OpenBaseKey\(\s*\[Microsoft\.Win32\.RegistryHive\]::CurrentUser,\s*\$View\s*\)|\[ToastRegistryKey\]::OpenCurrentUser\(/g;
      expect(cleanup.match(registryOpen)).toHaveLength(2);
      expect(cleanup).toMatch(programsLookup);
      expect(cleanup).toContain("$shortcutMoved = $false");
      const fixtureScript = cleanup
        .replace(programsLookup, "$env:AVE_FIXTURE_DIRECTORY")
        .replace(registryOpen, (match) => match.endsWith("(")
          ? "[FixtureRegistryKey]::OpenCurrentUser("
          : "[FixtureRegistryKey]::OpenBaseKey($View)")
        .replace("$shortcutMoved = $false", () => `${registryFixture}\n$shortcutMoved = $false`);
      writeFileSync(script, fixtureScript);

      const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = spawnSync(
        powerShell,
        [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
          "-InstalledExecutable", executable, "-ShortcutName", "Ave",
          "-AppUserModelId", "ai.example.toast", "-InstallMarker", marker,
        ],
        {
          env: { ...process.env, AVE_FIXTURE_DIRECTORY: installDir, AVE_FIXTURE_SCENARIO: scenario },
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toContain(`fixture exercised ${scenario}`);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(failureDetail);
      expect(result.stdout).toContain('"status":"contract-failed"');
      expect(result.stdout).not.toContain('"status":"verified-absent","artifact":"toast-registration"');
      expect(existsSync(shortcut)).toBe(true);
      expect(readFileSync(shortcut, "utf8")).toBe(evidence);
      expect(readdirSync(installDir).filter((file) => file.endsWith(".lnk"))).toEqual(["Ave.lnk"]);
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  it("matches registrations at the product CLSID and the exact CLSID from a verified shortcut", () => {
    const boot = readRepoFile("src/main/early-boot-env.ts");
    const pinnedClsid = boot.match(/const WINDOWS_TOAST_ACTIVATOR_CLSID =\s*"([^"]+)"/)?.[1];
    expect(pinnedClsid).toBe("{62FD3EFB-B3D2-4235-9402-6979F52C0286}");
    expect(cleanup).toContain(`$productClsid = "${pinnedClsid}"`);
    expect(cleanup).toContain("$candidateClsids = @($productClsid)");
    expect(cleanup).toMatch(
      /\$quarantinedMismatches = @\(\s+Get-ShortcutOwnershipMismatches \$quarantinedRecord [^)]+\)\s+if \(\$quarantinedMismatches\.Count -ne 0\) \{[\s\S]+?\$verifiedClsid = \(\[guid\]\$quarantinedRecord\.ToastClsid\)\.ToString\("B"\)/,
    );
    expect(cleanup).toMatch(
      /if \(\$verifiedClsid -ne \(\[guid\]\$record\.ToastClsid\)\.ToString\("B"\)\) \{\s+throw [^}]+\}\s+if \(\$verifiedClsid -ne \$productClsid\) \{\s+\$candidateClsids \+= \$verifiedClsid\s+\}/,
    );
    expect(cleanup.match(/^\s*\$candidateClsids\s*(?:\+?=)/gm)).toHaveLength(2);
    expect(cleanup).toMatch(/foreach \(\$clsid in \$CandidateClsids\) \{\s+if \(Test-ExactToastRegistration \$view \$clsid \$ExpectedExecutable\)/);
    expect(cleanup).toContain("$remaining = @(Find-ExactToastRegistrations $installedExe $candidateClsids)");
    expect(cleanup).not.toMatch(/GetSubKeyNames|ProfileList|HKEY_USERS|NTUSER\.DAT|UsrClass\.dat|RegLoad(?:App)?Key/i);
    const hives = [...cleanup.matchAll(/\bRegistryHive\.(\w+)/g)];
    expect(new Set(hives.map((match) => match[1]))).toEqual(new Set(["CurrentUser"]));
    const registered = cleanup.indexOf("$remaining = @(Find-ExactToastRegistrations");
    expect(cleanup.indexOf("[System.IO.File]::Delete($quarantinePath)")).toBeGreaterThan(registered);
    expect(cleanup).toContain("[System.IO.File]::Move($quarantinePath, $shortcutPath)");
  });

  it("removes only owned values and allows empty keys in the smoke postcondition", () => {
    expect(cleanup).not.toMatch(/\b(?:DeleteSubKey(?:Tree)?|Remove-Item(?:Property)?)\b/i);
    expect(cleanup.match(/\$(root|server)\.DeleteValue\("[^"]*"\)/g)).toEqual([
      '$server.DeleteValue("")',
      '$root.DeleteValue("CustomActivator")',
      '$root.DeleteValue("")',
    ]);
    expect(cleanup.match(/\$(root|server)\.HasValue\("[^"]*"\)/g)).toEqual([
      '$server.HasValue("")',
      '$root.HasValue("CustomActivator")',
      '$root.HasValue("")',
    ]);

    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");
    expect(smoke).toMatch(
      /if \(\s+rootDefault\.valueExists \|\|\s+customActivator\.valueExists \|\|\s+localServer\.valueExists\s+\) \{\s+registrations\.push/,
    );
  });
});
